# Thor

A voice-first cockpit for a workforce of specialist AI agents — an independent
reconstruction of the product Reznikov Engineering demonstrates publicly as
Apex — *"the autonomous AI co-founder that learns, runs, and scales your solo
business."* Their product is Apex; this implementation is Thor.

Two docs sit behind this: **[`docs/APEX-TEARDOWN.md`](docs/APEX-TEARDOWN.md)**
for the product analysis, and **[`docs/ENGINE.md`](docs/ENGINE.md)** for what
actually runs — the model stack, the Loops Engine, memory and style learning,
with the end-to-end transcripts that verify each one.

![The cockpit with a specialist attending](docs/screenshots/overview-attendance.png)

## The idea

You talk. Thor decides *who* should answer, pulls that specialist into the
conversation in front of you, and tells you which of your own words caused it.
There is no agent picker, because picking your own expert is the work you were
trying to delegate.

## What's here

**Overview** — one full-bleed canvas. A live core with eighteen agents in orbit,
ambient context (clock, weather, greeting, almanac), three status lamps, and a
transcript rail that stamps every reply with the seat it came from.

**Specialist Attendance** — the orchestrator scores each utterance against every
agent's routing vocabulary, calls in the winner, consults near-scorers in the
background, and surfaces the matched terms. Amber is reserved for this and for
nothing else.

**Voice** — continuous recognition with a four-state floor model and a hard
interrupt. Tapping while Thor is speaking cancels playback mid-sentence and
hands the floor straight back. A typed path runs through the identical
orchestrator for when the room isn't quiet.

**Social Command Center** — needs-you first, stats second, and the *goal loops*
last: standing objectives that run on a cadence, each with an explicit autonomy
level and a visible gate showing exactly where the machine will stop and wait
for you.

**Loops Engine** (`/loops`) — semi-autonomous workflows that really execute:
each step runs on its assigned model, the run halts at a human review gate, and
rejections and outcomes are turned into learnings that are injected into the
next run. Weekly Business Review and Content Engine are seeded.

**Phoenix** (`/phoenix`) — a separate, interactive 3D teardown of X's For You
pipeline, built from the source xAI open-sourced in January 2026: two-tower
retrieval, the ranking transformer's candidate-isolation mask, all 19 action
heads, and the weighted sum that becomes your feed. Move a signal or a weight
and everything recomputes live. Full analysis in
**[`docs/PHOENIX-TEARDOWN.md`](docs/PHOENIX-TEARDOWN.md)**.

![The ranking stage attention mask](docs/screenshots/phoenix-ranking.png)

## Getting it on your machine

Everything below runs in a terminal on your own computer — Terminal on macOS,
Windows Terminal or PowerShell on Windows, any terminal on Linux.

You need [Node.js 20 or newer](https://nodejs.org) (22 is what this was built
and tested on). Check with `node -v`.

Note that `node_modules` is per-project: having Node installed, or having run
`npm install` in some other folder, does not cover this one. The `npm install`
below creates this project's own, and you only run it once.

```bash
git clone https://github.com/Nina932/Who.git
cd Who

# main is an empty base branch — the code lives here until the PR is merged
git checkout claude/facebook-page-product-analysis-3wuj0g

npm install
```

Once the pull request is merged, `main` will have everything and the
`git checkout` line is no longer needed.

## Run it

```bash
npm run dev          # http://localhost:3000
```

It works with no configuration: attendance, voice, style learning and every
surface run offline. Model-backed steps report exactly which key they need
rather than pretending.

For the full stack, set the keys and restart. macOS and Linux:

```bash
export ANTHROPIC_API_KEY=sk-ant-...   # Opus (judgment), Sonnet (vision), Haiku (memory)
export GOOGLE_API_KEY=...             # Gemini Flash (quick), Pro (hard)
npm run dev
```

Windows PowerShell — `export` is not a thing here:

```powershell
$env:ANTHROPIC_API_KEY="sk-ant-..."
$env:GOOGLE_API_KEY="..."
npm run dev
```

Either way this lasts only for that terminal window. To make it stick, copy
`.env.example` to `.env.local` and fill it in — Next.js reads that on startup,
and `.env*` is gitignored so keys cannot be committed by accident.

Two decisions happen per turn, and they are orthogonal: **Specialist
Attendance** picks who answers, **model routing** picks which brain they use.
"Should we raise pricing?" escalates to Opus; "what time is it" rides Flash.

Attendance is decided **before** the model is called, never by it. The routing
stays cheap and inspectable, the cockpit lights up the right node the instant
you stop talking, and the model is handed a single seat to speak from rather
than being asked to role-play a whole company at once.

Voice needs a Chromium-based browser (the Web Speech API is still
vendor-prefixed elsewhere). Everything degrades to the typed path.

## Layout

```
app/
  page.tsx              Overview cockpit (react-three-fiber)
  loops/page.tsx        Loops Engine workspace
  social/page.tsx       Social Command Center
  phoenix/page.tsx      X For You pipeline — 3D teardown
  connect/page.tsx      Connector status, OAuth, live probes
  api/thor/route.ts     Orchestrator: attendance + routing + memory
components/
  thor/CockpitScene.tsx 3D cockpit: nebula, displaced core, orbits, bloom
  thor/shaders.ts       GLSL for the sky and the core
  HudHeader.tsx         Ambient context and status lamps
  SpecialistCallout.tsx Who was called in, and on which words
  VoiceStatus.tsx       Whose turn it is + the interrupt
  CommandDock.tsx       Microphone and typed fallback
  TranscriptRail.tsx    Attributed conversation history
  AgentInspector.tsx    Per-agent charter and routing vocabulary
  social/               Platform cards, goal loop pipelines
  phoenix/              react-three-fiber scene: five stages on camera rails
lib/
  phoenix.ts            Retrieval, 19 heads, the published combine formula
  models.ts             The stack: Flash / Pro / Opus / Sonnet / Haiku + routing
  loops.ts              Loops Engine — executor, review gate, learnings
  memory.ts             Durable facts: Haiku extraction, scored recall
  style.ts              Voice learned from the drafts you edit
  store.ts              Persistence: filesystem or Redis, with compare-and-set
  scheduler.ts          Cadence parsing and the tick that fires due loops
  tools.ts              Validated tool calls — where a loop touches the world
  connectors.ts         OAuth + calls: Drive, Calendar, Gmail, Sheets, Slides,
                        Slack, LinkedIn
  guard.ts              Origin and secret checks on mutating endpoints
  agents.ts             The roster — 18 seats, 4 families
  orchestrator.ts       Specialist Attendance scoring
  useVoice.ts           Turn-taking state machine
  ambient.ts            Clock, weather, local almanac
  social.ts             Platforms, goal loops, autonomy levels
```

## Adding an agent

Append to `AGENTS` in `lib/agents.ts`. `domains` is the routing vocabulary —
multi-word terms score higher because they are more specific. `angle` and
`orbit` seed its position in the constellation; the drift is applied on top.
Nothing else needs touching: the graph, the inspector, and the orchestrator all
read from that one array.

## Verification

```bash
npm run verify        # typecheck + 77 tests + build, no API keys needed
npm test              # just the tests
npm run verify:models # checks every configured model ID actually exists
```

There is no CI on this repository. A GitHub Actions workflow was added and
removed: GitHub never assigned it a runner — the job finished in 10 seconds
with `runner_id: 0`, no steps and no logs — which is an account-level Actions
entitlement problem, not something the repo can fix. A permanently red check
that never ran is worse than no check, so verification runs locally instead.

The workflow is preserved inert at `.github/workflows/ci.yml.disabled` and runs
exactly what `npm run verify` runs. To restore it once Actions can schedule
runners:

```bash
git mv .github/workflows/ci.yml.disabled .github/workflows/ci.yml
```

The tests run on Node's built-in runner over the pure core, and caught a live
routing bug on their first run — see [`docs/ENGINE.md`](docs/ENGINE.md#tests).

## Status

Working: the model stack and routing, the Loops Engine (execution, gates,
learnings), the scheduler, Google connectors (Drive, Calendar, Gmail) over a
real OAuth flow, durable memory, style learning, persistence, and write
protection on every mutating endpoint.

Loops reach the world: past its gate, the Content Engine places approved posts
on the calendar, Inbound saves its reply as a Gmail draft, and the Weekly
Review appends to a log spreadsheet. When a run stops at a gate, Slack tells
you. Connectors cover Drive, Calendar, Gmail, Sheets, Slides, Slack and
LinkedIn; image generation is wired to Imagen. State runs on the filesystem by
default or Upstash Redis — with compare-and-set, so several instances can share
one store.

Not built: Google Chat and WhatsApp, and retry/backoff on provider calls. See
the end of [`docs/ENGINE.md`](docs/ENGINE.md).
