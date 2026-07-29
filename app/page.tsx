"use client";

/**
 * The Overview cockpit.
 *
 * One screen, no chrome, no sidebar: the core, the workforce around it, and
 * whatever context is true right now. Every other surface in Morpheus is reached
 * from here and returns here.
 */

import { useCallback, useRef, useState } from "react";
import NyxCoreMark from "@/components/brand/NyxCoreMark";
import AgentInspector from "@/components/AgentInspector";
import CommandDock from "@/components/CommandDock";
import dynamic from "next/dynamic";
import HudHeader from "@/components/HudHeader";
import SpecialistCallout from "@/components/SpecialistCallout";
import TranscriptRail from "@/components/TranscriptRail";
import VoiceStatus from "@/components/VoiceStatus";
import { AGENTS_BY_ID } from "@/lib/agents";
import {
  decideAttendance,
  turnId,
  type AttendanceDecision,
  type Turn,
} from "@/lib/orchestrator";
import { useVoice } from "@/lib/useVoice";

// WebGL cannot render on the server, and the scene is the whole page.
const CockpitScene = dynamic(() => import("@/components/morpheus/CockpitScene"), {
  ssr: false,
  loading: () => (
    <div className="absolute inset-0 grid place-items-center gap-5">
      <div className="flex flex-col items-center gap-5">
        <NyxCoreMark size={104} />
        <span className="label-lit pulse-soft">Waking the core…</span>
      </div>
    </div>
  ),
});

const EMPTY_ATTENDANCE: AttendanceDecision = {
  primaryId: null,
  supportingIds: [],
  triggers: [],
  confidence: 0,
};

const OPENERS = [
  "What should I focus on today?",
  "Draft a post about the voice rebuild",
  "How is runway looking?",
  "Find out what competitors charge",
];

export default function Cockpit() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [attendance, setAttendance] = useState<AttendanceDecision>(EMPTY_ATTENDANCE);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [micOn, setMicOn] = useState(false);
  const [local, setLocal] = useState(true);

  // Read inside the async request without making `ask` depend on every turn.
  const turnsRef = useRef<Turn[]>([]);
  turnsRef.current = turns;

  const askRef = useRef<(text: string, forceAgentId?: string) => void>(() => {});

  const voice = useVoice({
    onUtterance: (text) => askRef.current(text),
  });
  const { beginSpeech, speakChunk, endSpeech, setState: setVoiceState } = voice;

  const ask = useCallback(
    async (text: string, forceAgentId?: string) => {
      const operatorTurn: Turn = {
        id: turnId("op"),
        role: "operator",
        text,
        at: Date.now(),
      };
      const history = turnsRef.current;
      setTurns([...history, operatorTurn]);
      setSelectedId(null);
      setVoiceState("thinking");

      // Light the node immediately from the local decision — waiting for the
      // round trip would make attendance feel like a result rather than a
      // reflex.
      const optimistic = forceAgentId
        ? { primaryId: forceAgentId, supportingIds: [], triggers: [], confidence: 1 }
        : decideAttendance(text);
      setAttendance(optimistic);

      try {
        const response = await fetch("/api/morpheus", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ utterance: text, history, forceAgentId }),
        });

        if (!response.ok || !response.body) {
          throw new Error(`Orchestrator returned ${response.status}`);
        }

        // The reply arrives as it is generated. A placeholder turn is appended
        // up front and rewritten in place as deltas land.
        const replyId = turnId("th");
        let reply = "";
        // Only whole sentences are handed to speech — synthesising fragments
        // makes the cadence robotic.
        let unspoken = "";
        beginSpeech();

        setTurns((prev) => [
          ...prev,
          { id: replyId, role: "specialist", agentId: optimistic.primaryId ?? undefined, text: "", at: Date.now() },
        ]);

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        const handle = (event: string, payload: Record<string, unknown>) => {
          if (event === "meta") {
            const meta = payload as unknown as { attendance?: AttendanceDecision };
            if (meta.attendance) {
              setAttendance(meta.attendance);
              setTurns((prev) =>
                prev.map((t) =>
                  t.id === replyId
                    ? { ...t, agentId: meta.attendance?.primaryId ?? t.agentId }
                    : t,
                ),
              );
            }
          } else if (event === "delta") {
            const delta = String(payload.text ?? "");
            reply += delta;
            unspoken += delta;
            setTurns((prev) =>
              prev.map((t) => (t.id === replyId ? { ...t, text: reply } : t)),
            );

            const boundary = unspoken.lastIndexOf(". ");
            const end = Math.max(boundary, unspoken.lastIndexOf("? "), unspoken.lastIndexOf("! "));
            if (end > 0) {
              speakChunk(unspoken.slice(0, end + 1));
              unspoken = unspoken.slice(end + 1);
            }
          } else if (event === "done") {
            if (unspoken.trim()) speakChunk(unspoken);
            unspoken = "";
            endSpeech();
            setLocal(Boolean(payload.local));
          }
        };

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";

          for (const frame of frames) {
            const eventLine = frame.split("\n").find((l) => l.startsWith("event:"));
            const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
            if (!eventLine || !dataLine) continue;
            try {
              handle(eventLine.slice(6).trim(), JSON.parse(dataLine.slice(5).trim()));
            } catch {
              // A malformed frame should not kill a good stream.
            }
          }
        }

        // The stream can end without a `done` frame if the server dies.
        endSpeech();
      } catch (error) {
        setTurns((prev) => [
          ...prev,
          {
            id: turnId("err"),
            role: "system",
            text:
              error instanceof Error
                ? `Orchestrator unreachable — ${error.message}`
                : "Orchestrator unreachable.",
            at: Date.now(),
          },
        ]);
        setVoiceState(micOn ? "listening" : "idle");
      }
    },
    [beginSpeech, endSpeech, micOn, setVoiceState, speakChunk],
  );

  askRef.current = (text, forceAgentId) => {
    void ask(text, forceAgentId);
  };

  const toggleListening = useCallback(() => {
    if (micOn) {
      voice.stopListening();
      setMicOn(false);
    } else {
      voice.startListening();
      setMicOn(true);
    }
  }, [micOn, voice]);

  const summon = useCallback(
    (agentId: string) => {
      const agent = AGENTS_BY_ID[agentId];
      if (!agent) return;
      void ask(`${agent.name}, take this one.`, agentId);
    },
    [ask],
  );

  return (
    <main className="relative h-screen w-screen overflow-hidden">
      {/* The workforce, always running behind everything else. */}
      <div className="absolute inset-0 z-0">
        <CockpitScene
          primaryId={attendance.primaryId}
          supportingIds={attendance.supportingIds}
          voiceState={voice.state}
          levelsRef={voice.levelsRef}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      </div>

      <HudHeader voiceState={voice.state} voiceEngaged={micOn} local={local} />

      <VoiceStatus
        state={voice.state}
        interim={voice.interim}
        onInterrupt={voice.stopSpeaking}
      />

      <SpecialistCallout
        primaryId={attendance.primaryId}
        supportingIds={attendance.supportingIds}
        triggers={attendance.triggers}
        active={attendance.primaryId !== null}
      />

      <TranscriptRail turns={turns} />

      <AgentInspector
        agentId={selectedId}
        onClose={() => setSelectedId(null)}
        onSummon={summon}
      />

      {/* Openers, shown only until the operator says something. */}
      {turns.length === 0 ? (
        <div className="pointer-events-auto absolute bottom-28 left-1/2 z-20 flex -translate-x-1/2 flex-wrap justify-center gap-2 px-8">
          {OPENERS.map((opener) => (
            <button
              key={opener}
              type="button"
              onClick={() => void ask(opener)}
              className="chip px-3.5 py-2 text-[11px] transition-colors hover:text-[color:var(--color-signal)]"
              style={{ color: "var(--color-ink-faint)" }}
            >
              {opener}
            </button>
          ))}
        </div>
      ) : null}

      <CommandDock
        state={voice.state}
        listening={micOn}
        supported={voice.supported}
        micLive={voice.micLive}
        transcribing={voice.transcribing}
        onToggleListening={toggleListening}
        onSubmit={(text) => void ask(text)}
      />
    </main>
  );
}
