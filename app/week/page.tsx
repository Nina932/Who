"use client";

/**
 * The week — human-capacity allocation over actions already derived elsewhere.
 *
 * This page ranks; it does not decide what exists. Its candidates come from
 * cases moving through the lead-to-cash workflow and from loops holding at
 * their gates, both of which were produced by events rather than by anyone
 * writing a list. That ordering matters: a prioritiser fed by hand is a
 * prioritiser of whatever you happened to remember.
 *
 * What it adds on top is the verdict. Ranking a list is easy and most tools
 * stop there. What nobody notices is that the same list, ranked the same way,
 * has produced a year of urgent weeks in which nothing compounded.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { SurfaceHeader } from "@/components/cases/parts";
import { candidatesFromCases, type CaseView } from "@/lib/cases";
import {
  DEFAULT_CONTEXT,
  DEFAULT_WEIGHTS,
  FACTORS,
  SAMPLE_CANDIDATES,
  SOURCE_LABEL,
  candidatesFromRuns,
  rankWeek,
  verdict,
  type Context,
  type WeightMap,
} from "@/lib/priority";

interface LoopsPayload {
  loops: Array<{ id: string; name: string }>;
  runs: Array<{ id: string; loopId: string; status: string }>;
}

const GROUP_COLOR: Record<string, string> = {
  money: "var(--color-alive)",
  time: "var(--color-attend)",
  compounding: "var(--color-signal)",
  cost: "var(--color-alert)",
};

function Dial({
  label,
  hint,
  value,
  min,
  max,
  step,
  accent,
  suffix,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  accent: string;
  suffix?: string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <div className="flex items-baseline justify-between gap-3">
        <span className="label" style={{ color: "var(--color-ink-soft)" }}>
          {label}
        </span>
        <span className="text-[10px] tabular-nums" style={{ color: accent }}>
          {value.toFixed(step < 1 ? 1 : 0)}
          {suffix ?? ""}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-2 w-full"
        style={{ accentColor: accent }}
      />
      {hint ? (
        <span className="mt-1 block text-[10px]" style={{ color: "var(--color-ink-faint)" }}>
          {hint}
        </span>
      ) : null}
    </label>
  );
}

export default function WeekPage() {
  const [weights, setWeights] = useState<WeightMap>({ ...DEFAULT_WEIGHTS });
  const [context, setContext] = useState<Context>({ ...DEFAULT_CONTEXT });
  const [live, setLive] = useState<LoopsPayload | null>(null);
  const [cases, setCases] = useState<CaseView[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [loops, ledger] = await Promise.allSettled([
      fetch("/api/loops", { cache: "no-store" }),
      fetch("/api/cases", { cache: "no-store" }),
    ]);
    if (loops.status === "fulfilled" && loops.value.ok) {
      setLive((await loops.value.json()) as LoopsPayload);
    }
    if (ledger.status === "fulfilled" && ledger.value.ok) {
      setCases(((await ledger.value.json()) as { cases: CaseView[] }).cases);
    } else {
      setCases([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Derived work first, always. The sample week appears only when there is
   * genuinely nothing real to rank — a prioritiser silently mixing invented
   * candidates into your actual commitments would be worse than useless.
   */
  const fromCases = useMemo(() => (cases ? candidatesFromCases(cases) : []), [cases]);

  const fromLoops = useMemo(() => {
    if (!live) return [];
    const names = Object.fromEntries(live.loops.map((l) => [l.id, l.name]));
    return candidatesFromRuns(live.runs, names);
  }, [live]);

  const real = useMemo(() => [...fromCases, ...fromLoops], [fromCases, fromLoops]);
  const usingSample = cases !== null && real.length === 0;
  const candidates = usingSample ? SAMPLE_CANDIDATES : real;

  const ranked = useMemo(
    () => rankWeek(candidates, weights, context),
    [candidates, weights, context],
  );
  const summary = useMemo(() => verdict(ranked, context), [ranked, context]);

  const chosen = ranked.filter((r) => r.chosen);
  const cut = ranked.filter((r) => !r.chosen);

  return (
    <main className="h-screen w-screen overflow-y-auto">
      <div className="mx-auto max-w-[1180px] px-8 pb-24 pt-6">
        <SurfaceHeader
          title="The week"
          right={
            <span className="label">
              {candidates.length} competing · {context.capacityHours}h available
            </span>
          }
        />

        <p className="mt-6 max-w-[70ch] text-[13px] leading-relaxed" style={{ color: "var(--color-ink-soft)" }}>
          Your week has more candidates than hours, so something ranks them.
          Left alone that something is whatever shouted loudest this morning.
          This makes the ranking explicit — and then tells you what it is
          actually optimising for.
        </p>

        {usingSample ? (
          <p className="mt-3 max-w-[70ch] text-[12px]" style={{ color: "var(--color-attend)" }}>
            No open cases and no loops at a gate, so this is a worked example
            week — none of it is yours. Open a case and it is replaced entirely.
          </p>
        ) : (
          <p className="mt-3 max-w-[70ch] text-[12px]" style={{ color: "var(--color-ink-faint)" }}>
            {fromCases.length} derived from open cases · {fromLoops.length} from
            loops holding at a gate. Waiting and blocked work is excluded — it
            is tracked, and tracking is not doing.
          </p>
        )}

        {/* The verdict, first, because it is the part worth reading. */}
        <section className="mt-8">
          <div className="panel rounded-xl p-6">
            <div className="label-lit">What this week optimises for</div>
            <p
              className="mt-3 text-[17px] leading-[1.5]"
              style={{ color: "var(--color-ink)", fontFamily: "var(--font-display)" }}
            >
              {summary.headline}
            </p>

            <div className="mt-5 flex h-2.5 overflow-hidden rounded-full" style={{ background: "rgba(255,255,255,0.05)" }}>
              {(["money", "time", "compounding", "cost"] as const).map((group) => (
                <div
                  key={group}
                  style={{
                    width: `${summary.mix[group] * 100}%`,
                    background: GROUP_COLOR[group],
                    opacity: 0.8,
                  }}
                  title={`${group}: ${Math.round(summary.mix[group] * 100)}%`}
                />
              ))}
            </div>

            <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
              {(["money", "time", "compounding", "cost"] as const).map((group) => (
                <span key={group} className="flex items-center gap-2 label">
                  <span
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: 999,
                      background: GROUP_COLOR[group],
                    }}
                  />
                  {group} · {Math.round(summary.mix[group] * 100)}%
                </span>
              ))}
              <span className="label" style={{ color: "var(--color-ink-soft)" }}>
                {summary.committedHours}h committed of {summary.capacityHours}h
              </span>
            </div>
          </div>
        </section>

        <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_320px]">
          {/* The ranked week */}
          <div>
            <div className="label-lit">In the week</div>
            <ol className="mt-3 space-y-2.5">
              {chosen.map((item, i) => (
                <li key={item.candidate.id}>
                  <button
                    type="button"
                    onClick={() =>
                      setOpenId(openId === item.candidate.id ? null : item.candidate.id)
                    }
                    className="panel w-full rounded-xl p-4 text-left transition-colors hover:border-[rgba(62,194,255,0.4)]"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex min-w-0 items-start gap-3">
                        <span
                          className="text-[11px] tabular-nums"
                          style={{ color: "var(--color-signal)", width: 18 }}
                        >
                          {i + 1}
                        </span>
                        <div className="min-w-0">
                          <div className="text-[13.5px]" style={{ color: "var(--color-ink)" }}>
                            {item.candidate.title}
                          </div>
                          <div className="label mt-1.5">{item.candidate.origin}</div>
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="text-[13px] tabular-nums" style={{ color: "var(--color-signal)" }}>
                          {item.candidate.hours}h
                        </div>
                        <div className="label mt-1">score {item.score.toFixed(1)}</div>
                      </div>
                    </div>

                    {/* Why it ranked here — the contributions, largest first. */}
                    {openId === item.candidate.id ? (
                      <div className="mt-4 space-y-1.5 border-t pt-4" style={{ borderColor: "rgba(62,194,255,0.15)" }}>
                        {[...item.contributions]
                          .filter((c) => Math.abs(c.value) > 0.01)
                          .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
                          .map((c) => {
                            const factor = FACTORS.find((f) => f.key === c.key);
                            return (
                              <div key={c.key} className="flex items-center gap-3">
                                <span className="label w-[130px] shrink-0">{c.label}</span>
                                <div className="h-1.5 flex-1 overflow-hidden rounded-full" style={{ background: "rgba(255,255,255,0.05)" }}>
                                  <div
                                    style={{
                                      width: `${Math.min(100, (Math.abs(c.value) / 8) * 100)}%`,
                                      height: "100%",
                                      background:
                                        c.value >= 0
                                          ? GROUP_COLOR[factor?.group ?? "money"]
                                          : "var(--color-alert)",
                                      opacity: 0.85,
                                    }}
                                  />
                                </div>
                                <span
                                  className="w-12 shrink-0 text-right text-[10px] tabular-nums"
                                  style={{ color: c.value >= 0 ? "var(--color-ink-soft)" : "var(--color-alert)" }}
                                >
                                  {c.value >= 0 ? "+" : ""}
                                  {c.value.toFixed(1)}
                                </span>
                              </div>
                            );
                          })}
                      </div>
                    ) : null}
                  </button>
                </li>
              ))}
            </ol>

            {/* What got cut — shown, never silently dropped. */}
            <div className="mt-8">
              <div className="label-lit" style={{ color: "var(--color-ink-faint)" }}>
                Cut this week · {cut.length}
              </div>
              <ul className="mt-3 space-y-1.5">
                {cut.map((item) => (
                  <li
                    key={item.candidate.id}
                    className="flex items-baseline justify-between gap-4 px-1"
                  >
                    <span className="min-w-0 truncate text-[12px]" style={{ color: "var(--color-ink-faint)" }}>
                      {item.candidate.title}
                    </span>
                    <span className="label shrink-0">
                      {SOURCE_LABEL[item.candidate.source]} ·{" "}
                      {item.score <= 0 ? "scored negative" : `${item.candidate.hours}h, no room`}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* The dials */}
          <aside className="space-y-4">
            <div className="panel rounded-xl p-5">
              <div className="label-lit">Your situation</div>
              <p className="mt-2 text-[11px]" style={{ color: "var(--color-ink-faint)" }}>
                These bend the weights rather than the scores.
              </p>
              <div className="mt-4 space-y-4">
                <Dial
                  label="Runway pressure"
                  hint="How much the money matters right now"
                  value={context.runwayPressure}
                  min={0}
                  max={1}
                  step={0.05}
                  accent="var(--color-alive)"
                  onChange={(v) => setContext((c) => ({ ...c, runwayPressure: v }))}
                />
                <Dial
                  label="Growth appetite"
                  hint="Protect what exists, or push"
                  value={context.growthAppetite}
                  min={0}
                  max={1}
                  step={0.05}
                  accent="var(--color-signal)"
                  onChange={(v) => setContext((c) => ({ ...c, growthAppetite: v }))}
                />
                <Dial
                  label="Hours this week"
                  hint="The hours you will give, not the ones you wish you had"
                  value={context.capacityHours}
                  min={2}
                  max={60}
                  step={1}
                  suffix="h"
                  accent="var(--color-attend)"
                  onChange={(v) => setContext((c) => ({ ...c, capacityHours: v }))}
                />
              </div>
            </div>

            <div className="panel rounded-xl p-5">
              <div className="flex items-baseline justify-between gap-3">
                <div className="label-lit">What you value</div>
                <button
                  type="button"
                  onClick={() => setWeights({ ...DEFAULT_WEIGHTS })}
                  className="label transition-colors hover:text-[color:var(--color-signal)]"
                >
                  reset
                </button>
              </div>
              <p className="mt-2 text-[11px]" style={{ color: "var(--color-ink-faint)" }}>
                Every default here is an opinion. Overrule them.
              </p>
              <div className="mt-4 space-y-4">
                {FACTORS.map((factor) => (
                  <Dial
                    key={factor.key}
                    label={factor.label}
                    hint={factor.meaning}
                    value={weights[factor.key]}
                    min={factor.polarity === -1 ? -6 : 0}
                    max={factor.polarity === -1 ? 0 : 6}
                    step={0.1}
                    accent={GROUP_COLOR[factor.group]}
                    onChange={(v) =>
                      setWeights((prev) => ({ ...prev, [factor.key]: v }))
                    }
                  />
                ))}
              </div>
            </div>
          </aside>
        </div>
      </div>
    </main>
  );
}
