"use client";

/**
 * The floor indicator.
 *
 * One chip, centred at the top of the cockpit, that always answers "whose
 * turn is it". While Morpheus is speaking it doubles as the interrupt: tapping
 * kills playback and hands the floor straight back to the operator.
 */

import type { VoicePath, VoiceState } from "@/lib/useVoice";

type Tone = "signal" | "attend" | "muted" | "success" | "danger" | "uncertain";

const COPY: Record<VoiceState, { text: string; tone: Tone }> = {
  idle: { text: "Standing by", tone: "muted" },
  listening: { text: "Listening", tone: "signal" },
  // Measured, not inferred: this appears only while the microphone level is
  // actually above the speech floor. See `lib/audio.ts`.
  hearing: { text: "Hearing you", tone: "attend" },
  thinking: { text: "Thinking", tone: "signal" },
  executing: { text: "Executing", tone: "signal" },
  speaking: { text: "Speaking · tap to stop", tone: "attend" },
  completed: { text: "Completed", tone: "success" },
  failed: { text: "Failed", tone: "danger" },
  "outcome-uncertain": { text: "Outcome uncertain", tone: "uncertain" },
};

export interface VoiceStatusProps {
  state: VoiceState;
  interim: string;
  /** True only after the browser has delivered a real microphone stream. */
  micLive: boolean;
  /** Which engine last spoke. Shown only when it is not the intended one. */
  voicePath: VoicePath;
  onInterrupt: () => void;
}

export default function VoiceStatus({
  state,
  interim,
  micLive,
  voicePath,
  onInterrupt,
}: VoiceStatusProps) {
  const status =
    state === "listening" && !micLive
      ? { text: "Allow microphone to react", tone: "uncertain" as const }
      : COPY[state];
  const { text, tone } = status;
  const color =
    tone === "attend"
      ? "var(--color-attend)"
      : tone === "success"
        ? "#69f2d0"
        : tone === "danger"
          ? "#ff704d"
          : tone === "uncertain"
            ? "#d48cff"
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

      {/* A fallback used to be silent, which read as the voice work never
          having landed. If the local engine is speaking, it says so. */}
      {voicePath.engine === "browser" ? (
        <div
          className="rise-in max-w-[520px] px-4 text-center text-[11px] uppercase tracking-[0.12em]"
          style={{ color: "#d48cff" }}
        >
          Local voice · {voicePath.reason}
        </div>
      ) : null}

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
