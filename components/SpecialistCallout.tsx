"use client";

/**
 * Specialist Attendance, announced.
 *
 * When the orchestrator pulls an expert into the conversation the operator
 * gets told — who came in, and which words in their own sentence caused it.
 * Showing the trigger is the difference between a system that feels
 * intelligent and one that feels arbitrary.
 */

import { AGENTS_BY_ID, FAMILY_LABEL } from "@/lib/agents";

export interface SpecialistCalloutProps {
  primaryId: string | null;
  supportingIds: string[];
  triggers: string[];
  active: boolean;
}

export default function SpecialistCallout({
  primaryId,
  supportingIds,
  triggers,
  active,
}: SpecialistCalloutProps) {
  const agent = primaryId ? AGENTS_BY_ID[primaryId] : null;
  if (!agent || !active) return null;

  const supporting = supportingIds
    .map((id) => AGENTS_BY_ID[id]?.name)
    .filter(Boolean) as string[];

  return (
    <div
      key={primaryId}
      className="rise-in pointer-events-none absolute left-8 top-1/2 z-20 max-w-[300px] -translate-y-1/2"
    >
      <div className="flex items-center gap-2">
        <span
          className="pulse-soft"
          style={{
            width: 6,
            height: 6,
            borderRadius: 999,
            background: "var(--color-attend)",
            boxShadow: "0 0 10px var(--color-attend)",
          }}
        />
        <span className="label" style={{ color: "var(--color-attend)" }}>
          Live
        </span>
      </div>

      <div
        className="mt-3 font-semibold uppercase"
        style={{
          fontSize: 30,
          lineHeight: 1.05,
          letterSpacing: "0.01em",
          fontFamily: "var(--font-display)",
          color: "var(--color-ink)",
          textShadow: "0 0 26px rgba(242,193,78,0.35)",
        }}
      >
        Specialist
        <br />
        attendance
      </div>

      <div className="mt-4 h-px w-16" style={{ background: "var(--color-attend-dim)" }} />

      <div className="mt-4">
        <div
          className="text-[17px] font-semibold"
          style={{ color: "var(--color-attend)", fontFamily: "var(--font-display)" }}
        >
          {agent.name}
        </div>
        <div className="label mt-1.5">{FAMILY_LABEL[agent.family]}</div>
        <p className="mt-3 text-[12px] leading-relaxed" style={{ color: "var(--color-ink-soft)" }}>
          {agent.role}
        </p>
      </div>

      {triggers.length > 0 ? (
        <div className="mt-4">
          <div className="label">Called in on</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {triggers.slice(0, 3).map((t) => (
              <span
                key={t}
                className="chip-attend px-2 py-1 text-[10px]"
                style={{ color: "var(--color-attend)" }}
              >
                {t}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {supporting.length > 0 ? (
        <p className="mt-4 text-[11px]" style={{ color: "var(--color-ink-faint)" }}>
          Consulting {supporting.join(" · ")}
        </p>
      ) : null}
    </div>
  );
}
