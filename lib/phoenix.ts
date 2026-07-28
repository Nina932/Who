/**
 * Phoenix — a working reconstruction of X's For You ranking pipeline.
 *
 * Grounded in what xAI actually published in `xai-org/x-algorithm`
 * (open-sourced 20 Jan 2026). What is real and what is ours:
 *
 *   REAL  Two-stage shape: two-tower retrieval → transformer ranking.
 *   REAL  Candidate isolation — candidates attend to user + history but never
 *         to each other, so a post's score never depends on what it was
 *         batched with.
 *   REAL  The ranking head predicts 19 actions simultaneously, and the 19
 *         weight names below are the ones in `weighted_scorer.rs`.
 *   REAL  The combine formula, including the negative-score offset branch.
 *   OURS  Every weight *value*. xAI published the architecture and a "mini"
 *         checkpoint, not production weights — so the numbers here are
 *         plausible defaults, and the whole point of the UI is that you move
 *         them and watch the feed rearrange.
 *   OURS  The prediction model. A real Phoenix head is a transformer; this is
 *         a transparent feature function, because a black box would teach the
 *         reader nothing.
 *
 * The thesis the visualisation exists to demonstrate: nothing here optimises
 * for whether a post is *true*. It optimises for 19 flavours of engagement.
 * Outrage scores well on reply and dwell, and the ranking follows.
 */

// ── Signals ──────────────────────────────────────────────────────────────

export const SIGNAL_AXES = [
  "interests",
  "engagement",
  "behavior",
  "context",
  "relationships",
  "sentiment",
] as const;

export type SignalAxis = (typeof SIGNAL_AXES)[number];

export const SIGNAL_COPY: Record<SignalAxis, string> = {
  interests: "Topics you have engaged with before",
  engagement: "How readily you like, reply, repost",
  behavior: "Dwell, scroll speed, session shape",
  context: "Time of day, device, session length",
  relationships: "Who you follow and answer",
  sentiment: "The emotional register you respond to",
};

/** The user tower's input, all axes 0..1. */
export type SignalVector = Record<SignalAxis, number>;

export const DEFAULT_SIGNALS: SignalVector = {
  interests: 0.72,
  engagement: 0.58,
  behavior: 0.64,
  context: 0.4,
  relationships: 0.55,
  sentiment: 0.68,
};

// ── The 19 action heads ──────────────────────────────────────────────────

export type Polarity = 1 | -1;

export interface ActionSpec {
  key: string;
  /** The constant name in xai-org/x-algorithm's weighted_scorer.rs. */
  weightName: string;
  label: string;
  polarity: Polarity;
  group: "engage" | "amplify" | "attention" | "negative";
  /** Our default. Not xAI's — theirs are unpublished. */
  weight: number;
}

export const ACTIONS: ActionSpec[] = [
  { key: "favorite", weightName: "FAVORITE_WEIGHT", label: "Like", polarity: 1, group: "engage", weight: 0.5 },
  { key: "reply", weightName: "REPLY_WEIGHT", label: "Reply", polarity: 1, group: "engage", weight: 1.4 },
  { key: "retweet", weightName: "RETWEET_WEIGHT", label: "Repost", polarity: 1, group: "amplify", weight: 1.2 },
  { key: "quote", weightName: "QUOTE_WEIGHT", label: "Quote", polarity: 1, group: "amplify", weight: 1.1 },
  { key: "share", weightName: "SHARE_WEIGHT", label: "Share", polarity: 1, group: "amplify", weight: 1.6 },
  { key: "shareViaDm", weightName: "SHARE_VIA_DM_WEIGHT", label: "Share via DM", polarity: 1, group: "amplify", weight: 2.2 },
  { key: "shareViaCopyLink", weightName: "SHARE_VIA_COPY_LINK_WEIGHT", label: "Copy link", polarity: 1, group: "amplify", weight: 1.5 },
  { key: "click", weightName: "CLICK_WEIGHT", label: "Open post", polarity: 1, group: "attention", weight: 0.3 },
  { key: "profileClick", weightName: "PROFILE_CLICK_WEIGHT", label: "Open profile", polarity: 1, group: "attention", weight: 0.7 },
  { key: "quotedClick", weightName: "QUOTED_CLICK_WEIGHT", label: "Open quoted", polarity: 1, group: "attention", weight: 0.4 },
  { key: "photoExpand", weightName: "PHOTO_EXPAND_WEIGHT", label: "Expand photo", polarity: 1, group: "attention", weight: 0.25 },
  { key: "vqv", weightName: "VQV_WEIGHT", label: "Video quality view", polarity: 1, group: "attention", weight: 0.9 },
  { key: "dwell", weightName: "DWELL_WEIGHT", label: "Dwell", polarity: 1, group: "attention", weight: 0.45 },
  { key: "contDwellTime", weightName: "CONT_DWELL_TIME_WEIGHT", label: "Dwell time", polarity: 1, group: "attention", weight: 0.35 },
  { key: "followAuthor", weightName: "FOLLOW_AUTHOR_WEIGHT", label: "Follow author", polarity: 1, group: "engage", weight: 4 },
  { key: "notInterested", weightName: "NOT_INTERESTED_WEIGHT", label: "Not interested", polarity: -1, group: "negative", weight: -8 },
  { key: "muteAuthor", weightName: "MUTE_AUTHOR_WEIGHT", label: "Mute author", polarity: -1, group: "negative", weight: -14 },
  { key: "blockAuthor", weightName: "BLOCK_AUTHOR_WEIGHT", label: "Block author", polarity: -1, group: "negative", weight: -20 },
  { key: "report", weightName: "REPORT_WEIGHT", label: "Report", polarity: -1, group: "negative", weight: -30 },
];

export type WeightMap = Record<string, number>;

export const DEFAULT_WEIGHTS: WeightMap = Object.fromEntries(
  ACTIONS.map((a) => [a.key, a.weight]),
);

/** Real constant from the published scorer; the value itself is ours. */
export const NEGATIVE_SCORES_OFFSET = 1;
/** Video shorter than this does not earn the video-quality-view weight. */
export const MIN_VIDEO_DURATION_MS = 10_000;

// ── Corpus ───────────────────────────────────────────────────────────────

export interface Post {
  id: string;
  author: string;
  handle: string;
  text: string;
  /** Affinity with each signal axis, 0..1. The item tower's input. */
  topics: SignalVector;
  /** How much the post trades on outrage, threat, or certainty. 0..1. */
  outrage: number;
  /** Substantiated, checkable claims. 0..1. Deliberately never scored. */
  veracity: number;
  inNetwork: boolean;
  hasPhoto: boolean;
  videoDurationMs: number;
  ageMinutes: number;
}

function sig(
  interests: number,
  engagement: number,
  behavior: number,
  context: number,
  relationships: number,
  sentiment: number,
): SignalVector {
  return { interests, engagement, behavior, context, relationships, sentiment };
}

/**
 * A deliberately mixed corpus: the engagement-bait posts from the source
 * infographic sit alongside dry, well-sourced ones. That contrast is the
 * entire demonstration — watch which end of it the ranker rewards.
 */
export const CORPUS: Post[] = [
  {
    id: "p1", author: "Unmasked", handle: "@unmasked",
    text: "They don't want you to know this…",
    topics: sig(0.8, 0.95, 0.9, 0.5, 0.3, 0.98),
    outrage: 0.95, veracity: 0.05, inNetwork: false, hasPhoto: true,
    videoDurationMs: 0, ageMinutes: 40,
  },
  {
    id: "p2", author: "Truth Signal", handle: "@truthsignal",
    text: "The truth is finally out.",
    topics: sig(0.75, 0.9, 0.85, 0.45, 0.25, 0.95),
    outrage: 0.9, veracity: 0.08, inNetwork: false, hasPhoto: true,
    videoDurationMs: 0, ageMinutes: 65,
  },
  {
    id: "p3", author: "Awakened", handle: "@awakened",
    text: "WAKE UP. Everything is connected.",
    topics: sig(0.7, 0.92, 0.88, 0.4, 0.2, 0.97),
    outrage: 0.97, veracity: 0.03, inNetwork: false, hasPhoto: true,
    videoDurationMs: 0, ageMinutes: 22,
  },
  {
    id: "p4", author: "The Eye", handle: "@the_eye",
    text: "You've been lied to your entire life.",
    topics: sig(0.68, 0.9, 0.86, 0.42, 0.22, 0.96),
    outrage: 0.93, veracity: 0.04, inNetwork: false, hasPhoto: true,
    videoDurationMs: 0, ageMinutes: 95,
  },
  {
    id: "p5", author: "Patterns", handle: "@patterns",
    text: "Coincidence? I think not.",
    topics: sig(0.65, 0.88, 0.84, 0.38, 0.24, 0.94),
    outrage: 0.88, veracity: 0.06, inNetwork: false, hasPhoto: true,
    videoDurationMs: 0, ageMinutes: 130,
  },
  {
    id: "p6", author: "Dana Reeves", handle: "@danareeves",
    text: "Spent the weekend reading the Phoenix retrieval code. The two-tower split is the whole trick — user tower runs once, item tower is precomputed.",
    topics: sig(0.85, 0.4, 0.5, 0.6, 0.8, 0.25),
    outrage: 0.05, veracity: 0.92, inNetwork: true, hasPhoto: false,
    videoDurationMs: 0, ageMinutes: 55,
  },
  {
    id: "p7", author: "Ilya Roth", handle: "@ilyaroth",
    text: "Candidate isolation masking is the most underrated line in the repo. Your score doesn't depend on who you were batched with.",
    topics: sig(0.88, 0.35, 0.45, 0.55, 0.85, 0.2),
    outrage: 0.03, veracity: 0.95, inNetwork: true, hasPhoto: false,
    videoDurationMs: 0, ageMinutes: 88,
  },
  {
    id: "p8", author: "Marla Chen", handle: "@marlachen",
    text: "Walkthrough of the ranking stage, 12 minutes, no hype.",
    topics: sig(0.8, 0.45, 0.7, 0.5, 0.6, 0.3),
    outrage: 0.06, veracity: 0.88, inNetwork: false, hasPhoto: false,
    videoDurationMs: 720_000, ageMinutes: 150,
  },
  {
    id: "p9", author: "Night Shift", handle: "@nightshiftdev",
    text: "Shipped the thing at 3am. It works. Going to sleep.",
    topics: sig(0.5, 0.55, 0.6, 0.75, 0.7, 0.45),
    outrage: 0.02, veracity: 0.7, inNetwork: true, hasPhoto: false,
    videoDurationMs: 0, ageMinutes: 18,
  },
  {
    id: "p10", author: "Rage Index", handle: "@rageindex",
    text: "This is the most disgraceful thing I have seen all year. Everyone involved should be ashamed.",
    topics: sig(0.6, 0.94, 0.9, 0.35, 0.15, 0.99),
    outrage: 0.99, veracity: 0.2, inNetwork: false, hasPhoto: false,
    videoDurationMs: 0, ageMinutes: 12,
  },
  {
    id: "p11", author: "Quiet Data", handle: "@quietdata",
    text: "Charted six months of feed composition. In-network share fell from 41% to 22%. Method and data in the replies.",
    topics: sig(0.82, 0.4, 0.55, 0.6, 0.65, 0.3),
    outrage: 0.1, veracity: 0.96, inNetwork: false, hasPhoto: true,
    videoDurationMs: 0, ageMinutes: 200,
  },
  {
    id: "p12", author: "Sam Okoro", handle: "@samokoro",
    text: "Reminder that a recommender optimising 19 engagement heads is not optimising for whether the post is true. Those are different objectives.",
    topics: sig(0.78, 0.6, 0.6, 0.5, 0.75, 0.5),
    outrage: 0.25, veracity: 0.9, inNetwork: true, hasPhoto: false,
    videoDurationMs: 0, ageMinutes: 44,
  },
];

// ── The two towers ───────────────────────────────────────────────────────

function dot(a: SignalVector, b: SignalVector): number {
  return SIGNAL_AXES.reduce((sum, axis) => sum + a[axis] * b[axis], 0);
}

function norm(v: SignalVector): number {
  return Math.sqrt(SIGNAL_AXES.reduce((sum, axis) => sum + v[axis] * v[axis], 0));
}

/**
 * Retrieval score — cosine similarity between the user embedding and the item
 * embedding, which is what the published two-tower stage computes before
 * top-K selection.
 */
export function retrievalScore(user: SignalVector, post: Post): number {
  const d = norm(user) * norm(post.topics);
  return d === 0 ? 0 : dot(user, post.topics) / d;
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export type Predictions = Record<string, number>;

/**
 * The ranking head, as a legible feature function.
 *
 * Each of the 19 probabilities is driven by the features that plausibly drive
 * it in the real thing. The important property — and it is not editorialising,
 * it falls out of the head list — is that `veracity` appears in none of them.
 * There is no head for "is this true".
 */
export function predictActions(user: SignalVector, post: Post): Predictions {
  const relevance = retrievalScore(user, post);
  const heat = post.outrage * user.sentiment;
  const social = user.relationships * (post.inNetwork ? 1 : 0.35);
  const attentive = user.behavior;
  const active = user.engagement;
  const recency = clamp01(1 - post.ageMinutes / 480);

  const p = (x: number) => clamp01(sigmoid(x));

  return {
    favorite: p(relevance * 3.2 + active * 1.4 + heat * 1.1 - 2.2),
    // Reply is the classic outrage head: disagreement is a reply, not a like.
    reply: p(heat * 3.4 + active * 1.2 + relevance * 0.8 - 2.8),
    retweet: p(relevance * 2.4 + heat * 2.0 + active - 3.0),
    quote: p(heat * 2.6 + active * 0.9 - 3.2),
    share: p(relevance * 2.0 + heat * 1.6 - 3.4),
    shareViaDm: p(heat * 1.9 + social * 1.2 - 3.6),
    shareViaCopyLink: p(relevance * 1.6 + heat * 1.2 - 3.8),
    click: p(relevance * 2.6 + attentive * 1.2 + heat * 0.9 - 1.8),
    profileClick: p(social * 2.2 + relevance * 1.1 - 2.6),
    quotedClick: p(heat * 1.4 + attentive * 0.8 - 3.0),
    photoExpand: post.hasPhoto ? p(attentive * 2.0 + relevance * 1.2 - 1.9) : 0,
    vqv: post.videoDurationMs > MIN_VIDEO_DURATION_MS
      ? p(attentive * 2.4 + relevance * 1.4 - 1.7)
      : 0,
    dwell: p(attentive * 2.6 + heat * 1.5 + relevance * 1.2 - 1.9),
    contDwellTime: p(attentive * 2.2 + heat * 1.3 + relevance * 1.0 - 2.1),
    followAuthor: p(relevance * 2.0 + social * 1.4 - 4.2),
    // Negative heads: the only brake, and outrage trips them far more weakly
    // than it trips reply and dwell.
    notInterested: p(-relevance * 2.6 + post.outrage * 1.5 - 2.4),
    muteAuthor: p(post.outrage * 1.7 - relevance * 1.8 - 3.4),
    blockAuthor: p(post.outrage * 1.6 - relevance * 1.6 - 4.0),
    report: p(post.outrage * 1.5 - 4.6),
    // Recency is applied in selection rather than as a head; kept here so the
    // UI can show it.
    __recency: recency,
  };
}

/**
 * The published combine step from `weighted_scorer.rs`:
 *
 *   combined = Σ apply(score_i, WEIGHT_i)
 *   if combined < 0 → (combined + NEGATIVE_WEIGHTS_SUM) / WEIGHTS_SUM * OFFSET
 *   else            → combined + OFFSET
 *   if WEIGHTS_SUM == 0 → max(combined, 0)
 *
 * The branch matters: it squashes negatives into a small positive band rather
 * than letting them run away, so a post has to be *actively* reported to be
 * buried — mild dislike barely registers.
 */
export function combinedScore(preds: Predictions, weights: WeightMap): number {
  let combined = 0;
  for (const action of ACTIONS) {
    combined += (preds[action.key] ?? 0) * (weights[action.key] ?? 0);
  }

  const values = ACTIONS.map((a) => weights[a.key] ?? 0);
  const weightsSum = values.reduce((s, w) => s + Math.abs(w), 0);
  const negativeWeightsSum = values
    .filter((w) => w < 0)
    .reduce((s, w) => s + Math.abs(w), 0);

  if (weightsSum === 0) return Math.max(combined, 0);

  return combined < 0
    ? ((combined + negativeWeightsSum) / weightsSum) * NEGATIVE_SCORES_OFFSET
    : combined + NEGATIVE_SCORES_OFFSET;
}

export interface Ranked {
  post: Post;
  retrieval: number;
  predictions: Predictions;
  score: number;
  /** Score after the author-diversity penalty in the selection stage. */
  finalScore: number;
}

/** Retrieval → ranking → author-diversity decay → sort. The whole pipeline. */
export function rankFeed(
  user: SignalVector,
  weights: WeightMap,
  corpus: Post[] = CORPUS,
  topK = corpus.length,
): Ranked[] {
  const retrieved = corpus
    .map((post) => ({ post, retrieval: retrievalScore(user, post) }))
    .sort((a, b) => b.retrieval - a.retrieval)
    .slice(0, topK);

  const scored: Ranked[] = retrieved.map(({ post, retrieval }) => {
    const predictions = predictActions(user, post);
    const score = combinedScore(predictions, weights);
    return { post, retrieval, predictions, score, finalScore: score };
  });

  scored.sort((a, b) => b.score - a.score);

  // Author diversity: each repeat from the same author is decayed, which is
  // why the feed alternates voices instead of stacking one account.
  const seen = new Map<string, number>();
  for (const item of scored) {
    const n = seen.get(item.post.handle) ?? 0;
    item.finalScore = item.score * Math.pow(0.6, n);
    seen.set(item.post.handle, n + 1);
  }

  return scored.sort((a, b) => b.finalScore - a.finalScore);
}

export const STAGES = [
  {
    id: "signals",
    name: "Signals",
    caption: "Grok analyses billions of signals to understand what keeps you engaged.",
  },
  {
    id: "retrieval",
    name: "Retrieval",
    caption: "Two towers. Your history becomes one embedding, every post becomes another. Dot product, top-K, millions down to hundreds.",
  },
  {
    id: "ranking",
    name: "Ranking",
    caption: "A Grok-derived transformer scores the survivors. Candidates attend to you and to your history — never to each other.",
  },
  {
    id: "heads",
    name: "19 heads",
    caption: "One forward pass predicts nineteen actions at once. Fifteen reward attention. Four punish it. None ask whether the post is true.",
  },
  {
    id: "feed",
    name: "For You",
    caption: "Weighted sum, author-diversity decay, sort. This is your feed.",
  },
] as const;

export type StageId = (typeof STAGES)[number]["id"];
