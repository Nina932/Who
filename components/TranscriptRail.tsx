"use client";

/**
 * The conversation, kept to the side.
 *
 * Voice-first does not mean text-blind: the operator needs to scan back over
 * what was said and see which seat each answer came from. Attribution is the
 * point — every reply is stamped with the agent that produced it.
 */

import { useEffect, useRef } from "react";
import { AGENTS_BY_ID } from "@/lib/agents";
import type { Turn } from "@/lib/orchestrator";

export interface TranscriptRailProps {
  turns: Turn[];
}

export default function TranscriptRail({ turns }: TranscriptRailProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  if (turns.length === 0) return null;

  return (
    <div className="pointer-events-auto absolute right-8 top-1/2 z-20 w-[330px] -translate-y-1/2">
      <div className="label-lit mb-3">Transcript</div>
      <div
        ref={scrollRef}
        className="max-h-[46vh] space-y-4 overflow-y-auto pr-2"
      >
        {turns.map((turn) => {
          const agent = turn.agentId ? AGENTS_BY_ID[turn.agentId] : null;
          const isOperator = turn.role === "operator";

          return (
            <div key={turn.id} className="rise-in">
              <div className="mb-1.5 flex items-center gap-2">
                <span
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: 999,
                    background: isOperator
                      ? "var(--color-ink-faint)"
                      : "var(--color-attend)",
                  }}
                />
                <span
                  className="label"
                  style={{
                    color: isOperator
                      ? "var(--color-ink-faint)"
                      : "var(--color-attend)",
                  }}
                >
                  {isOperator ? "You" : (agent?.name ?? "Apex")}
                </span>
              </div>
              <p
                className="whitespace-pre-wrap text-[12.5px] leading-[1.6]"
                style={{
                  color: isOperator ? "var(--color-ink-soft)" : "var(--color-ink)",
                }}
              >
                {turn.text}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
