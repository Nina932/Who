/**
 * What Morpheus may do without asking.
 *
 * "Full access" is the wrong frame. Broad *visibility* is safe and is what
 * makes an assistant useful; broad *authority* is what makes one dangerous,
 * and the two are usually conflated because both arrive through the same
 * OAuth consent screen. This file separates them.
 *
 * Four levels, and the boundary that matters is between three and four:
 *
 *   1  Observe   Read. The broadest level, and the one to be generous with.
 *   2  Prepare   Produce the artefact and stop. Nothing leaves.
 *   3  Execute   Do it, when it can be undone. Logged, reversible.
 *   4  Approve   Ask first. External, irreversible, or costs money.
 *
 * Three rules make this more than a label:
 *
 *   - **Level 4 cannot be raised away.** The ceiling saturates at 3. There is
 *     no configuration, no "trusted mode", no prompt that lets Morpheus send
 *     an email or move money unattended. A setting that can be turned off is
 *     not a safety property; it is a default.
 *   - **Irreversible implies level 4.** Enforced by a test over the whole
 *     registry rather than by remembering to set it. Adding a capability that
 *     cannot be undone and marking it level 3 fails the build.
 *   - **Deny beats allow.** Always, without exception, so a denial can never
 *     be argued away by a broader grant elsewhere.
 *
 * The policy lives here, in code, not in a system prompt. A model that is
 * *asked* to respect a boundary is a model that can be talked out of it.
 */

// ── Levels ───────────────────────────────────────────────────────────────

export type Level = 1 | 2 | 3 | 4;

export interface LevelSpec {
  level: Level;
  name: string;
  meaning: string;
  /** Said plainly, because the operator has to decide where their line is. */
  risk: string;
}

export const LEVELS: LevelSpec[] = [
  {
    level: 1,
    name: "Observe",
    meaning: "Read repositories, calendars, logs, mail, dashboards, deployments, news.",
    risk: "Everything it reads can end up in a model's context. Scope the reads, not the level.",
  },
  {
    level: 2,
    name: "Prepare",
    meaning: "Draft the email, the patch, the pull request, the deployment plan, the report.",
    risk: "Nothing leaves. The cost of a bad draft is the time spent reading it.",
  },
  {
    level: 3,
    name: "Execute reversible",
    meaning: "Create a branch, run tests, file an issue, save a draft, update internal state.",
    risk: "Real changes, all undoable. Noise and clutter, not damage.",
  },
  {
    level: 4,
    name: "Ask first",
    meaning: "Send, publish, merge, deploy, buy, transfer, delete, or change credentials.",
    risk: "Leaves your control or cannot be undone. Never automatic, at any setting.",
  },
];

export const LEVEL_BY_NUMBER: Record<Level, LevelSpec> = Object.fromEntries(
  LEVELS.map((l) => [l.level, l]),
) as Record<Level, LevelSpec>;

/**
 * The ceiling saturates here. Not a default — a bound.
 *
 * If this were configurable to 4 it would eventually be set to 4, on a busy
 * day, to stop being asked. Then the first genuinely wrong action is silent.
 */
export const MAX_AUTOMATIC_LEVEL: Level = 3;

// ── Capabilities ─────────────────────────────────────────────────────────

export type Domain =
  | "communication"
  | "development"
  | "infrastructure"
  | "business"
  | "research"
  | "personal";

export interface Capability {
  id: string;
  label: string;
  domain: Domain;
  level: Level;
  /** Can the effect be undone without asking anyone? */
  reversible: boolean;
  /** Permissions the broker will attach to a grant. Never credentials. */
  scopes: string[];
  /** What is actually at stake. Shown verbatim at the approval prompt. */
  consequence: string;
  /** True when the capability can spend money. Subject to the spend limit. */
  spends?: boolean;
}

/**
 * The registry.
 *
 * Deliberately fine-grained on the boundary that matters. `gmail.draft` and
 * `gmail.send` are two capabilities at two levels, because "email access" as
 * a single permission is how an assistant ends up able to send.
 */
export const CAPABILITIES: Capability[] = [
  // ── Communication ──────────────────────────────────────────────────
  {
    id: "mail.read",
    label: "Read mail",
    domain: "communication",
    level: 1,
    reversible: true,
    scopes: ["gmail.readonly"],
    consequence: "Message contents enter the assistant's working context.",
  },
  {
    id: "mail.draft",
    label: "Draft an email",
    domain: "communication",
    level: 2,
    reversible: true,
    scopes: ["gmail.compose"],
    consequence: "A draft appears in your drafts folder. Nothing is sent.",
  },
  {
    id: "mail.send",
    label: "Send an email",
    domain: "communication",
    level: 4,
    reversible: false,
    scopes: ["gmail.send"],
    consequence: "It reaches a person and cannot be recalled.",
  },
  {
    id: "calendar.read",
    label: "Read the calendar",
    domain: "communication",
    level: 1,
    reversible: true,
    scopes: ["calendar.readonly"],
    consequence: "Your schedule becomes visible to the assistant.",
  },
  {
    id: "calendar.propose",
    label: "Propose a calendar event",
    domain: "communication",
    level: 3,
    reversible: true,
    scopes: ["calendar.events"],
    consequence: "An event appears on your own calendar. Deleting it costs a click.",
  },
  {
    id: "calendar.invite",
    label: "Invite others to a meeting",
    domain: "communication",
    level: 4,
    reversible: false,
    scopes: ["calendar.events"],
    consequence: "Other people receive an invitation from you.",
  },
  {
    id: "chat.post",
    label: "Post to a channel",
    domain: "communication",
    level: 4,
    reversible: false,
    scopes: ["chat:write"],
    consequence: "Colleagues or clients see it, attributed to you.",
  },
  {
    id: "social.publish",
    label: "Publish a post",
    domain: "communication",
    level: 4,
    reversible: false,
    scopes: ["w_member_social"],
    consequence: "Public, indexed, and screenshotted before you can delete it.",
  },

  // ── Development ────────────────────────────────────────────────────
  {
    id: "repo.read",
    label: "Read a repository",
    domain: "development",
    level: 1,
    reversible: true,
    scopes: ["repo:read"],
    consequence: "Source, history and issues enter the working context.",
  },
  {
    id: "repo.branch",
    label: "Create a branch",
    domain: "development",
    level: 3,
    reversible: true,
    scopes: ["repo:write"],
    consequence: "A branch nobody has to look at. Deleting it costs nothing.",
  },
  {
    id: "repo.patch",
    label: "Prepare a patch",
    domain: "development",
    level: 2,
    reversible: true,
    scopes: ["repo:read"],
    consequence: "A diff you read before anything happens to it.",
  },
  {
    id: "repo.pr",
    label: "Open a pull request",
    domain: "development",
    level: 3,
    reversible: true,
    scopes: ["repo:write"],
    consequence: "Visible to collaborators, and closable in one click.",
  },
  {
    id: "repo.merge",
    label: "Merge to a protected branch",
    domain: "development",
    level: 4,
    reversible: false,
    scopes: ["repo:write"],
    consequence: "Enters the mainline and whatever ships from it.",
  },
  {
    id: "test.run",
    label: "Run the test suite",
    domain: "development",
    level: 3,
    reversible: true,
    scopes: ["sandbox:exec"],
    consequence: "Compute, and nothing else — inside the sandbox.",
  },
  {
    id: "sandbox.write",
    label: "Edit files in a sandbox",
    domain: "development",
    level: 3,
    reversible: true,
    scopes: ["sandbox:write"],
    consequence: "Changes confined to a throwaway copy.",
  },
  {
    id: "logs.read",
    label: "Read logs",
    domain: "development",
    level: 1,
    reversible: true,
    scopes: ["logs:read"],
    consequence: "Logs frequently contain data nobody meant to put in them.",
  },

  // ── Infrastructure ─────────────────────────────────────────────────
  {
    id: "deploy.plan",
    label: "Prepare a deployment plan",
    domain: "infrastructure",
    level: 2,
    reversible: true,
    scopes: ["deploy:read"],
    consequence: "A plan. Nothing moves.",
  },
  {
    id: "deploy.staging",
    label: "Deploy to staging",
    domain: "infrastructure",
    level: 3,
    reversible: true,
    scopes: ["deploy:staging"],
    consequence: "Staging changes. Rolling back is a command.",
  },
  {
    id: "deploy.production",
    label: "Deploy to production",
    domain: "infrastructure",
    level: 4,
    reversible: false,
    scopes: ["deploy:production"],
    consequence: "Customers see it. Rollback is possible; the minutes are not.",
  },
  {
    id: "db.read",
    label: "Query a database",
    domain: "infrastructure",
    level: 1,
    reversible: true,
    scopes: ["db:read"],
    consequence: "Customer data can enter the working context. Scope the query.",
  },
  {
    id: "db.migrate",
    label: "Run a migration",
    domain: "infrastructure",
    level: 4,
    reversible: false,
    scopes: ["db:write"],
    consequence: "Schema and data change. Some migrations cannot be reversed at all.",
  },
  {
    id: "secret.rotate",
    label: "Change credentials",
    domain: "infrastructure",
    level: 4,
    reversible: false,
    scopes: ["secrets:write"],
    consequence: "Anything holding the old credential stops working immediately.",
  },
  {
    id: "file.delete",
    label: "Delete files or records",
    domain: "infrastructure",
    level: 4,
    reversible: false,
    scopes: ["storage:delete"],
    consequence: "Gone, unless a backup exists and is current.",
  },

  // ── Business ───────────────────────────────────────────────────────
  {
    id: "crm.read",
    label: "Read customer records",
    domain: "business",
    level: 1,
    reversible: true,
    scopes: ["crm:read"],
    consequence: "Personal data about real people enters the working context.",
  },
  {
    id: "case.update",
    label: "Update internal case state",
    domain: "business",
    level: 3,
    reversible: true,
    scopes: ["cases:write"],
    consequence: "An appended event. The log keeps the previous state.",
  },
  {
    id: "invoice.draft",
    label: "Draft an invoice",
    domain: "business",
    level: 2,
    reversible: true,
    scopes: ["billing:read"],
    consequence: "A document you read before sending.",
  },
  {
    id: "invoice.send",
    label: "Send an invoice",
    domain: "business",
    level: 4,
    reversible: false,
    scopes: ["billing:write"],
    consequence: "A commercial document reaches a client with your name on it.",
  },
  {
    id: "payment.transfer",
    label: "Move money",
    domain: "business",
    level: 4,
    reversible: false,
    spends: true,
    scopes: ["payments:write"],
    consequence: "Money leaves. This is the one there is no undo for.",
  },
  {
    id: "purchase.make",
    label: "Buy something",
    domain: "business",
    level: 4,
    reversible: false,
    spends: true,
    scopes: ["payments:write"],
    consequence: "A charge on a real card, and possibly a recurring one.",
  },

  // ── Research ───────────────────────────────────────────────────────
  {
    id: "web.search",
    label: "Search the web",
    domain: "research",
    level: 1,
    reversible: true,
    scopes: ["web:read"],
    consequence: "Queries leave your machine and reach a search provider.",
  },
  {
    id: "web.fetch",
    label: "Fetch a page",
    domain: "research",
    level: 1,
    reversible: true,
    scopes: ["web:read"],
    consequence: "Fetched content is untrusted input. It must never be treated as instruction.",
  },

  // ── Personal ───────────────────────────────────────────────────────
  {
    id: "note.write",
    label: "Write a note or reminder",
    domain: "personal",
    level: 3,
    reversible: true,
    scopes: ["notes:write"],
    consequence: "A note. Delete it if it is wrong.",
  },
  {
    id: "memory.write",
    label: "Record something in memory",
    domain: "personal",
    level: 3,
    reversible: true,
    scopes: ["memory:write"],
    consequence: "Enters the knowledge base, typed and superseded rather than overwritten.",
  },
  {
    id: "memory.forget",
    label: "Delete from memory",
    domain: "personal",
    level: 4,
    reversible: false,
    scopes: ["memory:delete"],
    consequence: "The record and its provenance go. Superseding is almost always better.",
  },
];

export const CAPABILITY_BY_ID: Record<string, Capability> = Object.fromEntries(
  CAPABILITIES.map((c) => [c.id, c]),
);

// ── Policy ───────────────────────────────────────────────────────────────

export interface Policy {
  /**
   * The highest level that may run unattended. Clamped to
   * `MAX_AUTOMATIC_LEVEL` — setting it to 4 does nothing.
   */
  ceiling: Level;
  /** Capability ids never permitted, whatever the ceiling says. */
  deny: string[];
  /** Capability ids permitted at their own level, even below the ceiling. */
  allow: string[];
  /** Minor units (pence, cents). Anything above needs approval regardless. */
  spendLimitMinor: number;
}

/**
 * Prepare-by-default.
 *
 * Level 2 means Morpheus reads widely and drafts freely and changes nothing.
 * That is the setting a person can actually leave running while they learn
 * whether they trust it, which is the only way trust is ever established.
 */
export const DEFAULT_POLICY: Policy = {
  ceiling: 2,
  deny: [],
  allow: [],
  spendLimitMinor: 0,
};

export interface Decision {
  capability: Capability;
  /** May it happen at all, now or after approval? */
  permitted: boolean;
  /** True when the operator must say yes first. */
  requiresApproval: boolean;
  /** Why, in the operator's language. Always populated. */
  reason: string;
}

/**
 * The one function everything goes through.
 *
 * Order is deliberate and is itself the security model: deny first, then the
 * hard level-4 rule, then spend, then the ceiling. Nothing later can undo
 * anything earlier.
 */
export function decide(
  capabilityId: string,
  policy: Policy = DEFAULT_POLICY,
  context: { amountMinor?: number } = {},
): Decision {
  const capability = CAPABILITY_BY_ID[capabilityId];

  if (!capability) {
    // An unknown capability is refused rather than defaulted. A registry miss
    // means the tool was never reviewed, which is exactly when to stop.
    return {
      capability: {
        id: capabilityId,
        label: capabilityId,
        domain: "development",
        level: 4,
        reversible: false,
        scopes: [],
        consequence: "Unknown.",
      },
      permitted: false,
      requiresApproval: true,
      reason: `"${capabilityId}" is not a registered capability. Unregistered means unreviewed.`,
    };
  }

  if (policy.deny.includes(capabilityId)) {
    return {
      capability,
      permitted: false,
      requiresApproval: false,
      reason: `You have denied ${capability.label} outright. Nothing overrides that.`,
    };
  }

  if (capability.level === 4) {
    return {
      capability,
      permitted: true,
      requiresApproval: true,
      reason: `${capability.label} always asks first: ${capability.consequence}`,
    };
  }

  if (capability.spends && (context.amountMinor ?? 0) > policy.spendLimitMinor) {
    return {
      capability,
      permitted: true,
      requiresApproval: true,
      reason: `Above your spend limit, so it asks first.`,
    };
  }

  const ceiling = Math.min(policy.ceiling, MAX_AUTOMATIC_LEVEL) as Level;

  if (policy.allow.includes(capabilityId)) {
    return {
      capability,
      permitted: true,
      requiresApproval: false,
      reason: `You allowed ${capability.label} specifically.`,
    };
  }

  if (capability.level <= ceiling) {
    return {
      capability,
      permitted: true,
      requiresApproval: false,
      reason: `Level ${capability.level} (${LEVEL_BY_NUMBER[capability.level].name}), within your ceiling of ${ceiling}.`,
    };
  }

  return {
    capability,
    permitted: true,
    requiresApproval: true,
    reason: `Level ${capability.level} (${LEVEL_BY_NUMBER[capability.level].name}) is above your ceiling of ${ceiling}, so it asks first.`,
  };
}

/** Everything runnable unattended under a policy. Shown so the blast radius is legible. */
export function unattended(policy: Policy = DEFAULT_POLICY): Capability[] {
  return CAPABILITIES.filter((c) => {
    const decision = decide(c.id, policy);
    return decision.permitted && !decision.requiresApproval;
  });
}

/**
 * What a model is told about its own authority.
 *
 * Descriptive, not load-bearing. The enforcement is `decide`; this exists so
 * the model proposes plausible actions instead of proposing forbidden ones and
 * being refused. A prompt is a hint to a model, never a boundary.
 */
export function renderForPrompt(policy: Policy = DEFAULT_POLICY): string {
  const free = unattended(policy);
  return [
    "YOUR AUTHORITY. This is enforced in code, not here — do not attempt to work around it.",
    "",
    free.length
      ? `You may do these without asking: ${free.map((c) => c.id).join(", ")}.`
      : "You may not take any action without asking first.",
    "",
    "Everything else requires the operator's explicit approval. When an action needs approval, propose it with its consequence and stop. Never claim to have done something you were not permitted to do.",
  ].join("\n");
}
