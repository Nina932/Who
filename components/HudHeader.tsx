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
  onThisDay,
} from "@/lib/ambient";
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
  /** True once the operator has granted the mic and Thor is listening. */
  voiceEngaged: boolean;
  /** True when replies are generated locally rather than by a live model. */
  local: boolean;
}

interface Ambient {
  operator: string;
  city: string;
  temperature: number;
  conditions: string;
  live: boolean;
}

export default function HudHeader({ voiceState, voiceEngaged, local }: HudHeaderProps) {
  // Fetched at runtime rather than inlined at build time, so changing your
  // name or city in .env.local takes effect on the next page load.
  const [ambient, setAmbient] = useState<Ambient | null>(null);

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
              ["/today", "Today"],
              ["/cases", "Cases"],
              ["/waiting", "Waiting"],
              ["/week", "The week"],
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
        <Lamp label="Thor" on />
        <Lamp label="Local" on={local} tone="signal" />
        <Lamp
          label="Voice"
          on={voiceEngaged}
          tone={voiceState === "speaking" ? "attend" : "signal"}
        />
      </div>

      {/* On this day */}
      <div className="mt-7 max-w-[380px]">
        <div className="label-lit">On this day</div>
        <p
          className="mt-2 text-[12.5px] leading-[1.65]"
          style={{ color: "var(--color-ink-soft)" }}
        >
          {now ? onThisDay(now) : " "}
        </p>
      </div>
    </header>
  );
}
