"use client";

/**
 * The pipeline as a place you fly through.
 *
 * Five stages laid out along −Z. The camera is on rails between them; the
 * mouse only ever nudges it. Colour carries the argument: the signal half is
 * Grok-blue, the ranking half burns amber, and the transition happens exactly
 * where understanding turns into optimisation.
 */

import { useMemo, useRef } from "react";
import { Canvas, useFrame, type ThreeElements } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import {
  ACTIONS,
  SIGNAL_AXES,
  type Ranked,
  type SignalVector,
  type StageId,
} from "@/lib/phoenix";

const BLUE = "#3b82f6";
const CYAN = "#38e8ff";
const AMBER = "#ffa62b";
const EMBER = "#ff6a1f";

/** Where each stage lives in world space. */
const STAGE_Z: Record<StageId, number> = {
  signals: 0,
  retrieval: -46,
  ranking: -92,
  heads: -138,
  feed: -184,
};

function fibonacciSphere(count: number, radius: number): Float32Array {
  const points = new Float32Array(count * 3);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i += 1) {
    const y = 1 - (i / (count - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const theta = golden * i;
    points[i * 3] = Math.cos(theta) * r * radius;
    points[i * 3 + 1] = y * radius;
    points[i * 3 + 2] = Math.sin(theta) * r * radius;
  }
  return points;
}

// ── Stage 0 — the signal sphere ──────────────────────────────────────────

function SignalCore({ signals, active }: { signals: SignalVector; active: boolean }) {
  const group = useRef<THREE.Group>(null);
  const shell = useRef<THREE.Points>(null);

  const positions = useMemo(() => fibonacciSphere(1400, 6.2), []);

  // Total signal energy drives how hot the core burns.
  const energy =
    SIGNAL_AXES.reduce((sum, axis) => sum + signals[axis], 0) / SIGNAL_AXES.length;

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (group.current) {
      group.current.rotation.y = t * 0.11;
      group.current.rotation.x = Math.sin(t * 0.19) * 0.14;
    }
    if (shell.current) {
      const s = 1 + Math.sin(t * 0.9) * 0.02 * (0.4 + energy);
      shell.current.scale.setScalar(s);
    }
  });

  return (
    <group position={[0, 0, STAGE_Z.signals]}>
      <group ref={group}>
        <mesh>
          <icosahedronGeometry args={[6.2, 3]} />
          <meshBasicMaterial
            wireframe
            color={BLUE}
            transparent
            opacity={0.18 + energy * 0.22}
          />
        </mesh>
        <mesh>
          <icosahedronGeometry args={[6.15, 1]} />
          <meshBasicMaterial wireframe color={CYAN} transparent opacity={0.35} />
        </mesh>
        <points ref={shell}>
          <bufferGeometry>
            <bufferAttribute
              attach="attributes-position"
              args={[positions, 3]}
            />
          </bufferGeometry>
          <pointsMaterial
            size={0.11}
            color={CYAN}
            transparent
            opacity={0.55 + energy * 0.4}
            sizeAttenuation
            blending={THREE.AdditiveBlending}
            depthWrite={false}
          />
        </points>
        <mesh>
          <sphereGeometry args={[5.9, 32, 32]} />
          <meshBasicMaterial color="#05173f" transparent opacity={0.55} />
        </mesh>
      </group>

      {/* Axis readouts, anchored outboard like the source diagram. Labels are
          gated on the active stage — Html always draws over the canvas, so
          leaving them on would print every stage's text through the world. */}
      {active && SIGNAL_AXES.map((axis, i) => {
        const y = 5.4 - i * 2.15;
        return (
          <Html
            key={axis}
            position={[-11.5, y, 0]}
            center
            distanceFactor={26}
            style={{ pointerEvents: "none" }}
          >
            <div
              style={{
                whiteSpace: "nowrap",
                textTransform: "uppercase",
                letterSpacing: "0.24em",
                fontSize: 11,
                fontFamily: "var(--font-hud)",
                color: `rgba(120, 190, 255, ${0.35 + signals[axis] * 0.65})`,
                textShadow: `0 0 ${8 + signals[axis] * 18}px rgba(56,232,255,0.7)`,
              }}
            >
              {axis}
            </div>
          </Html>
        );
      })}
    </group>
  );
}

// ── Stage 1 — two-tower retrieval ────────────────────────────────────────

function RetrievalField({ ranked, active }: { ranked: Ranked[]; active: boolean }) {
  const cloud = useRef<THREE.Points>(null);

  // The corpus X cannot show you: millions of posts, none of them retrieved.
  const corpusPositions = useMemo(() => {
    const count = 4200;
    const arr = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      const r = 14 + Math.random() * 26;
      const theta = Math.random() * Math.PI * 2;
      const y = (Math.random() - 0.5) * 26;
      arr[i * 3] = Math.cos(theta) * r;
      arr[i * 3 + 1] = y;
      arr[i * 3 + 2] = Math.sin(theta) * r * 0.5;
    }
    return arr;
  }, []);

  useFrame(({ clock }) => {
    if (cloud.current) cloud.current.rotation.y = clock.getElapsedTime() * 0.035;
  });

  const topK = ranked.slice(0, 6);

  return (
    <group position={[0, 0, STAGE_Z.retrieval]}>
      <points ref={cloud}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[corpusPositions, 3]} />
        </bufferGeometry>
        <pointsMaterial
          size={0.075}
          color="#1e4a8a"
          transparent
          opacity={0.5}
          sizeAttenuation
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </points>

      {/* The user tower: one embedding, recomputed per request. */}
      <mesh position={[-9, 0, 0]}>
        <cylinderGeometry args={[0.7, 0.7, 11, 6, 1, true]} />
        <meshBasicMaterial color={CYAN} wireframe transparent opacity={0.55} />
      </mesh>
      {/* The item tower: precomputed for the whole corpus. */}
      <mesh position={[9, 0, 0]}>
        <cylinderGeometry args={[0.7, 0.7, 11, 6, 1, true]} />
        <meshBasicMaterial color={BLUE} wireframe transparent opacity={0.5} />
      </mesh>

      {topK.map((item, i) => {
        const angle = (i / topK.length) * Math.PI * 2;
        const radius = 7.5;
        const p: [number, number, number] = [
          Math.cos(angle) * radius,
          Math.sin(angle) * radius * 0.55,
          2,
        ];
        const lit = 0.3 + item.retrieval * 0.7;
        return (
          <group key={item.post.id} position={p}>
            <mesh>
              <sphereGeometry args={[0.34, 12, 12]} />
              <meshBasicMaterial color={CYAN} transparent opacity={lit} />
            </mesh>
            {active ? (
              <Html center distanceFactor={30} style={{ pointerEvents: "none" }}>
                <div
                  style={{
                    whiteSpace: "nowrap",
                    fontSize: 10,
                    fontFamily: "var(--font-hud)",
                    color: `rgba(180,230,255,${lit})`,
                    transform: "translateY(-22px)",
                  }}
                >
                  {item.post.handle} · {item.retrieval.toFixed(3)}
                </div>
              </Html>
            ) : null}
          </group>
        );
      })}
    </group>
  );
}

// ── Stage 2 — the isolation mask ─────────────────────────────────────────

const GRID = 14;

function IsolationLattice({ active }: { active: boolean }) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const colorA = useMemo(() => new THREE.Color(AMBER), []);
  const colorB = useMemo(() => new THREE.Color("#123048"), []);
  const colorC = useMemo(() => new THREE.Color(CYAN), []);

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    const m = mesh.current;
    if (!m) return;

    let i = 0;
    for (let row = 0; row < GRID; row += 1) {
      for (let col = 0; col < GRID; col += 1) {
        const x = (col - GRID / 2) * 1.15;
        const y = (GRID / 2 - row) * 1.15;

        // Column 0 and 1 are the user and their history: every candidate may
        // attend to them. Everything else is diagonal-only.
        const isContext = col < 2;
        const isSelf = row === col;
        const allowed = isContext || isSelf;

        const pulse = allowed ? 0.6 + Math.sin(t * 2 + row * 0.35) * 0.4 : 0.08;
        dummy.position.set(x, y, 0);
        dummy.scale.setScalar(allowed ? 0.92 : 0.72);
        dummy.updateMatrix();
        m.setMatrixAt(i, dummy.matrix);
        m.setColorAt(
          i,
          allowed ? (isContext ? colorC : colorA).clone().multiplyScalar(pulse) : colorB,
        );
        i += 1;
      }
    }
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  });

  return (
    <group position={[0, 0, STAGE_Z.ranking]}>
      <instancedMesh ref={mesh} args={[undefined, undefined, GRID * GRID]}>
        <planeGeometry args={[0.9, 0.9]} />
        <meshBasicMaterial
          transparent
          opacity={0.92}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </instancedMesh>

      {active ? (
      <Html position={[0, 10.5, 0]} center distanceFactor={30} style={{ pointerEvents: "none" }}>
        <div
          style={{
            whiteSpace: "nowrap",
            textTransform: "uppercase",
            letterSpacing: "0.26em",
            fontSize: 10,
            fontFamily: "var(--font-hud)",
            color: "rgba(255,200,120,0.9)",
          }}
        >
          attention mask · candidates cannot see each other
        </div>
      </Html>
      ) : null}
    </group>
  );
}

// ── Stage 3 — the 19 heads ───────────────────────────────────────────────

function ActionHeads({ ranked, active }: { ranked: Ranked[]; active: boolean }) {
  const group = useRef<THREE.Group>(null);
  const top = ranked[0];

  useFrame(({ clock }) => {
    if (group.current) {
      group.current.rotation.y = Math.sin(clock.getElapsedTime() * 0.16) * 0.09;
    }
  });

  return (
    <group ref={group} position={[0, 0, STAGE_Z.heads]}>
      {ACTIONS.map((action, i) => {
        // A shallow arc facing the camera rather than a full ring: with 19
        // heads a ring puts the back half's labels straight through the front
        // half's. Everything stays legible in one read this way.
        const centred = i - (ACTIONS.length - 1) / 2;
        const p = top?.predictions[action.key] ?? 0;
        const height = 0.35 + p * 7;
        const negative = action.polarity === -1;

        return (
          <group
            key={action.key}
            position={[centred * 1.6, 0, -Math.abs(centred) * 0.45]}
          >
            <mesh position={[0, height / 2, 0]}>
              <boxGeometry args={[0.62, height, 0.62]} />
              <meshBasicMaterial
                color={negative ? "#ff4d6d" : p > 0.4 ? EMBER : AMBER}
                transparent
                opacity={0.32 + p * 0.6}
                blending={THREE.AdditiveBlending}
                depthWrite={false}
              />
            </mesh>
            {active ? (
              <Html
                position={[0, height + 1.1 + (i % 2) * 1.6, 0]}
                center
                distanceFactor={30}
                style={{ pointerEvents: "none" }}
              >
                <div
                  style={{
                    whiteSpace: "nowrap",
                    fontSize: 9.5,
                    fontFamily: "var(--font-hud)",
                    textTransform: "uppercase",
                    letterSpacing: "0.14em",
                    color: negative ? "rgba(255,120,150,0.85)" : "rgba(255,205,140,0.85)",
                  }}
                >
                  {action.label} {(p * 100).toFixed(0)}%
                </div>
              </Html>
            ) : null}
          </group>
        );
      })}
    </group>
  );
}

// ── Stage 4 — the ranked feed ────────────────────────────────────────────

function FeedTowers({ ranked, active }: { ranked: Ranked[]; active: boolean }) {
  const max = Math.max(...ranked.map((r) => r.finalScore), 0.001);

  return (
    <group position={[0, 0, STAGE_Z.feed]}>
      {ranked.slice(0, 12).map((item, i) => {
        const height = 0.4 + (item.finalScore / max) * 12;
        const x = (i - 5.5) * 1.9;
        // Colour by how much of the score came from outrage-driven heads.
        const heat = item.post.outrage;
        return (
          <group key={item.post.id} position={[x, 0, 0]}>
            <mesh position={[0, height / 2, 0]}>
              <boxGeometry args={[1.15, height, 1.15]} />
              <meshBasicMaterial
                color={heat > 0.6 ? EMBER : heat > 0.3 ? AMBER : CYAN}
                transparent
                opacity={0.75}
                blending={THREE.AdditiveBlending}
                depthWrite={false}
              />
            </mesh>
            {active ? (
              <Html
                position={[0, height + 1.2 + (i % 3) * 1.7, 0]}
                center
                distanceFactor={32}
                style={{ pointerEvents: "none" }}
              >
                <div
                  style={{
                    whiteSpace: "nowrap",
                    fontSize: 10,
                    fontFamily: "var(--font-hud)",
                    color: heat > 0.6 ? "rgba(255,170,110,0.95)" : "rgba(170,225,255,0.9)",
                  }}
                >
                  #{i + 1} {item.post.handle}
                </div>
              </Html>
            ) : null}
          </group>
        );
      })}
    </group>
  );
}

// ── Rails ────────────────────────────────────────────────────────────────

/**
 * Per-stage framing. `dist` backs the camera off far enough to hold the whole
 * stage; `shift` slides the framing left so nothing important ends up behind
 * the control panel on the right.
 */
const STAGE_VIEW: Record<StageId, { dist: number; shift: number; height: number }> = {
  signals: { dist: 22, shift: 2.5, height: 2.2 },
  retrieval: { dist: 27, shift: 2.5, height: 2.2 },
  ranking: { dist: 25, shift: 2.5, height: 1.2 },
  heads: { dist: 34, shift: 3.5, height: 3.4 },
  feed: { dist: 34, shift: 3, height: 5.5 },
};

function CameraRig({ stage }: { stage: StageId }) {
  const target = useRef(new THREE.Vector3());
  const look = useRef(new THREE.Vector3());
  const pointer = useRef({ x: 0, y: 0 });

  useFrame((state, delta) => {
    const z = STAGE_Z[stage];
    const view = STAGE_VIEW[stage];
    pointer.current.x += (state.pointer.x - pointer.current.x) * 0.05;
    pointer.current.y += (state.pointer.y - pointer.current.y) * 0.05;

    target.current.set(
      view.shift + pointer.current.x * 4,
      view.height + pointer.current.y * 2.4,
      z + view.dist,
    );
    look.current.set(view.shift, 0, z);

    // Frame-rate independent easing so the flight feels identical everywhere.
    const k = 1 - Math.pow(0.0015, delta);
    state.camera.position.lerp(target.current, k);
    state.camera.lookAt(look.current);
  });

  return null;
}

function Starfield() {
  const positions = useMemo(() => {
    const count = 2600;
    const arr = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      arr[i * 3] = (Math.random() - 0.5) * 260;
      arr[i * 3 + 1] = (Math.random() - 0.5) * 160;
      arr[i * 3 + 2] = -Math.random() * 260 + 30;
    }
    return arr;
  }, []);

  return (
    <points>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial
        size={0.16}
        color="#5f7fa8"
        transparent
        opacity={0.4}
        sizeAttenuation
        depthWrite={false}
      />
    </points>
  );
}

/** The connective tissue between stages — data physically moving downstream. */
function Conduit() {
  const ref = useRef<THREE.Points>(null);
  const count = 900;

  const positions = useMemo(() => {
    const arr = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      arr[i * 3] = (Math.random() - 0.5) * 9;
      arr[i * 3 + 1] = (Math.random() - 0.5) * 9;
      arr[i * 3 + 2] = -Math.random() * 200;
    }
    return arr;
  }, []);

  useFrame((_, delta) => {
    const geometry = ref.current?.geometry;
    if (!geometry) return;
    const attr = geometry.getAttribute("position") as THREE.BufferAttribute;
    const array = attr.array as Float32Array;
    for (let i = 0; i < count; i += 1) {
      array[i * 3 + 2] -= delta * 14;
      if (array[i * 3 + 2] < -200) array[i * 3 + 2] = 10;
    }
    attr.needsUpdate = true;
  });

  return (
    <points ref={ref}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial
        size={0.1}
        color={AMBER}
        transparent
        opacity={0.35}
        sizeAttenuation
        blending={THREE.AdditiveBlending}
        depthWrite={false}
      />
    </points>
  );
}

export interface PhoenixSceneProps {
  stage: StageId;
  signals: SignalVector;
  ranked: Ranked[];
}

export default function PhoenixScene({ stage, signals, ranked }: PhoenixSceneProps) {
  return (
    <Canvas
      camera={{ position: [0, 2.2, 22], fov: 58, near: 0.1, far: 400 }}
      gl={{ antialias: true, alpha: true }}
      dpr={[1, 2]}
    >
      <color attach="background" args={["#03050c"]} />
      <fog attach="fog" args={["#03050c", 24, 70]} />

      <Starfield />
      <Conduit />

      <SignalCore signals={signals} active={stage === "signals"} />
      <RetrievalField ranked={ranked} active={stage === "retrieval"} />
      <IsolationLattice active={stage === "ranking"} />
      <ActionHeads ranked={ranked} active={stage === "heads"} />
      <FeedTowers ranked={ranked} active={stage === "feed"} />

      <CameraRig stage={stage} />
    </Canvas>
  );
}

// Keeps the R3F namespace import meaningful for consumers of this module.
export type { ThreeElements };
