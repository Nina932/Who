"use client";

/**
 * Social Command Center.
 *
 * A "needs you" screen before it is a stats screen. The first thing the
 * operator reads is whether anything is waiting on them; the numbers come
 * second, and the loops — the part that actually does the work — come last
 * because they are supposed to be running without supervision.
 *
 * The loops here are the real ones from the Loops Engine, fetched live from
 * /api/loops. "Needs you" is derived from runs genuinely sitting at a gate,
 * not from a hardcoded list.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import LoopCard from "@/components/social/LoopCard";
import PlatformCard from "@/components/social/PlatformCard";
import type { Learning, LoopDefinition, LoopRun } from "@/lib/loops";
import { PLATFORMS } from "@/lib/social";

interface EnginePayload {
  loops: LoopDefinition[];
  runs: LoopRun[];
  learnings: Learning[];
}

/** Seats whose loops belong on this screen. */
const SURFACE_OWNERS = ["social", "sales"];

export default function SocialCommandCenter() {
  const [filter, setFilter] = useState<string>("all");
  const [engine, setEngine] = useState<EnginePayload | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const platforms = useMemo(
    () => (filter === "all" ? PLATFORMS : PLATFORMS.filter((p) => p.id === filter)),
    [filter],
  );

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/loops", { cache: "no-store" });
      if (!response.ok) throw new Error(`Engine returned ${response.status}`);
      setEngine((await response.json()) as EnginePayload);
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
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Action failed.");
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  // The loops this surface owns, each with its most recent run.
  const surfaceLoops = useMemo(() => {
    const loops = (engine?.loops ?? []).filter((l) => SURFACE_OWNERS.includes(l.ownerAgentId));
    return loops.map((loop) => ({
      loop,
      run: (engine?.runs ?? []).find((r) => r.loopId === loop.id),
      learningCount: (engine?.learnings ?? []).filter((l) => l.loopId === loop.id).length,
    }));
  }, [engine]);

  const gated = surfaceLoops.filter((x) => x.run?.status === "awaiting-go");
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

        {error ? (
          <div className="panel mt-6 rounded-xl p-4" style={{ borderColor: "rgba(255,107,107,0.4)" }}>
            <span className="text-[12px]" style={{ color: "var(--color-alert)" }}>
              {error}
            </span>
          </div>
        ) : null}

        {/* Needs you */}
        <section className="mt-9">
          <div className="label-lit">Needs you</div>
          <div className="panel mt-3 rounded-xl p-5">
            {gated.length === 0 ? (
              <p className="text-[13px]" style={{ color: "var(--color-ink-soft)" }}>
                <span style={{ color: "var(--color-alive)" }}>✓</span>{" "}
                {allConnected
                  ? "Nothing is waiting on you. No loop is sitting at a gate."
                  : "Some channels are disconnected — reconnect them to resume their loops."}
              </p>
            ) : (
              <ul className="space-y-3">
                {gated.map(({ loop, run }) => (
                  <li key={loop.id} className="flex items-start gap-3">
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
                      {loop.name} is held at its review gate after{" "}
                      {run?.artifacts.length ?? 0} steps.
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* Platforms */}
        <section className="mt-9">
          <div className="flex items-baseline justify-between gap-4">
            <div className="label-lit">Platforms</div>
            <span className="label">Sample figures · no channel connectors yet</span>
          </div>
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
            <Link href="/loops" className="label transition-colors hover:text-[color:var(--color-signal)]">
              All loops →
            </Link>
          </div>
          {surfaceLoops.length === 0 ? (
            <p className="mt-3 text-[12px]" style={{ color: "var(--color-ink-faint)" }}>
              {engine ? "No loops own this surface." : "Reading the engine…"}
            </p>
          ) : (
            <div className="mt-3 space-y-4">
              {surfaceLoops.map(({ loop, run, learningCount }) => (
                <LoopCard
                  key={loop.id}
                  loop={loop}
                  run={run}
                  learningCount={learningCount}
                  busy={busy === loop.id}
                  onStart={() => void act({ action: "start", loopId: loop.id }, loop.id)}
                  onApprove={(note) =>
                    void act({ action: "approve", runId: run?.id, note }, loop.id)
                  }
                  onReject={(note) =>
                    void act({ action: "reject", runId: run?.id, note }, loop.id)
                  }
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
