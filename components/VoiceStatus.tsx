"use client";

/**
 * The floor indicator.
 *
 * One chip, centred at the top of the cockpit, that always answers "whose
 * turn is it". While Morpheus is speaking it doubles as the interrupt: tapping
 * kills playback and hands the floor straight back to the operator.
 */

import type { VoiceState } from "@/lib/useVoice";

const COPY: Record<VoiceState, { text: string; tone: "signal" | "attend" | "muted" }> = {
  idle: { text: "Standing by", tone: "muted" },
  listening: { text: "Listening", tone: "signal" },
  // Measured, not inferred: this appears only while the microphone level is
  // actually above the speech floor. See `lib/audio.ts`.
  hearing: { text: "Hearing you", tone: "attend" },
  thinking: { text: "Thinking", tone: "signal" },
  speaking: { text: "Speaking · tap to stop", tone: "attend" },
};

export interface VoiceStatusProps {
  state: VoiceState;
  interim: string;
  onInterrupt: () => void;
}

export default function VoiceStatus({ state, interim, onInterrupt }: VoiceStatusProps) {
  const { text, tone } = COPY[state];
  const color =
    tone === "attend"
      ? "var(--color-attend)"
      : tone === "signal"
        ? "var(--color-signal)"
        : "var(--color-ink-faint)";

  return (
    <div className="pointer-events-none absolute left-1/2 top-6 z-30 flex -translate-x-1/2 flex-col items-center gap-3">
      <button
        type="button"
        onClick={state === "speaking" ? onInterrupt : undefined}
        disabled={state !== "speaking"}
        className={`${tone === "attend" ? "chip-attend" : "chip"} pointer-events-auto flex items-center gap-2.5 px-4 py-2 transition-all ${
          state === "speaking" ? "cursor-pointer" : "cursor-default"
        }`}
      >
        <span
          className={state === "idle" ? "" : "pulse-soft"}
          style={{
            width: 7,
            height: 7,
            borderRadius: 999,
            background: color,
            boxShadow: `0 0 10px ${color}`,
          }}
        />
        <span className="label" style={{ color }}>
          {text}
        </span>
      </button>

      {/* Partial recognition, shown live so the operator can see it landing. */}
      {interim ? (
        <div
          className="rise-in max-w-[520px] px-4 text-center text-[13px] italic"
          style={{ color: "var(--color-ink-faint)" }}
        >
          {interim}
        </div>
      ) : null}
    </div>
  );
}
