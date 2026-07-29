"use client";

/**
 * The brief — the assistant's face.
 *
 * Everything here was derived on the server from cases, product state and
 * dated commitments. Nothing was composed. That is why every item can show
 * why it matters, why today, and what delaying it costs: those are fields,
 * not phrasing.
 *
 * The two sections most tools would leave out are the ones worth having. What
 * was *cut* from today, with the test it failed. And what you have skipped
 * three days running, which is information about you rather than about the
 * task.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { SurfaceHeader } from "@/components/cases/parts";
import type { Advisory } from "@/lib/advisory";
import type { Brief } from "@/lib/brief";
import type { Entry } from "@/lib/knowledge";
import type { Product } from "@/lib/products";
import { MODES, type ModeId } from "@/lib/modes";
import { VERDICT_LABEL, VERDICT_MEANING, type Classified } from "@/lib/signals";

interface State {
  brief: Brief;
  alerts: Classified[];
  digest: Classified[];
  entries: Entry[];
  products: Product[];
  problems: string[];
  pushedDown: number;
  capacity: { plannedHours: number; bookedHours: number | null };
  calendar: { connected: boolean; bookedHours: number | null; note: string };
  poll?: Array<{ source: string; ok: boolean; found: number; kept: number; error?: string }>;
}

interface Answer {
  mode: ModeId;
  text: string;
  live: boolean;
  context: string;
  model?: string;
}

const CONFIDENCE_COLOR: Record<string, string> = {
  high: "var(--color-alive)",
  medium: "var(--color-signal)",
  low: "var(--color-attend)",
  none: "var(--color-alert)",
};

const VERDICT_COLOR: Record<string, string> = {
  "act-now": "var(--color-alert)",
  "evaluate-soon": "var(--color-signal)",
  watch: "var(--color-ink-soft)",
  "ignore-for-now": "var(--color-ink-faint)",
};

export default function BriefPage() {
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);
  const [openAdvisory, setOpenAdvisory] = useState<string | null>(null);
  const [showDigest, setShowDigest] = useState(false);
  const [poll, setPoll] = useState<State["poll"] | null>(null);
  const [mode, setMode] = useState<ModeId>("daily-operator");
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [asking, setAsking] = useState(false);
  const [showContext, setShowContext] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/assistant", { cache: "no-store" });
      if (response.ok) setState((await response.json()) as State);
    } catch {
      /* rendered as an empty brief below */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(async (payload: Record<string, unknown>) => {
    setBusy(true);
    try {
      const response = await fetch("/api/assistant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (response.ok) {
        const next = (await response.json()) as State;
        setState(next);
        if (next.poll) setPoll(next.poll);
      }
    } finally {
      setBusy(false);
    }
  }, []);

  const askMode = useCallback(async (question: string) => {
    setAsking(true);
    setAnswer(null);
    try {
      const response = await fetch("/api/assistant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "ask", mode, question }),
      });
      const body = (await response.json()) as { answer?: Answer };
      if (body.answer) setAnswer(body.answer);
    } finally {
      setAsking(false);
    }
  }, [mode]);

  if (!state) {
    return (
      <main className="h-screen w-screen overflow-y-auto">
        <div className="mx-auto max-w-[1000px] px-8 pt-6">
          <SurfaceHeader title="Brief" />
          <p className="label mt-10">deriving…</p>
        </div>
      </main>
    );
  }

  const { brief, alerts, digest, products, problems, pushedDown } = state;
  const empty = brief.items.length === 0 && products.length === 0;

  return (
    <main className="h-screen w-screen overflow-y-auto">
      <div className="mx-auto max-w-[1000px] px-8 pb-24 pt-6">
        <SurfaceHeader
          title="Brief"
          right={
            <span className="label">
              {Math.round(brief.committedMinutes / 6) / 10}h planned of{" "}
              {brief.capacity.realisticHours}h
            </span>
          }
        />

        {/* An unsound evidence chain is shown, never swallowed. */}
        {problems.length > 0 ? (
          <div className="panel mt-6 rounded-xl p-4" style={{ borderColor: "rgba(255,107,107,0.4)" }}>
            <div className="label-lit" style={{ color: "var(--color-alert)" }}>
              The knowledge base has {problems.length} unsound link
              {problems.length === 1 ? "" : "s"}
            </div>
            <ul className="mt-2 space-y-1">
              {problems.map((p) => (
                <li key={p} className="text-[12px]" style={{ color: "var(--color-ink-soft)" }}>
                  {p}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <p
          className="mt-7 text-[22px] leading-[1.35]"
          style={{ color: "var(--color-ink)", fontFamily: "var(--font-display)" }}
        >
          {brief.greeting}
        </p>
        <p className="mt-2 max-w-[70ch] text-[13px] leading-relaxed" style={{ color: "var(--color-ink-soft)" }}>
          You have {brief.capacity.realisticHours} hours of realistic capacity.{" "}
          {brief.capacity.note}
        </p>

        {empty ? (
          <div className="panel mt-8 rounded-xl p-8">
            <div className="label-lit">Nothing to brief on yet</div>
            <p className="mt-3 max-w-[62ch] text-[13px] leading-relaxed" style={{ color: "var(--color-ink-soft)" }}>
              The brief is derived from open cases, product state and dated
              commitments — it has none of those to read. Load a worked example
              set, or open a case from the Cases screen.
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => void act({ action: "seed-examples" })}
              className="chip mt-5 px-4 py-2 label transition-colors hover:text-[color:var(--color-signal)] disabled:opacity-40"
            >
              {busy ? "loading…" : "Load examples"}
            </button>
          </div>
        ) : (
          <>
            {/* ── Today ─────────────────────────────────────────────── */}
            <section className="mt-8">
              <div className="label-lit">Today</div>
              {brief.items.length === 0 ? (
                <p className="mt-3 text-[13px]" style={{ color: "var(--color-ink-soft)" }}>
                  Nothing clears the bar for today. Everything open is with
                  someone else, booked, or blocked.
                </p>
              ) : (
                <ol className="mt-3 space-y-3">
                  {brief.items.map((item, index) => (
                    <li key={item.key} className="panel rounded-xl p-5">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex min-w-0 items-start gap-3">
                          <span
                            className="mt-0.5 text-[11px] tabular-nums"
                            style={{ color: "var(--color-signal)", width: 18 }}
                          >
                            {index + 1}
                          </span>
                          <div className="min-w-0">
                            <div className="text-[14px]" style={{ color: "var(--color-ink)" }}>
                              {item.title}
                            </div>
                            <dl className="mt-2 space-y-1">
                              <Line label="Why" value={item.matters} />
                              <Line label="Why now" value={item.now} />
                              <Line label="If delayed" value={item.ifDelayed} />
                            </dl>
                            {item.appearances >= 3 ? (
                              <p className="mt-2 text-[12px]" style={{ color: "var(--color-attend)" }}>
                                This is the {item.appearances}
                                {item.appearances === 3 ? "rd" : "th"} brief in a row it has
                                appeared in. Either do it, schedule it, or drop it.
                              </p>
                            ) : null}
                          </div>
                        </div>
                        <div className="shrink-0 text-right">
                          <div className="text-[13px] tabular-nums" style={{ color: "var(--color-signal)" }}>
                            {item.minutes}m
                          </div>
                          <div className="label mt-1">{item.subject}</div>
                        </div>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </section>

            {/* Which product got the blocker hour, and why not the others. */}
            {brief.focus ? (
              <p className="mt-4 max-w-[72ch] text-[12px] leading-relaxed" style={{ color: "var(--color-ink-faint)" }}>
                {brief.focus.note}
              </p>
            ) : null}

            {/* ── What was cut ──────────────────────────────────────── */}
            {brief.deferred.length > 0 ? (
              <section className="mt-8">
                <div className="label-lit" style={{ color: "var(--color-ink-faint)" }}>
                  Moved out of today · {brief.deferred.length}
                </div>
                <ul className="mt-3 space-y-1.5">
                  {brief.deferred.map((row) => (
                    <li key={row.key} className="flex flex-wrap items-baseline gap-x-3 px-1">
                      <span className="text-[12px]" style={{ color: "var(--color-ink-faint)" }}>
                        {row.title}
                      </span>
                      <span className="label">— {row.reason}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {/* ── Advice ────────────────────────────────────────────── */}
            {brief.advisories.length > 0 ? (
              <section className="mt-9">
                <div className="label-lit">What I would change</div>
                <ul className="mt-3 space-y-2.5">
                  {brief.advisories.map((advisory) => (
                    <li key={advisory.id} className="panel rounded-xl p-4">
                      <button
                        type="button"
                        className="w-full text-left"
                        onClick={() =>
                          setOpenAdvisory(openAdvisory === advisory.id ? null : advisory.id)
                        }
                      >
                        <div className="flex items-start justify-between gap-4">
                          <span className="text-[13.5px]" style={{ color: "var(--color-ink)" }}>
                            {advisory.recommendation}
                          </span>
                          <span
                            className="label shrink-0"
                            style={{ color: CONFIDENCE_COLOR[advisory.confidence] }}
                          >
                            {advisory.confidence}
                          </span>
                        </div>
                        <p className="mt-1.5 text-[12px] leading-relaxed" style={{ color: "var(--color-ink-soft)" }}>
                          {advisory.reason}
                        </p>
                      </button>

                      {openAdvisory === advisory.id ? (
                        <AdvisoryDetail advisory={advisory} entries={state.entries} />
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {/* ── Intelligence ──────────────────────────────────────── */}
            <section className="mt-9">
              <div className="flex items-baseline justify-between gap-4">
                <div className="label-lit">Worth interrupting you for · {alerts.length}</div>
                <div className="flex items-baseline gap-4">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void act({ action: "poll-feeds" })}
                    className="label transition-colors hover:text-[color:var(--color-signal)] disabled:opacity-40"
                  >
                    {busy ? "polling…" : "poll feeds"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowDigest((v) => !v)}
                    className="label transition-colors hover:text-[color:var(--color-signal)]"
                  >
                    {showDigest ? "hide" : `digest · ${digest.length}`}
                  </button>
                </div>
              </div>

              {/* Never silently truncate a list of things called urgent. */}
              {pushedDown > 0 ? (
                <p className="mt-2 text-[12px]" style={{ color: "var(--color-attend)" }}>
                  {pushedDown} more item{pushedDown === 1 ? " is" : "s are"} also act-now
                  and sitting in the digest. Three is the most that can be put in front of
                  you at once — a day with eleven urgent items has none.
                </p>
              ) : null}

              {alerts.length === 0 ? (
                <p className="mt-3 text-[13px]" style={{ color: "var(--color-ink-soft)" }}>
                  Nothing in the feed touches a current blocker or your stack.
                  That is the normal answer.
                </p>
              ) : (
                <ul className="mt-3 space-y-2.5">
                  {alerts.map((row) => (
                    <SignalRow key={row.signal.id} row={row} />
                  ))}
                </ul>
              )}

              {/* Per source. A dead feed is named rather than folded into a
                  silent "nothing new" — which is indistinguishable from a
                  quiet week, and is how every feed reader ends up lying. */}
              {poll ? (
                <ul className="mt-4 space-y-1">
                  {poll.map((row) => (
                    <li key={row.source} className="flex flex-wrap items-baseline gap-x-3">
                      <span className="label" style={{ color: row.ok ? "var(--color-ink-soft)" : "var(--color-alert)" }}>
                        {row.source}
                      </span>
                      <span className="label">
                        {row.ok
                          ? `${row.found} items, ${row.kept} touched your stack`
                          : `unreachable — ${row.error}`}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}

              {showDigest ? (
                <ul className="mt-3 space-y-2.5">
                  {digest.map((row) => (
                    <SignalRow key={row.signal.id} row={row} />
                  ))}
                </ul>
              ) : null}
            </section>

            {/* ── Horizons ──────────────────────────────────────────── */}
            {brief.horizons.length > 0 ? (
              <section className="mt-9">
                <div className="label-lit">Today, inside the longer arc</div>
                <div className="mt-3 space-y-3">
                  {brief.horizons.map((link) => (
                    <div key={link.week} className="panel rounded-xl p-4">
                      <div className="text-[13px]" style={{ color: "var(--color-ink)" }}>
                        {link.today}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1">
                        <span className="label">this week · {link.week}</span>
                        <span className="label">phase · {link.phase}</span>
                      </div>
                    </div>
                  ))}
                </div>
                <p className="mt-3 text-[12px]" style={{ color: "var(--color-ink-faint)" }}>
                  {brief.waitingCount} case{brief.waitingCount === 1 ? " is" : "s are"} with
                  someone else —{" "}
                  <Link href="/waiting" className="underline decoration-dotted" style={{ color: "var(--color-signal)" }}>
                    Waiting
                  </Link>{" "}
                  has the clocks.
                </p>
              </section>
            ) : null}

            {/* ── Modes ─────────────────────────────────────────────── */}
            <section className="mt-9">
              <div className="label-lit">Ask</div>
              <p className="mt-2 max-w-[70ch] text-[12px]" style={{ color: "var(--color-ink-faint)" }}>
                Six framings, one truth system. A mode changes which slice of the
                derived state it is handed and what it may not do with it — never
                where the state comes from, so two modes cannot disagree about a fact.
              </p>

              <div className="mt-3 flex flex-wrap gap-2">
                {MODES.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => {
                      setMode(m.id);
                      setAnswer(null);
                    }}
                    title={m.refuses}
                    className="chip px-3 py-1.5 label transition-colors"
                    style={{ color: mode === m.id ? "var(--color-signal)" : undefined }}
                  >
                    {m.name}
                  </button>
                ))}
              </div>

              <p className="mt-3 text-[12px]" style={{ color: "var(--color-ink-soft)" }}>
                {MODES.find((m) => m.id === mode)?.question}{" "}
                <span style={{ color: "var(--color-ink-faint)" }}>
                  {MODES.find((m) => m.id === mode)?.refuses}
                </span>
              </p>

              <form
                className="mt-3 flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  const input = e.currentTarget.elements.namedItem("q") as HTMLInputElement;
                  const question = input.value.trim() || (MODES.find((m) => m.id === mode)?.question ?? "");
                  void askMode(question);
                }}
              >
                <input
                  name="q"
                  placeholder={MODES.find((m) => m.id === mode)?.question}
                  className="chip flex-1 px-3 py-2 text-[12px] outline-none"
                  style={{ color: "var(--color-ink)", background: "transparent" }}
                />
                <button type="submit" disabled={asking} className="chip px-4 py-2 label disabled:opacity-40">
                  {asking ? "thinking…" : "ask"}
                </button>
              </form>

              {answer ? (
                <div className="panel mt-4 rounded-xl p-5">
                  <div className="flex flex-wrap items-baseline justify-between gap-3">
                    <span className="label-lit">
                      {MODES.find((m) => m.id === answer.mode)?.name}
                    </span>
                    <span className="label" style={{ color: answer.live ? "var(--color-alive)" : "var(--color-attend)" }}>
                      {answer.live ? answer.model : "no model — showing the state instead"}
                    </span>
                  </div>
                  <p
                    className="mt-3 whitespace-pre-wrap text-[13px] leading-relaxed"
                    style={{ color: "var(--color-ink-soft)" }}
                  >
                    {answer.text}
                  </p>

                  {/* The answer's own basis, always available. An answer you
                      cannot check against its inputs is one you have to trust. */}
                  {answer.live ? (
                    <>
                      <button
                        type="button"
                        onClick={() => setShowContext((v) => !v)}
                        className="label mt-4 transition-colors hover:text-[color:var(--color-signal)]"
                      >
                        {showContext ? "hide what it was given" : "what it was given"}
                      </button>
                      {showContext ? (
                        <pre
                          className="mt-3 max-h-[380px] overflow-auto whitespace-pre-wrap border-t pt-3 text-[11px] leading-relaxed"
                          style={{ borderColor: "rgba(62,194,255,0.15)", color: "var(--color-ink-faint)" }}
                        >
                          {answer.context}
                        </pre>
                      ) : null}
                    </>
                  ) : null}
                </div>
              ) : null}
            </section>

            <div className="mt-9 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void act({ action: "acknowledge" })}
                className="chip px-4 py-2 label transition-colors hover:text-[color:var(--color-alive)] disabled:opacity-40"
              >
                seen it
              </button>
              <Link href="/products" className="chip px-4 py-2 label transition-colors hover:text-[color:var(--color-signal)]">
                product state →
              </Link>
            </div>
          </>
        )}
      </div>
    </main>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3">
      <dt className="label w-[86px] shrink-0 whitespace-nowrap">{label}</dt>
      <dd className="min-w-0 flex-1 text-[12px] leading-relaxed" style={{ color: "var(--color-ink-soft)" }}>
        {value}
      </dd>
    </div>
  );
}

/**
 * The full advisory. The last row is the one that matters: an assistant that
 * cannot say what would change its mind is not advising, it is asserting.
 */
function AdvisoryDetail({ advisory, entries }: { advisory: Advisory; entries: Entry[] }) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  return (
    <div className="mt-3 space-y-1.5 border-t pt-3" style={{ borderColor: "rgba(62,194,255,0.15)" }}>
      <Line label="Benefit" value={advisory.expectedBenefit} />
      <Line label="Trade-off" value={advisory.tradeOff} />
      <Line label="Changes if" value={advisory.wouldChangeIf} />
      <div className="flex gap-3">
        <dt className="label w-[72px] shrink-0">Evidence</dt>
        <dd className="min-w-0 flex-1">
          {advisory.evidence.length === 0 ? (
            <span className="text-[12px]" style={{ color: "var(--color-attend)" }}>
              None recorded — treat this as a prompt, not a finding.
            </span>
          ) : (
            <ul className="space-y-1">
              {advisory.evidence.map((ref) => {
                const entry = byId.get(ref);
                return (
                  <li key={ref} className="text-[12px]" style={{ color: "var(--color-ink-soft)" }}>
                    <span className="label" style={{ color: "var(--color-signal)" }}>
                      {entry?.kind ?? "missing"}
                    </span>{" "}
                    {entry?.text ?? ref}
                  </li>
                );
              })}
            </ul>
          )}
        </dd>
      </div>
      <p className="pt-1 label" style={{ color: "var(--color-ink-faint)" }}>
        rule · {advisory.rule}
      </p>
    </div>
  );
}

function SignalRow({ row }: { row: Classified }) {
  return (
    <li className="panel rounded-xl p-4">
      <div className="flex items-start justify-between gap-4">
        <span className="text-[13.5px]" style={{ color: "var(--color-ink)" }}>
          {row.signal.headline}
        </span>
        <span
          className="chip shrink-0 px-2 py-0.5 label"
          style={{ color: VERDICT_COLOR[row.verdict], borderColor: VERDICT_COLOR[row.verdict] }}
          title={VERDICT_MEANING[row.verdict]}
        >
          {VERDICT_LABEL[row.verdict]}
        </span>
      </div>
      <p className="mt-1.5 text-[12px] leading-relaxed" style={{ color: "var(--color-ink-soft)" }}>
        {row.because}
      </p>
      <div className="mt-2 flex flex-wrap gap-x-4">
        <span className="label">{row.signal.source}</span>
        <span className="label">{row.signal.nature}</span>
        {row.signal.demo ? (
          <span className="label" style={{ color: "var(--color-violet)" }}>
            example
          </span>
        ) : null}
      </div>
    </li>
  );
}
