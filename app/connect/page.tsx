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
import type { OperatorContext } from "@/lib/operator-context";
import type {
  OperatorProfile,
  TelegramBotStatus,
} from "@/lib/operator-integrations";

interface Probe {
  ok: boolean;
  count?: number;
  error?: string;
}

function ConnectInner() {
  const params = useSearchParams();
  const [connectors, setConnectors] = useState<ConnectorStatus[]>([]);
  const [configured, setConfigured] = useState(true);
  const [operatorContext, setOperatorContext] = useState<OperatorContext>({
    description: "",
    projectNotes: "",
    updatedAt: null,
  });
  const [profiles, setProfiles] = useState<OperatorProfile[]>([]);
  const [telegram, setTelegram] = useState<TelegramBotStatus>({
    configured: false,
    verified: false,
  });
  const [contextSaved, setContextSaved] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [probes, setProbes] = useState<Record<string, Probe>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [response, contextResponse, integrationResponse] = await Promise.all([
        fetch("/api/connectors", { cache: "no-store" }),
        fetch("/api/operator-context", { cache: "no-store" }),
        fetch("/api/operator-integrations", { cache: "no-store" }),
      ]);
      const data = (await response.json()) as {
        configured: boolean;
        connectors: ConnectorStatus[];
      };
      const contextData = (await contextResponse.json()) as {
        context: OperatorContext;
      };
      const integrationData = (await integrationResponse.json()) as {
        profiles: OperatorProfile[];
        telegram: TelegramBotStatus;
      };
      setConnectors(data.connectors);
      setConfigured(data.configured);
      setOperatorContext(contextData.context);
      setProfiles(integrationData.profiles);
      setTelegram(integrationData.telegram);
    } catch {
      setError("Could not read connector status.");
    }
  }, []);

  const saveContext = useCallback(async () => {
    setBusy("operator-context");
    setError(null);
    setContextSaved(false);
    try {
      const response = await fetch("/api/operator-context", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          description: operatorContext.description,
          projectNotes: operatorContext.projectNotes,
        }),
      });
      const data = (await response.json()) as {
        context?: OperatorContext;
        error?: string;
      };
      if (!response.ok || !data.context) {
        throw new Error(data.error ?? "Could not save private context.");
      }
      setOperatorContext(data.context);
      setContextSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save private context.");
    } finally {
      setBusy(null);
    }
  }, [operatorContext]);

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
          else setError(data.error ?? "Could not start authorisation.");
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
  const callbackOrigin =
    typeof window === "undefined"
      ? "http://127.0.0.1:4173"
      : window.location.origin;
  const missingProviders = Array.from(
    new Set(
      connectors
        .filter((connector) => !connector.available)
        .map((connector) => connector.provider),
    ),
  );

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
                : `Authorisation failed — ${params.get("reason") ?? "unknown reason"}`}
            </span>
          </div>
        ) : null}

        {!configured ? (
          <div className="panel mt-6 rounded-xl p-5">
            <div className="label-lit" style={{ color: "var(--color-attend)" }}>
              Account credentials still needed
            </div>
            <p className="mt-3 text-[12.5px] leading-relaxed" style={{ color: "var(--color-ink-soft)" }}>
              Morpheus never asks for your Google or Facebook password. Create OAuth
              clients with each provider, add{" "}
              <code style={{ color: "var(--color-signal)" }}>
                {"{origin}"}/api/connectors/callback
              </code>{" "}
              as an authorised redirect URI, then put their ids and secrets in
              <code style={{ color: "var(--color-signal)" }}> .env.local</code>.
            </p>
            <pre
              className="panel mt-3 overflow-x-auto rounded-lg p-3 text-[11px]"
              style={{ color: "var(--color-ink)", background: "rgba(4,7,10,0.6)" }}
            >{`GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
GOOGLE_OAUTH_REDIRECT_URI=http://127.0.0.1:4173/api/connectors/callback

FACEBOOK_APP_ID=...
FACEBOOK_APP_SECRET=...
FACEBOOK_OAUTH_REDIRECT_URI=http://127.0.0.1:4173/api/connectors/callback`}</pre>
          </div>
        ) : null}

        {error ? (
          <p className="mt-4 text-[12px]" style={{ color: "var(--color-alert)" }}>
            {error}
          </p>
        ) : null}

        {missingProviders.length ? (
          <section className="panel mt-6 rounded-xl p-5">
            <div className="label-lit" style={{ color: "var(--color-attend)" }}>
              Provider apps still needed
            </div>
            <p
              className="mt-3 text-[12.5px] leading-relaxed"
              style={{ color: "var(--color-ink-soft)" }}
            >
              Creating the provider app is free. Morpheus cannot connect until
              its client ID and secret exist locally; profile links are not API
              credentials.
            </p>
            <pre
              className="panel mt-3 overflow-x-auto rounded-lg p-3 text-[11px]"
              style={{ color: "var(--color-ink)", background: "rgba(4,7,10,0.6)" }}
            >{missingProviders
              .map((provider) =>
                provider === "facebook"
                  ? `FACEBOOK_APP_ID=...\nFACEBOOK_APP_SECRET=...\nFACEBOOK_OAUTH_REDIRECT_URI=${callbackOrigin}/api/connectors/callback`
                  : provider === "linkedin"
                    ? `LINKEDIN_CLIENT_ID=...\nLINKEDIN_CLIENT_SECRET=...\nLINKEDIN_OAUTH_REDIRECT_URI=${callbackOrigin}/api/connectors/callback`
                    : provider === "slack"
                      ? "SLACK_CLIENT_ID=...\nSLACK_CLIENT_SECRET=..."
                      : "",
              )
              .filter(Boolean)
              .join("\n\n")}</pre>
          </section>
        ) : null}

        <section className="panel mt-8 rounded-xl p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="label-lit">Known identities</div>
              <p className="mt-2 text-[12px] leading-relaxed" style={{ color: "var(--color-ink-soft)" }}>
                These are your confirmed profile addresses. A profile link helps
                Morpheus identify you; it does not pretend OAuth access exists.
              </p>
            </div>
            <span className="label">{profiles.length} profiles</span>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {profiles.map((profile) => (
              <a
                key={profile.id}
                href={profile.url}
                target="_blank"
                rel="noreferrer noopener"
                className="chip px-3 py-2 label-lit"
              >
                {profile.label} ↗
              </a>
            ))}
          </div>

          <div className="rule my-5" />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: 999,
                  background: telegram.verified
                    ? telegram.matchesExpected === false
                      ? "var(--color-alert)"
                      : "var(--color-alive)"
                    : "rgba(146,171,182,0.3)",
                  boxShadow: telegram.verified
                    ? telegram.matchesExpected === false
                      ? "0 0 10px var(--color-alert)"
                      : "0 0 10px var(--color-alive)"
                    : "none",
                }}
              />
              <div>
                <div className="text-[13px]" style={{ color: "var(--color-ink)" }}>
                  Telegram bot
                </div>
                <div className="label mt-1">
                  {telegram.verified
                    ? telegram.matchesExpected === false
                      ? `Token is bot ID ${telegram.botId}; expected ${telegram.expectedBotId ?? "unknown"}`
                      : telegram.usernameChanged
                        ? `Verified ID ${telegram.botId} · current username @${telegram.username}`
                        : `Verified · @${telegram.username} · ID ${telegram.botId}${
                            telegram.workerActive
                              ? telegram.paired
                                ? " · replies live"
                                : " · worker live, pairing needed"
                              : " · reply worker offline"
                          }`
                    : telegram.configured
                      ? `Token configured · probe failed${telegram.error ? `: ${telegram.error}` : ""}`
                      : "Not configured"}
                </div>
              </div>
            </div>
            {telegram.verified &&
            telegram.matchesExpected !== false &&
            telegram.username ? (
              <a
                href={`https://t.me/${telegram.username}`}
                target="_blank"
                rel="noreferrer noopener"
                className="chip px-3 py-2 label-lit"
              >
                Open bot ↗
              </a>
            ) : null}
          </div>
        </section>

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
                      {connector.account ? (
                        <span className="label-lit">{connector.account}</span>
                      ) : null}
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

        <section className="panel mt-8 rounded-xl p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="label-lit" style={{ color: "var(--color-attend)" }}>
                Private operator context
              </div>
              <p className="mt-2 max-w-[650px] text-[12px] leading-relaxed" style={{ color: "var(--color-ink-soft)" }}>
                This stays in Morpheus&apos; local context. It personalizes replies and
                is never sent to Gmail, Facebook, or another connector.
              </p>
            </div>
            <span className="label">
              {operatorContext.updatedAt
                ? `Saved ${new Date(operatorContext.updatedAt).toLocaleString()}`
                : "Not saved yet"}
            </span>
          </div>

          <label className="mt-5 block">
            <span className="label">About you · how Morpheus should understand you</span>
            <textarea
              value={operatorContext.description}
              onChange={(event) => {
                setContextSaved(false);
                setOperatorContext((current) => ({
                  ...current,
                  description: event.target.value,
                }));
              }}
              rows={5}
              maxLength={4000}
              placeholder="Your background, goals, working style, sense of humor, and anything Morpheus should remember."
              className="panel mt-2 w-full resize-y rounded-lg px-3 py-3 text-[12.5px] outline-none"
              style={{ color: "var(--color-ink)", background: "rgba(4,7,10,0.62)" }}
            />
          </label>

          <label className="mt-4 block">
            <span className="label">Project context · beyond the existing FinAI and G8 ledger</span>
            <textarea
              value={operatorContext.projectNotes}
              onChange={(event) => {
                setContextSaved(false);
                setOperatorContext((current) => ({
                  ...current,
                  projectNotes: event.target.value,
                }));
              }}
              rows={6}
              maxLength={8000}
              placeholder="Current priorities, constraints, collaborators, deadlines, and what success means."
              className="panel mt-2 w-full resize-y rounded-lg px-3 py-3 text-[12.5px] outline-none"
              style={{ color: "var(--color-ink)", background: "rgba(4,7,10,0.62)" }}
            />
          </label>

          <div className="mt-4 flex items-center gap-3">
            <button
              type="button"
              disabled={busy === "operator-context"}
              onClick={() => void saveContext()}
              className="chip px-4 py-2 label-lit disabled:opacity-40"
            >
              Save private context
            </button>
            {contextSaved ? (
              <span className="text-[11.5px]" style={{ color: "var(--color-alive)" }}>
                Morpheus will use this on the next turn.
              </span>
            ) : null}
          </div>
        </section>

        <p className="mt-8 text-[11px] leading-relaxed" style={{ color: "var(--color-ink-faint)" }}>
          Scopes are requested narrowly on purpose. Gmail can read and prepare drafts,
          personal Facebook only verifies identity, and a human still approves anything
          public.
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
