import type { TelegramBotStatus } from "./operator-integrations";

export interface ModelRouteStatus {
  role: string;
  spec: { label: string };
  ready: boolean;
  protected: boolean;
}

export function requestsSystemStatus(utterance: string): boolean {
  return /\b(?:system status|health check|how (?:is|are) (?:the |our |your )?(?:system|systems|stack|cockpit)|how (?:the |our |your )(?:system|stack|cockpit) is (?:working|running)|is everything (?:working|running|online)|ci\s*\/?\s*cd|pipeline status|build status)\b/i.test(
    utterance,
  );
}

export function systemStatusReply(
  stack: ModelRouteStatus[],
  telegram: TelegramBotStatus,
): string {
  const configured = stack
    .filter((route) => route.ready)
    .map((route) => `${route.role}: ${route.spec.label}`);
  const missing = stack
    .filter((route) => !route.ready)
    .map((route) => route.role);
  const telegramLine = telegram.workerActive
    ? telegram.paired
      ? "Telegram replies are live and paired."
      : "Telegram polling is live, but your user ID is not paired yet."
    : "The Telegram reply worker is offline.";

  return [
    "The cockpit request path is responding right now.",
    configured.length
      ? `Configured model routes: ${configured.join(", ")}.`
      : "No live model route is configured.",
    missing.length ? `Unconfigured model roles: ${missing.join(", ")}.` : "",
    telegramLine,
    "I have not queried GitHub Actions, deployment logs, or production monitoring in this turn, so I cannot honestly call CI/CD or every server green.",
  ]
    .filter(Boolean)
    .join(" ");
}
