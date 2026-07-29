"use client";

/**
 * The Loops workspace.
 *
 * A real control surface over `lib/loops.ts`: start a run, watch each step's
 * artefact land, give or withhold the GO, record what actually happened, and
 * read the learnings the engine derived from it.
 *
 * The gate is the centre of the screen because it is the centre of the idea.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { Learning, LoopDefinition, LoopRun } from "@/lib/loops";

interface Payload {
  loops: LoopDefinition[];
  runs: LoopRun[];
  learnings: Learning[];
}

const STATUS_COPY: Record<LoopRun["status"], { label: string; color: string }> = {
  running: { label: "Running", color: "var(--color-signal)" },
  "awaiting-go": { label: "Awaiting your GO", color: "var(--color-attend)" },
  completed: { label: "Completed", color: "var(--color-alive)" },
  rejected: { label: "Rejected", color: "var(--color-alert)" },
  failed: { label: "Failed", color: "var(--color-alert)" },
};

export default function LoopsPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [outcome, setOutcome] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/loops", { cache: "no-store" });
      if (!response.ok) throw new Error(`Engine returned ${response.status}`);
      setData((await response.json()) as Payload);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not reach the Loops Engine.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(
    async (body: Record<string, unknown>, key: string) => {
      setBusy(key);
      setError(null);
      try {
        const response = await fetch("/api/loops", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const payload = (await response.json()) as { error?: string };
        if (!response.ok) throw new Error(payload.error ?? `Engine returned ${response.status}`);
        setNote("");
        setOutcome("");
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Action failed.");
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const runs = data?.runs ?? [];
  const gated = runs.filter((r) => r.status === "awaiting-go");

  return (
    <main className="h-screen w-screen overflow-y-auto">
      <div className="mx-auto max-w-[1100px] px-8 pb-24 pt-6">
        <div className="relative mb-7 h-px w-full overflow-hidden">
          <div className="rule absolute inset-0 opacity-40" />
          <div
            className="scan-sweep absolute top-0 h-px w-1/4"
            style={{
              background: "linear-gradient(90deg, transparent, var(--color-signal), transparent)",
              boxShadow: "0 0 10px var(--color-signal)",
            }}
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <Link href="/" className="chip px-3 py-1.5 label transition-colors hover:text-[color:var(--color-signal)]">
              ← Morpheus
            </Link>
            <h1
              className="uppercase"
              style={{
                fontSize: 15,
                letterSpacing: "0.28em",
                color: "var(--color-signal)",
                fontFamily: "var(--font-display)",
                textShadow: "0 0 20px rgba(63,224,240,0.4)",
              }}
            >
              Loops Engine
            </h1>
          </div>
          <button type="button" onClick={() => void load()} className="chip px-3 py-1.5 label">
            Refresh
          </button>
        </div>

        <p className="mt-5 max-w-[68ch] text-[13px] leading-relaxed" style={{ color: "var(--color-ink-soft)" }}>
          Semi-autonomous workflows. Each runs its steps on the model assigned to that
          step, stops at the review gate, and — once you say what happened — derives
          learnings that are injected into the next run.
        </p>

        {error ? (
          <div className="panel mt-5 rounded-xl p-4" style={{ borderColor: "rgba(255,107,107,0.4)" }}>
            <span className="text-[12px]" style={{ color: "var(--color-alert)" }}>
              {error}
            </span>
          </div>
        ) : null}

        {/* Anything waiting on a human comes first. */}
        {gated.length > 0 ? (
          <section className="mt-9">
            <div className="label-lit" style={{ color: "var(--color-attend)" }}>
              Needs your GO
            </div>
            <div className="mt-3 space-y-4">
              {gated.map((run) => {
                const loop = data?.loops.find((l) => l.id === run.loopId);
                return (
                  <div key={run.id} className="panel rounded-xl p-5" style={{ borderColor: "rgba(242,193,78,0.35)" }}>
                    <div className="flex items-center justify-between gap-4">
                      <span
                        className="text-[14px] font-semibold"
                        style={{ color: "var(--color-ink)", fontFamily: "var(--font-display)" }}
                      >
                        {loop?.name ?? run.loopId}
                      </span>
                      <span className="label" style={{ color: "var(--color-attend)" }}>
                        Held at step {run.stepIndex + 1}
                      </span>
                    </div>

                    <div className="mt-4 space-y-4">
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
                      placeholder="Optional note on approval — required if you reject, because that is what the loop learns from."
                      rows={2}
                      className="panel mt-5 w-full rounded-lg p-3 text-[12px] outline-none"
                      style={{ color: "var(--color-ink)", background: "rgba(4,7,10,0.6)" }}
                    />

                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void act({ action: "approve", runId: run.id, note }, run.id)}
                        className="chip-attend px-5 py-2.5 label disabled:opacity-40"
                        style={{ color: "var(--color-attend)" }}
                      >
                        {busy === run.id ? "Running…" : "GO"}
                      </button>
                      <button
                        type="button"
                        disabled={busy !== null || !note.trim()}
                        onClick={() => void act({ action: "reject", runId: run.id, note }, run.id)}
                        className="chip px-5 py-2.5 label disabled:opacity-30"
                        style={{ color: "var(--color-alert)" }}
                        title={note.trim() ? undefined : "Add a reason first"}
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}

        {/* The loop catalogue */}
        <section className="mt-9">
          <div className="label-lit">Loops</div>
          <div className="mt-3 space-y-4">
            {(data?.loops ?? []).map((loop) => {
              const loopRuns = runs.filter((r) => r.loopId === loop.id);
              const learnings = (data?.learnings ?? []).filter((l) => l.loopId === loop.id);
              return (
                <div key={loop.id} className="panel rounded-xl p-5">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <div
                        className="text-[14px] font-semibold"
                        style={{ color: "var(--color-ink)", fontFamily: "var(--font-display)" }}
                      >
                        {loop.name}
                      </div>
                      <p className="mt-2 max-w-[60ch] text-[12px] leading-relaxed" style={{ color: "var(--color-ink-soft)" }}>
                        {loop.objective}
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void act({ action: "start", loopId: loop.id }, loop.id)}
                      className="chip px-4 py-2 label-lit disabled:opacity-40"
                    >
                      {busy === loop.id ? "Starting…" : "Run now"}
                    </button>
                  </div>

                  <div className="mt-4 flex flex-wrap items-center gap-1.5">
                    {loop.steps.map((step, i) => (
                      <div key={step.id} className="flex items-center gap-1.5">
                        <span
                          className="rounded-md border px-2.5 py-1.5 text-[10px] uppercase tracking-[0.16em]"
                          style={{
                            borderColor:
                              step.kind === "gate"
                                ? "rgba(242,193,78,0.6)"
                                : "rgba(63,224,240,0.3)",
                            color:
                              step.kind === "gate" ? "var(--color-attend)" : "var(--color-signal-dim)",
                          }}
                        >
                          {step.name}
                        </span>
                        {i < loop.steps.length - 1 ? (
                          <span style={{ color: "var(--color-ink-faint)", fontSize: 10 }}>–</span>
                        ) : null}
                      </div>
                    ))}
                  </div>

                  <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2">
                    <span className="label">Cadence · {loop.cadence}</span>
                    <span className="label">Runs · {loopRuns.length}</span>
                    <span className="label">Learnings · {learnings.length}</span>
                  </div>

                  {learnings.length > 0 ? (
                    <div className="mt-4">
                      <div className="label-lit">What it has learned</div>
                      <ul className="mt-2 space-y-1.5">
                        {learnings.slice(-5).map((l) => (
                          <li key={l.id} className="text-[12px]" style={{ color: "var(--color-ink)" }}>
                            · {l.text}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>

        {/* History, with outcome capture — the other half of learning. */}
        <section className="mt-9">
          <div className="label-lit">Recent runs</div>
          {runs.length === 0 ? (
            <p className="mt-3 text-[12px]" style={{ color: "var(--color-ink-faint)" }}>
              No runs yet. Start one above.
            </p>
          ) : (
            <div className="mt-3 space-y-3">
              {runs.slice(0, 12).map((run) => {
                const loop = data?.loops.find((l) => l.id === run.loopId);
                const status = STATUS_COPY[run.status];
                return (
                  <div key={run.id} className="panel rounded-xl p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <span className="text-[12.5px]" style={{ color: "var(--color-ink)" }}>
                        {loop?.name ?? run.loopId}
                      </span>
                      <span className="label" style={{ color: status.color }}>
                        {status.label}
                      </span>
                    </div>

                    {run.error ? (
                      <p className="mt-2 text-[11px]" style={{ color: "var(--color-alert)" }}>
                        {run.error}
                      </p>
                    ) : null}

                    {run.note ? (
                      <p className="mt-2 text-[11px]" style={{ color: "var(--color-ink-soft)" }}>
                        Note · {run.note}
                      </p>
                    ) : null}

                    {run.status === "completed" && !run.outcome ? (
                      <div className="mt-3 flex flex-wrap gap-2">
                        <input
                          value={outcome}
                          onChange={(e) => setOutcome(e.target.value)}
                          placeholder="What actually happened? This is what it learns from."
                          className="panel min-w-0 flex-1 rounded-lg px-3 py-2 text-[12px] outline-none"
                          style={{ color: "var(--color-ink)", background: "rgba(4,7,10,0.6)" }}
                        />
                        <button
                          type="button"
                          disabled={busy !== null || !outcome.trim()}
                          onClick={() => void act({ action: "observe", runId: run.id, outcome }, run.id)}
                          className="chip px-4 py-2 label-lit disabled:opacity-30"
                        >
                          Record
                        </button>
                      </div>
                    ) : null}

                    {run.outcome ? (
                      <p className="mt-2 text-[11px]" style={{ color: "var(--color-alive)" }}>
                        Outcome · {run.outcome}
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
