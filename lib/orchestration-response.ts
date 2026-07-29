import { AGENTS_BY_ID } from "./agents";
import { scoreAgents } from "./orchestrator";

const ACTIONS: Record<string, string> = {
  "chief-of-staff":
    "sequence the work, keep the decision log, expose blockers, and close the loop",
  strategist:
    "set the decision criteria, positioning, trade-offs, and what would stop the bet",
  researcher:
    "collect the evidence and source the unknowns before they become assumptions",
  editor:
    "set the quality bar and run the final coherence check before anything ships",
  marketing:
    "define the audience, launch narrative, campaign assets, and channel sequence",
  sales:
    "define the customer motion, objections, qualification path, and follow-up",
  social:
    "adapt approved messaging into channel-specific drafts and an approval queue",
  engineering:
    "define technical scope, dependencies, verification, rollout, and rollback",
  developer:
    "turn the approved technical scope into implementation tasks and evidence",
  design:
    "define the user flow, interaction states, visual handoff, and acceptance criteria",
  ops:
    "define operational readiness, ownership, monitoring, and incident handling",
  finance:
    "identify the real cost, runway effect, and approval boundary without inventing a budget",
  analytics:
    "define success measures, baselines, instrumentation, and the review point",
};

function objectiveFrom(utterance: string): string {
  const stripped = utterance
    .replace(/^\s*morpheus[,\s]*/i, "")
    .replace(
      /\b(?:take (?:the )?lead and |please )?(?:orchestrate|coordinate|lead|run|manage)\b/i,
      "",
    )
    .replace(/^\s*(?:this|the task)\s*[:,-]?\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.?!]+$/, "");
  return stripped || "the requested work";
}

function capabilityIds(utterance: string): string[] {
  const ranked = [...scoreAgents(utterance).entries()]
    .sort((left, right) => right[1].score - left[1].score)
    .map(([id]) => id)
    .filter((id) => ACTIONS[id])
    .slice(0, 4);
  if (!ranked.includes("chief-of-staff")) ranked.unshift("chief-of-staff");
  return ranked.slice(0, 5);
}

/**
 * Explicit orchestration is a control command, not an invitation for the model
 * to role-play a staff. Render the command brief from registered capabilities
 * so ownership is clear and no imaginary kickoff, budget, or capacity appears.
 */
export function orchestrationReply(utterance: string): string {
  const ids = capabilityIds(utterance);
  const specialists = ids.filter((id) => id !== "chief-of-staff");
  const sequence = specialists.length ? specialists : ["chief-of-staff"];
  const assignments = sequence.map((id, index) => {
    const name = AGENTS_BY_ID[id]?.name ?? id;
    return `${index + 1}. ${name}: ${ACTIONS[id]}.`;
  });
  if (specialists.length) {
    assignments.push(
      `${assignments.length + 1}. Chief of staff: ${ACTIONS["chief-of-staff"]}.`,
    );
  }

  const first = AGENTS_BY_ID[sequence[0]]?.name ?? "Chief of staff";
  return [
    `Objective: ${objectiveFrom(utterance)}.`,
    "Command sequence:",
    ...assignments,
    `Dependencies: each downstream capability works from the verified output of the step before it; unresolved owner names, dates, capacity, and budget stay explicitly unset.`,
    `Immediate next move: ${first} owns the first proposed work packet; Morpheus owns coordination and synthesis.`,
    "Execution receipt: this response assigned and sequenced the work only. Nothing was scheduled, sent, published, or started.",
  ].join("\n");
}
