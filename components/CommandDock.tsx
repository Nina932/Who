"use client";

/**
 * The dock: voice mode, the microphone, a live waveform, and a typed fallback.
 *
 * Voice is the primary channel, but a cockpit that only works when the room is
 * quiet is not a cockpit. The typed path runs through exactly the same
 * orchestrator, so attendance behaves identically either way.
 *
 * Everything that moves in here is driven by CSS custom properties written
 * from `lib/useVoice.ts` — real analyser readings, not a timer. If the bars
 * are still, the microphone is not being heard, and the dock should say so by
 * standing still rather than by animating reassuringly.
 */

import { useState } from "react";
import type { VoiceState } from "@/lib/useVoice";

export interface CommandDockProps {
  state: VoiceState;
  listening: boolean;
  supported: boolean;
  /** True once the microphone is actually open, not merely requested. */
  micLive: boolean;
  /** True when spoken words can actually become text — separate from the mic. */
  transcribing: boolean;
  onToggleListening: () => void;
  onSubmit: (text: string) => void;
}

/**
 * A waveform from the three measured bands.
 *
 * Bass in the centre, mids around it, treble at the edges — the shape a
 * spectrum analyser has had since they were made of valves, so it reads
 * instantly. `--i` staggers each bar's transition slightly, which is what
 * turns thirty-nine independent heights into something that travels.
 */
const BAND_FOR_DISTANCE = [
  "--voice-bass",
  "--voice-bass",
  "--voice-mids",
  "--voice-mids",
  "--voice-mids",
  "--voice-treble",
] as const;

function Waveform({ bars, className = "" }: { bars: number; className?: string }) {
  const centre = (bars - 1) / 2;
  return (
    <div className={`voice-bars ${className}`} aria-hidden>
      {Array.from({ length: bars }, (_, index) => {
        const distance = Math.round((Math.abs(index - centre) / centre) * 5);
        return (
          <span
            key={index}
            className="voice-bar"
            style={{
              ["--band" as string]: `var(${BAND_FOR_DISTANCE[distance]}, 0)`,
              ["--i" as string]: index,
            }}
          />
        );
      })}
    </div>
  );
}

export default function CommandDock({
  state,
  listening,
  supported,
  micLive,
  transcribing,
  onToggleListening,
  onSubmit,
}: CommandDockProps) {
  const [draft, setDraft] = useState("");

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    onSubmit(text);
  };

  /**
   * The microphone and the transcription service are separate things that fail
   * separately, and a single "voice unavailable" line for both is a lie half
   * the time. Say which one is missing.
   */
  const note = !supported
    ? "Voice unavailable in this browser — the typed path is identical."
    : !listening
      ? null
      : !micLive
        ? "Waiting on microphone access — the orb will not react until it is granted."
        : !transcribing
          ? "Microphone live. This browser cannot transcribe speech, so type your words — the orb still hears you."
          : null;

  const mode = listening ? "ACTIVE" : "STANDBY";
  const floor =
    state === "hearing"
      ? "HEARING YOU…"
      : state === "speaking"
        ? "SPEAKING"
        : state === "thinking"
          ? "WORKING"
          : listening
            ? "AWAITING YOU"
            : "TAP TO SPEAK";

  return (
    <div className="pointer-events-auto absolute bottom-7 left-1/2 z-30 w-[880px] max-w-[calc(100vw-3rem)] -translate-x-1/2">
      <div className="panel flex items-center gap-4 rounded-full py-2.5 pl-5 pr-3">
        {/* Voice mode — the standing fact, left of the control that changes it. */}
        <div className="hidden shrink-0 items-center gap-2.5 sm:flex">
          <Waveform bars={7} className="opacity-70" />
          <div className="leading-tight">
            <div className="label">Voice mode</div>
            <div
              className="label"
              style={{
                color: listening ? "var(--color-attend)" : "var(--color-ink-faint)",
              }}
            >
              {mode}
            </div>
          </div>
        </div>

        {/* The microphone, with a ring that expands on the measured level. */}
        <div className="relative shrink-0">
          {micLive ? (
            <>
              <span className="voice-ring" />
              <span className="voice-ring voice-ring-outer" />
            </>
          ) : null}
          <button
            type="button"
            onClick={onToggleListening}
            disabled={!supported}
            title={
              !supported
                ? "This browser has neither speech recognition nor a microphone"
                : listening
                  ? "Stop listening"
                  : "Start listening"
            }
            className={`${listening ? "mic-button mic-button-live" : "mic-button"} relative flex h-[52px] w-[52px] items-center justify-center rounded-full transition-all disabled:opacity-35`}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
              <rect
                x="9"
                y="2"
                width="6"
                height="12"
                rx="3"
                stroke="currentColor"
                strokeWidth="1.7"
              />
              <path
                d="M5 11a7 7 0 0 0 14 0M12 18v4"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
              />
            </svg>
            <span className="sr-only">
              {listening ? "Stop listening" : "Start listening"}
            </span>
          </button>
        </div>

        {/* Whose turn it is, then the live waveform, then the typed path. */}
        <div className="hidden w-[124px] shrink-0 leading-tight md:block">
          <div
            className="label"
            style={{
              color:
                state === "hearing" || state === "speaking"
                  ? "var(--color-attend)"
                  : "var(--color-signal)",
            }}
          >
            {floor}
          </div>
          <div className="label" style={{ color: "var(--color-ink-faint)" }}>
            {transcribing ? "Transcribing" : "Audio only"}
          </div>
        </div>

        {micLive ? <Waveform bars={39} className="hidden flex-1 lg:flex" /> : null}

        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder={
            state === "hearing"
              ? "Hearing you…"
              : listening
                ? "Listening — or type instead"
                : "Talk to Morpheus, or type here"
          }
          className={`min-w-0 bg-transparent text-[13px] outline-none placeholder:text-[color:var(--color-ink-faint)] ${micLive ? "flex-1 lg:max-w-[210px]" : "flex-1"}`}
          style={{ color: "var(--color-ink)" }}
        />

        <button
          type="button"
          onClick={submit}
          disabled={!draft.trim() || state === "thinking"}
          className="chip shrink-0 px-5 py-2.5 label-lit transition-opacity disabled:opacity-30"
        >
          Send
        </button>
      </div>

      {note ? (
        <p
          className="mt-2.5 text-center text-[10.5px]"
          style={{ color: "var(--color-ink-faint)" }}
        >
          {note}
        </p>
      ) : null}
    </div>
  );
}
