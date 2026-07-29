/**
 * Style learning.
 *
 * "Picking up my style from the drafts I edit" and the "More my style" coaching
 * button.
 *
 * The signal is the *diff*, not the final text. When the operator rewrites a
 * draft, the difference between what Morpheus wrote and what shipped is the most
 * honest style data available — nobody describes their own voice accurately,
 * but everybody corrects it consistently.
 *
 * Two layers: measurable deltas computed locally on every edit (free, instant,
 * always available), and a periodic model pass that turns accumulated edits
 * into prose rules. The measurable layer alone is enough to change output.
 */

import { callRole } from "./models";
import { id, mutate, readCollection } from "./store";

export interface EditSample {
  id: string;
  /** What Morpheus produced. */
  draft: string;
  /** What the operator actually shipped. */
  edited: string;
  surface: string;
  at: number;
}

export interface StyleProfile {
  /** Model-written rules, refreshed as edits accumulate. */
  rules: string[];
  /** Locally measured tendencies — always present, no key needed. */
  metrics: {
    samples: number;
    /** Positive = the operator cuts length. */
    lengthDelta: number;
    avgSentenceWords: number;
    emojiPerPost: number;
    exclamationPerPost: number;
    hashtagPerPost: number;
    /** Words the operator repeatedly deletes. */
    avoids: string[];
  };
  updatedAt: number;
}

const SAMPLES = "style-samples";
const PROFILE = "style-profile";

const EMPTY: StyleProfile = {
  rules: [],
  metrics: {
    samples: 0,
    lengthDelta: 0,
    avgSentenceWords: 0,
    emojiPerPost: 0,
    exclamationPerPost: 0,
    hashtagPerPost: 0,
    avoids: [],
  },
  updatedAt: 0,
};

export async function getProfile(): Promise<StyleProfile> {
  return readCollection<StyleProfile>(PROFILE, EMPTY);
}

export async function getSamples(): Promise<EditSample[]> {
  return readCollection<EditSample[]>(SAMPLES, []);
}

const EMOJI = /\p{Extended_Pictographic}/gu;

function count(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length;
}

function words(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9'\s]/g, " ").split(/\s+/).filter(Boolean);
}

/** Recompute the measurable half of the profile from every sample held. */
function measure(samples: EditSample[]): StyleProfile["metrics"] {
  if (samples.length === 0) return EMPTY.metrics;

  let lengthDelta = 0;
  let sentenceWords = 0;
  let sentences = 0;
  let emoji = 0;
  let exclamation = 0;
  let hashtag = 0;
  const deletions = new Map<string, number>();

  for (const sample of samples) {
    const draftLen = sample.draft.length || 1;
    lengthDelta += (draftLen - sample.edited.length) / draftLen;

    const parts = sample.edited.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean);
    for (const part of parts) {
      sentenceWords += part.split(/\s+/).length;
      sentences += 1;
    }

    emoji += count(sample.edited, EMOJI);
    exclamation += count(sample.edited, /!/g);
    hashtag += count(sample.edited, /#\w+/g);

    // Words present in the draft but cut from the shipped version.
    const kept = new Set(words(sample.edited));
    for (const word of new Set(words(sample.draft))) {
      if (word.length > 4 && !kept.has(word)) {
        deletions.set(word, (deletions.get(word) ?? 0) + 1);
      }
    }
  }

  const n = samples.length;
  return {
    samples: n,
    lengthDelta: lengthDelta / n,
    avgSentenceWords: sentences > 0 ? sentenceWords / sentences : 0,
    emojiPerPost: emoji / n,
    exclamationPerPost: exclamation / n,
    hashtagPerPost: hashtag / n,
    avoids: [...deletions.entries()]
      // Cut once is noise; cut repeatedly is a preference.
      .filter(([, hits]) => hits >= Math.max(2, Math.ceil(n * 0.4)))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([word]) => word),
  };
}

const RULES_SYSTEM = `You infer a person's writing voice from edits they made to drafts written for them.

You are given pairs: DRAFT (what the AI wrote) and SHIPPED (what the person actually published).

Infer what they consistently change. Return ONLY a JSON array of at most 7 short imperative rules, each one actionable when writing the next draft.

Good: "Cut the opening throat-clearing and start on the claim." "Never use exclamation marks." "Use 'we' not 'I' when describing the product."
Bad: "Write well." "Be professional." Anything you can't verify from the pairs.

Return [] if the edits show no consistent pattern.`;

/**
 * Record an edit and refresh the profile.
 *
 * The metrics half always updates. The model-written rules refresh every few
 * samples — often enough to keep up, rarely enough not to burn a call per edit.
 */
export async function recordEdit(
  draft: string,
  edited: string,
  surface = "post",
): Promise<StyleProfile> {
  if (draft.trim() === edited.trim()) return getProfile();

  const sample: EditSample = {
    id: id("edit"),
    draft,
    edited,
    surface,
    at: Date.now(),
  };

  const samples = await mutate<EditSample[], EditSample[]>(SAMPLES, [], (current) => {
    // Keep the trailing window: voice drifts, and old edits shouldn't outvote
    // recent ones forever.
    const next = [...current, sample].slice(-40);
    return { next, result: next };
  });

  const metrics = measure(samples);
  const existing = await getProfile();

  let rules = existing.rules;
  const shouldRefresh = samples.length >= 3 && samples.length % 3 === 0;

  if (shouldRefresh) {
    const result = await callRole("hard", {
      system: RULES_SYSTEM,
      messages: [
        {
          role: "user",
          content: samples
            .slice(-12)
            .map((s) => `DRAFT: ${s.draft}\n\nSHIPPED: ${s.edited}`)
            .join("\n\n---\n\n"),
        },
      ],
      json: true,
    });

    if (result.live && result.text) {
      const { parseJson } = await import("./models");
      const parsed = parseJson<string[]>(result.text);
      if (Array.isArray(parsed)) {
        rules = parsed.filter((r) => typeof r === "string" && r.trim()).slice(0, 7);
      }
    }
  }

  const profile: StyleProfile = { rules, metrics, updatedAt: Date.now() };
  await mutate<StyleProfile, null>(PROFILE, EMPTY, () => ({ next: profile, result: null }));
  return profile;
}

/**
 * The profile as prompt text.
 *
 * Metrics are rendered as instructions rather than numbers — a model handles
 * "keep sentences to about 14 words" far better than "avgSentenceWords: 14.2".
 */
export function renderForPrompt(profile: StyleProfile): string {
  const { metrics, rules } = profile;
  if (metrics.samples === 0 && rules.length === 0) return "";

  const lines: string[] = ["The operator's voice, learned from drafts they edited:"];

  for (const rule of rules) lines.push(`- ${rule}`);

  if (metrics.samples > 0) {
    if (metrics.lengthDelta > 0.15) {
      lines.push(
        `- They cut roughly ${Math.round(metrics.lengthDelta * 100)}% of what is drafted. Write short.`,
      );
    } else if (metrics.lengthDelta < -0.15) {
      lines.push("- They usually add to drafts. Do not be terse.");
    }
    if (metrics.avgSentenceWords > 0) {
      lines.push(`- Sentences average about ${Math.round(metrics.avgSentenceWords)} words.`);
    }
    if (metrics.emojiPerPost < 0.3) lines.push("- No emoji.");
    if (metrics.exclamationPerPost < 0.2) lines.push("- No exclamation marks.");
    if (metrics.hashtagPerPost < 0.5) lines.push("- No hashtags.");
    else lines.push(`- About ${Math.round(metrics.hashtagPerPost)} hashtags per post.`);
    if (metrics.avoids.length > 0) {
      lines.push(`- Words they repeatedly delete: ${metrics.avoids.join(", ")}. Avoid them.`);
    }
  }

  return lines.join("\n");
}

/** The "More my style" action: rewrite text against the learned profile. */
export async function moreMyStyle(text: string): Promise<{ text: string; live: boolean; note?: string }> {
  const profile = await getProfile();
  const guidance = renderForPrompt(profile);

  if (!guidance) {
    return {
      text,
      live: false,
      note: "No style learned yet — edit a few drafts and Morpheus will pick it up.",
    };
  }

  const result = await callRole("hard", {
    system: `Rewrite the text in the operator's voice. Change only voice — never the facts, never the meaning, never the length beyond what the rules require. Return the rewritten text and nothing else.\n\n${guidance}`,
    messages: [{ role: "user", content: text }],
  });

  if (!result.live || !result.text) {
    return { text, live: false, note: result.error ?? "Style model unavailable." };
  }
  return { text: result.text, live: true };
}
