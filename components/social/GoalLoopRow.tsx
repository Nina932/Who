"use client";

import { AGENTS_BY_ID } from "@/lib/agents";
import { AUTONOMY_COPY, type GoalLoop, type LoopStage } from "@/lib/social";

/**
 * A standing objective rendered as its pipeline.
 *
 * The stage chips carry the whole story: what has run, what is running, and —
 * critically — where the loop will stop and wait for a human. A `gated` stage
 * is drawn in the attention colour because that is the only kind of stage
 * that will ever cost the operator time.
 */

const STAGE_STYLE: Record<LoopStage["state"], { border: string; text: string; fill: string }> = {
  done: {
    border: "rgba(63,224,240,0.32)",
    text: "var(--color-signal-dim)",
    fill: "rgba(63,224,240,0.05)",
  },
  active: {
    border: "rgba(63,224,240,0.85)",
    text: "var(--color-signal)",
    fill: "rgba(63,224,240,0.14)",
  },
  gated: {
    border: "rgba(242,193,78,0.7)",
    text: "var(--color-attend)",
    fill: "rgba(242,193,78,0.1)",
  },
  queued: {
    border: "rgba(146,171,182,0.18)",
    text: "var(--color-ink-faint)",
    fill: "transparent",
  },
};

export default function GoalLoopRow({ loop }: { loop: GoalLoop }) {
  const owner = AGENTS_BY_ID[loop.owner];
  const autonomy = AUTONOMY_COPY[loop.autonomy];

  return (
    <div className="panel rounded-xl p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <span
              className="pulse-soft"
              style={{
                width: 6,
                height: 6,
                borderRadius: 999,
                background: "var(--color-alive)",
                boxShadow: "0 0 8px var(--color-alive)",
              }}
            />
            <span
              className="text-[14px] font-semibold"
              style={{ color: "var(--color-ink)", fontFamily: "var(--font-display)" }}
            >
              {loop.name}
            </span>
          </div>
          <p
            className="mt-2.5 max-w-[54ch] text-[12px] leading-relaxed"
            style={{ color: "var(--color-ink-soft)" }}
          >
            {loop.objective}
          </p>
        </div>

        <div className="text-right">
          <span
            className={loop.autonomy === "full" ? "chip px-3 py-1.5" : "chip-attend px-3 py-1.5"}
            style={{
              fontSize: 10,
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              color:
                loop.autonomy === "full" ? "var(--color-signal)" : "var(--color-attend)",
            }}
          >
            {autonomy.label}
          </span>
          <div className="label mt-2.5">Next · {loop.nextRun}</div>
        </div>
      </div>

      {/* The pipeline */}
      <div className="mt-5 flex flex-wrap items-center gap-1.5">
        {loop.stages.map((stage, i) => {
          const style = STAGE_STYLE[stage.state];
          return (
            <div key={stage.label} className="flex items-center gap-1.5">
              <span
                className={`rounded-md border px-2.5 py-1.5 text-[10px] uppercase tracking-[0.16em] ${
                  stage.state === "active" ? "pulse-soft" : ""
                }`}
                style={{
                  borderColor: style.border,
                  color: style.text,
                  background: style.fill,
                }}
              >
                {stage.label}
              </span>
              {i < loop.stages.length - 1 ? (
                <span style={{ color: "var(--color-ink-faint)", fontSize: 10 }}>–</span>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2">
        <span className="label">Owner · {owner?.name ?? loop.owner}</span>
        <span className="label">Cadence · {loop.cadence}</span>
        <span className="label" style={{ color: "var(--color-ink-faint)" }}>
          {autonomy.detail}
        </span>
      </div>
    </div>
  );
}
