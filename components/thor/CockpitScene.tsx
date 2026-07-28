"use client";

/**
 * The Thor cockpit, in three dimensions.
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

import { useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import { Bloom, EffectComposer, Noise, Vignette } from "@react-three/postprocessing";
import { BlendFunction } from "postprocessing";
import * as THREE from "three";
import { AGENTS, type Agent } from "@/lib/agents";
import type { VoiceState } from "@/lib/useVoice";
import {
  CORE_FRAG,
  CORE_VERT,
  NEBULA_FRAG,
  NEBULA_VERT,
  SHELL_FRAG,
} from "./shaders";

const SIGNAL = new THREE.Color("#3fe0f0");
const HOT = new THREE.Color("#b9fbff");
const ATTEND = new THREE.Color("#f2c14e");

const DEG = Math.PI / 180;

/** Energy per voice state — drives displacement, bloom and link traffic. */
const ENERGY: Record<VoiceState, number> = {
  idle: 0.25,
  listening: 0.55,
  thinking: 0.45,
  speaking: 1,
};

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

function DustField() {
  const ref = useRef<THREE.Points>(null);

  const positions = useMemo(() => {
    const count = 3200;
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
  }, []);

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

function Core({ energy }: { energy: number }) {
  const group = useRef<THREE.Group>(null);
  const ringA = useRef<THREE.Mesh>(null);
  const ringB = useRef<THREE.Mesh>(null);
  const swarm = useRef<THREE.Points>(null);

  const coreUniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uEnergy: { value: 0 },
      uColor: { value: SIGNAL.clone() },
      uHot: { value: HOT.clone() },
    }),
    [],
  );

  const shellUniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uEnergy: { value: 0 },
      uColor: { value: SIGNAL.clone() },
      uHot: { value: HOT.clone() },
    }),
    [],
  );

  const swarmPositions = useMemo(() => {
    const count = 1600;
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
  }, []);

  useFrame((state, delta) => {
    const t = state.clock.getElapsedTime();

    for (const u of [coreUniforms, shellUniforms]) {
      u.uTime.value += delta;
      u.uEnergy.value += (energy - u.uEnergy.value) * 0.05;
    }

    if (group.current) {
      group.current.rotation.y += delta * 0.06;
      group.current.rotation.x = Math.sin(t * 0.18) * 0.1;
    }
    if (swarm.current) {
      swarm.current.rotation.y -= delta * 0.22;
      swarm.current.rotation.z += delta * 0.05;
    }
    // Counter-rotating rings: the cheapest way to read as machinery.
    if (ringA.current) ringA.current.rotation.z += delta * 0.24;
    if (ringB.current) ringB.current.rotation.z -= delta * 0.17;
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

      <mesh scale={1.42}>
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
          opacity={0.3 + energy * 0.25}
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
          opacity={0.5 + energy * 0.4}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
      <mesh ref={ringB} rotation={[Math.PI / 1.7, -0.7, 0.5]}>
        <torusGeometry args={[8.1, 0.014, 8, 180]} />
        <meshBasicMaterial
          color={SIGNAL}
          transparent
          opacity={0.28 + energy * 0.3}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
    </group>
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
  energy: number;
  onSelect: (id: string) => void;
}

function AgentNode({ agent, position, attendRef, isPrimary, selected, energy, onSelect }: NodeProps) {
  const shape = useRef<THREE.Mesh>(null);
  const halo = useRef<THREE.Mesh>(null);
  const isIntegration = agent.family === "integration";

  const color = useMemo(
    () => (isIntegration ? new THREE.Color("#4a7d95") : SIGNAL.clone()),
    [isIntegration],
  );
  const lit = useMemo(() => color.clone(), [color]);

  useFrame((state, delta) => {
    const t = state.clock.getElapsedTime();
    const attend = attendRef.current?.[agent.id] ?? 0;
    if (shape.current) {
      shape.current.rotation.x += delta * 0.5;
      shape.current.rotation.y += delta * 0.35;
      const s = (isIntegration ? 0.72 : 1) * (1 + attend * 0.7 + (selected ? 0.25 : 0));
      shape.current.scale.setScalar(s);
      lit.copy(color).lerp(ATTEND, attend);
      (shape.current.material as THREE.MeshBasicMaterial).color.copy(lit);
    }
    if (halo.current) {
      const pulse = 1 + Math.sin(t * 2.4) * 0.12;
      halo.current.scale.setScalar((0.85 + attend * 0.9) * pulse);
      const mat = halo.current.material as THREE.MeshBasicMaterial;
      mat.opacity = (isIntegration ? 0.1 : 0.16) + attend * 0.4;
      mat.color.copy(lit);
      halo.current.lookAt(state.camera.position);
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

      <Html center distanceFactor={13} style={{ pointerEvents: "none" }} zIndexRange={[10, 0]}>
        <div
          style={{
            whiteSpace: "nowrap",
            transform: "translateY(-26px)",
            fontFamily: "var(--font-display)",
            fontSize: isIntegration ? 11 : 13,
            fontWeight: isIntegration ? 400 : 600,
            letterSpacing: "0.04em",
            color: isPrimary
              ? "rgba(255,236,186,0.98)"
              : isIntegration
                ? "rgba(146,171,182,0.62)"
                : "rgba(228,248,253,0.94)",
            textShadow: isPrimary
              ? "0 0 18px rgba(242,193,78,0.85)"
              : "0 0 14px rgba(63,224,240,0.45)",
          }}
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
  energy,
  integration,
}: {
  agentId: string;
  position: THREE.Vector3;
  attendRef: React.RefObject<Record<string, number>>;
  energy: number;
  integration: boolean;
}) {
  const packet = useRef<THREE.Mesh>(null);

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

  const material = useRef<THREE.MeshBasicMaterial>(null);
  const scratch = useMemo(() => new THREE.Vector3(), []);

  useFrame((state) => {
    const t = state.clock.getElapsedTime();
    const attend = attendRef.current?.[agentId] ?? 0;
    if (material.current) {
      material.current.opacity =
        (integration ? 0.1 : 0.2) + attend * 0.7 + energy * 0.06;
      material.current.color.copy(SIGNAL).lerp(ATTEND, attend);
    }
    if (packet.current) {
      // Traffic only runs while the seat is actually attending.
      packet.current.visible = attend > 0.08;
      const p = (t * (0.22 + energy * 0.2)) % 1;
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
  energy,
  onSelect,
}: {
  primaryId: string | null;
  supportingIds: string[];
  selectedId: string | null;
  energy: number;
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
              energy={energy}
              integration={agent.family === "integration"}
            />
            <AgentNode
              agent={agent}
              position={position}
              attendRef={attendRef}
              isPrimary={agent.id === primaryId}
              selected={selectedId === agent.id}
              energy={energy}
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

export interface CockpitSceneProps {
  primaryId: string | null;
  supportingIds: string[];
  voiceState: VoiceState;
  selectedId: string | null;
  onSelect: (agentId: string | null) => void;
}

export default function CockpitScene({
  primaryId,
  supportingIds,
  voiceState,
  selectedId,
  onSelect,
}: CockpitSceneProps) {
  const energy = ENERGY[voiceState];

  return (
    <Canvas
      camera={{ position: [0, 3, 34], fov: 55, near: 0.1, far: 300 }}
      gl={{ antialias: true, powerPreference: "high-performance" }}
      dpr={[1, 2]}
      onPointerMissed={() => onSelect(null)}
    >
      <Nebula energy={energy} />
      <DustField />
      <Core energy={energy} />
      <Workforce
        primaryId={primaryId}
        supportingIds={supportingIds}
        selectedId={selectedId}
        energy={energy}
        onSelect={onSelect}
      />
      <CameraRig focusId={primaryId} />

      <EffectComposer>
        <Bloom
          intensity={0.62 + energy * 0.4}
          luminanceThreshold={0.45}
          luminanceSmoothing={0.22}
          mipmapBlur
        />
        <Vignette offset={0.28} darkness={0.72} />
        <Noise premultiply blendFunction={BlendFunction.SOFT_LIGHT} opacity={0.11} />
      </EffectComposer>
    </Canvas>
  );
}
