/**
 * Social Command Center data model.
 *
 * The interesting idea on this screen is not the follower count — it is the
 * *goal loop*: a standing objective the Social agent runs on a cadence, with
 * an explicit autonomy level saying how far it may go before a human is
 * required. That is what makes it a workforce rather than a scheduler.
 */

export type Autonomy = "draft" | "approve" | "full";

export interface Platform {
  id: string;
  name: string;
  handle: string;
  connected: boolean;
  followers: number;
  /** Reach over the trailing 30 days. */
  reach30d: number;
  /** Percentage change on the previous 30 days. */
  delta: number;
  /** Brand accent, used only as a hairline so the HUD stays coherent. */
  accent: string;
  url: string;
}

export interface LoopStage {
  label: string;
  state: "done" | "active" | "queued" | "gated";
}

export interface GoalLoop {
  id: string;
  name: string;
  objective: string;
  cadence: string;
  autonomy: Autonomy;
  owner: string;
  stages: LoopStage[];
  nextRun: string;
}

export interface Attention {
  id: string;
  severity: "info" | "action";
  text: string;
}

export const AUTONOMY_COPY: Record<Autonomy, { label: string; detail: string }> = {
  draft: {
    label: "Draft only",
    detail: "Thor prepares the work and stops. Nothing leaves without you.",
  },
  approve: {
    label: "Approve to ship",
    detail: "Thor runs the whole loop and waits at the final gate for a yes.",
  },
  full: {
    label: "Full autonomy",
    detail: "Thor runs and publishes inside the guardrails, then reports back.",
  },
};

export const PLATFORMS: Platform[] = [
  {
    id: "instagram",
    name: "Instagram",
    handle: "@reznikov_engineering",
    connected: true,
    followers: 6100,
    reach30d: 2400,
    delta: 12.4,
    accent: "#e1467c",
    url: "https://instagram.com",
  },
  {
    id: "facebook",
    name: "Facebook",
    handle: "Reznikov Engineering",
    connected: true,
    followers: 10900,
    reach30d: 18700,
    delta: 4.1,
    accent: "#4b7bec",
    url: "https://facebook.com",
  },
  {
    id: "linkedin",
    name: "LinkedIn",
    handle: "reznikov-engineering",
    connected: true,
    followers: 3800,
    reach30d: 9100,
    delta: -2.3,
    accent: "#3fb0d6",
    url: "https://linkedin.com",
  },
];

export const GOAL_LOOPS: GoalLoop[] = [
  {
    id: "weekly-content",
    name: "Weekly content plan",
    objective: "Three build-in-public posts a week, in the operator's own voice.",
    cadence: "Mondays, 07:00",
    autonomy: "approve",
    owner: "social",
    stages: [
      { label: "Mine", state: "done" },
      { label: "Plan", state: "done" },
      { label: "Draft", state: "active" },
      { label: "Review", state: "gated" },
      { label: "Post", state: "queued" },
    ],
    nextRun: "Monday 07:00",
  },
  {
    id: "comment-triage",
    name: "Comment triage",
    objective: "Every comment read, sorted, and answered or escalated within an hour.",
    cadence: "Hourly",
    autonomy: "full",
    owner: "social",
    stages: [
      { label: "Fetch", state: "done" },
      { label: "Sort", state: "done" },
      { label: "Draft", state: "done" },
      { label: "Reply", state: "active" },
      { label: "Log", state: "queued" },
    ],
    nextRun: "in 24 minutes",
  },
  {
    id: "inbound-leads",
    name: "Inbound to pipeline",
    objective: "Turn a DM that smells like work into a qualified lead with a next step.",
    cadence: "On arrival",
    autonomy: "draft",
    owner: "sales",
    stages: [
      { label: "Detect", state: "done" },
      { label: "Qualify", state: "active" },
      { label: "Enrich", state: "queued" },
      { label: "Draft", state: "queued" },
      { label: "Hand off", state: "gated" },
    ],
    nextRun: "on arrival",
  },
];

export const ATTENTION: Attention[] = [
  {
    id: "a1",
    severity: "action",
    text: "Weekly content plan has 3 drafts waiting on your yes before Monday.",
  },
];

export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
