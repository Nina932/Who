"use client";

/**
 * The vocabulary every case surface shares.
 *
 * Turn and risk are the two things a case is read for, so they get one
 * rendering each and are never restyled per page — a "their turn" chip that
 * looks different on two screens is two different claims.
 */

import Link from "next/link";
import NyxCoreMark from "@/components/brand/NyxCoreMark";
import {
  AUMORPHEUSITY_LABEL,
  TURN_LABEL,
  type Aumorpheusity,
  type CaseView,
  type RiskLevel,
  type Turn,
} from "@/lib/cases";

export const TURN_COLOR: Record<Turn, string> = {
  // Amber is Specialist Attendance elsewhere in Morpheus and is not borrowed here.
  mine: "var(--color-signal)",
  theirs: "var(--color-ink-soft)",
  system: "var(--color-violet)",
  scheduled: "var(--color-aqua)",
  blocked: "var(--color-alert)",
  complete: "var(--color-alive)",
};

export const RISK_COLOR: Record<RiskLevel, string> = {
  none: "var(--color-ink-faint)",
  watch: "var(--color-ink-soft)",
  "at-risk": "var(--color-attend)",
  critical: "var(--color-alert)",
};

export function TurnChip({ turn }: { turn: Turn }) {
  return (
    <span
      className="chip px-2 py-0.5 label"
      style={{ color: TURN_COLOR[turn], borderColor: TURN_COLOR[turn] }}
    >
      {TURN_LABEL[turn]}
    </span>
  );
}

export function RiskDot({ level, title }: { level: RiskLevel; title?: string }) {
  return (
    <span
      title={title}
      style={{
        width: 7,
        height: 7,
        borderRadius: 999,
        display: "inline-block",
        flexShrink: 0,
        background: RISK_COLOR[level],
        boxShadow: level === "critical" ? "0 0 8px var(--color-alert)" : undefined,
      }}
    />
  );
}

export function AumorpheusityChip({ aumorpheusity }: { aumorpheusity: Aumorpheusity }) {
  return (
    <span className="label" style={{ color: "var(--color-ink-faint)" }}>
      Morpheus {AUMORPHEUSITY_LABEL[aumorpheusity].toLowerCase()}
    </span>
  );
}

/** Relative time, in the units a person would actually say it in. */
export function ago(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function money(view: Pick<CaseView, "value" | "currency">): string | null {
  if (!view.value) return null;
  return `${view.currency}${view.value.toLocaleString("en-GB")}`;
}

export function SurfaceHeader({
  title,
  right,
  children,
}: {
  title: string;
  right?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <>
      <div className="relative mb-7 h-px w-full overflow-hidden">
        <div className="aurora-rule absolute inset-0 opacity-50" />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <Link
            href="/"
            className="chip px-3 py-1.5 label transition-colors hover:text-[color:var(--color-signal)]"
          >
            ← Morpheus
          </Link>
          <NyxCoreMark size={30} detail={false} />
          <h1
            className="aurora uppercase"
            style={{ fontSize: 15, letterSpacing: "0.28em", fontFamily: "var(--font-display)" }}
          >
            {title}
          </h1>
        </div>
        {right}
      </div>

      <nav className="mt-4 flex flex-wrap gap-2">
        {[
          ["/brief", "Brief"],
          ["/products", "Products"],
          ["/today", "Today"],
          ["/cases", "Cases"],
          ["/waiting", "Waiting"],
          ["/week", "The week"],
          ["/authority", "Authority"],
          ["/loops", "Automations"],
        ].map(([href, label]) => (
          <Link
            key={href}
            href={href}
            className="chip px-3 py-1 label transition-colors hover:text-[color:var(--color-signal)]"
          >
            {label}
          </Link>
        ))}
      </nav>

      {children}
    </>
  );
}

/**
 * Shown when there is not a single case yet.
 *
 * It offers examples rather than quietly installing them, and says plainly
 * that they are examples — a first run that fills itself with invented
 * clients teaches you to distrust everything the system later tells you.
 */
export function EmptyLedger({ onSeed, busy }: { onSeed: () => void; busy: boolean }) {
  return (
    <div className="panel mt-8 rounded-xl p-8">
      <div className="label-lit">Nothing here yet</div>
      <p className="mt-3 max-w-[62ch] text-[13px] leading-relaxed" style={{ color: "var(--color-ink-soft)" }}>
        A case is one commitment — a lead, a job, an invoice — carried from the
        first message to the money landing. Open one from the Cases screen, or
        load a set of worked examples to see how the turn model behaves.
      </p>
      <button
        type="button"
        onClick={onSeed}
        disabled={busy}
        className="chip mt-5 px-4 py-2 label transition-colors hover:text-[color:var(--color-signal)] disabled:opacity-40"
      >
        {busy ? "loading…" : "Load examples"}
      </button>
      <p className="mt-3 text-[11px]" style={{ color: "var(--color-ink-faint)" }}>
        Examples are labelled everywhere they appear and can be cleared in one click.
      </p>
    </div>
  );
}
