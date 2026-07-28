"use client";

/**
 * Social Command Center.
 *
 * A "needs you" screen before it is a stats screen. The first thing the
 * operator reads is whether anything is waiting on them; the numbers come
 * second, and the loops — the part that actually does the work — come last
 * because they are supposed to be running without supervision.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import GoalLoopRow from "@/components/social/GoalLoopRow";
import PlatformCard from "@/components/social/PlatformCard";
import { ATTENTION, GOAL_LOOPS, PLATFORMS } from "@/lib/social";

export default function SocialCommandCenter() {
  const [filter, setFilter] = useState<string>("all");

  const platforms = useMemo(
    () => (filter === "all" ? PLATFORMS : PLATFORMS.filter((p) => p.id === filter)),
    [filter],
  );

  const needsAction = ATTENTION.filter((a) => a.severity === "action");
  const allConnected = PLATFORMS.every((p) => p.connected);

  return (
    <main className="h-screen w-screen overflow-y-auto">
      <div className="mx-auto max-w-[1180px] px-8 pb-20 pt-6">
        {/* Crown scan line, carried over from the cockpit. */}
        <div className="relative mb-7 h-px w-full overflow-hidden">
          <div className="rule absolute inset-0 opacity-40" />
          <div
            className="scan-sweep absolute top-0 h-px w-1/4"
            style={{
              background:
                "linear-gradient(90deg, transparent, var(--color-signal), transparent)",
              boxShadow: "0 0 10px var(--color-signal)",
            }}
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <Link
              href="/"
              className="chip px-3 py-1.5 label transition-colors hover:text-[color:var(--color-signal)]"
            >
              ← Exit
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
              Social command center
            </h1>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setFilter("all")}
              className={`${filter === "all" ? "chip" : ""} px-3 py-1.5 label transition-colors hover:text-[color:var(--color-signal)]`}
              style={filter === "all" ? { color: "var(--color-signal)" } : undefined}
            >
              All
            </button>
            {PLATFORMS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setFilter(p.id)}
                className={`${filter === p.id ? "chip" : ""} flex items-center gap-2 px-3 py-1.5 label transition-colors hover:text-[color:var(--color-signal)]`}
                style={filter === p.id ? { color: "var(--color-signal)" } : undefined}
              >
                <span
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: 999,
                    background: p.accent,
                    boxShadow: `0 0 8px ${p.accent}`,
                  }}
                />
                {p.name}
              </button>
            ))}
          </div>
        </div>

        {/* Needs you */}
        <section className="mt-9">
          <div className="label-lit">Needs you</div>
          <div className="panel mt-3 rounded-xl p-5">
            {needsAction.length === 0 ? (
              <p className="text-[13px]" style={{ color: "var(--color-ink-soft)" }}>
                <span style={{ color: "var(--color-alive)" }}>✓</span>{" "}
                {allConnected
                  ? "All channels connected and strategies set. Nothing needs your attention."
                  : "Some channels are disconnected — reconnect them to resume their loops."}
              </p>
            ) : (
              <ul className="space-y-3">
                {needsAction.map((item) => (
                  <li key={item.id} className="flex items-start gap-3">
                    <span
                      className="pulse-soft mt-1.5"
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: 999,
                        background: "var(--color-attend)",
                        boxShadow: "0 0 8px var(--color-attend)",
                        flexShrink: 0,
                      }}
                    />
                    <span className="text-[13px]" style={{ color: "var(--color-ink)" }}>
                      {item.text}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* Platforms */}
        <section className="mt-9">
          <div className="label-lit">Platforms</div>
          <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {platforms.map((platform) => (
              <PlatformCard key={platform.id} platform={platform} />
            ))}
          </div>
        </section>

        {/* Goal loops */}
        <section className="mt-9">
          <div className="flex items-baseline justify-between gap-4">
            <div className="label-lit">Goal loops</div>
            <span className="label">
              {GOAL_LOOPS.length} running · autonomy set per loop
            </span>
          </div>
          <div className="mt-3 space-y-4">
            {GOAL_LOOPS.map((loop) => (
              <GoalLoopRow key={loop.id} loop={loop} />
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
