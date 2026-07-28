"use client";

/**
 * The ambient header: time, weather, greeting, and the three status lamps.
 * Rendered above the constellation with no background of its own so the
 * cockpit reads as one continuous surface.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  AMBIENT,
  formatClock,
  formatDate,
  greeting,
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
  /** True once the operator has granted the mic and Apex is listening. */
  voiceEngaged: boolean;
  /** True when replies are generated locally rather than by a live model. */
  local: boolean;
}

export default function HudHeader({ voiceState, voiceEngaged, local }: HudHeaderProps) {
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

      <div className="flex items-start justify-between gap-8">
        {/* Time */}
        <div className="min-w-[190px]">
          <div
            className="glow-text font-light tabular-nums"
            style={{
              fontSize: 54,
              lineHeight: 1,
              letterSpacing: "0.04em",
              fontFamily: "var(--font-display)",
            }}
          >
            {now ? formatClock(now) : "--:--"}
          </div>
          <div className="label mt-2">{now ? formatDate(now) : " "}</div>
        </div>

        {/* Weather */}
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
            {AMBIENT.temperature}°C
          </div>
          <div className="label mt-2">
            {AMBIENT.city} · {AMBIENT.conditions}
          </div>
        </div>

        {/* Greeting + nav */}
        <div className="flex-1 text-right">
          <div
            className="font-light uppercase"
            style={{
              fontSize: 22,
              lineHeight: 1.2,
              letterSpacing: "0.14em",
              color: "var(--color-ink-soft)",
              fontFamily: "var(--font-display)",
            }}
          >
            {now ? greeting(now.getHours()) : "Standing by"},
            <br />
            {AMBIENT.operator}
          </div>

          <nav className="pointer-events-auto mt-4 flex items-center justify-end gap-2">
            <span className="chip px-3 py-1.5 label-lit">Overview</span>
            <Link
              href="/social"
              className="chip px-3 py-1.5 label transition-colors hover:text-[color:var(--color-signal)]"
            >
              Social command center
            </Link>
            <Link
              href="/phoenix"
              className="chip-attend px-3 py-1.5 label transition-colors"
              style={{ color: "var(--color-attend)" }}
            >
              Phoenix
            </Link>
          </nav>
        </div>
      </div>

      {/* Status lamps */}
      <div className="mt-6 flex flex-wrap items-center gap-x-7 gap-y-3">
        <Lamp label="Apex" on />
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
