/**
 * The Morpheus roster.
 *
 * Morpheus is not a chatbot with personas — it is a workforce with a hierarchy.
 * Four families sit at different depths around the core:
 *
 *   council      the standing brain trust; always in the room, cheap to consult
 *   operations   domain specialists who get *called in* on demand
 *   faculty      the system's own organs (memory, voice) rather than employees
 *   integration  outside surfaces Morpheus can reach through — not agents at all
 *
 * `domains` drives Specialist Attendance: the orchestrator scores an incoming
 * utterance against these terms to decide who to pull into the conversation.
 */

export type AgentFamily = "council" | "operations" | "faculty" | "integration";

export interface Agent {
  id: string;
  name: string;
  family: AgentFamily;
  /** One line shown under the name in the inspector. */
  role: string;
  /** What this agent is actually accountable for. */
  charter: string;
  /** Routing vocabulary — matched against the operator's words. */
  domains: string[];
  /** Seed angle in degrees; 0 = right, 90 = down (screen coords). */
  angle: number;
  /** Seed distance from the core, 0..1 of the usable radius. */
  orbit: number;
}

export const AGENTS: Agent[] = [
  // ── Council ────────────────────────────────────────────────────────────
  {
    id: "chief-of-staff",
    name: "Chief of staff",
    family: "council",
    role: "Runs the day, guards the calendar",
    charter:
      "Holds the operator's week. Decides what reaches you and what gets handled, sequences the other agents, and closes the loop on anything left hanging.",
    domains: [
      "today", "schedule", "priorit", "plan my", "agenda", "week", "focus",
      "remind", "delegate", "status", "standup", "inbox",
    ],
    angle: 190,
    orbit: 0.5,
  },
  {
    id: "strategist",
    name: "Strategist",
    family: "council",
    role: "Positioning, bets, and sequencing",
    charter:
      "Thinks in quarters, not hours. Owns positioning, pricing posture, which bets to place and — more often — which to kill.",
    domains: [
      "strategy", "position", "market", "compet", "pricing", "roadmap",
      "bet", "moat", "differenti", "should we", "long term", "vision",
    ],
    angle: 258,
    orbit: 0.6,
  },
  {
    id: "researcher",
    name: "Researcher",
    family: "council",
    role: "Finds it, reads it, cites it",
    charter:
      "Goes and looks. Pulls primary sources, summarises the field, and refuses to answer from vibes when a citation exists.",
    domains: [
      "research", "find out", "look up", "source", "cite", "evidence",
      "study", "benchmark", "compare", "what is", "who is", "data on",
    ],
    angle: 205,
    orbit: 0.62,
  },
  {
    id: "editor",
    name: "Editor",
    family: "council",
    role: "Last pass before anything ships",
    charter:
      "Owns voice and standard. Nothing leaves the building — post, email, landing page — without passing through here.",
    domains: [
      "edit", "rewrite", "proofread", "tone", "copy", "draft", "polish",
      "shorten", "tighten", "headline", "wording",
    ],
    angle: 350,
    orbit: 0.7,
  },

  // ── Operations ─────────────────────────────────────────────────────────
  {
    id: "marketing",
    name: "Marketing",
    family: "operations",
    role: "Demand, narrative, campaigns",
    charter:
      "Turns the strategy into a story people hear. Owns campaigns, launch beats, and the funnel above the fold.",
    domains: [
      "marketing", "campaign", "launch", "brand", "audience", "funnel",
      "ads", "landing", "seo", "newsletter", "growth", "positioning copy",
    ],
    angle: 152,
    orbit: 0.62,
  },
  {
    id: "sales",
    name: "Sales",
    family: "operations",
    role: "Pipeline, outreach, close",
    charter:
      "Owns the pipeline end to end: who to talk to, what to say, what happens after they say maybe.",
    domains: [
      "sales", "lead", "pipeline", "deal", "prospect", "outreach", "client",
      "proposal", "quote", "invoice them", "follow up", "close",
    ],
    angle: 165,
    orbit: 0.6,
  },
  {
    id: "social",
    name: "Social",
    family: "operations",
    role: "Channels, posting, replies",
    charter:
      "Runs the Social Command Center: plans content, drafts to the operator's voice, triages comments, and publishes within its autonomy level.",
    domains: [
      "social", "post", "post about", "instagram", "facebook", "linkedin",
      "reel", "content", "comment", "engagement", "follower", "caption",
      "hashtag",
    ],
    angle: 100,
    orbit: 0.45,
  },
  {
    id: "engineering",
    name: "Engineering",
    family: "operations",
    role: "Architecture and hard calls",
    charter:
      "Owns how the thing is built. Makes the architectural calls, reviews the risky changes, and says no to clever when boring will hold.",
    domains: [
      "engineering", "architect", "system", "infra", "database", "scale",
      "deploy", "latency", "security", "api", "technical", "stack",
    ],
    angle: 62,
    orbit: 0.5,
  },
  {
    id: "developer",
    name: "Developer",
    family: "operations",
    role: "Writes and ships the code",
    charter:
      "Hands on keys. Takes a scoped change from Engineering and lands it — implementation, tests, and the pull request.",
    domains: [
      "code", "bug", "implement", "refactor", "test", "function", "build it",
      "fix", "typescript", "component", "pull request", "commit",
    ],
    angle: 140,
    orbit: 1.0,
  },
  {
    id: "design",
    name: "Design",
    family: "operations",
    role: "Interface, identity, craft",
    charter:
      "Owns what it looks like and how it feels to use. Interface, identity, and the details nobody can name but everybody notices.",
    domains: [
      "design", "ui", "ux", "layout", "visual", "figma", "logo", "colour",
      "color", "typography", "mockup", "interface",
    ],
    angle: 40,
    orbit: 0.55,
  },
  {
    id: "ops",
    name: "Ops",
    family: "operations",
    role: "Process, vendors, the boring load",
    charter:
      "Absorbs the operational drag: tooling, vendors, subscriptions, paperwork, and the recurring chores that eat a solo founder's week.",
    domains: [
      "ops", "process", "vendor", "tool", "subscription", "admin",
      "logistics", "workflow", "automat", "chore", "paperwork",
    ],
    angle: 128,
    orbit: 0.6,
  },
  {
    id: "finance",
    name: "Finance",
    family: "operations",
    role: "Runway, margin, invoices",
    charter:
      "Watches the money. Runway, burn, margin per client, what is unpaid and how long it has been unpaid.",
    domains: [
      "finance", "revenue", "cost", "runway", "burn", "budget", "margin",
      "invoice", "tax", "cash", "profit", "expense", "pricing model",
    ],
    angle: 310,
    orbit: 0.6,
  },
  {
    id: "analytics",
    name: "Analytics",
    family: "operations",
    role: "Measurement and honest numbers",
    charter:
      "Instruments everything and reports it without flattery. Owns the metric definitions so two agents never argue from different numbers.",
    domains: [
      "analytics", "metric", "number", "report", "dashboard", "measure",
      "conversion", "retention", "traffic", "how many", "trend",
    ],
    angle: 118,
    orbit: 0.9,
  },

  // ── Faculty ────────────────────────────────────────────────────────────
  {
    id: "memory",
    name: "Memory",
    family: "faculty",
    role: "Everything Morpheus has been told",
    charter:
      "The long-term store. Decisions, preferences, people, and the reasons behind past calls — so the workforce never asks you the same thing twice.",
    domains: [
      "remember", "recall", "last time", "we decided", "preference",
      "note that", "forget", "history", "context", "you said",
    ],
    angle: 12,
    orbit: 0.5,
  },

  // ── Integrations ───────────────────────────────────────────────────────
  {
    id: "drive",
    name: "Drive",
    family: "integration",
    role: "Documents and assets",
    charter: "Read and write access to the operator's file store.",
    domains: ["drive", "file", "document", "folder", "asset", "spreadsheet"],
    angle: 330,
    orbit: 0.95,
  },
  {
    id: "email",
    name: "Email",
    family: "integration",
    role: "Inbox and sending",
    charter: "Reads the inbox, drafts replies, sends within its autonomy level.",
    domains: ["email", "inbox", "reply", "mail", "send a message", "thread"],
    angle: 20,
    orbit: 0.9,
  },
  {
    id: "calendar",
    name: "Calendar",
    family: "integration",
    role: "Time and availability",
    charter: "Owns availability, books and moves meetings, protects deep work.",
    domains: ["calendar", "meeting", "book", "availability", "slot", "call at"],
    angle: 35,
    orbit: 0.85,
  },
  {
    id: "chat",
    name: "Chat",
    family: "integration",
    role: "Messaging surfaces",
    charter: "Bridges Morpheus into the messaging apps the operator already lives in.",
    domains: ["chat", "slack", "whatsapp", "telegram", "dm", "message"],
    angle: 55,
    orbit: 0.95,
  },
];

export const AGENTS_BY_ID: Record<string, Agent> = Object.fromEntries(
  AGENTS.map((a) => [a.id, a]),
);

export const FAMILY_LABEL: Record<AgentFamily, string> = {
  council: "Standing council",
  operations: "Specialist",
  faculty: "Faculty",
  integration: "Integration",
};

/** Anything in these families can be summoned by Specialist Attendance. */
export const SUMMONABLE: AgentFamily[] = ["council", "operations"];
