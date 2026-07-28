"use client";

/**
 * Clicking a node opens its charter.
 *
 * The roster is only trustworthy if the operator can audit it — what each
 * seat owns, and the vocabulary that will cause it to be called in. This
 * panel is that audit surface.
 */

import { AGENTS_BY_ID, FAMILY_LABEL } from "@/lib/agents";

export interface AgentInspectorProps {
  agentId: string | null;
  onClose: () => void;
  onSummon: (agentId: string) => void;
}

export default function AgentInspector({ agentId, onClose, onSummon }: AgentInspectorProps) {
  const agent = agentId ? AGENTS_BY_ID[agentId] : null;
  if (!agent) return null;

  const summonable = agent.family === "council" || agent.family === "operations";

  return (
    <div className="rise-in pointer-events-auto absolute bottom-28 left-1/2 z-40 w-[440px] max-w-[calc(100vw-4rem)] -translate-x-1/2">
      <div className="panel rounded-xl p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div
              className="text-[19px] font-semibold"
              style={{ color: "var(--color-ink)", fontFamily: "var(--font-display)" }}
            >
              {agent.name}
            </div>
            <div className="label-lit mt-2">{FAMILY_LABEL[agent.family]}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="label transition-colors hover:text-[color:var(--color-signal)]"
          >
            Close
          </button>
        </div>

        <p
          className="mt-4 text-[13px] leading-[1.65]"
          style={{ color: "var(--color-ink-soft)" }}
        >
          {agent.charter}
        </p>

        <div className="mt-5">
          <div className="label">Attends on</div>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {agent.domains.slice(0, 8).map((d) => (
              <span
                key={d}
                className="chip px-2 py-1 text-[10px]"
                style={{ color: "var(--color-ink-soft)" }}
              >
                {d}
              </span>
            ))}
          </div>
        </div>

        {summonable ? (
          <button
            type="button"
            onClick={() => onSummon(agent.id)}
            className="chip mt-5 w-full py-2.5 label-lit transition-colors hover:bg-[rgba(63,224,240,0.12)]"
          >
            Call {agent.name} in
          </button>
        ) : (
          <p className="mt-5 text-[11px]" style={{ color: "var(--color-ink-faint)" }}>
            Integrations are reached through agents rather than addressed directly.
          </p>
        )}
      </div>
    </div>
  );
}
