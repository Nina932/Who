"use client";

/**
 * The Morpheus cockpit, in three dimensions.
 *
 * Not a diagram of a workforce — a place containing one. The core is a
 * displaced, fresnel-lit body breathing inside a volumetric sky; the agents
 * hang in real orbits around it at real depths; the links are tubes with
 * traffic running along them. The camera never stops moving, and when a
 * specialist is called in the whole rig swings to face them.
 *
 * Everything is additive and bloomed, so brightness is the only hierarchy the
 * eye needs.
 */

import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Html } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { Bloom, EffectComposer, Noise, Vignette } from "@react-three/postprocessing";
import { BlendFunction } from "postprocessing";
import * as THREE from "three";
import { AGENTS, FAMILY_LABEL, type Agent } from "@/lib/agents";
import { SILENT, hueToRgb, type VoiceLevels } from "@/lib/audio";
import { hueWindow, moodFor, toRgb, type MoodProfile } from "@/lib/mood";
import type { VoiceState } from "@/lib/useVoice";
import {
  CORE_FRAG,
  CORE_VERT,
  FLOOR_FRAG,
  FLOOR_VERT,
  NEBULA_FRAG,
  NEBULA_VERT,
  SHELL_FRAG,
  VOLUME_FRAG,
} from "./shaders";

const SIGNAL = new THREE.Color("#3fe0f0");
const ATTEND = new THREE.Color("#f2c14e");
/** Integration seats read as connections to elsewhere, not as colleagues. */
const OUTSIDE = new THREE.Color("#8f7dff");

const DEG = Math.PI / 180;

/** A ref of live microphone levels, or nothing when the mic is closed. */
export type LevelsRef = React.RefObject<VoiceLevels>;

/**
 * Two reductions, from one signal.
 *
 * A vestibular disorder does not care that the motion is pretty, and a
 * four-core laptop does not care that the dust looks better at 3200 points.
 * Both are read once at mount: neither changes mid-session in practice, and
 * re-seeding the particle buffers would be a visible glitch if they did.
 */
function readEnvironment() {
  if (typeof window === "undefined") return { reduced: false, thin: false };
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const thin = (navigator.hardwareConcurrency ?? 8) <= 4;
  return { reduced, thin };
}

// ── Mood and voice, driven together ──────────────────────────────────────

interface VoiceUniforms {
  // The index signature is what three.js's `uniforms` prop expects. The named
  // members below are what makes a typo in `drive` a compile error.
  [name: string]: THREE.IUniform;
  uTime: { value: number };
  uEnergy: { value: number };
  uVoiceVolume: { value: number };
  uBass: { value: number };
  uMids: { value: number };
  uTreble: { value: number };
  uEmphasis: { value: number };
  uColor: { value: THREE.Color };
  uHot: { value: THREE.Color };
}

interface FloorUniforms extends VoiceUniforms {
  uLayer: { value: number };
}

function voiceUniforms(): VoiceUniforms {
  return {
    uTime: { value: 0 },
    uEnergy: { value: 0 },
    uVoiceVolume: { value: 0 },
    uBass: { value: 0 },
    uMids: { value: 0 },
    uTreble: { value: 0 },
    uEmphasis: { value: 0 },
    uColor: { value: new THREE.Color("#3fe0f0") },
    uHot: { value: new THREE.Color("#b9fbff") },
  };
}

function floorUniforms(layer: number): FloorUniforms {
  return { ...voiceUniforms(), uLayer: { value: layer } };
}

interface Tint {
  base: THREE.Color;
  hot: THREE.Color;
  accent: THREE.Color;
  centre: number;
  range: number;
  /** Scratch, reused every frame so no allocation happens in the loop. */
  scratch: THREE.Color;
}

function useTint(mood: MoodProfile): Tint {
  return useMemo(() => {
    const { centre, range } = hueWindow(mood);
    return {
      base: new THREE.Color(...toRgb(mood.palette.base)),
      hot: new THREE.Color(...toRgb(mood.palette.hot)),
      accent: new THREE.Color(...toRgb(mood.palette.accent)),
      centre,
      range,
      scratch: new THREE.Color(),
    };
  }, [mood]);
}

/**
 * One frame of both channels into one uniform set.
 *
 * The two are combined here and nowhere else, so the core, the shell and the
 * floor cannot drift into disagreeing about what Morpheus is doing.
 *
 * Note the asymmetry. The scalars are assigned outright — they are already
 * smoothed in `lib/audio.ts`, and easing them twice would only add lag to the
 * one channel that has to feel instant. Colour is eased, because a mood
 * change is a change of subject and should take about a second to land.
 */
function drive(
  u: VoiceUniforms,
  v: VoiceLevels,
  mood: MoodProfile,
  tint: Tint,
  gain: number,
  delta: number,
): void {
  u.uTime.value += delta;

  // Emphasis rides in energy rather than in displacement, so a stressed word
  // flares the bloom as well as the surface.
  const target = Math.min(1.6, mood.energy + (v.volume * 0.45 + v.emphasis * 0.35) * gain);
  u.uEnergy.value += (target - u.uEnergy.value) * 0.05;

  u.uVoiceVolume.value = v.volume * gain;
  u.uBass.value = v.bass * gain;
  u.uMids.value = v.mids * gain;
  u.uTreble.value = v.treble * gain;
  // Keep the attack outside the slow state-energy easing. A hard consonant
  // should reach the surface on the frame it happens.
  u.uEmphasis.value = v.emphasis * gain;

  // Hue moves inside the window the mood allows, and no further. Mids and
  // treble push it; loudness decides how much of that push actually lands.
  const hue = tint.centre + (v.mids * 0.4 + v.treble * 0.6) * tint.range;
  tint.scratch.setRGB(...hueToRgb(hue));
  tint.scratch.lerpColors(tint.base, tint.scratch, Math.min(1, v.volume * 1.4));

  // State changes must be legible before a short spoken sentence ends.
  u.uColor.value.lerp(tint.scratch, 0.13);
  u.uHot.value.lerp(tint.hot, 0.13);
}

/**
 * Agents live on a real sphere. Azimuth keeps each agent roughly where it sat
 * in the flat layout, while `orbit` becomes latitude *and* distance — so depth
 * carries the same meaning the 2D version encoded with radius alone.
 */
function agentPosition(agent: Agent): THREE.Vector3 {
  const az = agent.angle * DEG;
  const el = (agent.orbit - 0.66) * 1.35;
  const r = 10.5 + agent.orbit * 4.5 + (agent.family === "integration" ? 3.5 : 0);
  return new THREE.Vector3(
    r * Math.cos(el) * Math.cos(az),
    r * Math.sin(el),
    r * Math.cos(el) * Math.sin(az),
  );
}

// ── Sky ──────────────────────────────────────────────────────────────────

function Nebula({ mood }: { mood: MoodProfile }) {
  const tint = useTint(mood);
  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uEnergy: { value: 0 },
      uBase: { value: new THREE.Color("#18386f") },
      uAccent: { value: new THREE.Color("#3ec2ff") },
    }),
    [],
  );

  useFrame((_, delta) => {
    uniforms.uTime.value += delta;
    uniforms.uEnergy.value += (mood.energy - uniforms.uEnergy.value) * 0.03;
    uniforms.uBase.value.lerp(tint.base, 0.018);
    uniforms.uAccent.value.lerp(tint.accent, 0.018);
  });

  return (
    <mesh scale={[-1, 1, 1]}>
      <sphereGeometry args={[150, 48, 32]} />
      <shaderMaterial
        vertexShader={NEBULA_VERT}
        fragmentShader={NEBULA_FRAG}
        uniforms={uniforms}
        depthWrite={false}
        side={THREE.BackSide}
      />
    </mesh>
  );
}

// ── The core ─────────────────────────────────────────────────────────────

interface CoreProps {
  mood: MoodProfile;
  /**
   * Read inside `useFrame`, never as a prop. Same reason `attendRef` is a ref:
   * a value passed down as a number is whatever it was at the last render,
   * which for audio means frozen at roughly zero.
   */
  levelsRef?: LevelsRef;
  reduced: boolean;
  thin: boolean;
}

function EtherFilaments({
  mood,
  levelsRef,
  reduced,
}: Pick<CoreProps, "mood" | "levelsRef" | "reduced">) {
  const group = useRef<THREE.Group>(null);
  const inner = useMemo(() => {
    return Array.from({ length: 6 }, (_, index) => {
      const positions = new Float32Array(72 * 3);
      const phase = index * 0.71;
      const tilt = new THREE.Euler(
        0.28 + index * 0.39,
        -0.34 + index * 0.51,
        index * 0.63,
      );
      for (let point = 0; point < 72; point += 1) {
        const angle = (point / 72) * Math.PI * 2;
        const radius =
          4.35 +
          Math.sin(angle * 3 + phase) * 0.42 +
          Math.sin(angle * 7 - phase) * 0.16;
        const vector = new THREE.Vector3(
          Math.cos(angle) * radius,
          Math.sin(angle) * radius * (0.76 + (index % 3) * 0.08),
          Math.sin(angle * 2 + phase) * (0.34 + (index % 2) * 0.16),
        ).applyEuler(tilt);
        positions.set([vector.x, vector.y, vector.z], point * 3);
      }
      return positions;
    });
  }, []);
  const outer = useMemo(() => {
    return Array.from({ length: 4 }, (_, index) => {
      const positions = new Float32Array(96 * 3);
      const phase = index * 1.17;
      const tilt = new THREE.Euler(
        0.48 + index * 0.61,
        0.18 + index * 0.46,
        -0.36 + index * 0.73,
      );
      for (let point = 0; point < 96; point += 1) {
        const angle = (point / 96) * Math.PI * 2;
        const radius = 5.85 + index * 0.18 + Math.sin(angle * 5 + phase) * 0.12;
        const vector = new THREE.Vector3(
          Math.cos(angle) * radius,
          Math.sin(angle) * radius * 0.72,
          Math.sin(angle * 3 + phase) * 0.22,
        ).applyEuler(tilt);
        positions.set([vector.x, vector.y, vector.z], point * 3);
      }
      return positions;
    });
  }, []);
  const tint = useTint(mood);
  const gain = reduced ? 0.3 : 1;

  useFrame((state, delta) => {
    if (!group.current) return;
    const levels = levelsRef?.current ?? SILENT;
    const loudness = Math.sqrt(levels.volume);
    group.current.rotation.y += delta * (0.08 + loudness * 0.36 * gain);
    group.current.rotation.x =
      Math.sin(state.clock.getElapsedTime() * 0.23) * 0.13 +
      Math.sqrt(levels.mids) * 0.08 * gain;
    group.current.rotation.z += delta * (0.025 + Math.sqrt(levels.treble) * 0.16 * gain);
    group.current.scale.set(
      1 + Math.sqrt(levels.bass) * 0.055 * gain + levels.emphasis * 0.04 * gain,
      1 + loudness * 0.035 * gain,
      1 - levels.emphasis * 0.025 * gain,
    );
    group.current.children.forEach((child, index) => {
      const material = (child as THREE.Line).material as THREE.LineBasicMaterial;
      material.color.lerp(
        index % 5 === 0 ? OUTSIDE : tint.hot,
        0.06,
      );
      material.opacity =
        (index < inner.length ? 0.16 : 0.24) +
        mood.energy * 0.08 +
        loudness * 0.22 * gain +
        levels.emphasis * 0.18 * gain;
    });
  });

  return (
    <group ref={group}>
      {[...inner, ...outer].map((positions, index) => (
        <lineLoop key={index}>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[positions, 3]} />
          </bufferGeometry>
          <lineBasicMaterial
            color={index % 5 === 0 ? OUTSIDE : tint.hot}
            transparent
            opacity={index < inner.length ? 0.16 : 0.24}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </lineLoop>
      ))}
    </group>
  );
}

function Core({ mood, levelsRef, reduced, thin }: CoreProps) {
  const group = useRef<THREE.Group>(null);
  const swarm = useRef<THREE.Points>(null);

  const coreUniforms = useMemo(voiceUniforms, []);
  const shellUniforms = useMemo(voiceUniforms, []);
  const volumeUniforms = useMemo(voiceUniforms, []);
  const tint = useTint(mood);

  // Reduced motion damps the voice reaction rather than removing it: the orb
  // must still answer, or the microphone indicator becomes a claim with no
  // evidence behind it.
  const gain = reduced ? 0.3 : 1;

  const swarmPositions = useMemo(() => {
    const count = thin ? 900 : 2600;
    const arr = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      // Fill the volume, not only the perimeter. The reference reads as a
      // suspended energy field with depth, never as a halo around an empty disc.
      const r = 1.2 + Math.cbrt(Math.random()) * 5.2;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      arr[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      arr[i * 3 + 1] = r * Math.cos(phi);
      arr[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    return arr;
  }, [thin]);

  useFrame((state, delta) => {
    const t = state.clock.getElapsedTime();
    // Already smoothed per band in `lib/audio.ts`, so these are assigned
    // straight through — easing twice would only add lag.
    const v = levelsRef?.current ?? SILENT;

    for (const u of [coreUniforms, shellUniforms, volumeUniforms]) {
      drive(u, v, mood, tint, gain, delta);
    }

    if (group.current) {
      group.current.rotation.y += delta * (0.075 + mood.energy * 0.025);
      group.current.rotation.x =
        Math.sin(t * 0.18) * 0.1 + Math.sin(t * 0.41) * 0.035;
      // Square-root mapping gives quiet speech useful visual range without
      // letting a loud room exceed the existing cap.
      const loudness = Math.sqrt(v.volume);
      const bass = Math.sqrt(v.bass);
      const mids = Math.sqrt(v.mids);
      const treble = Math.sqrt(v.treble);
      const voiceScale = 1 + loudness * 0.085 * gain;
      // Breathing is deliberately asymmetric. Uniform scale is a pulse; three
      // slightly different phases make the volume inhale, roll and settle like
      // liquid ether even in silence.
      const breathRate = Math.max(0.12, mood.pulse) * Math.PI * 2;
      const breathX = Math.sin(t * breathRate) * (0.018 + mood.energy * 0.01);
      const breathY =
        Math.sin(t * breathRate * 0.79 + 1.7) * (0.014 + mood.energy * 0.012);
      const breathZ =
        Math.sin(t * breathRate * 1.17 + 3.1) * (0.016 + mood.energy * 0.008);
      const release = mood.mood === "resolved" ? 0.035 : 0;
      const unsettled = mood.mood === "unsettled" ? 0.025 : 0;
      const contraction = mood.mood === "warning" ? 0.91 : 1;
      const executeY = mood.mood === "focused" ? 1.13 : 1;
      const presence = 1.15;
      group.current.scale.set(
        (1 + breathX + release + unsettled + bass * 0.065 * gain + v.emphasis * 0.04 * gain) *
          voiceScale *
          contraction *
          presence,
        (1 + breathY + release - unsettled + mids * 0.055 * gain) *
          voiceScale *
          contraction *
          executeY *
          presence,
        (1 + breathZ + release + treble * 0.045 * gain - v.emphasis * 0.025 * gain) *
          voiceScale *
          contraction *
          presence,
      );
    }
    if (swarm.current) {
      // The swarm is thrown outward by loudness — the halo around the orb
      // when somebody is actually talking.
      const loudness = Math.sqrt(v.volume);
      const mids = Math.sqrt(v.mids);
      const treble = Math.sqrt(v.treble);
      swarm.current.rotation.y -= delta * (0.26 + mids * 1.3 * gain);
      swarm.current.rotation.z += delta * (0.08 + treble * 0.6 * gain);
      swarm.current.scale.setScalar(1 + loudness * 0.42 * gain + v.emphasis * 0.14 * gain);
      const mat = swarm.current.material as THREE.PointsMaterial;
      mat.opacity =
        0.3 +
        mood.energy * 0.25 +
        loudness * 0.28 * gain +
        treble * 0.5 * gain +
        v.emphasis * 0.24 * gain;
      mat.color.lerp(tint.hot, 0.05);
    }
  });

  return (
    <group ref={group}>
      <mesh>
        <icosahedronGeometry args={[5.2, 20]} />
        <shaderMaterial
          vertexShader={CORE_VERT}
          fragmentShader={CORE_FRAG}
          uniforms={coreUniforms}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      <mesh scale={1.018} rotation={[0.18, -0.26, 0.12]}>
        <icosahedronGeometry args={[5.2, 12]} />
        <shaderMaterial
          vertexShader={CORE_VERT}
          fragmentShader={SHELL_FRAG}
          uniforms={shellUniforms}
          transparent
          depthWrite={false}
          side={THREE.BackSide}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      <mesh scale={0.93} rotation={[-0.21, 0.32, -0.16]}>
        <icosahedronGeometry args={[5.2, 5]} />
        <meshBasicMaterial
          color={tint.hot}
          wireframe
          transparent
          opacity={0.032}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {[0.76, 0.52].map((scale, index) => (
        <mesh
          key={scale}
          scale={scale}
          rotation={
            index === 0
              ? [-0.28, 0.41, -0.19]
              : [0.36, -0.31, 0.27]
          }
        >
          <icosahedronGeometry args={[5.2, 10]} />
          <shaderMaterial
            vertexShader={CORE_VERT}
            fragmentShader={VOLUME_FRAG}
            uniforms={volumeUniforms}
            transparent
            depthWrite={false}
            side={THREE.DoubleSide}
            blending={THREE.AdditiveBlending}
          />
        </mesh>
      ))}

      <EtherFilaments mood={mood} levelsRef={levelsRef} reduced={reduced} />

      <points ref={swarm}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[swarmPositions, 3]} />
        </bufferGeometry>
        <pointsMaterial
          size={0.052}
          color="#d8feff"
          transparent
          opacity={0.64}
          sizeAttenuation
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>

    </group>
  );
}

// ── The ground ───────────────────────────────────────────────────────────

/**
 * A wave field for the orb to stand on.
 *
 * Without it the core is an object floating on a backdrop; with it the cockpit
 * is a place, and the voice is visible in the room rather than only in the
 * thing in the middle of it. The plane is built lying flat and rotated, so the
 * shader's `position.z` displacement becomes height.
 */
function WaveFloor({
  mood,
  levelsRef,
  reduced,
  thin,
}: {
  mood: MoodProfile;
  levelsRef?: LevelsRef;
  reduced: boolean;
  thin: boolean;
}) {
  const layers = useMemo(() => [0, 1, 2].map(floorUniforms), []);
  const tint = useTint(mood);
  const gain = reduced ? 0.3 : 1;

  // Segments are the entire cost here: the fragment work is trivial and the
  // vertex work is not, so this is the one number to turn down first.
  const segments = thin ? 120 : 240;

  useFrame((_, delta) => {
    for (const uniforms of layers) {
      drive(uniforms, levelsRef?.current ?? SILENT, mood, tint, gain, delta);
      // The floor takes the accent rather than the body colour, so the crests
      // stay distinct from the orb sitting on them.
      uniforms.uColor.value.lerp(tint.accent, 0.04);
    }
  });

  return (
    <group>
      {layers.map((uniforms, index) => (
        <mesh
          key={index}
          rotation={[-Math.PI / 2, 0, (index - 1) * 0.025]}
          position={[0, -15.65 - index * 0.42, index * 0.65]}
          scale={1 - index * 0.045}
        >
          <planeGeometry args={[130, 130, segments, segments]} />
          <shaderMaterial
            vertexShader={FLOOR_VERT}
            fragmentShader={FLOOR_FRAG}
            uniforms={uniforms}
            transparent
            depthWrite={false}
            side={THREE.DoubleSide}
            blending={THREE.AdditiveBlending}
          />
        </mesh>
      ))}
    </group>
  );
}

/**
 * Light climbing from the floor into the core.
 *
 * Points rather than tubes: a few thousand rising motes read as a current
 * feeding the orb, and cost one draw call. Each keeps its own phase so they
 * arrive continuously instead of in visible waves.
 */
function RisingStreams({
  mood,
  levelsRef,
  reduced,
  thin,
}: {
  mood: MoodProfile;
  levelsRef?: LevelsRef;
  reduced: boolean;
  thin: boolean;
}) {
  const ref = useRef<THREE.Points>(null);
  const tint = useTint(mood);
  const gain = reduced ? 0.3 : 1;
  const count = thin ? 320 : 950;

  const { positions, seeds } = useMemo(() => {
    const positions = new Float32Array(count * 3);
    // radius, phase, speed — kept out of the position buffer so the per-frame
    // update never has to recover them by trigonometry.
    const seeds = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      const radius = 1.1 + Math.pow(Math.random(), 0.72) * 5.7;
      const theta = Math.random() * Math.PI * 2;
      seeds[i * 3] = radius;
      seeds[i * 3 + 1] = theta;
      seeds[i * 3 + 2] = 0.5 + Math.random() * 1.6;
      positions[i * 3] = Math.cos(theta) * radius;
      positions[i * 3 + 1] = -15.5 + Math.random() * 18.5;
      positions[i * 3 + 2] = Math.sin(theta) * radius;
    }
    return { positions, seeds };
  }, [count]);

  useFrame((_, delta) => {
    const points = ref.current;
    if (!points) return;
    const v = levelsRef?.current ?? SILENT;

    const attribute = points.geometry.getAttribute("position") as THREE.BufferAttribute;
    const array = attribute.array as Float32Array;
    // Loudness makes the current run harder; that is the whole effect.
    const rise = delta * (1.6 + mood.energy * 2.2 + v.volume * 9 * gain);

    for (let i = 0; i < count; i += 1) {
      const y = array[i * 3 + 1] + rise * seeds[i * 3 + 2];
      if (y > 3.5) {
        // Recycled at the floor at a fresh angle, so the column never develops
        // visible lanes.
        const theta = Math.random() * Math.PI * 2;
        const radius = seeds[i * 3];
        array[i * 3] = Math.cos(theta) * radius;
        array[i * 3 + 1] = -15.5;
        array[i * 3 + 2] = Math.sin(theta) * radius;
        seeds[i * 3 + 1] = theta;
      } else {
        array[i * 3 + 1] = y;
        // Drawn inward as they climb: a current converging on the core rather
        // than a curtain going straight up.
        array[i * 3] *= 1 - delta * 0.28;
        array[i * 3 + 2] *= 1 - delta * 0.28;
      }
    }
    attribute.needsUpdate = true;

    const mat = points.material as THREE.PointsMaterial;
    mat.color.lerp(tint.hot, 0.05);
    mat.opacity = 0.2 + mood.energy * 0.24 + v.volume * 0.38 * gain;
  });

  return (
    <points ref={ref}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial
        size={0.11}
        transparent
        opacity={0.4}
        sizeAttenuation
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}

// ── Agents and their links ───────────────────────────────────────────────

interface NodeProps {
  agent: Agent;
  position: THREE.Vector3;
  /** Read per-frame, never as a prop: easing must not depend on re-renders. */
  attendRef: React.RefObject<Record<string, number>>;
  isPrimary: boolean;
  selected: boolean;
  onSelect: (id: string) => void;
}

function AgentNode({ agent, position, attendRef, isPrimary, selected, onSelect }: NodeProps) {
  const shape = useRef<THREE.Mesh>(null);
  const halo = useRef<THREE.Mesh>(null);
  const [hovered, setHovered] = useState(false);
  const isIntegration = agent.family === "integration";

  // Integration seats are violet, not dimmer cyan. They are a different kind
  // of thing — a connection to somewhere else rather than a seat at the table
  // — and hue says that where brightness only said "less important".
  const color = useMemo(
    () => (isIntegration ? OUTSIDE.clone() : SIGNAL.clone()),
    [isIntegration],
  );
  const lit = useMemo(() => color.clone(), [color]);

  useFrame((_, delta) => {
    const attend = attendRef.current?.[agent.id] ?? 0;

    if (shape.current) {
      shape.current.rotation.y += delta * 0.08;
      const s = (isIntegration ? 0.72 : 1) * (1 + attend * 1.5 + (selected ? 0.35 : 0));
      shape.current.scale.setScalar(s);
      lit.copy(color).lerp(ATTEND, attend);
      (shape.current.material as THREE.MeshBasicMaterial).color.copy(lit);
    }

    if (halo.current) {
      halo.current.scale.setScalar(1.8 + attend * 1.9 + (selected ? 0.45 : 0));
      const mat = halo.current.material as THREE.MeshBasicMaterial;
      mat.opacity = 0.035 + attend * 0.34 + (selected ? 0.08 : 0);
      mat.color.copy(lit);
    }
  });

  return (
    <group position={position}>
      <mesh
        onClick={(e) => {
          e.stopPropagation();
          onSelect(agent.id);
        }}
        onPointerOver={() => {
          setHovered(true);
          document.body.style.cursor = "pointer";
        }}
        onPointerOut={() => {
          setHovered(false);
          document.body.style.cursor = "default";
        }}
      >
        <sphereGeometry args={[0.62, 8, 8]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>

      <mesh ref={shape}>
        <sphereGeometry args={[0.12, 10, 10]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.9}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>

      <mesh ref={halo}>
        <sphereGeometry args={[0.17, 8, 8]} />
        <meshBasicMaterial
          color={color}
          wireframe
          transparent
          opacity={0.24}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>

      {hovered || selected ? (
        <Html position={[0, 0.72, 0]} center zIndexRange={[30, 20]}>
          <div className="agent-hover-label">
            <span>{agent.name}</span>
            <small>{FAMILY_LABEL[agent.family]}</small>
          </div>
        </Html>
      ) : null}

    </group>
  );
}

function Link({
  agentId,
  position,
  attendRef,
  mood,
  integration,
  voiceState,
  primary,
  taskLoad,
}: {
  agentId: string;
  position: THREE.Vector3;
  attendRef: React.RefObject<Record<string, number>>;
  mood: MoodProfile;
  integration: boolean;
  voiceState: VoiceState;
  primary: boolean;
  taskLoad: number;
}) {
  const sparks = useRef<Array<THREE.Mesh | null>>([]);
  const tint = useTint(mood);
  const rest = useMemo(() => (integration ? OUTSIDE.clone() : SIGNAL.clone()), [integration]);

  // A bowed tube rather than a straight line: spokes look like a diagram,
  // curves look like a field.
  const curve = useMemo(() => {
    const mid = position.clone().multiplyScalar(0.5);
    const bow = new THREE.Vector3(-position.z, position.x * 0.35 + 3, position.x)
      .normalize()
      .multiplyScalar(2.6);
    mid.add(bow);
    return new THREE.QuadraticBezierCurve3(
      position.clone().normalize().multiplyScalar(4.4),
      mid,
      position.clone(),
    );
  }, [position]);

  const geometry = useMemo(
    () => new THREE.TubeGeometry(curve, 40, 0.018, 5, false),
    [curve],
  );

  // Geometry built outside the R3F tree is not disposed for us.
  useEffect(() => () => geometry.dispose(), [geometry]);

  const material = useRef<THREE.MeshBasicMaterial>(null);
  const scratch = useMemo(() => new THREE.Vector3(), []);

  useFrame((state) => {
    const t = state.clock.getElapsedTime();
    const attend = attendRef.current?.[agentId] ?? 0;
    const working =
      voiceState === "thinking" ||
      voiceState === "executing" ||
      voiceState === "speaking";
    const stateDrive =
      voiceState === "executing"
        ? 1
        : voiceState === "thinking"
          ? 0.74
          : voiceState === "speaking"
            ? 0.58
            : 0;
    const electrical = attend * stateDrive;
    const flicker =
      0.72 +
      Math.sin(t * (17 + taskLoad * 2.7) + agentId.length * 0.83) * 0.2 +
      Math.sin(t * 41.0 + agentId.length) * 0.08;
    if (material.current) {
      material.current.opacity =
        0.003 + electrical * (0.48 + taskLoad * 0.07) * flicker;
      // Idle links carry the mood; attending links go amber regardless, so
      // "who is working on this" is never something the palette can hide.
      material.current.color
        .copy(rest)
        .lerp(tint.accent, integration ? 0 : 0.5)
        .lerp(tint.hot, electrical * 0.72)
        .lerp(ATTEND, primary ? electrical * 0.35 : 0);
    }
    const sparkCount = primary ? Math.min(3, 1 + taskLoad) : 1;
    sparks.current.forEach((spark, index) => {
      if (!spark) return;
      spark.visible = working && electrical > 0.055 && index < sparkCount;
      const phase = index / Math.max(1, sparkCount);
      const p =
        (t * (0.32 + mood.energy * 0.32 + taskLoad * 0.045) + phase) % 1;
      curve.getPoint(p, scratch);
      spark.position.copy(scratch);
      const surge = 0.7 + Math.sin(t * 26 + index * 2.1) * 0.24;
      spark.scale.setScalar((0.42 + electrical * 0.95) * surge);
      const sparkMaterial = spark.material as THREE.MeshBasicMaterial;
      sparkMaterial.opacity = Math.min(1, electrical * (0.75 + flicker * 0.4));
      sparkMaterial.color.copy(tint.hot).lerp(ATTEND, primary ? 0.28 : 0);
    });
  });

  return (
    <group>
      <mesh geometry={geometry}>
        <meshBasicMaterial
          ref={material}
          color={SIGNAL}
          transparent
          opacity={0.2}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
      {[0, 1, 2].map((index) => (
        <mesh
          key={index}
          ref={(node) => {
            sparks.current[index] = node;
          }}
        >
          <sphereGeometry args={[0.13, 8, 8]} />
          <meshBasicMaterial
            color={ATTEND}
            transparent
            blending={THREE.AdditiveBlending}
            depthWrite={false}
          />
        </mesh>
      ))}
    </group>
  );
}

function Workforce({
  primaryId,
  supportingIds,
  selectedId,
  mood,
  voiceState,
  onSelect,
}: {
  primaryId: string | null;
  supportingIds: string[];
  selectedId: string | null;
  mood: MoodProfile;
  voiceState: VoiceState;
  onSelect: (id: string) => void;
}) {
  const group = useRef<THREE.Group>(null);
  const nodes = useMemo(
    () => AGENTS.map((agent) => ({ agent, position: agentPosition(agent) })),
    [],
  );

  // Eased in a ref and READ IN EACH CHILD'S useFrame. Passing the number
  // down as a prop froze it at the last render, which killed the animation.
  const attendRef = useRef<Record<string, number>>({});

  useFrame((_, delta) => {
    if (group.current) group.current.rotation.y += delta * 0.014;
    for (const { agent } of nodes) {
      const target =
        agent.id === primaryId ? 1 : supportingIds.includes(agent.id) ? 0.62 : 0;
      const current = attendRef.current[agent.id] ?? 0;
      attendRef.current[agent.id] = current + (target - current) * 0.06;
    }
  });

  return (
    <group ref={group}>
      {nodes.map(({ agent, position }) => {
        return (
          <group key={agent.id}>
            <Link
              agentId={agent.id}
              position={position}
              attendRef={attendRef}
              mood={mood}
              integration={agent.family === "integration"}
              voiceState={voiceState}
              primary={agent.id === primaryId}
              taskLoad={Math.max(1, 1 + supportingIds.length)}
            />
            <AgentNode
              agent={agent}
              position={position}
              attendRef={attendRef}
              isPrimary={agent.id === primaryId}
              selected={selectedId === agent.id}
              onSelect={onSelect}
            />
          </group>
        );
      })}
    </group>
  );
}

// ── Camera ───────────────────────────────────────────────────────────────

/**
 * Always drifting. A slow automatic orbit, mouse parallax on top, and — when a
 * specialist is called in — a swing that brings them into frame without ever
 * losing the core.
 */
function CameraRig({ focusId }: { focusId: string | null }) {
  const desired = useRef(new THREE.Vector3(0, 5, 34));
  const look = useRef(new THREE.Vector3(0, 0, 0));
  const pointer = useRef({ x: 0, y: 0 });

  const focusPos = useMemo(() => {
    const agent = AGENTS.find((a) => a.id === focusId);
    return agent ? agentPosition(agent) : null;
  }, [focusId]);

  useFrame((state, delta) => {
    const t = state.clock.getElapsedTime();

    pointer.current.x += (state.pointer.x - pointer.current.x) * 0.04;
    pointer.current.y += (state.pointer.y - pointer.current.y) * 0.04;

    // Cursor drift is atmospheric, not navigation. A larger offset made the
    // lights move away while the operator was trying to identify one.
    const orbit = t * 0.035 + pointer.current.x * 0.08;
    const radius = 34 - (focusPos ? 2.5 : 0);
    const height = 5 + pointer.current.y * 0.6 + Math.sin(t * 0.21) * 1.2;

    desired.current.set(
      Math.sin(orbit) * radius,
      height,
      Math.cos(orbit) * radius,
    );

    // Lean toward the attending specialist rather than snapping to them.
    if (focusPos) {
      desired.current.lerp(focusPos.clone().multiplyScalar(2.15).setY(height + 3), 0.26);
      look.current.lerp(focusPos.clone().multiplyScalar(0.42), 0.05);
    } else {
      look.current.lerp(new THREE.Vector3(0, 0, 0), 0.05);
    }

    const k = 1 - Math.pow(0.02, delta);
    state.camera.position.lerp(desired.current, k);
    state.camera.lookAt(look.current);
  });

  return null;
}

// ── Scene ────────────────────────────────────────────────────────────────

/**
 * Post-processing is the single most fragile thing in this scene: it needs
 * float render targets and a healthy WebGL2 context, and when it cannot get
 * them the composer happily renders a black frame while the HTML overlays keep
 * drawing — which looks exactly like a broken app rather than a missing
 * effect.
 *
 * So it is treated as an enhancement, not a dependency. If it throws, it is
 * dropped and the scene renders unbloomed, which is why every material below
 * is bright enough to read on its own.
 */
class EffectsBoundary extends Component<
  { onFailure: () => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("morpheus: post-processing disabled —", error);
    this.props.onFailure();
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export interface CockpitSceneProps {
  primaryId: string | null;
  supportingIds: string[];
  voiceState: VoiceState;
  /** Live microphone levels. Absent when the operator has not opened the mic. */
  levelsRef?: LevelsRef;
  selectedId: string | null;
  onSelect: (agentId: string | null) => void;
}

export default function CockpitScene({
  primaryId,
  supportingIds,
  voiceState,
  levelsRef,
  selectedId,
  onSelect,
}: CockpitSceneProps) {
  // Two channels, joined only inside the scene: mood is slow and owns the
  // palette, the microphone is fast and owns the motion. See `lib/mood.ts`.
  const mood = moodFor(voiceState);

  // The shader materials carry their own additive light. Keep the composer
  // opt-out by default: some valid WebGL2 implementations accept the float
  // target and then return a black frame without throwing, which previously
  // left only the HTML labels visible.
  const [effects, setEffects] = useState(false);

  // Read after mount: `matchMedia` does not exist during the server render,
  // and reading it during the first client render would mismatch hydration.
  const [environment, setEnvironment] = useState({ reduced: false, thin: false });
  useEffect(() => setEnvironment(readEnvironment()), []);

  return (
    <Canvas
      camera={{ position: [0, 5, 34], fov: 55, near: 0.1, far: 300 }}
      gl={{ antialias: true, powerPreference: "high-performance" }}
      dpr={environment.thin ? [1, 1.25] : [1, 2]}
      onPointerMissed={() => onSelect(null)}
      onCreated={({ gl }) => {
        // A WebGL1-only context cannot drive the composer; skip it up front
        // instead of waiting for it to fail.
        const isWebGL2 =
          typeof WebGL2RenderingContext !== "undefined" &&
          gl.getContext() instanceof WebGL2RenderingContext;
        if (!isWebGL2) {
          console.warn("morpheus: WebGL2 unavailable — running without post-processing");
          setEffects(false);
        }
      }}
    >
      <Nebula mood={mood} />
      <WaveFloor
        mood={mood}
        levelsRef={levelsRef}
        reduced={environment.reduced}
        thin={environment.thin}
      />
      <RisingStreams
        mood={mood}
        levelsRef={levelsRef}
        reduced={environment.reduced}
        thin={environment.thin}
      />
      <Core
        mood={mood}
        levelsRef={levelsRef}
        reduced={environment.reduced}
        thin={environment.thin}
      />
      <Workforce
        primaryId={primaryId}
        supportingIds={supportingIds}
        selectedId={selectedId}
        mood={mood}
        voiceState={voiceState}
        onSelect={onSelect}
      />
      <CameraRig focusId={primaryId} />

      {effects ? (
        <EffectsBoundary onFailure={() => setEffects(false)}>
          <EffectComposer>
            <Bloom
              intensity={0.62 + mood.energy * 0.4}
              luminanceThreshold={0.45}
              luminanceSmoothing={0.22}
              mipmapBlur
            />
            <Vignette offset={0.28} darkness={0.72} />
            <Noise premultiply blendFunction={BlendFunction.SOFT_LIGHT} opacity={0.11} />
          </EffectComposer>
        </EffectsBoundary>
      ) : null}
    </Canvas>
  );
}
