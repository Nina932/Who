"use client";

/**
 * The Overview cockpit.
 *
 * One screen, no chrome, no sidebar: the core, the workforce around it, and
 * whatever context is true right now. Every other surface in Apex is reached
 * from here and returns here.
 */

import { useCallback, useRef, useState } from "react";
import AgentInspector from "@/components/AgentInspector";
import CommandDock from "@/components/CommandDock";
import Constellation from "@/components/Constellation";
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
  const { speak, setState: setVoiceState } = voice;

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
        const response = await fetch("/api/apex", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ utterance: text, history, forceAgentId }),
        });

        if (!response.ok) throw new Error(`Orchestrator returned ${response.status}`);

        const data = (await response.json()) as {
          attendance: AttendanceDecision;
          reply: string;
          local: boolean;
        };

        setAttendance(data.attendance ?? optimistic);
        setLocal(Boolean(data.local));
        setTurns((prev) => [
          ...prev,
          {
            id: turnId("ax"),
            role: "specialist",
            agentId: data.attendance?.primaryId ?? optimistic.primaryId ?? undefined,
            text: data.reply,
            at: Date.now(),
          },
        ]);
        speak(data.reply);
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
    [micOn, setVoiceState, speak],
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
        <Constellation
          primaryId={attendance.primaryId}
          supportingIds={attendance.supportingIds}
          voiceState={voice.state}
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
        onToggleListening={toggleListening}
        onSubmit={(text) => void ask(text)}
      />
    </main>
  );
}
