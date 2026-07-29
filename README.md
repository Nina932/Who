# Morpheus

A voice-first cockpit for a workforce of specialist AI agents — an independent
reconstruction of the product Reznikov Engineering demonstrates publicly as
Apex — *"the autonomous AI co-founder that learns, runs, and scales your solo
business."* Their product is Apex; this implementation is Morpheus.

Five docs sit behind this: **[`docs/AUTHORITY.md`](docs/AUTHORITY.md)** for
what Morpheus may do without asking, the credential broker and the model
router; **[`docs/ASSISTANT.md`](docs/ASSISTANT.md)** for
the assistant — typed memory, product state, the brief and the intelligence
filter; **[`docs/CASES.md`](docs/CASES.md)** for the operational core beneath
it — cases, events, whose turn it is;
**[`docs/APEX-TEARDOWN.md`](docs/APEX-TEARDOWN.md)** for the product analysis;
and **[`docs/ENGINE.md`](docs/ENGINE.md)** for what actually runs — the model
stack, the Loops Engine, memory and style learning, with the end-to-end
transcripts that verify each one.

![The cockpit with a specialist attending](docs/screenshots/overview-attendance.png)

## The idea

You talk. Morpheus decides *who* should answer, pulls that specialist into the
conversation in front of you, and tells you which of your own words caused it.
There is no agent picker, because picking your own expert is the work you were
trying to delegate.

## What's here

**Overview** — one full-bleed canvas. A live core with eighteen agents in orbit,
ambient context (clock, weather, greeting, almanac), three status lamps, and a
transcript rail that stamps every reply with the seat it came from.

**Authority** (`/authority`) — what Morpheus may do without asking. Four
levels: observe, prepare, execute-reversible, ask-first. **Level 4 cannot be
raised away** — the ceiling saturates at 3, and sending, publishing, deploying,
deleting and spending always ask, at every setting. A boundary that can be
switched off is a default.

The model never holds a credential. It holds a *grant*: an opaque id naming one
capability, valid 90 seconds and one use, redeemed server-side. Every issue,
redemption and refusal is audited. The Loops Engine goes through it — a loop
running past its human gate is still not permission to act. Full write-up in
**[`docs/AUTHORITY.md`](docs/AUTHORITY.md)**.

**Brief** (`/brief`) — the assistant, and the front door. Your day, derived
rather than composed: every item traces to a case's turn, a release blocker or
a dated promise, and carries why it matters, why *today*, and what delaying it
costs. It reads your calendar for what is already booked, caps the plan at
what is left of your working day, shows what it moved out of today and which
test that work failed, and names anything you have skipped three briefs
running.

It also carries the intelligence filter and the six conversational modes.
Relevance is measured against your current blocker first, your stack second,
your phase third — a genuinely better model is *evaluate soon*, not *act now*,
when the thing stopping your release is worker deployment. **That filtering
needs no API key**: articles are matched against the vocabulary your own
products already contain. Three interruptions maximum, because a day with
eleven urgent items has none.

It gives the blocker hour to exactly one product and says why — a day split
across two stuck products unsticks neither, and scheduling both would
contradict the advice the same system gives about running too many things.

**Products** (`/products`) — where each product actually is, how long it has
been there, and whether the milestone it claims to be pursuing has anything
behind it. Seven rules watch for the failure that is invisible day to day:
a phase held too long, a blocker carried rather than cleared, surfaces added
*after* a blocker opened, a milestone with no evidenced exit condition.

Every recommendation carries a reason, its evidence, a trade-off, a derived
confidence, and — required — what would change it. Advice you cannot argue
with is advice you cannot check. Underneath is memory that keeps a fact, a
decision, a hypothesis and a guess apart by construction: a hypothesis can
never be cited as evidence, and confidence is capped by the weakest link in
the chain. Full write-up in **[`docs/ASSISTANT.md`](docs/ASSISTANT.md)**.

**Cases** (`/cases`, `/today`, `/waiting`) — the operational core, and the
thing the rest of the product now sits on top of. A **case** is one commitment
carried from the first message to the money landing. It has no stored state:
it is projected from its event log every time it is read, so the past is
queryable and nothing can be edited into an inconsistent position.

Every case is somebody's turn — yours, theirs, the system's, a date's, blocked
or done. *Their turn is not idle.* Every waiting stage carries a patience
threshold, and when that runs out the turn comes back to you with an escalation
action attached. That single rule is the difference between a system that
tracks work and one that maintains continuity. Full write-up in
**[`docs/CASES.md`](docs/CASES.md)**.

**The week** (`/week`) — human-capacity allocation over the actions cases and
loops have already derived. It ranks; it does not decide what exists. Waiting
and blocked work is excluded, because tracking is not doing.

The part with teeth is the verdict at the top: *what your weights are actually
optimising for.* Ranking a list is easy and most tools stop there. What nobody
notices is that the same list, ranked the same way, produces a year of urgent
weeks in which nothing compounded — so it says so. And when the derived work
does not fill the week it says that too, which is a finding rather than a gap:

> 22 of your 24 hours have nothing to do in them. Everything else is with
> someone else — that is a pipeline problem, not a scheduling one.

The scoring machinery came from an interactive teardown of X's For You
algorithm, which was removed: it was genuinely useful machinery attached to
the wrong subject. The analysis survives as
**[`docs/PHOENIX-TEARDOWN.md`](docs/PHOENIX-TEARDOWN.md)**.

**Specialist Attendance** — the orchestrator scores each utterance against every
agent's routing vocabulary, calls in the winner, consults near-scorers in the
background, and surfaces the matched terms. Amber is reserved for this and for
nothing else.

**Voice** — continuous recognition with a four-state floor model and a hard
interrupt. Tapping while Morpheus is speaking cancels playback mid-sentence and
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

## Getting it on your machine

Everything below runs in a terminal on your own computer — Terminal on macOS,
Windows Terminal or PowerShell on Windows, any terminal on Linux.

You need [Node.js 20 or newer](https://nodejs.org) (22 is what this was built
and tested on). Check with `node -v`.

Note that `node_modules` is per-project: having Node installed, or having run
`npm install` in some other folder, does not cover this one. The `npm install`
below creates this project's own, and you only run it once.

First move somewhere you can write. A terminal opened as Administrator on
Windows starts in `C:\WINDOWS\system32`, which is write-protected — clone
there and every command fails with `Permission denied` or `EPERM`. Use a normal
(non-Administrator) terminal and start from your home folder:

```powershell
cd $HOME            # Windows PowerShell
mkdir projects -Force
cd projects
```

```bash
cd ~ && mkdir -p projects && cd projects   # macOS and Linux
```

Then, the same on every platform:

```bash
git clone https://github.com/Nina932/Who.git
cd Who

# main is an empty base branch — the code lives here until the PR is merged
git checkout claude/facebook-page-product-analysis-3wuj0g

npm install
```

Your prompt should now end in `\Who` (or `/Who`). If it does not, the `cd` did
not take and nothing after this will work.

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
export ANTHROPIC_API_KEY=sk-ant-...   # Opus (judgment), Sonnet (vision)
export GOOGLE_API_KEY=...             # Gemini Pro (hard), Flash (quick fallback)
export GROQ_API_KEY=gsk_...           # GPT-OSS 120B — the fast/voice path
export MORPHEUS_OPERATOR=Nino             # who the brief greets
export MORPHEUS_TZ=Asia/Tbilisi           # your zone — the brief is derived server-side
npm run dev
```

`MORPHEUS_TZ` matters more than it looks. The brief is built on the server, so
without it the greeting and "hours left today" use the host's clock rather
than yours.

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
  today/page.tsx        What is genuinely yours, and why
  cases/page.tsx        The ledger, the stage rail, and every write
  waiting/page.tsx      Who is holding what, with the clock on it
  week/page.tsx         Allocation under an hours budget, and the verdict
  loops/page.tsx        Loops Engine workspace
  social/page.tsx       Social Command Center
  connect/page.tsx      Connector status, OAuth, live probes
  brief/page.tsx        The assistant: your day, derived and explained
  products/page.tsx     Product phase, blockers, milestone evidence, advice
  api/assistant/route.ts  Brief, product state, knowledge, intelligence
  api/cases/route.ts    The case ledger — reads project, writes append
  api/morpheus/route.ts     Orchestrator: attendance + routing + memory
components/
  cases/                Turn and risk chips, the shared loader
  morpheus/CockpitScene.tsx 3D cockpit: nebula, displaced core, orbits, bloom
  morpheus/shaders.ts       GLSL for the sky and the core
  HudHeader.tsx         Ambient context and status lamps
  SpecialistCallout.tsx Who was called in, and on which words
  VoiceStatus.tsx       Whose turn it is + the interrupt
  CommandDock.tsx       Microphone and typed fallback
  TranscriptRail.tsx    Attributed conversation history
  AgentInspector.tsx    Per-agent charter and routing vocabulary
  social/               Platform cards, goal loop pipelines
lib/
  authority.ts          Four levels, the capability registry, the policy engine
  broker.ts             Short-lived grants, single use, audited
  authority-runtime.ts  The live broker and withAuthority — the only path out
  intent.ts             Answer modes: direct / business / code / action
  voice.ts              The Morpheus register, and delivery under risk
  knowledge.ts          Typed memory: fact / decision / hypothesis / guess
  advisory.ts           The seven-field shape every recommendation must take
  products.ts           Product phase, blockers, exit conditions, drift rules
  brief.ts              The derived day, the cut, avoidance, horizons
  calendar.ts           Booked hours: overlaps merged, all-day ignored
  signals.ts            Relevance against the constraint; the interruption cap
  feeds.ts              RSS and Atom, tagged from your own vocabulary
  modes.ts              Six framings, one truth system
  assistant-store.ts    Assistant persistence (server only)
  cases.ts              Cases, events, the workflow, whose turn it is (pure)
  case-store.ts         Persistence and interpretation (server only)
  priority.ts           Factors, context, ranking under an hours budget
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
npm run verify        # typecheck + 346 tests + build, no API keys needed
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

Working: the assistant layer (typed memory with an enforced evidence chain,
product-drift rules, the derived brief, the intelligence filter), the case
ledger (event-sourced, with the turn model and the patience policy), the model
stack and routing, the Loops Engine (execution, gates,
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

Not built: the feed does not poll itself on a schedule; nothing pushes an
alert to you, so the interruption gate decides what *would* be worth
interrupting for and nothing does the interrupting; the default sources cover
infrastructure rather than buyers; the five loops beyond lead-to-cash; events arriving *from*
connectors rather than from a person pressing a button; per-counterparty
calibration of the patience thresholds; Google Chat and WhatsApp; and
retry/backoff on provider calls. See the end of
[`docs/CASES.md`](docs/CASES.md) and of [`docs/ENGINE.md`](docs/ENGINE.md).
