"use client";

/**
 * The ambient header: time, weather, greeting, and the three status lamps.
 * Rendered above the constellation with no background of its own so the
 * cockpit reads as one continuous surface.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import NyxCoreMark from "@/components/brand/NyxCoreMark";
import {
  formatClock,
  formatDate,
  greetingLine,
} from "@/lib/ambient";
import type { DailyBriefing } from "@/lib/daily-briefing";
import type { LiveHeadline } from "@/lib/live-news";
import type { VoiceState } from "@/lib/useVoice";

interface LampProps {
  label: string;
  on: boolean;
  tone?: "alive" | "signal" | "attend";
}

function Lamp({ label, on, tone = "alive" }: LampProps) {
  const color =
    tone === "alive"
      ? "var(--color-alive)"
      : tone === "attend"
        ? "var(--color-attend)"
        : "var(--color-signal)";
  return (
    <div className="flex items-center gap-2">
      <span
        className={on ? "pulse-soft" : ""}
        style={{
          width: 7,
          height: 7,
          borderRadius: 999,
          background: on ? color : "rgba(146,171,182,0.28)",
          boxShadow: on ? `0 0 10px ${color}` : "none",
        }}
      />
      <span
        className="label"
        style={{ color: on ? "var(--color-ink)" : "var(--color-ink-faint)" }}
      >
        {label}
      </span>
    </div>
  );
}

export interface HudHeaderProps {
  voiceState: VoiceState;
  /** True once the operator has granted the mic and Morpheus is listening. */
  voiceEngaged: boolean;
  /** True when replies are generated locally rather than by a live model. */
  local: boolean;
  /** Lets the same verified fetch populate the compact news reader. */
  onNews?: (headlines: LiveHeadline[]) => void;
}

interface Ambient {
  operator: string;
  city: string;
  temperature: number;
  conditions: string;
  live: boolean;
}

export default function HudHeader({
  voiceState,
  voiceEngaged,
  local,
  onNews,
}: HudHeaderProps) {
  // Fetched at runtime rather than inlined at build time, so changing your
  // name or city in .env.local takes effect on the next page load.
  const [ambient, setAmbient] = useState<Ambient | null>(null);
  const [briefing, setBriefing] = useState<DailyBriefing | null>(null);
  const [briefingError, setBriefingError] = useState(false);
  const [briefingRefresh, setBriefingRefresh] = useState(0);
  const [briefingHidden, setBriefingHidden] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/ambient")
      .then((r) => r.json())
      .then((data: Ambient) => {
        if (!cancelled) setAmbient(data);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setBriefingError(false);

    void fetch("/api/daily-briefing", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`briefing ${response.status}`);
        return response.json() as Promise<DailyBriefing>;
      })
      .then((data) => {
        setBriefing(data);
        onNews?.(data.headlines);
      })
      .catch((error) => {
        if ((error as Error).name !== "AbortError") setBriefingError(true);
      });

    return () => controller.abort();
  }, [briefingRefresh, onNews]);

  // The clock is client-only; rendering it on the server would guarantee a
  // hydration mismatch within a minute of the page being built.
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000 * 15);
    return () => clearInterval(id);
  }, []);

  return (
    <header className="pointer-events-none relative z-20 px-8 pt-5">
      {/* Crown scan line */}
      <div className="relative mb-6 h-px w-full overflow-hidden">
        <div className="aurora-rule absolute inset-0 opacity-50" />
        <div
          className="scan-sweep absolute top-0 h-px w-1/4"
          style={{
            background:
              "linear-gradient(90deg, transparent, var(--color-signal), transparent)",
            boxShadow: "0 0 10px var(--color-signal)",
          }}
        />
      </div>

      <div className="flex items-start justify-between gap-8">
        {/* Brand + time */}
        <div className="flex min-w-[190px] items-start gap-4">
          <NyxCoreMark size={46} className="mt-1 shrink-0" />
          <div>
            <div
              className="aurora glow-text tabular-nums"
              style={{
                fontSize: 56,
                fontWeight: 200,
                lineHeight: 1,
                letterSpacing: "0.02em",
                fontFamily: "var(--font-display)",
              }}
            >
              {now ? formatClock(now) : "--:--"}
            </div>
            <div className="label mt-2">{now ? formatDate(now) : " "}</div>
            <div className="label mt-2" style={{ color: "var(--color-chrome-dim)" }}>
              NYX Core
            </div>
          </div>
        </div>

        {/* Weather — omitted entirely when there is no live reading, rather
            than showing a hardcoded number dressed up as a measurement. */}
        {ambient?.live ? (
          <div className="hidden min-w-[210px] sm:block">
            <div
              className="font-light"
              style={{
                fontSize: 34,
                lineHeight: 1,
                color: "var(--color-signal)",
                fontFamily: "var(--font-display)",
              }}
            >
              {ambient.temperature}°C
            </div>
            <div className="label mt-2">
              {[ambient.city, ambient.conditions].filter(Boolean).join(" · ")}
            </div>
          </div>
        ) : null}

        {/* Greeting + nav */}
        <div className="flex-1 text-right">
          <div
            className="aurora uppercase"
            style={{
              fontSize: 21,
              fontWeight: 300,
              lineHeight: 1.2,
              letterSpacing: "0.12em",
              fontFamily: "var(--font-display)",
            }}
          >
            {now ? greetingLine(now.getHours(), ambient?.operator ?? "") : "Standing by"}
          </div>

          <nav className="pointer-events-auto mt-4 flex flex-wrap items-center justify-end gap-2">
            <span className="chip px-3 py-1.5 label-lit">Overview</span>
            {/* The operational surfaces, in the order they answer questions:
                what's mine, what exists, who's holding what, what fits. */}
            {[
              ["/brief", "Brief"],
              ["/products", "Products"],
              ["/today", "Today"],
              ["/cases", "Cases"],
              ["/waiting", "Waiting"],
              ["/week", "The week"],
              ["/authority", "Authority"],
              ["/loops", "Loops"],
              ["/social", "Social"],
            ].map(([href, label]) => (
              <Link
                key={href}
                href={href}
                className="chip px-3 py-1.5 label transition-colors hover:text-[color:var(--color-signal)]"
              >
                {label}
              </Link>
            ))}
            <Link
              href="/connect"
              className="chip px-3 py-1.5 label transition-colors hover:text-[color:var(--color-signal)]"
            >
              Connect
            </Link>
          </nav>
        </div>
      </div>

      {/* Status lamps */}
      <div className="mt-6 flex flex-wrap items-center gap-x-7 gap-y-3">
        <Lamp label="Morpheus" on />
        <Lamp label="Local" on={local} tone="signal" />
        <Lamp
          label="Voice"
          on={voiceEngaged}
          tone={voiceState === "speaking" ? "attend" : "signal"}
        />
      </div>

      {/* A truthful aggregation of the connected surfaces. Historical context
          remains available, but it no longer masquerades as today's brief. */}
      {briefingHidden ? (
        <button
          type="button"
          className="chip pointer-events-auto mt-7 px-4 py-2 label-lit"
          onClick={() => setBriefingHidden(false)}
        >
          Show today&apos;s briefing
        </button>
      ) : (
      <div className="daily-briefing-panel pointer-events-auto mt-7 max-w-[440px] overflow-hidden rounded-2xl border px-4 py-3">
        <div className="flex items-center justify-between gap-4">
          <div className="label-lit">Today&apos;s briefing</div>
          <div className="flex items-center gap-3">
            {briefing ? (
              <div className="label">
                {briefing.coverage.live}/{briefing.coverage.total} ready ·{" "}
                {new Date(briefing.generatedAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </div>
            ) : null}
            <button
              type="button"
              className="label transition-colors hover:text-[color:var(--color-signal)]"
              onClick={() => setBriefingHidden(true)}
            >
              Hide
            </button>
          </div>
        </div>

        {!briefing && !briefingError ? (
          <div className="label mt-3 pulse-soft">Checking connected sources…</div>
        ) : null}

        {briefingError ? (
          <div className="mt-3 flex items-center justify-between gap-4">
            <span className="text-[12px]" style={{ color: "var(--color-ink-soft)" }}>
              Briefing sources could not be reached.
            </span>
            <button
              type="button"
              className="label-lit"
              onClick={() => setBriefingRefresh((value) => value + 1)}
            >
              Retry
            </button>
          </div>
        ) : null}

        {briefing ? (
          <p
            className="mt-3 text-[12.5px] leading-relaxed"
            style={{ color: "var(--color-ink)" }}
          >
            {briefing.summary}
          </p>
        ) : null}

        {briefing ? (
          <div className="mt-3 divide-y divide-[rgba(118,208,255,0.09)] border-t border-[rgba(118,208,255,0.09)]">
            {briefing.lines.map((line) => {
              const content = (
                <>
                  <span
                    className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{
                      background:
                        line.state === "live"
                          ? "var(--color-alive)"
                          : line.state === "empty"
                            ? "var(--color-signal)"
                            : "rgba(146,171,182,0.35)",
                      boxShadow:
                        line.state === "live"
                          ? "0 0 8px var(--color-alive)"
                          : "none",
                    }}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="label block">{line.label}</span>
                    <span
                      className="mt-0.5 block truncate text-[12.5px]"
                      style={{ color: "var(--color-ink)" }}
                    >
                      {line.text}
                    </span>
                    {line.detail ? (
                      <span
                        className="mt-0.5 block truncate text-[10.5px]"
                        style={{ color: "var(--color-ink-faint)" }}
                      >
                        {line.detail}
                      </span>
                    ) : null}
                  </span>
                  {line.href ? (
                    <span
                      className="mt-1 text-[12px]"
                      style={{ color: "var(--color-signal)" }}
                      aria-hidden="true"
                    >
                      ↗
                    </span>
                  ) : null}
                </>
              );

              return line.href ? (
                <a
                  key={line.id}
                  href={line.href}
                  target={line.external ? "_blank" : undefined}
                  rel={line.external ? "noreferrer noopener" : undefined}
                  className="daily-briefing-line flex gap-3 py-2.5"
                >
                  {content}
                </a>
              ) : (
                <div key={line.id} className="flex gap-3 py-2.5">
                  {content}
                </div>
              );
            })}
          </div>
        ) : null}

        {briefing?.almanac ? (
          <details className="mt-2 border-t border-[rgba(118,208,255,0.09)] pt-2">
            <summary className="label cursor-pointer select-none">On this day</summary>
            <p
              className="mt-2 text-[11px] leading-relaxed"
              style={{ color: "var(--color-ink-soft)" }}
            >
              {briefing.almanac}
            </p>
          </details>
        ) : null}
      </div>
      )}
    </header>
  );
}
