"use client";

/**
 * The voice system.
 *
 * The rebuilt-voice claim in the Reznikov post is about *turn-taking*, not
 * about recognition quality: no push-to-talk, no waiting for a beep, and a
 * hard interrupt whenever the operator starts speaking again. That is what
 * this hook models.
 *
 * States: idle → listening → thinking → speaking → listening (continuous).
 * Tapping during `speaking` stops playback immediately and returns the floor,
 * which is the "TAP TO STOP" affordance visible in the cockpit.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export type VoiceState = "idle" | "listening" | "thinking" | "speaking";

/**
 * How Thor sounds. Tunable without touching the code:
 *
 *   NEXT_PUBLIC_THOR_VOICE_PITCH=0    0 is the deepest the spec allows
 *   NEXT_PUBLIC_THOR_VOICE_RATE=0.78  below ~0.7 diction starts to smear
 *   NEXT_PUBLIC_THOR_VOICE="Microsoft David - English (United States)"
 */
const VOICE = {
  pitch: Number(process.env.NEXT_PUBLIC_THOR_VOICE_PITCH ?? 0),
  rate: Number(process.env.NEXT_PUBLIC_THOR_VOICE_RATE ?? 0.78),
};

// The Web Speech API is still vendor-prefixed and unversioned in lib.dom, so
// we describe only the surface we touch.
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: { 0: { transcript: string }; isFinal: boolean };
  };
}

type RecognitionCtor = new () => SpeechRecognitionLike;

function getRecognitionCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export interface UseVoiceOptions {
  /** Called with a completed utterance from the operator. */
  onUtterance: (text: string) => void;
}

export function useVoice({ onUtterance }: UseVoiceOptions) {
  const [state, setState] = useState<VoiceState>("idle");
  const [interim, setInterim] = useState("");
  const [supported, setSupported] = useState(false);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const wantListeningRef = useRef(false);
  // Kept in a ref so the recognition callbacks never close over a stale prop.
  const onUtteranceRef = useRef(onUtterance);
  onUtteranceRef.current = onUtterance;

  useEffect(() => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      setSupported(false);
      return;
    }
    setSupported(true);

    const recognition = new Ctor();
    recognition.lang = "en-US";
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onresult = (event) => {
      let finalText = "";
      let pending = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (result.isFinal) finalText += result[0].transcript;
        else pending += result[0].transcript;
      }
      setInterim(pending);
      if (finalText.trim()) {
        setInterim("");
        setState("thinking");
        onUtteranceRef.current(finalText.trim());
      }
    };

    recognition.onerror = (event) => {
      // `no-speech` and `aborted` are routine in continuous mode.
      if (event.error !== "no-speech" && event.error !== "aborted") {
        wantListeningRef.current = false;
        setState("idle");
      }
    };

    recognition.onend = () => {
      // Chrome ends the session on its own schedule; restart if still wanted.
      if (wantListeningRef.current) {
        try {
          recognition.start();
        } catch {
          /* already starting — ignore */
        }
      }
    };

    recognitionRef.current = recognition;

    return () => {
      wantListeningRef.current = false;
      recognition.onend = null;
      recognition.abort();
    };
  }, []);

  const startListening = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition) return;
    wantListeningRef.current = true;
    try {
      recognition.start();
      setState("listening");
    } catch {
      // start() throws if already running, which is harmless here.
      setState("listening");
    }
  }, []);

  const stopListening = useCallback(() => {
    const recognition = recognitionRef.current;
    wantListeningRef.current = false;
    recognition?.stop();
    setInterim("");
    setState("idle");
  }, []);

  /** Interrupt: kill playback and hand the floor straight back. */
  const stopSpeaking = useCallback(() => {
    if (typeof window !== "undefined") window.speechSynthesis?.cancel();
    // Drop the queue too, or a half-spoken stream keeps firing after the
    // operator has taken the floor back.
    pendingRef.current = 0;
    doneQueueingRef.current = true;
    setState(wantListeningRef.current ? "listening" : "idle");
  }, []);

  // ── Voice character ─────────────────────────────────────────────────────
  //
  // Aiming for the Transformers register: deep, slow, mechanical. What the
  // browser gives us is pitch, rate and voice choice — real metallic timbre
  // needs ring modulation and distortion, and SpeechSynthesis output cannot be
  // routed into a Web Audio graph, so that is not reachable from here. See
  // docs/ENGINE.md for the path that is.
  //
  // Within those limits: the deepest installed voice, pitch at the floor, and
  // a rate slow enough to land like a pronouncement rather than a readout.
  const voiceRef = useRef<SpeechSynthesisVoice | null>(null);

  useEffect(() => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;

    const choose = () => {
      const voices = window.speechSynthesis.getVoices();
      if (voices.length === 0) return;

      const named = process.env.NEXT_PUBLIC_THOR_VOICE;
      if (named) {
        const exact = voices.find((v) => v.name === named);
        if (exact) {
          voiceRef.current = exact;
          return;
        }
      }

      // Deep male voices, in rough order of how low they actually sit.
      // "David" and "Mark" ship with Windows; "Daniel" and "Alex" with macOS.
      const preferred = ["david", "mark", "daniel", "alex", "george", "rishi"];
      const english = voices.filter((v) => v.lang.toLowerCase().startsWith("en"));

      voiceRef.current =
        preferred
          .map((name) => english.find((v) => v.name.toLowerCase().includes(name)))
          .find(Boolean) ??
        english[0] ??
        voices[0] ??
        null;
    };

    choose();
    // Chrome populates the list asynchronously, often after first paint.
    window.speechSynthesis.addEventListener("voiceschanged", choose);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", choose);
  }, []);

  // ── Incremental speech ──────────────────────────────────────────────────
  // SpeechSynthesis queues natively, so streamed sentences can be enqueued as
  // they complete. State returns to listening only when the queue drains AND
  // no more chunks are coming.
  const pendingRef = useRef(0);
  const doneQueueingRef = useRef(true);

  const beginSpeech = useCallback(() => {
    if (typeof window === "undefined") return;
    window.speechSynthesis?.cancel();
    pendingRef.current = 0;
    doneQueueingRef.current = false;
  }, []);

  const speakChunk = useCallback((text: string) => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    // Bracketed system notes are for the eye, not the ear.
    const spoken = text.replace(/\[[^\]]*\]/g, "").trim();
    if (!spoken) return;

    const utterance = new SpeechSynthesisUtterance(spoken);
    if (voiceRef.current) utterance.voice = voiceRef.current;
    // 0 is the floor the spec allows, and every engine honours it.
    utterance.pitch = VOICE.pitch;
    utterance.rate = VOICE.rate;
    pendingRef.current += 1;

    const settle = () => {
      pendingRef.current = Math.max(0, pendingRef.current - 1);
      if (pendingRef.current === 0 && doneQueueingRef.current) {
        setState(wantListeningRef.current ? "listening" : "idle");
      }
    };

    utterance.onstart = () => setState("speaking");
    utterance.onend = settle;
    utterance.onerror = settle;
    window.speechSynthesis.speak(utterance);
  }, []);

  const endSpeech = useCallback(() => {
    doneQueueingRef.current = true;
    if (pendingRef.current === 0) {
      setState(wantListeningRef.current ? "listening" : "idle");
    }
  }, []);

  const speak = useCallback((text: string) => {
    if (typeof window === "undefined" || !window.speechSynthesis) {
      setState(wantListeningRef.current ? "listening" : "idle");
      return;
    }
    window.speechSynthesis.cancel();

    // Strip the bracketed system notes — they are for the eye, not the ear.
    const spoken = text.replace(/\[[^\]]*\]/g, "").trim();
    if (!spoken) {
      setState(wantListeningRef.current ? "listening" : "idle");
      return;
    }

    const utterance = new SpeechSynthesisUtterance(spoken);
    if (voiceRef.current) utterance.voice = voiceRef.current;
    utterance.pitch = VOICE.pitch;
    utterance.rate = VOICE.rate;
    utterance.onstart = () => setState("speaking");
    utterance.onend = () => setState(wantListeningRef.current ? "listening" : "idle");
    utterance.onerror = () => setState(wantListeningRef.current ? "listening" : "idle");
    window.speechSynthesis.speak(utterance);
  }, []);

  return {
    state,
    setState,
    interim,
    supported,
    startListening,
    stopListening,
    speak,
    beginSpeech,
    speakChunk,
    endSpeech,
    stopSpeaking,
  };
}
