"use client";

/**
 * The voice system.
 *
 * The rebuilt-voice claim in the Reznikov post is about *turn-taking*, not
 * about recognition quality: no push-to-talk, no waiting for a beep, and a
 * hard interrupt whenever the operator starts speaking again. That is what
 * this hook models.
 *
 * States: idle → listening ⇄ hearing → thinking → speaking → listening.
 * Tapping during `speaking` stops playback immediately and returns the floor,
 * which is the "TAP TO STOP" affordance visible in the cockpit.
 *
 * `listening` and `hearing` are separated deliberately. Recognition alone
 * cannot tell them apart: it reports a transcript when a phrase ends and
 * nothing at all before that, so an interface driven by recognition is inert
 * for the entire time somebody is actually talking. The distinction comes from
 * `lib/audio.ts`, which measures the microphone every frame.
 *
 * Two things this hook is careful about:
 *
 * **The measurements never enter React state.** Sixty renders a second would
 * make the whole page stutter. Levels live in a ref that the render loop and
 * the shader read directly; React only sees the four state transitions.
 *
 * **Morpheus does not hear itself.** The analyser is muted for the whole time
 * speech synthesis is playing, on top of the browser's echo cancellation.
 * Without it, its own voice would drive the orb and — far worse — could read
 * as the operator holding the floor.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { SILENT, createAnalyser, type Analyser, type VoiceLevels } from "./audio";
import { PREFERRED_VOICES, deliveryFor } from "./voice";

export type VoiceState = "idle" | "listening" | "hearing" | "thinking" | "speaking";

/**
 * How long the level must stay under the floor before the operator is treated
 * as having stopped. Short enough to feel responsive, long enough to survive
 * the gap between two words.
 */
const SETTLE_MS = 650;

/**
 * How Morpheus sounds. The profile lives in `lib/voice.ts`; tune it with:
 *
 *   NEXT_PUBLIC_MORPHEUS_VOICE_PITCH=0    0 is the deepest the spec allows
 *   NEXT_PUBLIC_MORPHEUS_VOICE_RATE=0.78  below ~0.7 diction starts to smear
 *   NEXT_PUBLIC_MORPHEUS_VOICE="Microsoft David - English (United States)"
 */
const VOICE = deliveryFor("none");

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

  // Three capabilities, tracked apart because they fail apart. Collapsing them
  // into one `supported` flag is what made a browser with no recognition
  // service also refuse to open the microphone.
  const [recognitionSupported, setRecognitionSupported] = useState(false);
  const [micSupported, setMicSupported] = useState(false);
  /** False once recognition has failed for this session. */
  const [transcribing, setTranscribing] = useState(false);
  const recognitionOkRef = useRef(true);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const wantListeningRef = useRef(false);
  // Kept in a ref so the recognition callbacks never close over a stale prop.
  const onUtteranceRef = useRef(onUtterance);
  onUtteranceRef.current = onUtterance;

  // ── The microphone ──────────────────────────────────────────────────────

  const analyserRef = useRef<Analyser | null>(null);
  /** True while a getUserMedia prompt is outstanding. */
  const micPendingRef = useRef(false);
  /** Live audio levels. Consumers read this from their own render loop. */
  const levelsRef = useRef<VoiceLevels>({ ...SILENT });
  const frameRef = useRef<number | null>(null);
  const publishedRef = useRef<Record<string, number>>({});
  const [micLive, setMicLive] = useState(false);

  // The state machine reads the current state from a ref: the rAF loop is
  // started once and must not be torn down and rebuilt on every transition.
  const stateRef = useRef<VoiceState>("idle");
  stateRef.current = state;

  /**
   * Levels out to CSS, for the parts of the interface that are DOM rather
   * than WebGL — the microphone ring and the level bars in the dock.
   *
   * Rounded to two places and written only on change, so a quiet room does not
   * invalidate style every frame for no visible difference.
   */
  const publish = useCallback((levels: VoiceLevels) => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    const values: Record<string, number> = {
      "--voice-level": levels.volume,
      "--voice-bass": levels.bass,
      "--voice-mids": levels.mids,
      "--voice-treble": levels.treble,
    };
    for (const [name, raw] of Object.entries(values)) {
      const value = Math.round(raw * 100) / 100;
      if (publishedRef.current[name] === value) continue;
      publishedRef.current[name] = value;
      root.style.setProperty(name, String(value));
    }
  }, []);

  const pump = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) {
      frameRef.current = null;
      return;
    }

    analyser.sample(performance.now());
    const levels = analyser.levels;
    levelsRef.current = levels;
    publish(levels);

    // listening ⇄ hearing, and only ever between those two. `thinking` and
    // `speaking` own the floor: a sound arriving while Morpheus is talking is
    // not the operator taking a turn, and must not be shown as one.
    const current = stateRef.current;
    if (current === "listening" && levels.speaking) {
      setState("hearing");
    } else if (current === "hearing" && !levels.speaking && levels.quietFor > SETTLE_MS) {
      setState("listening");
    }

    frameRef.current = requestAnimationFrame(pump);
  }, [publish]);

  const openMicrophone = useCallback(async () => {
    if (analyserRef.current || micPendingRef.current) return;
    micPendingRef.current = true;
    try {
      const analyser = await createAnalyser();
      // A refused microphone is a normal outcome. Recognition may still work,
      // and the typed path certainly does — so nothing is thrown.
      if (!analyser) return;
      if (!wantListeningRef.current) {
        // The operator switched it off again while permission was pending.
        analyser.stop();
        return;
      }
      analyserRef.current = analyser;
      setMicLive(true);
      if (frameRef.current === null) frameRef.current = requestAnimationFrame(pump);
    } finally {
      micPendingRef.current = false;
    }
  }, [pump]);

  const closeMicrophone = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    analyserRef.current?.stop();
    analyserRef.current = null;
    // The stopped analyser's object keeps its last values forever; point at a
    // fresh silent one so nothing renders a level that is no longer measured.
    levelsRef.current = { ...SILENT };
    publish(levelsRef.current);
    setMicLive(false);
  }, [publish]);

  // Stopping tracks on unmount is not tidiness — a live track keeps the
  // browser's recording indicator lit after the page is gone.
  useEffect(() => closeMicrophone, [closeMicrophone]);

  /** Morpheus speaking must never reach Morpheus listening. */
  const setDeaf = useCallback((deaf: boolean) => {
    analyserRef.current?.setMuted(deaf);
  }, []);

  // Whether the browser has a microphone API at all, as opposed to whether
  // the operator will grant it. Checked after mount for the same reason the
  // clock is: it does not exist during the server render.
  useEffect(() => {
    setMicSupported(
      typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia,
    );
  }, []);

  useEffect(() => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      setRecognitionSupported(false);
      return;
    }
    setRecognitionSupported(true);

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
      if (event.error === "no-speech" || event.error === "aborted") return;

      // Anything else means transcription is not coming back this session —
      // most often no network path to the recognition service, or a Chromium
      // build without one at all.
      //
      // It must not take the microphone down with it. Recognition and the
      // audio stream are separate grants that fail separately, and the orb,
      // the level meter and the `hearing` state all work without a single
      // word being transcribed. Losing one is a degraded cockpit; treating it
      // as losing both is a dead one.
      recognitionOkRef.current = false;
      setTranscribing(false);
      // Only surrender the floor if there is no audio either — and not while a
      // microphone prompt is still outstanding, which is the common case:
      // recognition fails within milliseconds, permission takes a human.
      if (!analyserRef.current && !micPendingRef.current) {
        wantListeningRef.current = false;
        setState("idle");
      }
    };

    recognition.onend = () => {
      // Chrome ends the session on its own schedule; restart if still wanted.
      if (wantListeningRef.current && recognitionOkRef.current) {
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
    wantListeningRef.current = true;
    recognitionOkRef.current = true;
    setState("listening");

    // Recognition first and synchronously: it must stay inside the click that
    // triggered it, or Safari treats it as an unprompted request.
    const recognition = recognitionRef.current;
    if (recognition) {
      try {
        recognition.start();
        setTranscribing(true);
      } catch {
        // start() throws if already running, which is harmless here.
      }
    }

    // The microphone is a separate grant from recognition, and worth having
    // even where recognition is missing: it still drives the orb.
    void openMicrophone();
  }, [openMicrophone]);

  const stopListening = useCallback(() => {
    const recognition = recognitionRef.current;
    wantListeningRef.current = false;
    recognition?.stop();
    closeMicrophone();
    setTranscribing(false);
    setInterim("");
    setState("idle");
  }, [closeMicrophone]);

  /** Interrupt: kill playback and hand the floor straight back. */
  const stopSpeaking = useCallback(() => {
    if (typeof window !== "undefined") window.speechSynthesis?.cancel();
    // Drop the queue too, or a half-spoken stream keeps firing after the
    // operator has taken the floor back.
    pendingRef.current = 0;
    doneQueueingRef.current = true;
    setDeaf(false);
    setState(wantListeningRef.current ? "listening" : "idle");
  }, [setDeaf]);

  // ── Voice character ─────────────────────────────────────────────────────
  //
  // An original register rather than an impersonation — deep, deliberate,
  // faintly metallic, calm rather than menacing. See `lib/voice.ts` for the
  // full profile and why it is described rather than copied.
  //
  // The browser gives pitch, rate and voice choice. Real metallic timbre needs
  // ring modulation, and SpeechSynthesis output cannot be routed into a Web
  // Audio graph, so it is not reachable from here. Within those limits: the
  // deepest installed voice, pitch at the floor, and a rate slow enough to
  // land like a pronouncement rather than a readout.
  const voiceRef = useRef<SpeechSynthesisVoice | null>(null);

  useEffect(() => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;

    const choose = () => {
      const voices = window.speechSynthesis.getVoices();
      if (voices.length === 0) return;

      const named = process.env.NEXT_PUBLIC_MORPHEUS_VOICE;
      if (named) {
        const exact = voices.find((v) => v.name === named);
        if (exact) {
          voiceRef.current = exact;
          return;
        }
      }

      const preferred = PREFERRED_VOICES;
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
    // A cancelled utterance does not reliably fire `onend` everywhere, so the
    // deaf flag is reset here rather than trusted to unwind on its own.
    setDeaf(false);
  }, [setDeaf]);

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
      // Only once the whole queue has drained. Unmuting in the gap between two
      // chunks would let the tail of one sentence be measured as the operator.
      if (pendingRef.current === 0) setDeaf(false);
      if (pendingRef.current === 0 && doneQueueingRef.current) {
        setState(wantListeningRef.current ? "listening" : "idle");
      }
    };

    utterance.onstart = () => {
      setDeaf(true);
      setState("speaking");
    };
    utterance.onend = settle;
    utterance.onerror = settle;
    window.speechSynthesis.speak(utterance);
  }, [setDeaf]);

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
    const settle = () => {
      setDeaf(false);
      setState(wantListeningRef.current ? "listening" : "idle");
    };

    utterance.onstart = () => {
      setDeaf(true);
      setState("speaking");
    };
    utterance.onend = settle;
    utterance.onerror = settle;
    window.speechSynthesis.speak(utterance);
  }, [setDeaf]);

  return {
    state,
    setState,
    interim,
    /** True when the floor can be taken at all — by either route. */
    supported: recognitionSupported || micSupported,
    /** True when spoken words can actually become text this session. */
    transcribing,
    /**
     * Live microphone levels, updated every frame in place. Read it from a
     * render loop — putting it in state is what this whole arrangement exists
     * to avoid.
     */
    levelsRef,
    /** True while the microphone is open and measuring. */
    micLive,
    startListening,
    stopListening,
    speak,
    beginSpeech,
    speakChunk,
    endSpeech,
    stopSpeaking,
  };
}
