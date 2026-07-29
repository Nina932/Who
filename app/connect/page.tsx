"use client";

/**
 * Connections.
 *
 * Status is never asserted from stored tokens alone — every connector carries
 * a Probe button that makes one real API call. "Connected" should mean the
 * last request actually worked, not that a token exists in a file.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { AGENTS_BY_ID } from "@/lib/agents";
import type { ConnectorStatus } from "@/lib/connectors";

interface Probe {
  ok: boolean;
  count?: number;
  error?: string;
}

function ConnectInner() {
  const params = useSearchParams();
  const [connectors, setConnectors] = useState<ConnectorStatus[]>([]);
  const [configured, setConfigured] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [probes, setProbes] = useState<Record<string, Probe>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/connectors", { cache: "no-store" });
      const data = (await response.json()) as {
        configured: boolean;
        connectors: ConnectorStatus[];
      };
      setConnectors(data.connectors);
      setConfigured(data.configured);
    } catch {
      setError("Could not read connector status.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(
    async (connectorId: string, action: string) => {
      setBusy(connectorId);
      setError(null);
      try {
        const response = await fetch("/api/connectors", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action, connectorId }),
        });
        const data = (await response.json()) as {
          url?: string;
          error?: string;
          ok?: boolean;
          count?: number;
        };

        if (action === "connect") {
          if (data.url) window.location.href = data.url;
          else setError(data.error ?? "Could not start aumorpheusisation.");
          return;
        }
        if (action === "probe") {
          setProbes((prev) => ({
            ...prev,
            [connectorId]: { ok: Boolean(data.ok), count: data.count, error: data.error },
          }));
          return;
        }
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Action failed.");
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const callbackResult = params.get("result");

  return (
    <main className="h-screen w-screen overflow-y-auto">
      <div className="mx-auto max-w-[900px] px-8 pb-24 pt-6">
        <div className="relative mb-7 h-px w-full overflow-hidden">
          <div className="rule absolute inset-0 opacity-40" />
          <div
            className="scan-sweep absolute top-0 h-px w-1/4"
            style={{
              background: "linear-gradient(90deg, transparent, var(--color-signal), transparent)",
              boxShadow: "0 0 10px var(--color-signal)",
            }}
          />
        </div>

        <div className="flex items-center gap-4">
          <Link href="/" className="chip px-3 py-1.5 label transition-colors hover:text-[color:var(--color-signal)]">
            ← Morpheus
          </Link>
          <h1
            className="uppercase"
            style={{
              fontSize: 15,
              letterSpacing: "0.28em",
              color: "var(--color-signal)",
              fontFamily: "var(--font-display)",
              textShadow: "0 0 20px rgba(63,224,240,0.4)",
            }}
          >
            Connections
          </h1>
        </div>

        {callbackResult ? (
          <div
            className="panel mt-6 rounded-xl p-4"
            style={{
              borderColor:
                callbackResult === "connected"
                  ? "rgba(52,229,161,0.4)"
                  : "rgba(255,107,107,0.4)",
            }}
          >
            <span
              className="text-[12px]"
              style={{
                color: callbackResult === "connected" ? "var(--color-alive)" : "var(--color-alert)",
              }}
            >
              {callbackResult === "connected"
                ? `Connected ${params.get("connector") ?? ""}. Probe it to confirm the token works.`
                : `Aumorpheusisation failed — ${params.get("reason") ?? "unknown reason"}`}
            </span>
          </div>
        ) : null}

        {!configured ? (
          <div className="panel mt-6 rounded-xl p-5">
            <div className="label-lit" style={{ color: "var(--color-attend)" }}>
              OAuth not configured
            </div>
            <p className="mt-3 text-[12.5px] leading-relaxed" style={{ color: "var(--color-ink-soft)" }}>
              Connecting needs Google OAuth credentials. Create a client in the Google
              Cloud console, add{" "}
              <code style={{ color: "var(--color-signal)" }}>
                {"{origin}"}/api/connectors/callback
              </code>{" "}
              as an aumorpheusised redirect URI, then set:
            </p>
            <pre
              className="panel mt-3 overflow-x-auto rounded-lg p-3 text-[11px]"
              style={{ color: "var(--color-ink)", background: "rgba(4,7,10,0.6)" }}
            >{`GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
GOOGLE_OAUTH_REDIRECT_URI=http://localhost:3000/api/connectors/callback`}</pre>
          </div>
        ) : null}

        {error ? (
          <p className="mt-4 text-[12px]" style={{ color: "var(--color-alert)" }}>
            {error}
          </p>
        ) : null}

        <div className="mt-8 space-y-4">
          {connectors.map((connector) => {
            const owner = AGENTS_BY_ID[connector.ownerAgentId];
            const probe = probes[connector.id];
            return (
              <div key={connector.id} className="panel rounded-xl p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2.5">
                      <span
                        style={{
                          width: 7,
                          height: 7,
                          borderRadius: 999,
                          background: connector.connected
                            ? "var(--color-alive)"
                            : "rgba(146,171,182,0.3)",
                          boxShadow: connector.connected ? "0 0 10px var(--color-alive)" : "none",
                        }}
                      />
                      <span
                        className="text-[14px] font-semibold"
                        style={{ color: "var(--color-ink)", fontFamily: "var(--font-display)" }}
                      >
                        {connector.name}
                      </span>
                    </div>
                    <p className="mt-2.5 text-[12px]" style={{ color: "var(--color-ink-soft)" }}>
                      {connector.description}
                    </p>
                    <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1">
                      <span className="label">Reached by · {owner?.name ?? connector.ownerAgentId}</span>
                      <span className="label">
                        {connector.scopes.map((s) => s.split("/").pop()).join(" · ")}
                      </span>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {connector.connected ? (
                      <>
                        <button
                          type="button"
                          disabled={busy === connector.id}
                          onClick={() => void act(connector.id, "probe")}
                          className="chip px-4 py-2 label-lit disabled:opacity-40"
                        >
                          Probe
                        </button>
                        <button
                          type="button"
                          disabled={busy === connector.id}
                          onClick={() => void act(connector.id, "disconnect")}
                          className="chip px-4 py-2 label disabled:opacity-40"
                          style={{ color: "var(--color-alert)" }}
                        >
                          Disconnect
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        disabled={busy === connector.id || !connector.available}
                        onClick={() => void act(connector.id, "connect")}
                        className="chip px-4 py-2 label-lit disabled:opacity-30"
                        title={connector.available ? undefined : "OAuth is not configured"}
                      >
                        Connect
                      </button>
                    )}
                  </div>
                </div>

                {probe ? (
                  <p
                    className="mt-4 text-[11.5px]"
                    style={{ color: probe.ok ? "var(--color-alive)" : "var(--color-alert)" }}
                  >
                    {probe.ok
                      ? `Live call succeeded — ${probe.count} item${probe.count === 1 ? "" : "s"} returned.`
                      : probe.error}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>

        <p className="mt-8 text-[11px] leading-relaxed" style={{ color: "var(--color-ink-faint)" }}>
          Scopes are requested narrowly on purpose. Drive is read-only, and Gmail is
          granted compose rather than send — Morpheus prepares drafts, a human presses send.
        </p>
      </div>
    </main>
  );
}

export default function ConnectPage() {
  // useSearchParams needs a Suspense boundary during prerender.
  return (
    <Suspense fallback={<div className="label-lit pulse-soft p-8">Reading connections…</div>}>
      <ConnectInner />
    </Suspense>
  );
}
