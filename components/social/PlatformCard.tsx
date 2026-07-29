"use client";

import Link from "next/link";
import type { Platform } from "@/lib/social";
import type { OperatorProfile } from "@/lib/operator-integrations";

/**
 * One channel. The brand colour is allowed in exactly two places — the
 * status dot and a top hairline — so three connected platforms never turn
 * the cockpit into a logo wall.
 */
export default function PlatformCard({
  platform,
  connected,
  available,
  profiles,
}: {
  platform: Platform;
  connected: boolean;
  available: boolean;
  profiles: OperatorProfile[];
}) {
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
            background: connected ? platform.accent : "rgba(146,171,182,0.3)",
            boxShadow: connected ? `0 0 10px ${platform.accent}` : "none",
          }}
        />
        <span
          className="text-[14px] font-semibold"
          style={{ color: "var(--color-ink)", fontFamily: "var(--font-display)" }}
        >
          {platform.name}
        </span>
      </div>

      <div className="mt-4 text-[12px]" style={{ color: "var(--color-ink-soft)" }}>
        {connected
          ? platform.id === "facebook"
            ? "Identity verified. Meta does not expose personal timeline reading or publishing."
            : "Connected. Account data appears only after a successful live read."
          : platform.manualUrl
            ? "Free manual mode. X API access requires prepaid credits, so Morpheus will not spend money silently."
          : available
            ? "Not connected. No handle or metrics have been loaded."
            : "No connector is configured for this account yet."}
      </div>

      {profiles.length ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {profiles.map((profile) => (
            <a
              key={profile.id}
              href={profile.url}
              target="_blank"
              rel="noreferrer noopener"
              className="chip px-3 py-2 label-lit"
            >
              Known {profile.kind === "company" ? "company page" : "profile"} ↗
            </a>
          ))}
        </div>
      ) : null}

      {platform.manualUrl ? (
        <a
          href={platform.manualUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="chip mt-5 block py-2.5 text-center label transition-colors hover:text-[color:var(--color-signal)]"
        >
          {platform.manualLabel ?? "Open platform"} →
        </a>
      ) : (
        <Link
          href="/connect"
          className="chip mt-5 block py-2.5 text-center label transition-colors hover:text-[color:var(--color-signal)]"
        >
          {connected ? "Verify connection" : available ? "Connect account" : "Connection setup"} →
        </Link>
      )}
    </div>
  );
}
