"use client";

/**
 * What Morpheus may do without asking.
 *
 * The page exists because a policy nobody can see is a policy nobody has
 * agreed to. Every capability is listed with the decision it would get *right
 * now*, so the blast radius of the current setting is legible rather than
 * inferred from a number.
 *
 * The level-4 rows carry no toggle. That is not an omission — there is no
 * setting that makes sending, publishing, deploying, deleting or spending
 * automatic, and a disabled switch would imply there might be.
 */

import { useCallback, useEffect, useState } from "react";
import { SurfaceHeader } from "@/components/cases/parts";
import type { Capability, Decision, Level, LevelSpec, Policy } from "@/lib/authority";
import { describe, type AuditEntry } from "@/lib/broker";

interface Row extends Capability {
  decision: Decision;
}

interface State {
  policy: Policy;
  levels: LevelSpec[];
  maxAutomaticLevel: Level;
  capabilities: Row[];
  unattended: string[];
  audit: AuditEntry[];
}

const LEVEL_COLOR: Record<number, string> = {
  1: "var(--color-ink-soft)",
  2: "var(--color-signal)",
  3: "var(--color-aqua)",
  4: "var(--color-alert)",
};

const DOMAIN_ORDER = [
  "communication",
  "development",
  "infrastructure",
  "business",
  "research",
  "personal",
] as const;

export default function AuthorityPage() {
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/authority", { cache: "no-store" });
      if (response.ok) setState((await response.json()) as State);
    } catch {
      /* rendered as loading below */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(
    async (payload: Record<string, unknown>) => {
      setBusy(true);
      try {
        const response = await fetch("/api/authority", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        const body = (await response.json()) as { note?: string };
        setNote(body.note ?? null);
        await load();
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  if (!state) {
    return (
      <main className="h-screen w-screen overflow-y-auto">
        <div className="mx-auto max-w-[1040px] px-8 pt-6">
          <SurfaceHeader title="Authority" />
          <p className="label mt-10">reading policy…</p>
        </div>
      </main>
    );
  }

  const { policy, levels, capabilities, audit } = state;
  const free = capabilities.filter((c) => c.decision.permitted && !c.decision.requiresApproval);

  return (
    <main className="h-screen w-screen overflow-y-auto">
      <div className="mx-auto max-w-[1040px] px-8 pb-24 pt-6">
        <SurfaceHeader
          title="Authority"
          right={
            <span className="label">
              {free.length} of {capabilities.length} run without asking
            </span>
          }
        />

        <p className="mt-6 max-w-[72ch] text-[13px] leading-relaxed" style={{ color: "var(--color-ink-soft)" }}>
          Broad visibility is safe and is most of what makes an assistant
          useful. Broad authority is what makes one dangerous, and the two
          usually arrive through the same consent screen. This separates them.
        </p>

        {/* ── The ceiling ─────────────────────────────────────────── */}
        <section className="panel mt-8 rounded-xl p-6">
          <div className="label-lit">How far it may go on its own</div>

          <div className="mt-4 flex flex-wrap gap-2">
            {levels.map((level) => {
              const selected = policy.ceiling === level.level;
              const impossible = level.level > state.maxAutomaticLevel;
              return (
                <button
                  key={level.level}
                  type="button"
                  disabled={busy || impossible}
                  onClick={() => void act({ action: "set-ceiling", ceiling: level.level })}
                  className="chip px-3 py-1.5 label transition-colors disabled:cursor-not-allowed"
                  style={{
                    color: impossible
                      ? "var(--color-ink-faint)"
                      : selected
                        ? LEVEL_COLOR[level.level]
                        : undefined,
                    borderColor: selected ? LEVEL_COLOR[level.level] : undefined,
                    opacity: impossible ? 0.4 : 1,
                  }}
                  title={impossible ? "Not available at any setting." : level.meaning}
                >
                  {level.level} · {level.name}
                </button>
              );
            })}
          </div>

          <div className="mt-5 space-y-3">
            {levels.map((level) => (
              <div key={level.level} className="flex gap-3">
                <span
                  className="label w-[130px] shrink-0"
                  style={{ color: LEVEL_COLOR[level.level] }}
                >
                  {level.level} {level.name}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[12px]" style={{ color: "var(--color-ink-soft)" }}>
                    {level.meaning}
                  </p>
                  <p className="mt-0.5 text-[11px]" style={{ color: "var(--color-ink-faint)" }}>
                    {level.risk}
                  </p>
                </div>
              </div>
            ))}
          </div>

          <p className="mt-5 text-[12px] leading-relaxed" style={{ color: "var(--color-attend)" }}>
            Level 4 is not a setting. There is no configuration, and no
            instruction you could give it, that makes sending, publishing,
            deploying, deleting or spending happen unattended — a boundary that
            can be switched off is a default, not a boundary.
          </p>

          {note ? (
            <p className="mt-3 text-[12px]" style={{ color: "var(--color-signal)" }}>
              {note}
            </p>
          ) : null}
        </section>

        {/* ── Spend ───────────────────────────────────────────────── */}
        <section className="panel mt-5 rounded-xl p-6">
          <div className="label-lit">Spend limit</div>
          <p className="mt-2 text-[12px]" style={{ color: "var(--color-ink-soft)" }}>
            Anything above this asks, on top of already asking. Spending is
            level 4 regardless — this is a second bound, not a permission.
          </p>
          <form
            className="mt-3 flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const input = e.currentTarget.elements.namedItem("limit") as HTMLInputElement;
              void act({
                action: "set-spend-limit",
                spendLimitMinor: Math.round(Number(input.value) * 100),
              });
            }}
          >
            <input
              name="limit"
              type="number"
              step="0.01"
              min="0"
              defaultValue={(policy.spendLimitMinor / 100).toFixed(2)}
              className="chip w-[140px] px-3 py-1.5 text-[12px] outline-none"
              style={{ color: "var(--color-ink)", background: "transparent" }}
            />
            <button type="submit" disabled={busy} className="chip px-3 py-1.5 label disabled:opacity-40">
              set
            </button>
          </form>
        </section>

        {/* ── The registry ────────────────────────────────────────── */}
        {DOMAIN_ORDER.map((domain) => {
          const rows = capabilities.filter((c) => c.domain === domain);
          if (rows.length === 0) return null;

          return (
            <section key={domain} className="mt-8">
              <div className="label-lit">{domain}</div>
              <ul className="mt-3 space-y-1.5">
                {rows.map((row) => {
                  const automatic = row.decision.permitted && !row.decision.requiresApproval;
                  const denied = !row.decision.permitted;

                  return (
                    <li key={row.id} className="panel rounded-lg px-4 py-3">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span
                              className="label shrink-0"
                              style={{ color: LEVEL_COLOR[row.level], width: 14 }}
                            >
                              {row.level}
                            </span>
                            <span className="text-[13px]" style={{ color: "var(--color-ink)" }}>
                              {row.label}
                            </span>
                            <span className="label">{row.id}</span>
                          </div>
                          <p className="mt-1 pl-[22px] text-[12px]" style={{ color: "var(--color-ink-soft)" }}>
                            {row.consequence}
                          </p>
                          <p className="mt-0.5 pl-[22px] label label-flow">{row.decision.reason}</p>
                        </div>

                        <div className="flex shrink-0 items-center gap-2">
                          <span
                            className="label"
                            style={{
                              color: denied
                                ? "var(--color-alert)"
                                : automatic
                                  ? "var(--color-alive)"
                                  : "var(--color-attend)",
                            }}
                          >
                            {denied ? "denied" : automatic ? "automatic" : "asks first"}
                          </span>

                          {/* No toggle on level 4. A disabled switch would
                              imply there is a setting; there is not. */}
                          {row.level < 4 ? (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                void act({
                                  action: denied ? "clear" : "deny",
                                  capabilityId: row.id,
                                })
                              }
                              className="label transition-colors hover:text-[color:var(--color-alert)] disabled:opacity-40"
                            >
                              {denied ? "un-deny" : "deny"}
                            </button>
                          ) : null}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}

        {/* ── Audit ───────────────────────────────────────────────── */}
        <section className="mt-9">
          <div className="label-lit">Audit · {audit.length}</div>
          <p className="mt-2 max-w-[72ch] text-[12px]" style={{ color: "var(--color-ink-faint)" }}>
            Every grant, every redemption, and every refusal. The refusals are
            the rows worth reading — a successful redemption is the system
            working, and a refused one is the only evidence you get that
            something tried.
          </p>
          {audit.length === 0 ? (
            <p className="mt-3 label">Nothing has requested authority yet.</p>
          ) : (
            <pre
              className="mt-3 max-h-[320px] overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed"
              style={{ color: "var(--color-ink-soft)" }}
            >
              {audit.map((entry) => describe(entry)).join("\n")}
            </pre>
          )}
        </section>
      </div>
    </main>
  );
}
