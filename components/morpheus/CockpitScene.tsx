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
import { Canvas, useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import { Bloom, EffectComposer, Noise, Vignette } from "@react-three/postprocessing";
import { BlendFunction } from "postprocessing";
import * as THREE from "three";
import { AGENTS, type Agent } from "@/lib/agents";
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
  uColor: { value: THREE.Color };
  uHot: { value: THREE.Color };
}

function voiceUniforms(): VoiceUniforms {
  return {
    uTime: { value: 0 },
    uEnergy: { value: 0 },
    uVoiceVolume: { value: 0 },
    uBass: { value: 0 },
    uMids: { value: 0 },
    uTreble: { value: 0 },
    uColor: { value: new THREE.Color("#3fe0f0") },
    uHot: { value: new THREE.Color("#b9fbff") },
  };
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

  // Hue moves inside the window the mood allows, and no further. Mids and
  // treble push it; loudness decides how much of that push actually lands.
  const hue = tint.centre + (v.mids * 0.4 + v.treble * 0.6) * tint.range;
  tint.scratch.setRGB(...hueToRgb(hue));
  tint.scratch.lerpColors(tint.base, tint.scratch, Math.min(1, v.volume * 1.4));

  u.uColor.value.lerp(tint.scratch, 0.06);
  u.uHot.value.lerp(tint.hot, 0.06);
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

function Nebula({ energy }: { energy: number }) {
  const uniforms = useMemo(
    () => ({ uTime: { value: 0 }, uEnergy: { value: 0 } }),
    [],
  );

  useFrame((_, delta) => {
    uniforms.uTime.value += delta;
    uniforms.uEnergy.value += (energy - uniforms.uEnergy.value) * 0.03;
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

function DustField({ thin }: { thin: boolean }) {
  const ref = useRef<THREE.Points>(null);

  const positions = useMemo(() => {
    const count = thin ? 1100 : 3200;
    const arr = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      // A shell rather than a cube, so density stays even as you turn.
      const r = 30 + Math.random() * 70;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      arr[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      arr[i * 3 + 1] = r * Math.cos(phi) * 0.6;
      arr[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    return arr;
  }, [thin]);

  useFrame((_, delta) => {
    if (ref.current) ref.current.rotation.y += delta * 0.006;
  });

  return (
    <points ref={ref}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial
        size={0.22}
        color="#6ea8c8"
        transparent
        opacity={0.5}
        sizeAttenuation
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
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

function Core({ mood, levelsRef, reduced, thin }: CoreProps) {
  const group = useRef<THREE.Group>(null);
  const ringA = useRef<THREE.Mesh>(null);
  const ringB = useRef<THREE.Mesh>(null);
  const swarm = useRef<THREE.Points>(null);

  const coreUniforms = useMemo(voiceUniforms, []);
  const shellUniforms = useMemo(voiceUniforms, []);
  const tint = useTint(mood);

  // Reduced motion damps the voice reaction rather than removing it: the orb
  // must still answer, or the microphone indicator becomes a claim with no
  // evidence behind it.
  const gain = reduced ? 0.3 : 1;

  const swarmPositions = useMemo(() => {
    const count = thin ? 600 : 1600;
    const arr = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      const r = 3.4 + Math.random() * 1.9;
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

    for (const u of [coreUniforms, shellUniforms]) drive(u, v, mood, tint, gain, delta);

    // The slow ambient breath. Its rate is the mood's, which is what makes
    // "thinking" and "speaking" legible from across the room with the sound
    // off — one of them is visibly hurrying and the other is not.
    const breath = 1 + Math.sin(t * mood.pulse * Math.PI * 2) * 0.035;

    if (group.current) {
      group.current.rotation.y += delta * 0.06;
      group.current.rotation.x = Math.sin(t * 0.18) * 0.1;
      group.current.scale.setScalar(breath * (1 + v.volume * 0.06 * gain));
    }
    if (swarm.current) {
      // The swarm is thrown outward by loudness — the halo around the orb
      // when somebody is actually talking.
      swarm.current.rotation.y -= delta * (0.22 + v.mids * 0.5 * gain);
      swarm.current.rotation.z += delta * 0.05;
      swarm.current.scale.setScalar(1 + v.volume * 0.18 * gain);
      const mat = swarm.current.material as THREE.PointsMaterial;
      mat.opacity = 0.3 + mood.energy * 0.25 + v.treble * 0.35 * gain;
      mat.color.lerp(tint.hot, 0.05);
    }
    // Counter-rotating rings: the cheapest way to read as machinery.
    for (const [ring, sign, rate] of [
      [ringA, 1, 0.24],
      [ringB, -1, 0.17],
    ] as const) {
      if (!ring.current) continue;
      ring.current.rotation.z += delta * sign * (rate + v.bass * 0.4 * gain);
      const mat = ring.current.material as THREE.MeshBasicMaterial;
      mat.color.lerp(tint.accent, 0.05);
      mat.opacity = (sign > 0 ? 0.5 : 0.28) + mood.energy * 0.35 + v.volume * 0.4 * gain;
    }
  });

  return (
    <group ref={group}>
      <mesh>
        <icosahedronGeometry args={[3.6, 20]} />
        <shaderMaterial
          vertexShader={CORE_VERT}
          fragmentShader={CORE_FRAG}
          uniforms={coreUniforms}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      <mesh scale={1.2}>
        <icosahedronGeometry args={[3.6, 12]} />
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

      <points ref={swarm}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[swarmPositions, 3]} />
        </bufferGeometry>
        <pointsMaterial
          size={0.075}
          color="#d8feff"
          transparent
          opacity={0.55}
          sizeAttenuation
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>

      <mesh ref={ringA} rotation={[Math.PI / 2.4, 0.4, 0]}>
        <torusGeometry args={[6.6, 0.022, 8, 180]} />
        <meshBasicMaterial
          color={SIGNAL}
          transparent
          opacity={0.6}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
      <mesh ref={ringB} rotation={[Math.PI / 1.7, -0.7, 0.5]}>
        <torusGeometry args={[8.1, 0.014, 8, 180]} />
        <meshBasicMaterial
          color={SIGNAL}
          transparent
          opacity={0.4}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
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
  const uniforms = useMemo(voiceUniforms, []);
  const tint = useTint(mood);
  const gain = reduced ? 0.3 : 1;

  // Segments are the entire cost here: the fragment work is trivial and the
  // vertex work is not, so this is the one number to turn down first.
  const segments = thin ? 120 : 240;

  useFrame((_, delta) => {
    drive(uniforms, levelsRef?.current ?? SILENT, mood, tint, gain, delta);
    // The floor takes the accent rather than the body colour, so the crests
    // stay distinct from the orb sitting on them.
    uniforms.uColor.value.lerp(tint.accent, 0.04);
  });

  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -16, 0]}>
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
  const count = thin ? 700 : 2200;

  const { positions, seeds } = useMemo(() => {
    const positions = new Float32Array(count * 3);
    // radius, phase, speed — kept out of the position buffer so the per-frame
    // update never has to recover them by trigonometry.
    const seeds = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      const radius = 2 + Math.pow(Math.random(), 0.6) * 11;
      const theta = Math.random() * Math.PI * 2;
      seeds[i * 3] = radius;
      seeds[i * 3 + 1] = theta;
      seeds[i * 3 + 2] = 0.5 + Math.random() * 1.6;
      positions[i * 3] = Math.cos(theta) * radius;
      positions[i * 3 + 1] = -16 + Math.random() * 19.5;
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
        array[i * 3 + 1] = -16;
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
    mat.opacity = 0.3 + mood.energy * 0.35 + v.volume * 0.5 * gain;
  });

  return (
    <points ref={ref}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial
        size={0.16}
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
  const label = useRef<HTMLDivElement>(null);
  const isIntegration = agent.family === "integration";

  // Integration seats are violet, not dimmer cyan. They are a different kind
  // of thing — a connection to somewhere else rather than a seat at the table
  // — and hue says that where brightness only said "less important".
  const color = useMemo(
    () => (isIntegration ? OUTSIDE.clone() : SIGNAL.clone()),
    [isIntegration],
  );
  const lit = useMemo(() => color.clone(), [color]);

  useFrame((state, delta) => {
    const t = state.clock.getElapsedTime();
    const attend = attendRef.current?.[agent.id] ?? 0;

    if (shape.current) {
      // One slow axis. Tumbling on two made every node read as debris.
      shape.current.rotation.y += delta * 0.28;
      const s = (isIntegration ? 0.78 : 1) * (1 + attend * 0.55 + (selected ? 0.2 : 0));
      shape.current.scale.setScalar(s);
      lit.copy(color).lerp(ATTEND, attend);
      (shape.current.material as THREE.MeshBasicMaterial).color.copy(lit);
    }

    if (halo.current) {
      const pulse = 1 + Math.sin(t * 2.4 + position.x) * 0.1;
      // Was 1.5 and read as a saucer sitting in front of the node rather than
      // as light coming off it. A halo wider than the shape stops being a glow.
      halo.current.scale.setScalar((0.8 + attend * 0.9) * pulse);
      const mat = halo.current.material as THREE.MeshBasicMaterial;
      mat.opacity = (isIntegration ? 0.14 : 0.22) + attend * 0.4;
      mat.color.copy(lit);
      halo.current.lookAt(state.camera.position);
    }

    // The label is DOM, so it is styled from the same eased value rather than
    // re-rendered — sixty renders a second per node would be twenty thousand.
    if (label.current) {
      label.current.style.opacity = String(
        (isIntegration ? 0.5 : 0.82) + attend * 0.18,
      );
      label.current.style.color = attend > 0.25 ? "var(--color-attend)" : "";
    }
  });

  return (
    <group position={position}>
      <mesh
        ref={shape}
        onClick={(e) => {
          e.stopPropagation();
          onSelect(agent.id);
        }}
        onPointerOver={() => {
          document.body.style.cursor = "pointer";
        }}
        onPointerOut={() => {
          document.body.style.cursor = "default";
        }}
      >
        <octahedronGeometry args={[0.46, 0]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.95}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/* Camera-facing halo — a flat disc is cheaper than a real glow and,
          under bloom, indistinguishable. */}
      <mesh ref={halo}>
        <circleGeometry args={[0.5, 24]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.2}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>

      {/*
        No `distanceFactor`. Scaling labels with depth is what made the far
        side of the constellation unreadable: "Chief of staff" at eleven
        pixels shrinks to four, and a name nobody can read is worse than no
        name at all. Constant screen size costs the depth cue and buys back
        every label on screen.
      */}
      <Html center style={{ pointerEvents: "none" }} zIndexRange={[10, 0]}>
        <div
          ref={label}
          className={[
            "node-label",
            isPrimary ? "node-label-primary" : "",
            isIntegration ? "node-label-below" : "",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          {agent.name}
        </div>
      </Html>
    </group>
  );
}

function Link({
  agentId,
  position,
  attendRef,
  mood,
  integration,
}: {
  agentId: string;
  position: THREE.Vector3;
  attendRef: React.RefObject<Record<string, number>>;
  mood: MoodProfile;
  integration: boolean;
}) {
  const packet = useRef<THREE.Mesh>(null);
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
    () => new THREE.TubeGeometry(curve, 40, 0.018, 6, false),
    [curve],
  );

  // Geometry built outside the R3F tree is not disposed for us.
  useEffect(() => () => geometry.dispose(), [geometry]);

  const material = useRef<THREE.MeshBasicMaterial>(null);
  const scratch = useMemo(() => new THREE.Vector3(), []);

  useFrame((state) => {
    const t = state.clock.getElapsedTime();
    const attend = attendRef.current?.[agentId] ?? 0;
    if (material.current) {
      material.current.opacity =
        (integration ? 0.1 : 0.2) + attend * 0.7 + mood.energy * 0.06;
      // Idle links carry the mood; attending links go amber regardless, so
      // "who is working on this" is never something the palette can hide.
      material.current.color
        .copy(rest)
        .lerp(tint.accent, integration ? 0 : 0.5)
        .lerp(ATTEND, attend);
    }
    if (packet.current) {
      // Traffic only runs while the seat is actually attending.
      packet.current.visible = attend > 0.08;
      const p = (t * (0.22 + mood.energy * 0.2)) % 1;
      curve.getPoint(p, scratch);
      packet.current.position.copy(scratch);
      packet.current.scale.setScalar(0.5 + attend);
      (packet.current.material as THREE.MeshBasicMaterial).opacity = attend;
    }
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
      <mesh ref={packet}>
        <sphereGeometry args={[0.09, 8, 8]} />
        <meshBasicMaterial
          color={ATTEND}
          transparent
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}

function Workforce({
  primaryId,
  supportingIds,
  selectedId,
  mood,
  onSelect,
}: {
  primaryId: string | null;
  supportingIds: string[];
  selectedId: string | null;
  mood: MoodProfile;
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
        agent.id === primaryId ? 1 : supportingIds.includes(agent.id) ? 0.4 : 0;
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
  const desired = useRef(new THREE.Vector3(0, 3, 34));
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

    const orbit = t * 0.035 + pointer.current.x * 0.55;
    const radius = 34 - (focusPos ? 2.5 : 0);
    const height = 3 + pointer.current.y * 3.5 + Math.sin(t * 0.21) * 1.2;

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

  // Effects start on and are switched off permanently the first time they
  // fail, rather than retried every frame.
  const [effects, setEffects] = useState(true);

  // Read after mount: `matchMedia` does not exist during the server render,
  // and reading it during the first client render would mismatch hydration.
  const [environment, setEnvironment] = useState({ reduced: false, thin: false });
  useEffect(() => setEnvironment(readEnvironment()), []);

  return (
    <Canvas
      camera={{ position: [0, 3, 34], fov: 55, near: 0.1, far: 300 }}
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
      <Nebula energy={mood.energy} />
      <DustField thin={environment.thin} />
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
