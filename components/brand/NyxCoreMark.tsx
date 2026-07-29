"use client";

/**
 * The NYX Core mark, rebuilt as vector.
 *
 * Drawn rather than imported: an SVG scales to a favicon or a wall, weighs
 * about a kilobyte, and can be re-tinted from the same CSS variables as the
 * rest of the cockpit — none of which a PNG does.
 *
 * The geometry is a happy accident worth keeping: a lit core with twelve nodes
 * ringed around it, joined by struts, is the same shape as Morpheus's agent
 * constellation. The logo and the product's main screen are the same idea at
 * two scales, so they are built from one set of tokens.
 */

export interface NyxCoreMarkProps {
  size?: number;
  /** Slow rotation and a breathing core. Off for favicons and print. */
  animated?: boolean;
  /** Chrome ring and struts. Dropped below ~32px where they turn to mud. */
  detail?: boolean;
  className?: string;
  title?: string;
}

const NODES = 12;
const CENTER = 100;
const RING = 78;
const HEX_OUTER = 52;
const HEX_INNER = 42;

/** Flat-top hexagon: vertices at 0°, 60°, … so top and bottom edges are level. */
function hexPoints(radius: number): string {
  return Array.from({ length: 6 }, (_, i) => {
    const angle = (i * 60 * Math.PI) / 180;
    return `${(CENTER + radius * Math.cos(angle)).toFixed(2)},${(
      CENTER +
      radius * Math.sin(angle)
    ).toFixed(2)}`;
  }).join(" ");
}

function nodePositions() {
  return Array.from({ length: NODES }, (_, i) => {
    // Offset by half a step so a node sits above the hexagon's flat top
    // rather than colliding with a vertex.
    const angle = ((i * 360) / NODES + 15) * (Math.PI / 180);
    return {
      x: CENTER + RING * Math.cos(angle),
      y: CENTER + RING * Math.sin(angle),
    };
  });
}

export default function NyxCoreMark({
  size = 40,
  animated = true,
  detail = true,
  className,
  title = "NYX Core",
}: NyxCoreMarkProps) {
  const nodes = nodePositions();
  // Unique ids: two marks on one page would otherwise share defs and the
  // second would inherit the first's gradients.
  const uid = `nyx-${size}-${detail ? "d" : "p"}`;

  return (
    <svg
      viewBox="0 0 200 200"
      width={size}
      height={size}
      className={className}
      role="img"
      aria-label={title}
    >
      <title>{title}</title>

      <defs>
        <radialGradient id={`${uid}-sphere`} cx="35%" cy="30%" r="75%">
          <stop offset="0%" stopColor="#e8f4ff" />
          <stop offset="35%" stopColor="#8aa2b8" />
          <stop offset="75%" stopColor="#2c3d52" />
          <stop offset="100%" stopColor="#0d1622" />
        </radialGradient>

        <linearGradient id={`${uid}-chrome`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#0e1a28" />
          <stop offset="30%" stopColor="#9fb4c9" />
          <stop offset="50%" stopColor="#dfeaf5" />
          <stop offset="70%" stopColor="#7f95ab" />
          <stop offset="100%" stopColor="#0e1a28" />
        </linearGradient>

        <linearGradient id={`${uid}-neon`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#7ff0ff" />
          <stop offset="50%" stopColor="#ffffff" />
          <stop offset="100%" stopColor="#1aa8ff" />
        </linearGradient>

        <filter id={`${uid}-glow`} x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="4.5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>

        <filter id={`${uid}-softglow`} x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="2" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Light bleeding out of the core */}
      <circle cx={CENTER} cy={CENTER} r="72" fill="#1aa8ff" opacity="0.08" />

      {detail ? (
        <g>
          {/* Rays from the core out to each node */}
          {nodes.map((node, i) => (
            <line
              key={`ray-${i}`}
              x1={CENTER}
              y1={CENTER}
              x2={node.x}
              y2={node.y}
              stroke="#3ec2ff"
              strokeWidth="0.8"
              opacity="0.32"
            />
          ))}

          {/* Chrome struts around the ring */}
          <g opacity="0.9">
            {nodes.map((node, i) => {
              const next = nodes[(i + 1) % NODES];
              return (
                <line
                  key={`strut-${i}`}
                  x1={node.x}
                  y1={node.y}
                  x2={next.x}
                  y2={next.y}
                  stroke={`url(#${uid}-chrome)`}
                  strokeWidth="3"
                  strokeLinecap="round"
                />
              );
            })}
          </g>
        </g>
      ) : null}

      {/* The ring itself turns; the core stays put. */}
      <g>
        {animated ? (
          <animateTransform
            attributeName="transform"
            type="rotate"
            from={`0 ${CENTER} ${CENTER}`}
            to={`360 ${CENTER} ${CENTER}`}
            dur="90s"
            repeatCount="indefinite"
          />
        ) : null}

        {nodes.map((node, i) => (
          <circle
            key={`node-${i}`}
            cx={node.x}
            cy={node.y}
            r={detail ? 8 : 6}
            fill={`url(#${uid}-sphere)`}
            stroke="#0a121c"
            strokeWidth="0.5"
          />
        ))}
      </g>

      {/* Chrome bezel */}
      {detail ? (
        <polygon
          points={hexPoints(HEX_OUTER)}
          fill="none"
          stroke={`url(#${uid}-chrome)`}
          strokeWidth="5"
          strokeLinejoin="round"
        />
      ) : null}

      {/* The lit core */}
      <polygon
        points={hexPoints(HEX_INNER)}
        fill="none"
        stroke={`url(#${uid}-neon)`}
        strokeWidth={detail ? 5 : 8}
        strokeLinejoin="round"
        filter={`url(#${uid}-${detail ? "glow" : "softglow"})`}
      >
        {animated ? (
          <animate
            attributeName="stroke-width"
            values={detail ? "5;6.4;5" : "8;9.5;8"}
            dur="4.5s"
            repeatCount="indefinite"
          />
        ) : null}
      </polygon>
    </svg>
  );
}
