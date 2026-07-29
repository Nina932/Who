"use client";

/**
 * Today.
 *
 * One question: what is genuinely mine right now, and why. Everything on this
 * page is a case whose turn has landed on the operator — either because the
 * stage asked for it, or because a patience threshold ran out and the system
 * took the turn back on their behalf.
 *
 * Nothing here was typed by anyone. If an item is on this list, an event put
 * it there, and pressing the button that resolves it appends the next event.
 */

import { useMemo, useState } from "react";
import { SurfaceHeader, EmptyLedger, RiskDot, ago, money, AuthorityChip } from "@/components/cases/parts";
import { useCases } from "@/components/cases/useCases";
import { candidatesFromCases, type CaseView } from "@/lib/cases";
import { DEFAULT_CONTEXT, DEFAULT_WEIGHTS, scoreCandidate } from "@/lib/priority";

/** The event that resolves each stage, so the button does the obvious thing. */
const RESOLVES: Record<string, { type: string; label: string }> = {
  "qualify-review": { type: "qualified", label: "It's real work" },
  "proposal-due": { type: "proposal-sent", label: "Proposal sent" },
  "awaiting-decision": { type: "won", label: "They said yes" },
  "delivery-due": { type: "started", label: "Started" },
  "delivery-scheduled": { type: "started", label: "Started" },
  "delivery-active": { type: "delivered", label: "Delivered" },
  "awaiting-acceptance": { type: "accepted", label: "They signed off" },
  "invoice-due": { type: "invoiced", label: "Invoice sent" },
  "awaiting-payment": { type: "paid", label: "Paid" },
  inbound: { type: "qualified", label: "It's real work" },
};

export default function TodayPage() {
  const { cases, busy, error, act } = useCases();
  const [openId, setOpenId] = useState<string | null>(null);
  const [chasing, setChasing] = useState<string | null>(null);

  /**
   * Ranked by the same engine `/week` uses, so the order on this page and the
   * order on that one cannot disagree. This is the point of deriving actions
   * from cases rather than keeping two lists.
   */
  const mine = useMemo(() => {
    if (!cases) return [];
    const byId = new Map(cases.map((c) => [c.id, c]));
    return candidatesFromCases(cases)
      .map((candidate) => ({
        candidate,
        view: byId.get(candidate.id.replace(/^case-/, "")) as CaseView,
        scored: scoreCandidate(candidate, DEFAULT_WEIGHTS, DEFAULT_CONTEXT),
      }))
      .filter((row) => row.view)
      .sort((a, b) => b.scored.density - a.scored.density);
  }, [cases]);

  const hours = mine.reduce((sum, row) => sum + row.candidate.hours, 0);

  if (cases === null) {
    return (
      <main className="h-screen w-screen overflow-y-auto">
        <div className="mx-auto max-w-[1000px] px-8 pt-6">
          <SurfaceHeader title="Today" />
          <p className="label mt-10">reading the ledger…</p>
        </div>
      </main>
    );
  }

  return (
    <main className="h-screen w-screen overflow-y-auto">
      <div className="mx-auto max-w-[1000px] px-8 pb-24 pt-6">
        <SurfaceHeader
          title="Today"
          right={
            <span className="label">
              {mine.length} yours · {hours.toFixed(2).replace(/\.?0+$/, "")}h of work
            </span>
          }
        />

        <p className="mt-6 max-w-[70ch] text-[13px] leading-relaxed" style={{ color: "var(--color-ink-soft)" }}>
          Everything here arrived because something happened, or because
          something did not happen for long enough that the silence became the
          event. Nothing on this list was written by hand.
        </p>

        {error ? (
          <p className="mt-4 text-[12px]" style={{ color: "var(--color-alert)" }}>
            {error}
          </p>
        ) : null}

        {cases.length === 0 ? (
          <EmptyLedger busy={busy} onSeed={() => void act({ action: "seed-examples" })} />
        ) : mine.length === 0 ? (
          <div className="panel mt-8 rounded-xl p-8">
            <div className="label-lit" style={{ color: "var(--color-alive)" }}>
              Nothing is yours right now
            </div>
            <p className="mt-3 max-w-[62ch] text-[13px] leading-relaxed" style={{ color: "var(--color-ink-soft)" }}>
              Every open case is with somebody else, on a date, or blocked.
              That is a real state, not an empty screen — the Waiting page
              shows who is holding what, and how long they have had it.
            </p>
          </div>
        ) : (
          <ol className="mt-8 space-y-3">
            {mine.map((row, index) => {
              const { view, candidate, scored } = row;
              const resolve = RESOLVES[view.stage.id];
              const open = openId === view.id;

              return (
                <li key={view.id} className="panel rounded-xl p-5">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex min-w-0 items-start gap-3">
                      <span
                        className="mt-0.5 text-[11px] tabular-nums"
                        style={{ color: "var(--color-signal)", width: 18 }}
                      >
                        {index + 1}
                      </span>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <RiskDot level={view.risk.level} title={view.risk.reason} />
                          <span className="text-[14px]" style={{ color: "var(--color-ink)" }}>
                            {view.action?.title}
                          </span>
                        </div>

                        {/* Why this is here at all — the derivation, in words. */}
                        <p className="mt-1.5 text-[12px] leading-relaxed" style={{ color: "var(--color-ink-soft)" }}>
                          {view.action?.why}
                        </p>

                        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
                          <span className="label">{view.counterparty}</span>
                          {money(view) ? <span className="label">{money(view)}</span> : null}
                          <span className="label">{view.stage.label}</span>
                          <span
                            className="label"
                            style={{
                              color:
                                view.action?.derivedBy === "policy"
                                  ? "var(--color-attend)"
                                  : "var(--color-ink-faint)",
                            }}
                          >
                            {view.action?.derivedBy === "policy" ? "policy fired" : "from the workflow"}
                          </span>
                          {view.demo ? (
                            <span className="label" style={{ color: "var(--color-violet)" }}>
                              example
                            </span>
                          ) : null}
                        </div>
                      </div>
                    </div>

                    <div className="shrink-0 text-right">
                      <div className="text-[13px] tabular-nums" style={{ color: "var(--color-signal)" }}>
                        {candidate.hours}h
                      </div>
                      {/* Density, not score — because density is the sort key.
                          Showing the raw score here would make the order look
                          wrong every time a cheap item outranked a big one. */}
                      <div className="label mt-1" title={`score ${scored.score.toFixed(1)} over ${candidate.hours}h`}>
                        {scored.density.toFixed(1)} / hour
                      </div>
                    </div>
                  </div>

                  {view.action?.prepares ? (
                    <div
                      className="mt-3 rounded-lg px-3 py-2"
                      style={{ background: "rgba(62,194,255,0.06)" }}
                    >
                      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                        <AuthorityChip authority={view.action.authority} />
                        <span className="text-[12px]" style={{ color: "var(--color-ink-soft)" }}>
                          {view.action.prepares}
                        </span>
                      </div>
                    </div>
                  ) : null}

                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    {resolve ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void act({ action: "event", caseId: view.id, type: resolve.type })
                        }
                        className="chip px-3 py-1.5 label transition-colors hover:text-[color:var(--color-alive)] disabled:opacity-40"
                      >
                        {resolve.label}
                      </button>
                    ) : null}

                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setChasing(chasing === view.id ? null : view.id)}
                      className="chip px-3 py-1.5 label transition-colors hover:text-[color:var(--color-signal)] disabled:opacity-40"
                    >
                      Add a note
                    </button>

                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setOpenId(open ? null : view.id)}
                      className="label px-1 transition-colors hover:text-[color:var(--color-signal)]"
                    >
                      {open ? "hide history" : `history · ${view.events.length}`}
                    </button>
                  </div>

                  {chasing === view.id ? (
                    <form
                      className="mt-3 flex gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const input = e.currentTarget.elements.namedItem("note") as HTMLInputElement;
                        const note = input.value.trim();
                        if (!note) return;
                        void act({ action: "event", caseId: view.id, type: "note", note });
                        setChasing(null);
                      }}
                    >
                      <input
                        name="note"
                        autoFocus
                        placeholder="What happened?"
                        className="chip flex-1 px-3 py-1.5 text-[12px] outline-none"
                        style={{ color: "var(--color-ink)", background: "transparent" }}
                      />
                      <button type="submit" className="chip px-3 py-1.5 label">
                        record
                      </button>
                    </form>
                  ) : null}

                  {open ? <History view={view} /> : null}
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </main>
  );
}

/** The log, newest first. This is the case; everything above is a projection. */
function History({ view }: { view: CaseView }) {
  const now = Date.now();
  return (
    <div className="mt-4 border-t pt-4" style={{ borderColor: "rgba(62,194,255,0.15)" }}>
      <ul className="space-y-1.5">
        {[...view.events].reverse().map((event) => (
          <li key={event.id} className="flex items-baseline gap-3">
            <span className="label w-[110px] shrink-0" style={{ color: "var(--color-signal)" }}>
              {event.type}
            </span>
            <span className="label w-[70px] shrink-0">{ago(now - event.at)}</span>
            <span className="label w-[80px] shrink-0" style={{ color: "var(--color-ink-faint)" }}>
              {event.actor}
            </span>
            <span className="min-w-0 flex-1 text-[12px]" style={{ color: "var(--color-ink-soft)" }}>
              {event.note ?? ""}
            </span>
          </li>
        ))}
      </ul>
      {view.unapplied.length > 0 ? (
        <p className="mt-3 text-[11px]" style={{ color: "var(--color-attend)" }}>
          {view.unapplied.length} event
          {view.unapplied.length === 1 ? "" : "s"} the workflow had no transition for:{" "}
          {view.unapplied.map((u) => u.type).join(", ")}. Kept, not applied.
        </p>
      ) : null}
    </div>
  );
}
