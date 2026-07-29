/**
 * Social Command Center data model.
 *
 * Channel figures only. The loops on this screen are the REAL ones from
 * `lib/loops.ts`, fetched through /api/loops — there is deliberately no second
 * loop model here, because two of them meant the screen showed theatre while
 * the engine ran elsewhere.
 *
 * Identity and metrics are intentionally absent here. They appear only after
 * a connector proves a real account read; invented handles and sample figures
 * are more misleading than an explicit disconnected state.
 */

export type Autonomy = "draft" | "approve" | "full";

export interface Platform {
  id: string;
  name: string;
  connectorId?: string;
  /** A free browser handoff when the provider API itself is paid or unavailable. */
  manualUrl?: string;
  manualLabel?: string;
  /** Brand accent, used only as a hairline so the HUD stays coherent. */
  accent: string;
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
    id: "x",
    name: "X",
    manualUrl: "https://x.com/compose/post",
    manualLabel: "Compose on X",
    accent: "#dbeef4",
  },
  {
    id: "facebook",
    name: "Facebook",
    connectorId: "facebook-profile",
    accent: "#4b7bec",
  },
  {
    id: "linkedin",
    name: "LinkedIn",
    connectorId: "linkedin",
    accent: "#3fb0d6",
  },
];
