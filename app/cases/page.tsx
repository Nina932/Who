"use client";

/**
 * Cases — the whole ledger, and the only place that writes to it.
 *
 * Every control on this page appends an event. There is no field to edit a
 * case's stage, because a stage is not a property: it is where the log leaves
 * you. That constraint is what makes the history worth reading a year later.
 *
 * The transitions offered are exactly the ones the current stage accepts, read
 * from the workflow — so the UI cannot invite a move the engine would refuse.
 */

import { useMemo, useState } from "react";
import { SurfaceHeader, EmptyLedger, RiskDot, TurnChip, ago, money } from "@/components/cases/parts";
import { useCases } from "@/components/cases/useCases";
import { LEAD_TO_CASH, type CaseView } from "@/lib/cases";

type Filter = "open" | "all" | "closed";

export default function CasesPage() {
  const { cases, busy, error, act } = useCases();
  const [filter, setFilter] = useState<Filter>("open");
  const [openId, setOpenId] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  const shown = useMemo(() => {
    if (!cases) return [];
    const list =
      filter === "all"
        ? cases
        : filter === "closed"
          ? cases.filter((c) => c.stage.terminal)
          : cases.filter((c) => !c.stage.terminal);
    return [...list].sort((a, b) => b.overdueDays - a.overdueDays);
  }, [cases, filter]);

  const demos = cases?.filter((c) => c.demo).length ?? 0;

  if (cases === null) {
    return (
      <main className="h-screen w-screen overflow-y-auto">
        <div className="mx-auto max-w-[1080px] px-8 pt-6">
          <SurfaceHeader title="Cases" />
          <p className="label mt-10">reading the ledger…</p>
        </div>
      </main>
    );
  }

  return (
    <main className="h-screen w-screen overflow-y-auto">
      <div className="mx-auto max-w-[1080px] px-8 pb-24 pt-6">
        <SurfaceHeader
          title="Cases"
          right={<span className="label">{LEAD_TO_CASH.name} · {cases.length} on the books</span>}
        />

        <p className="mt-6 max-w-[70ch] text-[13px] leading-relaxed" style={{ color: "var(--color-ink-soft)" }}>
          {LEAD_TO_CASH.purpose} Every button below appends an event — nothing
          on this page edits a case, because a case has no editable state.
        </p>

        {error ? (
          <p className="mt-4 text-[12px]" style={{ color: "var(--color-alert)" }}>
            {error}
          </p>
        ) : null}

        <div className="mt-6 flex flex-wrap items-center gap-2">
          {(["open", "closed", "all"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setFilter(option)}
              className="chip px-3 py-1 label transition-colors"
              style={{ color: filter === option ? "var(--color-signal)" : undefined }}
            >
              {option}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setOpening((v) => !v)}
            className="chip px-3 py-1 label transition-colors hover:text-[color:var(--color-alive)]"
          >
            + open a case
          </button>
          {demos > 0 ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void act({ action: "clear-examples" })}
              className="chip px-3 py-1 label transition-colors hover:text-[color:var(--color-alert)] disabled:opacity-40"
            >
              clear {demos} example{demos === 1 ? "" : "s"}
            </button>
          ) : null}
        </div>

        {opening ? (
          <form
            className="panel mt-4 rounded-xl p-5"
            onSubmit={(e) => {
              e.preventDefault();
              const form = e.currentTarget;
              const data = new FormData(form);
              const title = String(data.get("title") ?? "").trim();
              const counterparty = String(data.get("counterparty") ?? "").trim();
              if (!title || !counterparty) return;
              const raw = String(data.get("value") ?? "").trim();
              void act({
                action: "open",
                title,
                counterparty,
                value: raw ? Number(raw) : undefined,
                note: String(data.get("note") ?? "").trim() || undefined,
              });
              form.reset();
              setOpening(false);
            }}
          >
            <div className="label-lit">A new commitment</div>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <Field name="title" placeholder="What the work is" />
              <Field name="counterparty" placeholder="Who it is with" />
              <Field name="value" placeholder="Value, if known" type="number" />
            </div>
            <div className="mt-3">
              <Field name="note" placeholder="How it arrived" />
            </div>
            <button type="submit" disabled={busy} className="chip mt-4 px-4 py-1.5 label disabled:opacity-40">
              open it
            </button>
            <p className="mt-3 text-[11px]" style={{ color: "var(--color-ink-faint)" }}>
              It starts at the enquiry stage. Thor takes the first turn.
            </p>
          </form>
        ) : null}

        {cases.length === 0 ? (
          <EmptyLedger busy={busy} onSeed={() => void act({ action: "seed-examples" })} />
        ) : (
          <>
            <StageRail cases={cases} />

            <ul className="mt-6 space-y-2.5">
              {shown.map((view) => (
                <li key={view.id} className="panel rounded-xl p-4">
                  <button
                    type="button"
                    onClick={() => setOpenId(openId === view.id ? null : view.id)}
                    className="w-full text-left"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex min-w-0 items-start gap-3">
                        <RiskDot level={view.risk.level} title={view.risk.reason} />
                        <div className="min-w-0">
                          <div className="text-[13.5px]" style={{ color: "var(--color-ink)" }}>
                            {view.title}
                          </div>
                          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1">
                            <span className="label">{view.counterparty}</span>
                            {money(view) ? <span className="label">{money(view)}</span> : null}
                            <span className="label">{view.stage.label}</span>
                            <span className="label">
                              {view.events.length} event{view.events.length === 1 ? "" : "s"}
                            </span>
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
                        <span className="label">{ago(view.quietFor)}</span>
                      </div>
                    </div>
                  </button>

                  {openId === view.id ? <Detail view={view} busy={busy} act={act} /> : null}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </main>
  );
}

function Field({
  name,
  placeholder,
  type = "text",
}: {
  name: string;
  placeholder: string;
  type?: string;
}) {
  return (
    <input
      name={name}
      type={type}
      placeholder={placeholder}
      className="chip w-full px-3 py-2 text-[12px] outline-none"
      style={{ color: "var(--color-ink)", background: "transparent" }}
    />
  );
}

/** Where the book stands, stage by stage. Terminal stages are excluded. */
function StageRail({ cases }: { cases: CaseView[] }) {
  const live = LEAD_TO_CASH.stages.filter((s) => !s.terminal);
  const counts = live.map((stage) => ({
    stage,
    count: cases.filter((c) => c.stage.id === stage.id).length,
  }));

  return (
    <div className="panel mt-6 overflow-x-auto rounded-xl p-4">
      <div className="flex min-w-[760px] items-end gap-1">
        {counts.map(({ stage, count }) => (
          <div key={stage.id} className="flex-1">
            <div
              className="h-1.5 rounded-full"
              style={{
                background: count > 0 ? "var(--color-signal)" : "rgba(255,255,255,0.07)",
                opacity: count > 0 ? 0.85 : 1,
              }}
            />
            <div className="mt-2 label" style={{ color: count > 0 ? "var(--color-ink-soft)" : "var(--color-ink-faint)" }}>
              {stage.label}
            </div>
            <div className="label tabular-nums" style={{ color: count > 0 ? "var(--color-signal)" : "var(--color-ink-faint)" }}>
              {count}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Detail({
  view,
  busy,
  act,
}: {
  view: CaseView;
  busy: boolean;
  act: (payload: Record<string, unknown>) => Promise<unknown>;
}) {
  const [reading, setReading] = useState(false);
  const [proposal, setProposal] = useState<{ type: string | null; reason: string; error?: string } | null>(
    null,
  );
  const now = Date.now();
  const transitions = Object.keys(view.stage.on);

  return (
    <div className="mt-4 border-t pt-4" style={{ borderColor: "rgba(62,194,255,0.15)" }}>
      <p className="text-[12px]" style={{ color: "var(--color-ink-soft)" }}>
        {view.risk.reason}
      </p>

      {/* Only what this stage accepts. The UI cannot offer an illegal move. */}
      <div className="mt-4">
        <div className="label-lit">What can happen next</div>
        <div className="mt-2 flex flex-wrap gap-2">
          {transitions.length === 0 ? (
            <span className="label">Nothing. This case is closed.</span>
          ) : (
            transitions.map((type) => (
              <button
                key={type}
                type="button"
                disabled={busy}
                onClick={() => void act({ action: "event", caseId: view.id, type })}
                className="chip px-3 py-1.5 label transition-colors hover:text-[color:var(--color-signal)] disabled:opacity-40"
              >
                {type}
              </button>
            ))
          )}
          {!view.stage.terminal ? (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void act({
                  action: "event",
                  caseId: view.id,
                  type: view.blockedBy ? "unblocked" : "blocked",
                })
              }
              className="chip px-3 py-1.5 label transition-colors hover:text-[color:var(--color-alert)] disabled:opacity-40"
            >
              {view.blockedBy ? "unblocked" : "blocked"}
            </button>
          ) : null}
        </div>
      </div>

      {/* Layer three, kept visibly at arm's length from the record. */}
      {transitions.length > 0 ? (
        <div className="mt-4">
          <button
            type="button"
            onClick={() => setReading((v) => !v)}
            className="label transition-colors hover:text-[color:var(--color-signal)]"
          >
            {reading ? "− " : "+ "}read a message and propose an event
          </button>

          {reading ? (
            <form
              className="mt-2"
              onSubmit={async (e) => {
                e.preventDefault();
                const form = e.currentTarget;
                const message = String(new FormData(form).get("message") ?? "").trim();
                if (!message) return;
                const body = (await act({
                  action: "interpret",
                  caseId: view.id,
                  message,
                })) as { proposal?: { type: string | null; reason: string; error?: string } } | null;
                setProposal(body?.proposal ?? null);
              }}
            >
              <textarea
                name="message"
                rows={3}
                placeholder="Paste what they actually said."
                className="chip w-full px-3 py-2 text-[12px] outline-none"
                style={{ color: "var(--color-ink)", background: "transparent" }}
              />
              <button type="submit" disabled={busy} className="chip mt-2 px-3 py-1.5 label disabled:opacity-40">
                read it
              </button>
            </form>
          ) : null}

          {proposal ? (
            <div className="mt-3 rounded-lg px-3 py-2" style={{ background: "rgba(74,111,224,0.1)" }}>
              {proposal.error ? (
                <p className="text-[12px]" style={{ color: "var(--color-alert)" }}>
                  {proposal.error}
                </p>
              ) : proposal.type ? (
                <>
                  <p className="text-[12px]" style={{ color: "var(--color-ink-soft)" }}>
                    Reads as <strong style={{ color: "var(--color-signal)" }}>{proposal.type}</strong> — {proposal.reason}
                  </p>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      void act({ action: "event", caseId: view.id, type: proposal.type as string });
                      setProposal(null);
                    }}
                    className="chip mt-2 px-3 py-1.5 label transition-colors hover:text-[color:var(--color-alive)] disabled:opacity-40"
                  >
                    commit it
                  </button>
                </>
              ) : (
                <p className="text-[12px]" style={{ color: "var(--color-ink-soft)" }}>
                  Nothing in that moves the case. {proposal.reason}
                </p>
              )}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="mt-5">
        <div className="label-lit">History</div>
        <ul className="mt-2 space-y-1.5">
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
            Kept but not applied: {view.unapplied.map((u) => u.type).join(", ")}. The
            workflow has no transition for these from where the case stood.
          </p>
        ) : null}
      </div>
    </div>
  );
}
