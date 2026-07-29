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
import NewsDock from "@/components/NewsDock";
import { AGENTS_BY_ID } from "@/lib/agents";
import type { LiveHeadline } from "@/lib/live-news";
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

export default function Cockpit() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [attendance, setAttendance] = useState<AttendanceDecision>(EMPTY_ATTENDANCE);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [micOn, setMicOn] = useState(false);
  const [local, setLocal] = useState(true);
  const [news, setNews] = useState<LiveHeadline[]>([]);

  // Read inside the async request without making `ask` depend on every turn.
  const turnsRef = useRef<Turn[]>([]);
  turnsRef.current = turns;

  const askRef = useRef<(text: string, forceAgentId?: string) => void>(() => {});
  const activeRequestRef = useRef<AbortController | null>(null);

  const voice = useVoice({
    onUtterance: (text) => askRef.current(text),
    onInterrupt: () => activeRequestRef.current?.abort(),
  });
  const {
    speak,
    setState: setVoiceState,
    showOutcome,
    stopSpeaking,
  } = voice;

  const ask = useCallback(
    async (text: string, forceAgentId?: string) => {
      activeRequestRef.current?.abort();
      const controller = new AbortController();
      activeRequestRef.current = controller;
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

      let responseStarted = false;
      try {
        const response = await fetch("/api/morpheus", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ utterance: text, history, forceAgentId }),
          signal: controller.signal,
        });

        if (!response.ok || !response.body) {
          throw new Error(`Orchestrator returned ${response.status}`);
        }
        responseStarted = true;

        // The reply arrives as it is generated. A placeholder turn is appended
        // up front and rewritten in place as deltas land.
        const replyId = turnId("th");
        let reply = "";
        let sawDone = false;

        setTurns((prev) => [
          ...prev,
          { id: replyId, role: "specialist", agentId: optimistic.primaryId ?? undefined, text: "", at: Date.now() },
        ]);

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        const handle = (event: string, payload: Record<string, unknown>) => {
          if (controller.signal.aborted) return;
          if (event === "meta") {
            setVoiceState("executing");
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
            setTurns((prev) =>
              prev.map((t) => (t.id === replyId ? { ...t, text: reply } : t)),
            );
          } else if (event === "done") {
            sawDone = true;
            setLocal(Boolean(payload.local));
          } else if (event === "news") {
            const incoming = payload.headlines;
            if (Array.isArray(incoming)) {
              setNews(incoming as LiveHeadline[]);
            }
          } else if (event === "action") {
            const type = String(payload.type ?? "");
            const url = String(payload.url ?? "");
            if (
              type === "navigate" &&
              (url.startsWith("/") ||
                url.startsWith("https://accounts.google.com/") ||
                url.startsWith("https://www.facebook.com/"))
            ) {
              window.location.assign(url);
            }
          }
        };

        for (;;) {
          if (controller.signal.aborted) break;
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

        // A stream ending without its receipt is not success. Keep it visually
        // distinct so a partial answer cannot look completed.
        if (sawDone) {
          if (reply.trim()) speak(reply);
          else showOutcome("completed");
        } else {
          stopSpeaking();
          showOutcome("outcome-uncertain", 1800);
        }
      } catch (error) {
        if (controller.signal.aborted) return;
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
        showOutcome(responseStarted ? "outcome-uncertain" : "failed", 1800);
      } finally {
        if (activeRequestRef.current === controller) activeRequestRef.current = null;
      }
    },
    [
      setVoiceState,
      showOutcome,
      speak,
      stopSpeaking,
    ],
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

      <HudHeader
        voiceState={voice.state}
        voiceEngaged={micOn}
        local={local}
        onNews={setNews}
      />

      <div className="workforce-key pointer-events-none absolute right-8 top-40 z-10 hidden md:block">
        <div>Specialists</div>
        <span>Hover or tap a light</span>
      </div>

      <VoiceStatus
        state={voice.state}
        interim={voice.interim}
        micLive={voice.micLive}
        onInterrupt={voice.stopSpeaking}
      />

      <SpecialistCallout
        primaryId={attendance.primaryId}
        supportingIds={attendance.supportingIds}
        triggers={attendance.triggers}
        active={attendance.primaryId !== null}
      />

      <TranscriptRail turns={turns} />
      <NewsDock headlines={news} />

      <AgentInspector
        agentId={selectedId}
        onClose={() => setSelectedId(null)}
        onSummon={summon}
      />

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
