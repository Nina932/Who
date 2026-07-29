"use client";

/**
 * A real loop, on the Social screen.
 *
 * This renders a `LoopDefinition` from `lib/loops.ts` together with its actual
 * latest run — status, per-step artefacts, and the GO gate. It is the same
 * engine the /loops workspace drives; this screen is just a narrower window
 * onto the loops the Social agent owns.
 */

import { useState } from "react";
import { AGENTS_BY_ID } from "@/lib/agents";
import type { LoopDefinition, LoopRun } from "@/lib/loops";

export interface LoopCardProps {
  loop: LoopDefinition;
  run?: LoopRun;
  learningCount: number;
  busy: boolean;
  onStart: () => void;
  onApprove: (note: string) => void;
  onReject: (note: string) => void;
}

/** Colour a step by where the run has actually got to. */
function stepStyle(index: number, run: LoopRun | undefined, isGate: boolean) {
  if (!run) {
    return isGate
      ? { border: "rgba(242,193,78,0.5)", color: "var(--color-attend)", fill: "transparent" }
      : { border: "rgba(146,171,182,0.18)", color: "var(--color-ink-faint)", fill: "transparent" };
  }
  if (index < run.stepIndex) {
    return { border: "rgba(63,224,240,0.32)", color: "var(--color-signal-dim)", fill: "rgba(63,224,240,0.05)" };
  }
  if (index === run.stepIndex) {
    return run.status === "awaiting-go"
      ? { border: "rgba(242,193,78,0.7)", color: "var(--color-attend)", fill: "rgba(242,193,78,0.1)" }
      : { border: "rgba(63,224,240,0.85)", color: "var(--color-signal)", fill: "rgba(63,224,240,0.14)" };
  }
  return { border: "rgba(146,171,182,0.18)", color: "var(--color-ink-faint)", fill: "transparent" };
}

export default function LoopCard({
  loop,
  run,
  learningCount,
  busy,
  onStart,
  onApprove,
  onReject,
}: LoopCardProps) {
  const [note, setNote] = useState("");
  const owner = AGENTS_BY_ID[loop.ownerAgentId];
  const gated = run?.status === "awaiting-go";

  return (
    <div
      className="panel rounded-xl p-5"
      style={gated ? { borderColor: "rgba(242,193,78,0.35)" } : undefined}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <span
              className={gated ? "pulse-soft" : ""}
              style={{
                width: 6,
                height: 6,
                borderRadius: 999,
                background: gated ? "var(--color-attend)" : "var(--color-alive)",
                boxShadow: `0 0 8px ${gated ? "var(--color-attend)" : "var(--color-alive)"}`,
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

        <button
          type="button"
          onClick={onStart}
          disabled={busy}
          className="chip px-4 py-2 label-lit disabled:opacity-40"
        >
          {busy ? "Working…" : "Run now"}
        </button>
      </div>

      {/* The pipeline, coloured by the run's real position. */}
      <div className="mt-5 flex flex-wrap items-center gap-1.5">
        {loop.steps.map((step, i) => {
          const style = stepStyle(i, run, step.kind === "gate");
          const active = run && i === run.stepIndex && run.status === "running";
          return (
            <div key={step.id} className="flex items-center gap-1.5">
              <span
                className={`rounded-md border px-2.5 py-1.5 text-[10px] uppercase tracking-[0.16em] ${active ? "pulse-soft" : ""}`}
                style={{ borderColor: style.border, color: style.color, background: style.fill }}
              >
                {step.name}
              </span>
              {i < loop.steps.length - 1 ? (
                <span style={{ color: "var(--color-ink-faint)", fontSize: 10 }}>–</span>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2">
        <span className="label">Owner · {owner?.name ?? loop.ownerAgentId}</span>
        <span className="label">Cadence · {loop.cadence}</span>
        <span className="label">Learned · {learningCount}</span>
        {run?.status === "failed" ? (
          <span className="label" style={{ color: "var(--color-alert)" }}>
            {run.error}
          </span>
        ) : null}
      </div>

      {/* The gate, in place — no need to leave for the workspace. */}
      {gated && run ? (
        <div className="mt-5 border-t pt-5" style={{ borderColor: "rgba(242,193,78,0.2)" }}>
          <div className="label" style={{ color: "var(--color-attend)" }}>
            Waiting on you
          </div>

          <div className="mt-3 space-y-4">
            {run.artifacts.map((artifact) => (
              <div key={`${artifact.stepId}-${artifact.at}`}>
                <div className="label">
                  {artifact.stepName} · {artifact.model}
                </div>
                <p
                  className="mt-2 whitespace-pre-wrap text-[12.5px] leading-[1.65]"
                  style={{ color: "var(--color-ink)" }}
                >
                  {artifact.text}
                </p>
              </div>
            ))}
          </div>

          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="Optional on approval. Required to reject — the reason is what the loop learns from."
            className="panel mt-4 w-full rounded-lg p-3 text-[12px] outline-none"
            style={{ color: "var(--color-ink)", background: "rgba(4,7,10,0.6)" }}
          />

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                onApprove(note);
                setNote("");
              }}
              className="chip-attend px-5 py-2.5 label disabled:opacity-40"
              style={{ color: "var(--color-attend)" }}
            >
              GO
            </button>
            <button
              type="button"
              disabled={busy || !note.trim()}
              onClick={() => {
                onReject(note);
                setNote("");
              }}
              className="chip px-5 py-2.5 label disabled:opacity-30"
              style={{ color: "var(--color-alert)" }}
              title={note.trim() ? undefined : "Add a reason first"}
            >
              Reject
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
