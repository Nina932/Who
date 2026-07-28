"use client";

import { formatCount, type Platform } from "@/lib/social";

/**
 * One channel. The brand colour is allowed in exactly two places — the
 * status dot and a top hairline — so three connected platforms never turn
 * the cockpit into a logo wall.
 */
export default function PlatformCard({ platform }: { platform: Platform }) {
  const up = platform.delta >= 0;

  return (
    <div className="panel relative overflow-hidden rounded-xl p-5">
      <div
        className="absolute inset-x-0 top-0 h-px"
        style={{
          background: `linear-gradient(90deg, transparent, ${platform.accent}, transparent)`,
        }}
      />

      <div className="flex items-center gap-2.5">
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: 999,
            background: platform.connected ? platform.accent : "rgba(146,171,182,0.3)",
            boxShadow: platform.connected ? `0 0 10px ${platform.accent}` : "none",
          }}
        />
        <span
          className="text-[14px] font-semibold"
          style={{ color: "var(--color-ink)", fontFamily: "var(--font-display)" }}
        >
          {platform.name}
        </span>
      </div>

      <div className="label mt-2">{platform.handle}</div>

      <div className="mt-5 flex items-end gap-7">
        <div>
          <div
            className="font-light tabular-nums"
            style={{ fontSize: 27, lineHeight: 1, color: "var(--color-ink)" }}
          >
            {formatCount(platform.followers)}
          </div>
          <div className="label mt-2">Followers</div>
        </div>
        <div>
          <div
            className="font-light tabular-nums"
            style={{ fontSize: 27, lineHeight: 1, color: "var(--color-signal)" }}
          >
            {formatCount(platform.reach30d)}
          </div>
          <div className="label mt-2">Reach · 30d</div>
        </div>
        <div className="pb-1">
          <span
            className="text-[12px] tabular-nums"
            style={{ color: up ? "var(--color-alive)" : "var(--color-alert)" }}
          >
            {up ? "▲" : "▼"} {Math.abs(platform.delta).toFixed(1)}%
          </span>
        </div>
      </div>

      <a
        href={platform.url}
        target="_blank"
        rel="noreferrer noopener"
        className="chip mt-5 block py-2.5 text-center label transition-colors hover:text-[color:var(--color-signal)]"
      >
        Open {platform.name} →
      </a>
    </div>
  );
}
