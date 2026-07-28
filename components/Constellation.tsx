"use client";

/**
 * The constellation.
 *
 * The cockpit's main object: a live core with the workforce in orbit around
 * it. Everything here is state made visible — link brightness is traffic,
 * ring colour is attendance, node drift is just enough motion to read as
 * alive rather than as a diagram.
 *
 * Drawn on canvas rather than SVG because the ambient curve field and the
 * core's particle interior mean a few thousand strokes a frame; the DOM is
 * the wrong tool for that.
 */

import { useCallback, useEffect, useRef } from "react";
import { AGENTS, type Agent } from "@/lib/agents";
import type { VoiceState } from "@/lib/useVoice";

const CORE_COLOR = { r: 63, g: 224, b: 240 };
const ATTEND_COLOR = { r: 242, g: 193, b: 78 };

/** Deterministic PRNG so the field looks identical across reloads. */
function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface NodeState {
  agent: Agent;
  /** Current drawn position in pixels. */
  x: number;
  y: number;
  /** Per-node drift parameters. */
  driftPhase: number;
  driftRate: number;
  driftAmp: number;
  /** 0..1 attendance intensity, eased each frame toward the target. */
  attend: number;
  hover: number;
}

interface Particle {
  angle: number;
  radius: number;
  speed: number;
  size: number;
}

interface AmbientCurve {
  x1: number;
  y1: number;
  cx: number;
  cy: number;
  x2: number;
  y2: number;
  alpha: number;
  phase: number;
}

export interface ConstellationProps {
  primaryId: string | null;
  supportingIds: string[];
  voiceState: VoiceState;
  selectedId: string | null;
  onSelect: (agentId: string | null) => void;
}

export default function Constellation({
  primaryId,
  supportingIds,
  voiceState,
  selectedId,
  onSelect,
}: ConstellationProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const nodesRef = useRef<NodeState[]>([]);
  const particlesRef = useRef<Particle[]>([]);
  const curvesRef = useRef<AmbientCurve[]>([]);
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const hoveredRef = useRef<string | null>(null);

  // Live props read inside the animation loop without restarting it.
  const stateRef = useRef({ primaryId, supportingIds, voiceState, selectedId });
  stateRef.current = { primaryId, supportingIds, voiceState, selectedId };

  const hitTest = useCallback((x: number, y: number): string | null => {
    for (const node of nodesRef.current) {
      const dx = x - node.x;
      const dy = y - node.y;
      // Generous radius — these are small targets and the labels sit beside them.
      if (dx * dx + dy * dy < 26 * 26) return node.agent.id;
    }
    return null;
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const rand = mulberry32(0x5eed);

    nodesRef.current = AGENTS.map((agent, i) => ({
      agent,
      x: 0,
      y: 0,
      driftPhase: rand() * Math.PI * 2,
      driftRate: 0.00008 + rand() * 0.00012,
      driftAmp: 5 + rand() * 5 + (i % 3),
      attend: 0,
      hover: 0,
    }));

    particlesRef.current = Array.from({ length: 460 }, () => ({
      angle: rand() * Math.PI * 2,
      radius: Math.sqrt(rand()),
      speed: (rand() - 0.5) * 0.0009,
      size: 0.6 + rand() * 1.5,
    }));

    let width = 0;
    let height = 0;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = rect.width;
      height = rect.height;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // The ambient field is laid out in pixels, so it is rebuilt on resize.
      const curveRand = mulberry32(0xc0ffee);
      curvesRef.current = Array.from({ length: 26 }, () => {
        const y1 = curveRand() * height;
        const y2 = curveRand() * height;
        return {
          x1: -60,
          y1,
          cx: width * (0.2 + curveRand() * 0.6),
          cy: curveRand() * height,
          x2: width + 60,
          y2,
          alpha: 0.04 + curveRand() * 0.09,
          phase: curveRand() * Math.PI * 2,
        };
      });
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    let raf = 0;
    const start = performance.now();

    const draw = (now: number) => {
      const t = now - start;
      const { primaryId: pid, supportingIds: sids, voiceState: vs, selectedId: sel } =
        stateRef.current;

      const cx = width / 2;
      const cy = height / 2;
      const shortSide = Math.min(width, height);
      const fieldRadius = shortSide * 0.44;
      const coreRadius = shortSide * 0.128;

      // Core breathing: idle is a slow swell, speaking is a fast bright pulse.
      const breath =
        vs === "speaking"
          ? 1 + Math.sin(t * 0.009) * 0.05 + Math.sin(t * 0.021) * 0.025
          : vs === "listening"
            ? 1 + Math.sin(t * 0.0035) * 0.028
            : vs === "thinking"
              ? 1 + Math.sin(t * 0.006) * 0.018
              : 1 + Math.sin(t * 0.0018) * 0.02;
      const energy =
        vs === "speaking" ? 1 : vs === "listening" ? 0.7 : vs === "thinking" ? 0.55 : 0.4;

      ctx.clearRect(0, 0, width, height);

      // ── Ambient curve field ────────────────────────────────────────────
      ctx.lineWidth = 1;
      for (const curve of curvesRef.current) {
        const wobble = Math.sin(t * 0.00016 + curve.phase) * 26;
        ctx.beginPath();
        ctx.moveTo(curve.x1, curve.y1 + wobble);
        ctx.quadraticCurveTo(curve.cx, curve.cy + wobble * 1.6, curve.x2, curve.y2 - wobble);
        ctx.strokeStyle = `rgba(${CORE_COLOR.r}, ${CORE_COLOR.g}, ${CORE_COLOR.b}, ${
          curve.alpha * (0.6 + energy * 0.4)
        })`;
        ctx.stroke();
      }

      // ── Node positions ─────────────────────────────────────────────────
      for (const node of nodesRef.current) {
        const drift = Math.sin(t * node.driftRate + node.driftPhase);
        const angle =
          ((node.agent.angle + drift * 2.2) * Math.PI) / 180;
        const radius = fieldRadius * node.agent.orbit + drift * node.driftAmp;
        node.x = cx + Math.cos(angle) * radius;
        node.y = cy + Math.sin(angle) * radius * 0.86; // slight vertical squash

        const isPrimary = node.agent.id === pid;
        const isSupporting = sids.includes(node.agent.id);
        const target = isPrimary ? 1 : isSupporting ? 0.45 : 0;
        node.attend += (target - node.attend) * 0.06;

        const hovering = hoveredRef.current === node.agent.id || sel === node.agent.id;
        node.hover += ((hovering ? 1 : 0) - node.hover) * 0.12;
      }

      // ── Links from the core ────────────────────────────────────────────
      for (const node of nodesRef.current) {
        const isIntegration = node.agent.family === "integration";
        const base = isIntegration ? 0.06 : 0.13;
        const lit = base + node.attend * 0.5 + node.hover * 0.18;

        // Links leave the rim of the core rather than its centre, so the core
        // stays an object with a surface instead of a hub with spokes.
        const dx = node.x - cx;
        const dy = node.y - cy;
        const dist = Math.hypot(dx, dy) || 1;
        const sx = cx + (dx / dist) * coreRadius * breath * 0.98;
        const sy = cy + (dy / dist) * coreRadius * breath * 0.98;

        // Curve the link so the field reads as organic rather than as spokes.
        const mx = (sx + node.x) / 2;
        const my = (sy + node.y) / 2;
        const nx = -dy;
        const ny = dx;
        const len = dist;
        const bow = 42 + Math.sin(t * 0.0004 + node.driftPhase) * 12;

        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.quadraticCurveTo(mx + (nx / len) * bow, my + (ny / len) * bow, node.x, node.y);

        const color = node.attend > 0.02 ? ATTEND_COLOR : CORE_COLOR;
        ctx.strokeStyle = `rgba(${color.r}, ${color.g}, ${color.b}, ${lit})`;
        ctx.lineWidth = 1 + node.attend * 1.4;
        ctx.stroke();

        // A packet travelling the link while the specialist is attending.
        if (node.attend > 0.15) {
          const p = ((t * 0.0006 + node.driftPhase) % 1 + 1) % 1;
          const inv = 1 - p;
          const c1x = mx + (nx / len) * bow;
          const c1y = my + (ny / len) * bow;
          const px = inv * inv * sx + 2 * inv * p * c1x + p * p * node.x;
          const py = inv * inv * sy + 2 * inv * p * c1y + p * p * node.y;
          ctx.beginPath();
          ctx.arc(px, py, 2 + node.attend, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${ATTEND_COLOR.r}, ${ATTEND_COLOR.g}, ${ATTEND_COLOR.b}, ${node.attend})`;
          ctx.fill();
        }
      }

      // ── The core ───────────────────────────────────────────────────────
      const r = coreRadius * breath;

      const halo = ctx.createRadialGradient(cx, cy, r * 0.2, cx, cy, r * 2.6);
      halo.addColorStop(0, `rgba(${CORE_COLOR.r}, ${CORE_COLOR.g}, ${CORE_COLOR.b}, ${0.42 * energy})`);
      halo.addColorStop(0.45, `rgba(${CORE_COLOR.r}, ${CORE_COLOR.g}, ${CORE_COLOR.b}, ${0.13 * energy})`);
      halo.addColorStop(1, "rgba(4, 7, 10, 0)");
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(cx, cy, r * 2.6, 0, Math.PI * 2);
      ctx.fill();

      // Interior: a lit body, not a hole. The core has to read as the
      // brightest object on the screen or the whole cockpit loses its centre.
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.95, 0, Math.PI * 2);
      ctx.clip();

      const body = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      body.addColorStop(0, `rgba(150, 245, 255, ${0.5 + energy * 0.3})`);
      body.addColorStop(0.55, `rgba(${CORE_COLOR.r}, ${CORE_COLOR.g}, ${CORE_COLOR.b}, ${0.34 + energy * 0.22})`);
      body.addColorStop(1, `rgba(20, 150, 175, ${0.2 + energy * 0.15})`);
      ctx.fillStyle = body;
      ctx.fillRect(cx - r, cy - r, r * 2, r * 2);

      for (const particle of particlesRef.current) {
        const a = particle.angle + t * particle.speed * (1 + energy);
        const rr = particle.radius * r * 0.93;
        const px = cx + Math.cos(a) * rr;
        const py = cy + Math.sin(a) * rr * 0.98;
        ctx.beginPath();
        ctx.arc(px, py, particle.size * (0.8 + energy * 0.5), 0, Math.PI * 2);
        ctx.fillStyle = `rgba(226, 254, 255, ${0.35 + energy * 0.4})`;
        ctx.fill();
      }
      ctx.restore();

      // The hard bright rim that makes the core read as an object.
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(215, 253, 255, ${0.65 + energy * 0.35})`;
      ctx.lineWidth = 3.5 + energy * 3;
      ctx.shadowColor = `rgba(${CORE_COLOR.r}, ${CORE_COLOR.g}, ${CORE_COLOR.b}, 0.9)`;
      ctx.shadowBlur = 28 + energy * 34;
      ctx.stroke();
      ctx.shadowBlur = 0;

      // ── Nodes and labels ───────────────────────────────────────────────
      for (const node of nodesRef.current) {
        const isIntegration = node.agent.family === "integration";
        const color = node.attend > 0.02 ? ATTEND_COLOR : CORE_COLOR;
        const ringRadius =
          (isIntegration ? 5 : 8) + node.attend * 5 + node.hover * 3;

        // Attendance halo.
        if (node.attend > 0.02) {
          ctx.beginPath();
          ctx.arc(node.x, node.y, ringRadius + 7 + Math.sin(t * 0.006) * 2.5, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(${ATTEND_COLOR.r}, ${ATTEND_COLOR.g}, ${ATTEND_COLOR.b}, ${node.attend * 0.45})`;
          ctx.lineWidth = 1;
          ctx.stroke();
        }

        ctx.beginPath();
        ctx.arc(node.x, node.y, ringRadius, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${color.r}, ${color.g}, ${color.b}, ${
          (isIntegration ? 0.4 : 0.72) + node.attend * 0.28 + node.hover * 0.2
        })`;
        ctx.lineWidth = 1.4;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(node.x, node.y, ringRadius * 0.4, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${color.r}, ${color.g}, ${color.b}, ${0.8 + node.attend * 0.2})`;
        ctx.shadowColor = `rgba(${color.r}, ${color.g}, ${color.b}, 0.8)`;
        ctx.shadowBlur = 10 + node.attend * 18;
        ctx.fill();
        ctx.shadowBlur = 0;

        // Labels sit outboard so they never cross the core.
        const outward = node.x >= cx ? 1 : -1;
        ctx.textAlign = outward > 0 ? "left" : "right";
        ctx.textBaseline = "middle";
        ctx.font = isIntegration
          ? '400 12px "Helvetica Neue", Inter, ui-sans-serif, sans-serif'
          : '600 14px "Helvetica Neue", Inter, ui-sans-serif, sans-serif';

        const labelAlpha = isIntegration
          ? 0.42 + node.hover * 0.4
          : 0.86 + node.attend * 0.14;
        ctx.fillStyle =
          node.attend > 0.4
            ? `rgba(255, 236, 186, ${labelAlpha})`
            : isIntegration
              ? `rgba(146, 171, 182, ${labelAlpha})`
              : `rgba(228, 248, 253, ${labelAlpha})`;

        if (node.attend > 0.4) {
          ctx.shadowColor = `rgba(${ATTEND_COLOR.r}, ${ATTEND_COLOR.g}, ${ATTEND_COLOR.b}, 0.7)`;
          ctx.shadowBlur = 14;
        }
        ctx.fillText(
          node.agent.name,
          node.x + outward * (ringRadius + 9),
          node.y,
        );
        ctx.shadowBlur = 0;
      }

      // Hover hit test happens against the freshly drawn positions.
      const pointer = pointerRef.current;
      hoveredRef.current = pointer ? hitTest(pointer.x, pointer.y) : null;
      canvas.style.cursor = hoveredRef.current ? "pointer" : "default";

      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [hitTest]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 h-full w-full"
      onPointerMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        pointerRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      }}
      onPointerLeave={() => {
        pointerRef.current = null;
      }}
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        onSelect(hitTest(e.clientX - rect.left, e.clientY - rect.top));
      }}
    />
  );
}
