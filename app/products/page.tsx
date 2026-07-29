"use client";

/**
 * Product state — the chief-of-staff view.
 *
 * Answers the questions a daily list cannot: where is this actually, what
 * changed, what is stopping it, and have we entered the phase we said we
 * entered a month ago.
 *
 * The exit conditions are the spine. A milestone with no evidenced condition
 * is a label, and this draws it as one — because "nearly ready" is the single
 * most expensive sentence a solo founder says to themselves.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { SurfaceHeader } from "@/components/cases/parts";
import type { Advisory } from "@/lib/advisory";
import type { Brief } from "@/lib/brief";
import { KIND_LABEL, type Entry } from "@/lib/knowledge";
import { PHASE_LABEL, PHASE_PATIENCE_DAYS, type ProductView } from "@/lib/products";

interface State {
  brief: Brief;
  entries: Entry[];
  problems: string[];
}

const DAY = 86_400_000;

const KIND_COLOR: Record<string, string> = {
  fact: "var(--color-alive)",
  decision: "var(--color-signal)",
  commitment: "var(--color-attend)",
  hypothesis: "var(--color-violet)",
  preference: "var(--color-ink-soft)",
  recommendation: "var(--color-aqua)",
};

export default function ProductsPage() {
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/assistant", { cache: "no-store" });
      if (response.ok) setState((await response.json()) as State);
    } catch {
      /* rendered as empty below */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(async (payload: Record<string, unknown>) => {
    setBusy(true);
    try {
      const response = await fetch("/api/assistant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (response.ok) setState((await response.json()) as State);
    } finally {
      setBusy(false);
    }
  }, []);

  const products: ProductView[] = useMemo(
    () => state?.brief.productViews ?? [],
    [state],
  );

  if (!state) {
    return (
      <main className="h-screen w-screen overflow-y-auto">
        <div className="mx-auto max-w-[1000px] px-8 pt-6">
          <SurfaceHeader title="Products" />
          <p className="label mt-10">reading product state…</p>
        </div>
      </main>
    );
  }

  const portfolio = state.brief.advisories.filter((a) => a.subject === "business");

  return (
    <main className="h-screen w-screen overflow-y-auto">
      <div className="mx-auto max-w-[1000px] px-8 pb-24 pt-6">
        <SurfaceHeader
          title="Products"
          right={
            <span className="label">
              {products.filter((p) => p.active).length} active of {products.length}
            </span>
          }
        />

        <p className="mt-6 max-w-[70ch] text-[13px] leading-relaxed" style={{ color: "var(--color-ink-soft)" }}>
          Where each product actually is, how long it has been there, and
          whether the milestone it claims to be pursuing has anything behind
          it. A phase is a claim; the exit conditions are the check.
        </p>

        {products.length === 0 ? (
          <div className="panel mt-8 rounded-xl p-8">
            <div className="label-lit">No products recorded</div>
            <p className="mt-3 max-w-[62ch] text-[13px] leading-relaxed" style={{ color: "var(--color-ink-soft)" }}>
              Load the worked example set — two products transcribed from a real
              description, with the blockers and phases that go with them.
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => void act({ action: "seed-examples" })}
              className="chip mt-5 px-4 py-2 label transition-colors hover:text-[color:var(--color-signal)] disabled:opacity-40"
            >
              {busy ? "loading…" : "Load examples"}
            </button>
          </div>
        ) : (
          <>
            {portfolio.length > 0 ? (
              <div className="panel mt-7 rounded-xl p-5" style={{ borderColor: "rgba(242,193,78,0.35)" }}>
                <div className="label-lit" style={{ color: "var(--color-attend)" }}>
                  Across the portfolio
                </div>
                {portfolio.map((advisory) => (
                  <div key={advisory.id} className="mt-3">
                    <p className="text-[13.5px]" style={{ color: "var(--color-ink)" }}>
                      {advisory.recommendation}
                    </p>
                    <p className="mt-1.5 text-[12px] leading-relaxed" style={{ color: "var(--color-ink-soft)" }}>
                      {advisory.reason}
                    </p>
                    <p className="mt-1.5 label label-flow">changes if · {advisory.wouldChangeIf}</p>
                  </div>
                ))}
              </div>
            ) : null}

            <div className="mt-7 space-y-5">
              {products.map((product) => (
                <ProductCard
                  key={product.id}
                  product={product}
                  entries={state.entries}
                  advisories={state.brief.advisories.filter((a) => a.subject === product.id)}
                  busy={busy}
                  act={act}
                />
              ))}
            </div>

            <button
              type="button"
              disabled={busy}
              onClick={() => void act({ action: "clear-examples" })}
              className="chip mt-8 px-3 py-1.5 label transition-colors hover:text-[color:var(--color-alert)] disabled:opacity-40"
            >
              clear examples
            </button>
          </>
        )}
      </div>
    </main>
  );
}

function ProductCard({
  product,
  entries,
  advisories,
  busy,
  act,
}: {
  product: ProductView;
  entries: Entry[];
  advisories: Advisory[];
  busy: boolean;
  act: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const patience = PHASE_PATIENCE_DAYS[product.phase];
  const overrun = product.phaseDays > patience;
  const known = entries.filter((e) => e.subject === product.id);

  return (
    <section className="panel rounded-xl p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-[17px]" style={{ color: "var(--color-ink)", fontFamily: "var(--font-display)" }}>
            {product.name}
          </h2>
          <p className="mt-1.5 text-[13px]" style={{ color: "var(--color-ink-soft)" }}>
            {product.objective}
          </p>
        </div>
        <div className="text-right">
          <div className="label" style={{ color: overrun ? "var(--color-attend)" : "var(--color-signal)" }}>
            {PHASE_LABEL[product.phase]}
          </div>
          <div className="label mt-1 tabular-nums">
            {Math.round(product.phaseDays)}d of ~{patience}d
          </div>
        </div>
      </div>

      {/* How far through the phase's reasonable duration. Past full is amber. */}
      <div className="mt-4 h-1 overflow-hidden rounded-full" style={{ background: "rgba(255,255,255,0.05)" }}>
        <div
          style={{
            width: `${Math.min(100, (product.phaseDays / patience) * 100)}%`,
            height: "100%",
            background: overrun ? "var(--color-attend)" : "var(--color-signal)",
            opacity: 0.85,
          }}
        />
      </div>

      <div className="mt-5 grid gap-5 sm:grid-cols-2">
        <div>
          <div className="label-lit" style={{ color: "var(--color-alive)" }}>
            Working
          </div>
          <ul className="mt-2 space-y-1">
            {product.working.map((capability) => (
              <li key={capability.name} className="text-[12px]" style={{ color: "var(--color-ink-soft)" }}>
                {capability.name}
                {capability.customerFacing ? (
                  <span className="label ml-2" style={{ color: "var(--color-alive)" }}>
                    customer-facing
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>

        <div>
          <div className="label-lit" style={{ color: "var(--color-alert)" }}>
            Blocked · {product.openBlockers.length}
          </div>
          <ul className="mt-2 space-y-1.5">
            {product.openBlockers.map((blocker) => {
              const days = Math.round((Date.now() - blocker.openedAt) / DAY);
              return (
                <li key={blocker.id} className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 text-[12px]" style={{ color: "var(--color-ink-soft)" }}>
                    {blocker.name}
                    {blocker.release ? (
                      <span className="label ml-2" style={{ color: "var(--color-alert)" }}>
                        blocks release
                      </span>
                    ) : null}
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void act({
                        action: "resolve-blocker",
                        productId: product.id,
                        blockerId: blocker.id,
                      })
                    }
                    className="label shrink-0 transition-colors hover:text-[color:var(--color-alive)] disabled:opacity-40"
                    title="Mark resolved"
                  >
                    {days}d · clear
                  </button>
                </li>
              );
            })}
            {product.openBlockers.length === 0 ? (
              <li className="label">Nothing open.</li>
            ) : null}
          </ul>
        </div>
      </div>

      {/* The spine: a milestone is only as real as its evidenced conditions. */}
      <div className="mt-5">
        <div className="flex items-baseline justify-between gap-3">
          <div className="label-lit">Next milestone · {product.milestone.name}</div>
          <span
            className="label tabular-nums"
            style={{
              color: product.metConditions === 0 ? "var(--color-alert)" : "var(--color-signal)",
            }}
          >
            {product.metConditions}/{product.totalConditions} evidenced
          </span>
        </div>
        <ul className="mt-2 space-y-1.5">
          {product.milestone.exit.map((condition) => {
            const met = condition.evidence.some((ref) =>
              entries.some((e) => e.id === ref && !e.supersededBy),
            );
            return (
              <li key={condition.id} className="flex items-baseline gap-3">
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: 999,
                    flexShrink: 0,
                    background: met ? "var(--color-alive)" : "rgba(255,255,255,0.12)",
                  }}
                />
                <span className="text-[12px]" style={{ color: met ? "var(--color-ink)" : "var(--color-ink-faint)" }}>
                  {condition.text}
                </span>
                {!met ? <span className="label">no evidence</span> : null}
              </li>
            );
          })}
        </ul>
      </div>

      {advisories.length > 0 ? (
        <div className="mt-5 rounded-lg px-4 py-3" style={{ background: "rgba(242,193,78,0.07)" }}>
          {advisories.map((advisory) => (
            <div key={advisory.id} className="mb-3 last:mb-0">
              <p className="text-[13px]" style={{ color: "var(--color-ink)" }}>
                {advisory.recommendation}
              </p>
              <p className="mt-1 text-[12px] leading-relaxed" style={{ color: "var(--color-ink-soft)" }}>
                {advisory.reason}
              </p>
              <p className="mt-1.5 label label-flow">
                {advisory.confidence} confidence · changes if {advisory.wouldChangeIf}
              </p>
            </div>
          ))}
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="label mt-4 transition-colors hover:text-[color:var(--color-signal)]"
      >
        {open ? "hide what is known" : `what is known · ${known.length}`}
      </button>

      {open ? (
        <ul className="mt-3 space-y-1.5 border-t pt-3" style={{ borderColor: "rgba(62,194,255,0.15)" }}>
          {known.map((entry) => (
            <li key={entry.id} className="flex items-baseline gap-3">
              <span className="label w-[100px] shrink-0" style={{ color: KIND_COLOR[entry.kind] }}>
                {KIND_LABEL[entry.kind]}
              </span>
              <span className="min-w-0 flex-1 text-[12px]" style={{ color: "var(--color-ink-soft)" }}>
                {entry.text}
              </span>
              <span className="label shrink-0">{entry.provenance}</span>
            </li>
          ))}
          {known.length === 0 ? <li className="label">Nothing recorded.</li> : null}
        </ul>
      ) : null}
    </section>
  );
}
