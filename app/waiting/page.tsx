"use client";

/**
 * Waiting.
 *
 * The page every task manager is missing. These cases are not stalled and
 * they are not done — somebody else has them, and each one has a clock.
 *
 * Sorted by how close that clock is to running out, so the top of this list is
 * always the thing about to become your problem. When a clock does expire the
 * case leaves this page entirely and appears on Today, which is the only
 * honest way to model it: waiting stops being waiting at some point, and the
 * system should be the one that notices.
 */

import { useMemo } from "react";
import Link from "next/link";
import { SurfaceHeader, EmptyLedger, RiskDot, TurnChip, ago, money } from "@/components/cases/parts";
import { useCases } from "@/components/cases/useCases";

const DAY = 86_400_000;

export default function WaitingPage() {
  const { cases, busy, error, act } = useCases();

  const waiting = useMemo(() => {
    if (!cases) return [];
    return cases
      .filter((view) => view.turn !== "mine" && view.turn !== "complete")
      .sort((a, b) => {
        // Blocked first, longest-blocked at the top. A block is the one state
        // where nobody is working and no clock is running, so it will never
        // resolve itself — it needs a person more urgently than anything with
        // a countdown still on it.
        const blocked = Number(b.turn === "blocked") - Number(a.turn === "blocked");
        if (blocked !== 0) return blocked;
        if (a.turn === "blocked") return b.quietFor - a.quietFor;
        // Then by how close patience is to running out.
        return b.overdueDays - a.overdueDays;
      });
  }, [cases]);

  const exposure = waiting.reduce((sum, view) => sum + (view.value ?? 0), 0);

  if (cases === null) {
    return (
      <main className="h-screen w-screen overflow-y-auto">
        <div className="mx-auto max-w-[1000px] px-8 pt-6">
          <SurfaceHeader title="Waiting" />
          <p className="label mt-10">reading the ledger…</p>
        </div>
      </main>
    );
  }

  return (
    <main className="h-screen w-screen overflow-y-auto">
      <div className="mx-auto max-w-[1000px] px-8 pb-24 pt-6">
        <SurfaceHeader
          title="Waiting"
          right={
            <span className="label">
              {waiting.length} with someone else
              {exposure > 0 ? ` · £${exposure.toLocaleString("en-GB")} riding on it` : ""}
            </span>
          }
        />

        <p className="mt-6 max-w-[70ch] text-[13px] leading-relaxed" style={{ color: "var(--color-ink-soft)" }}>
          Not stalled, not done. Each of these is a live obligation held by
          somebody who is not you, with a patience threshold attached. When one
          runs out the case moves to{" "}
          <Link href="/today" className="underline decoration-dotted" style={{ color: "var(--color-signal)" }}>
            Today
          </Link>{" "}
          by itself.
        </p>

        {error ? (
          <p className="mt-4 text-[12px]" style={{ color: "var(--color-alert)" }}>
            {error}
          </p>
        ) : null}

        {cases.length === 0 ? (
          <EmptyLedger busy={busy} onSeed={() => void act({ action: "seed-examples" })} />
        ) : waiting.length === 0 ? (
          <div className="panel mt-8 rounded-xl p-8">
            <div className="label-lit">Nobody is holding anything</div>
            <p className="mt-3 text-[13px]" style={{ color: "var(--color-ink-soft)" }}>
              Every open case is currently yours.
            </p>
          </div>
        ) : (
          <ul className="mt-8 space-y-2.5">
            {waiting.map((view) => {
              const patience = view.stage.waiting?.patienceDays ?? 0;
              // Slack remaining, as a share of the whole patience window.
              const spent = patience > 0 ? Math.min(1, Math.max(0, 1 + view.overdueDays / patience)) : 0;

              return (
                <li key={view.id} className="panel rounded-xl p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex min-w-0 items-start gap-3">
                      <RiskDot level={view.risk.level} title={view.risk.reason} />
                      <div className="min-w-0">
                        <div className="text-[13.5px]" style={{ color: "var(--color-ink)" }}>
                          {view.title}
                        </div>
                        <div className="mt-1 text-[12px]" style={{ color: "var(--color-ink-soft)" }}>
                          Waiting on {view.waitingOn}
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
                          <span className="label">{view.stage.label}</span>
                          {money(view) ? <span className="label">{money(view)}</span> : null}
                          <span className="label">last moved {ago(view.quietFor)}</span>
                          {view.demo ? (
                            <span className="label" style={{ color: "var(--color-violet)" }}>
                              example
                            </span>
                          ) : null}
                        </div>
                      </div>
                    </div>

                    <div className="flex shrink-0 flex-col items-end gap-2">
                      <TurnChip turn={view.turn} />
                      {patience > 0 ? (
                        <span className="label tabular-nums">
                          {view.overdueDays >= 0
                            ? `${Math.round(view.overdueDays)}d over`
                            : // A booked date does not "run out" — it arrives,
                              // and the case becomes yours a little before it.
                              view.turn === "scheduled"
                              ? `yours in ${Math.ceil(-view.overdueDays)}d`
                              : `${Math.ceil(-view.overdueDays)}d left`}
                        </span>
                      ) : null}
                    </div>
                  </div>

                  {/* The clock, drawn. Full bar means patience nearly spent. */}
                  {patience > 0 ? (
                    <div
                      className="mt-3 h-1 overflow-hidden rounded-full"
                      style={{ background: "rgba(255,255,255,0.05)" }}
                    >
                      <div
                        style={{
                          width: `${spent * 100}%`,
                          height: "100%",
                          background:
                            spent > 0.85 ? "var(--color-alert)" : spent > 0.6 ? "var(--color-attend)" : "var(--color-signal)",
                          opacity: 0.8,
                        }}
                      />
                    </div>
                  ) : null}

                  {view.turn === "blocked" ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void act({ action: "event", caseId: view.id, type: "unblocked" })}
                      className="chip mt-3 px-3 py-1.5 label transition-colors hover:text-[color:var(--color-alive)] disabled:opacity-40"
                    >
                      Unblocked
                    </button>
                  ) : null}

                  {view.turn === "scheduled" && view.dueAt ? (
                    <p className="mt-3 label">
                      due {new Date(view.dueAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })} ·{" "}
                      {Math.ceil((view.dueAt - Date.now()) / DAY)} days out
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </main>
  );
}
