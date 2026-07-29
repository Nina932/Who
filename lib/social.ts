/**
 * Social Command Center data model.
 *
 * Channel figures only. The loops on this screen are the REAL ones from
 * `lib/loops.ts`, fetched through /api/loops — there is deliberately no second
 * loop model here, because two of them meant the screen showed theatre while
 * the engine ran elsewhere.
 *
 * The follower/reach numbers below are sample data and are labelled as such in
 * the UI: there are no channel connectors yet, so there is nothing real to
 * show. See the end of docs/ENGINE.md.
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

export interface Attention {
  id: string;
  severity: "info" | "action";
  text: string;
}

export const AUTONOMY_COPY: Record<Autonomy, { label: string; detail: string }> = {
  draft: {
    label: "Draft only",
    detail: "Morpheus prepares the work and stops. Nothing leaves without you.",
  },
  approve: {
    label: "Approve to ship",
    detail: "Morpheus runs the whole loop and waits at the final gate for a yes.",
  },
  full: {
    label: "Full autonomy",
    detail: "Morpheus runs and publishes inside the guardrails, then reports back.",
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
