"use client";

/**
 * Phoenix — the For You pipeline, flown through rather than read about.
 *
 * Everything on screen is live: move a signal or a weight and retrieval,
 * ranking, the 19 heads and the final feed all recompute in the same frame.
 * The reader is meant to discover the punchline by playing rather than by
 * being told it — drag `sentiment` up and watch what wins.
 */

import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import Link from "next/link";
import {
  ACTIONS,
  DEFAULT_SIGNALS,
  DEFAULT_WEIGHTS,
  SIGNAL_AXES,
  SIGNAL_COPY,
  STAGES,
  rankFeed,
  type SignalAxis,
  type SignalVector,
  type StageId,
  type WeightMap,
} from "@/lib/phoenix";

const PhoenixScene = dynamic(() => import("@/components/phoenix/PhoenixScene"), {
  ssr: false,
  loading: () => (
    <div className="absolute inset-0 grid place-items-center">
      <span className="label-lit pulse-soft">Spinning up the pipeline…</span>
    </div>
  ),
});

function Slider({
  label,
  hint,
  value,
  min,
  max,
  step,
  accent,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  accent: string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <div className="flex items-baseline justify-between gap-3">
        <span className="label" style={{ color: "var(--color-ink-soft)" }}>
          {label}
        </span>
        <span className="text-[10px] tabular-nums" style={{ color: accent }}>
          {value.toFixed(2)}
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

export default function PhoenixPage() {
  const [stage, setStage] = useState<StageId>("signals");
  const [signals, setSignals] = useState<SignalVector>({ ...DEFAULT_SIGNALS });
  const [weights, setWeights] = useState<WeightMap>({ ...DEFAULT_WEIGHTS });
  const [showWeights, setShowWeights] = useState(false);

  const ranked = useMemo(() => rankFeed(signals, weights), [signals, weights]);
  const stageMeta = STAGES.find((s) => s.id === stage)!;
  const stageIndex = STAGES.findIndex((s) => s.id === stage);

  // The headline number: how well the ranking correlates with outrage, and how
  // little it correlates with being true.
  const outrageBias = useMemo(() => {
    const top = ranked.slice(0, 5);
    const rest = ranked.slice(5);
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    return {
      topOutrage: avg(top.map((r) => r.post.outrage)),
      topVeracity: avg(top.map((r) => r.post.veracity)),
      restVeracity: avg(rest.map((r) => r.post.veracity)),
    };
  }, [ranked]);

  return (
    <main className="relative h-screen w-screen overflow-hidden">
      <div className="absolute inset-0 z-0">
        <PhoenixScene stage={stage} signals={signals} ranked={ranked} />
      </div>

      {/* Header */}
      <header className="pointer-events-none absolute inset-x-0 top-0 z-20 px-8 pt-5">
        <div className="relative mb-5 h-px w-full overflow-hidden">
          <div className="rule absolute inset-0 opacity-40" />
          <div
            className="scan-sweep absolute top-0 h-px w-1/4"
            style={{
              background: "linear-gradient(90deg, transparent, #ffa62b, transparent)",
              boxShadow: "0 0 10px #ffa62b",
            }}
          />
        </div>
        <div className="flex items-start justify-between gap-6">
          <div>
            <h1
              className="uppercase"
              style={{
                fontSize: 15,
                letterSpacing: "0.3em",
                color: "#ffa62b",
                fontFamily: "var(--font-display)",
                textShadow: "0 0 24px rgba(255,166,43,0.5)",
              }}
            >
              Phoenix
            </h1>
            <p className="label mt-2.5">The For You pipeline · reconstructed</p>
          </div>
          <Link
            href="/"
            className="chip pointer-events-auto px-3 py-1.5 label transition-colors hover:text-[color:var(--color-signal)]"
          >
            ← Thor
          </Link>
        </div>
      </header>

      {/* Stage narration */}
      <div className="pointer-events-none absolute bottom-32 left-8 z-20 max-w-[420px]">
        <div className="label-lit" style={{ color: "#ffa62b" }}>
          Stage {stageIndex + 1} / {STAGES.length} · {stageMeta.name}
        </div>
        <p
          key={stage}
          className="rise-in mt-3 text-[15px] leading-[1.6]"
          style={{ color: "var(--color-ink)", fontFamily: "var(--font-display)" }}
        >
          {stageMeta.caption}
        </p>
      </div>

      {/* Stage nav */}
      <nav className="pointer-events-auto absolute bottom-8 left-1/2 z-30 flex -translate-x-1/2 flex-wrap justify-center gap-2">
        {STAGES.map((s, i) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setStage(s.id)}
            className={`${s.id === stage ? "chip-attend" : "chip"} px-3.5 py-2 label transition-all`}
            style={{ color: s.id === stage ? "#ffa62b" : "var(--color-ink-faint)" }}
          >
            {String(i + 1).padStart(2, "0")} {s.name}
          </button>
        ))}
      </nav>

      {/* Control panel */}
      <aside className="pointer-events-auto absolute right-6 top-24 z-20 flex max-h-[calc(100vh-11rem)] w-[330px] flex-col gap-4 overflow-y-auto pr-1">
        <div className="panel rounded-xl p-5">
          <div className="label-lit">Your signals</div>
          <p className="mt-2 text-[11px]" style={{ color: "var(--color-ink-faint)" }}>
            The user tower's input. Everything downstream moves when these do.
          </p>
          <div className="mt-4 space-y-4">
            {SIGNAL_AXES.map((axis: SignalAxis) => (
              <Slider
                key={axis}
                label={axis}
                hint={SIGNAL_COPY[axis]}
                value={signals[axis]}
                min={0}
                max={1}
                step={0.01}
                accent="#38e8ff"
                onChange={(v) => setSignals((prev) => ({ ...prev, [axis]: v }))}
              />
            ))}
          </div>
        </div>

        <div className="panel rounded-xl p-5">
          <button
            type="button"
            onClick={() => setShowWeights((v) => !v)}
            className="flex w-full items-center justify-between"
          >
            <span className="label-lit" style={{ color: "#ffa62b" }}>
              19 action weights
            </span>
            <span className="label">{showWeights ? "hide" : "show"}</span>
          </button>
          <p className="mt-2 text-[11px]" style={{ color: "var(--color-ink-faint)" }}>
            The names are xAI's. The values are ours — production weights were
            never published.
          </p>

          {showWeights ? (
            <div className="mt-4 space-y-3.5">
              {ACTIONS.map((action) => (
                <Slider
                  key={action.key}
                  label={action.label}
                  value={weights[action.key]}
                  min={action.polarity === -1 ? -40 : 0}
                  max={action.polarity === -1 ? 0 : 6}
                  step={0.1}
                  accent={action.polarity === -1 ? "#ff4d6d" : "#ffa62b"}
                  onChange={(v) =>
                    setWeights((prev) => ({ ...prev, [action.key]: v }))
                  }
                />
              ))}
              <button
                type="button"
                onClick={() => setWeights({ ...DEFAULT_WEIGHTS })}
                className="chip w-full py-2 label"
              >
                Reset weights
              </button>
            </div>
          ) : null}
        </div>

        <div className="panel rounded-xl p-5">
          <div className="label-lit">Ranked output</div>
          <ol className="mt-3 space-y-2.5">
            {ranked.slice(0, 8).map((item, i) => (
              <li key={item.post.id} className="flex items-baseline gap-2.5">
                <span
                  className="text-[10px] tabular-nums"
                  style={{ color: "var(--color-ink-faint)", width: 16 }}
                >
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    className="block truncate text-[11.5px]"
                    style={{
                      color:
                        item.post.outrage > 0.6
                          ? "#ff8a4c"
                          : "var(--color-ink)",
                    }}
                  >
                    {item.post.text}
                  </span>
                  <span className="label mt-1 block">
                    {item.post.handle} · score {item.finalScore.toFixed(2)}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        </div>

        <div className="panel rounded-xl p-5">
          <div className="label-lit" style={{ color: "#ff8a4c" }}>
            What the ranker optimised
          </div>
          <dl className="mt-3 space-y-2.5">
            <div className="flex items-baseline justify-between gap-3">
              <dt className="label">Avg outrage · top 5</dt>
              <dd className="text-[13px] tabular-nums" style={{ color: "#ff8a4c" }}>
                {(outrageBias.topOutrage * 100).toFixed(0)}%
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="label">Avg veracity · top 5</dt>
              <dd className="text-[13px] tabular-nums" style={{ color: "#38e8ff" }}>
                {(outrageBias.topVeracity * 100).toFixed(0)}%
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="label">Avg veracity · the rest</dt>
              <dd className="text-[13px] tabular-nums" style={{ color: "var(--color-ink-soft)" }}>
                {(outrageBias.restVeracity * 100).toFixed(0)}%
              </dd>
            </div>
          </dl>
          <p className="mt-3.5 text-[11px] leading-relaxed" style={{ color: "var(--color-ink-faint)" }}>
            Veracity is shown here but is an input to nothing. There is no head
            for it — not because anyone suppressed it, but because none of the
            19 actions measure it.
          </p>
        </div>
      </aside>
    </main>
  );
}
