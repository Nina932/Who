"use client";

/**
 * The dock: microphone toggle plus a typed fallback.
 *
 * Voice is the primary channel, but a cockpit that only works when the room
 * is quiet is not a cockpit. The typed path runs through exactly the same
 * orchestrator, so attendance behaves identically either way.
 */

import { useState } from "react";
import type { VoiceState } from "@/lib/useVoice";

export interface CommandDockProps {
  state: VoiceState;
  listening: boolean;
  supported: boolean;
  onToggleListening: () => void;
  onSubmit: (text: string) => void;
}

export default function CommandDock({
  state,
  listening,
  supported,
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

  return (
    <div className="pointer-events-auto absolute bottom-7 left-1/2 z-30 w-[620px] max-w-[calc(100vw-4rem)] -translate-x-1/2">
      <div className="panel flex items-center gap-3 rounded-full py-2 pl-2 pr-3">
        <button
          type="button"
          onClick={onToggleListening}
          disabled={!supported}
          title={
            supported
              ? listening
                ? "Stop listening"
                : "Start listening"
              : "This browser has no speech recognition — type instead"
          }
          className={`${listening ? "chip-attend" : "chip"} flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-all disabled:opacity-35`}
        >
          {/* Microphone */}
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
            <rect
              x="9"
              y="2"
              width="6"
              height="12"
              rx="3"
              stroke={listening ? "var(--color-attend)" : "var(--color-signal)"}
              strokeWidth="1.6"
            />
            <path
              d="M5 11a7 7 0 0 0 14 0M12 18v4"
              stroke={listening ? "var(--color-attend)" : "var(--color-signal)"}
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
          <span className="sr-only">
            {listening ? "Stop listening" : "Start listening"}
          </span>
        </button>

        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder={
            listening ? "Listening — or type instead" : "Talk to Thor, or type here"
          }
          className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-[color:var(--color-ink-faint)]"
          style={{ color: "var(--color-ink)" }}
        />

        <button
          type="button"
          onClick={submit}
          disabled={!draft.trim() || state === "thinking"}
          className="chip shrink-0 px-4 py-2 label-lit transition-opacity disabled:opacity-30"
        >
          Send
        </button>
      </div>

      {!supported ? (
        <p
          className="mt-2.5 text-center text-[10.5px]"
          style={{ color: "var(--color-ink-faint)" }}
        >
          Speech recognition unavailable in this browser — the typed path is identical.
        </p>
      ) : null}
    </div>
  );
}
