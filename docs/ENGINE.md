# The Thor engine

What actually runs, versus what is drawn. Every claim on this page was
exercised end to end — the transcripts are in the PR.

The design targets come from how Reznikov describes Apex publicly: a stack of
specialised models rather than one brain, a Loops Engine with a human review
stage, durable memory, and style picked up from edited drafts.

---

## 1. The model stack

> "It's not one giant brain, but a precisely orchestrated stack of specialized
> AI models… Gemini Flash for quick turns, Pro for harder ones… for
> consequential judgment, I escalate to Claude Opus… Haiku extracts crucial
> facts to remember."

[`lib/models.ts`](../lib/models.ts) implements exactly that, with two real
provider adapters (Anthropic Messages, Google `generateContent`).

| Role | Model | Used for |
| --- | --- | --- |
| `quick` | Gemini Flash | conversational turns |
| `hard` | Gemini Pro | reasoning, drafting, analysis |
| `judgment` | Claude Opus | consequential decisions — escalated to deliberately |
| `vision` | Claude Sonnet | images and PDFs |
| `extract` | Claude Haiku | pulling durable facts out of a conversation |

**Two orthogonal decisions per turn.** Specialist Attendance picks *who*
answers; model routing picks *which brain* they use. Verified:

```
"Should we raise our pricing next quarter?"
  seat:   strategist
  routed: Claude Opus — Consequential judgment ("should we")

"what time is it"
  routed: Gemini Flash — Conversational turn
```

Escalation is one-way and keyword-explicit. The cost of being fast and wrong on
a pricing decision is asymmetric, so those never ride Flash.

Missing keys never throw — `callRole` returns `live: false` with the reason, and
`GET /api/thor` reports which parts of the stack are reachable.

## 2. The Loops Engine

> "Semi-autonomous workflows (with a human review stage), observe results, learn
> from feedback, and constantly refine its approach."

[`lib/loops.ts`](../lib/loops.ts) is a real executor. A run walks its steps,
calls the model assigned to each, writes every artefact to disk, and **stops
dead at a gate** until a human says GO.

Verified — Weekly Business Review, one run:

```
start  → Gather    via Gemini Flash
       → Analyse   via Gemini Pro
       → Recommend via Claude Opus      ← escalated step
       → status: awaiting-go            ← execution halts here
GO     → Act       via Gemini Flash
       → status: completed
```

Nothing downstream of a gate can execute without `approve`. Autonomy without a
stopping rule is just an unattended script.

**The loop closes.** Rejections require a reason, because a rejection without
one teaches nothing. The note — or the recorded outcome — goes to Opus, which
derives at most three imperative rules, stored per loop and injected into the
system prompt of every future run. Verified:

```
reject "Too promotional, and stop pitching tooling posts."
  → learnings now held for content-engine:
      · Lead with the shipped thing, not the framing.
      · Do not propose posts about tooling.
```

Those two lines appear in the next run's prompt under *"What previous runs of
this loop learned. These are corrections — apply them."*

Seeded loops: **Weekly Business Review** and **Content Engine** (both named in
the source posts), plus **Inbound to pipeline**.

## 3. Memory

[`lib/memory.ts`](../lib/memory.ts). After every exchange, Haiku is asked what
will *still be true next month* — preferences, decisions, people, constraints,
goals. Ephemera is dropped on purpose. Facts below 0.45 confidence are
discarded, and near-duplicates are merged by token overlap so memory doesn't
fill with rephrasings.

Recall scores stored facts against the current utterance and folds them into
the prompt under "do not ask them again". Standing context — preferences,
constraints, goals — stays relevant even when no words match.

It is a flat JSON file on purpose:

```bash
$ cat .thor/memory.json
[ { "text": "Never publish to LinkedIn without explicit approval.",
    "kind": "constraint", "confidence": 1, "recalled": 1 }, … ]
```

A system claiming durable memory should let you audit it with `cat`, and delete
from it with one call.

## 4. Style learning

> "Picking up my style from the drafts I edit."

[`lib/style.ts`](../lib/style.ts). The signal is the **diff**, not the final
text: nobody describes their own voice accurately, but everybody corrects it
consistently.

Two layers. The measured layer runs locally on every edit and **needs no API
key at all** — verified on three real edit pairs:

```json
{ "samples": 3,
  "lengthDelta": 0.69,
  "avgSentenceWords": 4.5,
  "emojiPerPost": 0, "exclamationPerPost": 0, "hashtagPerPost": 0,
  "avoids": ["absolutely", "thrilled", "leveraged", "revolutionary"] }
```

Which renders into the prompt as *"They cut roughly 69% of what is drafted.
Write short. No emoji. No exclamation marks. No hashtags. Words they repeatedly
delete: absolutely, thrilled, leveraged, revolutionary."*

On top of that, every third sample triggers a model pass that turns accumulated
pairs into prose rules. The rolling 40-sample window means voice drift is
tracked rather than averaged away. `moreMyStyle()` backs the **"More my style"**
action.

## 5. Streaming and the voice path

`streamRole` in [`lib/models.ts`](../lib/models.ts) streams both providers
(Anthropic SSE, Google `streamGenerateContent?alt=sse`). `/api/thor` returns a
Server-Sent Event stream:

```
event: meta    { attendance, routing, memoryUsed }   <- before any token exists
event: delta   { text: "First " }                    <- word by word
event: delta   { text: "sentence " }
event: done    { local, learned }
```

`meta` arrives first so the cockpit lights the attending node the instant the
operator stops talking, rather than after generation.

The client buffers deltas to **sentence boundaries** and enqueues each finished
sentence with `speakChunk` — SpeechSynthesis queues natively, so Thor starts
speaking the first sentence while the third is still being generated.
Synthesising raw fragments makes the cadence robotic, which is why the boundary
split matters.

Memory extraction moved **after** the last delta is flushed. It is a second
model call, and blocking the reply on it added seconds of silence to a
voice-first product — the original justification for awaiting it was wrong.

## 6. Persistence

[`lib/store.ts`](../lib/store.ts). Two drivers behind one seam, chosen once at
load:

| Driver | When |
| --- | --- |
| `fs` (default) | Flat JSON under `.thor/`, temp-then-rename so a crash cannot leave a partial file. Deliberately readable — a system claiming durable memory should let you audit it with `cat`. |
| `redis` | Upstash over its REST API — plain `fetch`, no client library, no TCP socket, so it works in any runtime. Set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`. |

The filesystem driver is correct for a long-lived server and **wrong on
serverless**, where the filesystem is per-instance and ephemeral. That is what
the Redis driver is for.

Writes are serialised through a per-collection promise chain, because route
handlers run concurrently and a naive read-modify-write loses updates.

**Horizontal scale.** The chain alone is per-process, which is not enough
behind several instances. When the driver supports versioning, `mutate` also
does a compare-and-set: read the revision, apply the mutator, write only if
nobody moved first, and retry against fresh state if they did. The Redis driver
implements this with a Lua script that checks and bumps a version counter
beside the document in one atomic step, so two instances writing concurrently
cannot both believe they won.

After 8 contended attempts it throws rather than dropping the write silently —
tested both ways: a stolen write is re-applied on top of the winner, and a
permanently contended collection raises instead of quietly losing data.

The consequence worth knowing: **the mutator must be a pure function of
`current`**, because it can be re-run. Side effects inside it would happen more
than once.

## 7. The scheduler

[`lib/scheduler.ts`](../lib/scheduler.ts). Cadences were declared and nothing
fired them, so "autonomous" meant "on demand". `nextDue` parses the cadence
strings the loops already carry — `"Mondays, 07:00"`, `"Hourly"`,
`"Every 15 minutes"`, `"Daily, 09:00"`, `"On arrival"` — and an unrecognised
cadence returns null, which means never auto-fire. Failing in that direction is
the safe one.

Verified from a Tuesday:

```
weekly-business-review   next: Mon 03 Aug 07:00
content-engine           next: Mon 03 Aug 07:00
inbound-to-pipeline      next: event-driven
```

`tick()` advances a loop's next slot **before** starting its run, so a failing
loop moves to its next slot instead of retrying every tick and becoming a hot
loop. Two ways to drive it: an in-process timer (`THOR_SCHEDULER=on`) for a
long-lived server, or `POST /api/scheduler {"action":"tick"}` for cron on hosts
where background timers do not survive. Both call the same idempotent `tick()`.

## 8. Connectors

[`lib/connectors.ts`](../lib/connectors.ts). A real Google OAuth
authorisation-code flow with refresh, tokens persisted through the same store,
and real API calls on top: Drive file listing, Calendar read and event
creation, Gmail read and draft creation.

Scopes are requested narrowly on purpose:

| Connector | Provider | Scope | Why |
| --- | --- | --- | --- |
| Drive | Google | `drive.readonly` | An agent that can delete your files is a different risk |
| Calendar | Google | `calendar.events` | Needed to place approved work |
| Email | Google | `gmail.readonly` + `gmail.compose` | **compose, not send** — Thor drafts, a human presses send |
| Slides | Google | `presentations` + `drive.file` | `drive.file` only touches files Thor created |
| Sheets | Google | `spreadsheets` + `drive.file` | Appends run outcomes to a log you can pivot |
| Chat | Slack | `chat:write`, `channels:read` | **Post-only.** Thor speaks; it never reads your messages |
| LinkedIn | LinkedIn | `w_member_social` | Publishing — **wired into no loop by default** |

**"Chat" was ambiguous** in the source roster — Slack, Google Chat and WhatsApp
are three different integrations and nothing indicated which. Slack was chosen
as the most common ops surface for a solo operator. The scope is post-only on
purpose: a notifier does not need to read your conversations.

LinkedIn is the deliberate exception. Every other write lands somewhere private
(a calendar, a draft) or is trivially reversible; a public post is neither, so
it stays opt-in rather than shipping switched on. A test asserts no seeded loop
uses it.

Image generation (`generateImage` in `lib/models.ts`) covers the "photos via
Imagen" half of the described stack; the "branded graphics rendered as code"
half is the existing HTML/SVG surfaces, which is why there is no template
engine.

`access_type=offline` with `prompt=consent`, because without a refresh token the
connection dies silently within the hour.

Every connector carries a **Probe** button that makes one real API call.
"Connected" should mean the last request actually worked, not that a token
exists in a file.

Needs `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`. Without them the
UI says exactly that and the connect endpoint refuses:

```
{"error":"Google OAuth is not configured. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET."}
```

## 9. Tools — where a loop touches the world

[`lib/tools.ts`](../lib/tools.ts). Connectors worked and loops worked, and
nothing joined them, so an approved post was never actually placed anywhere.

A tool step runs in two beats:

1. the step's model turns the run's artefacts into structured JSON
2. that JSON is **validated here**, then executed against a real connector

The model never calls the API. It only proposes arguments; this file decides
whether they are well-formed. A hallucinated field becomes a validation error
rather than a bad calendar entry.

Verified end to end — Content Engine, past the gate:

```
Mine               via Gemini Flash
Draft              via Gemini Pro
Schedule           via Gemini Flash
Place on calendar  via Gemini Flash → calendar.schedule

  Nothing was placed on the calendar.
  Skipped:
  - "Post: voice rebuild" — google OAuth is not configured.
  - "Post: loops engine"  — missing or past start time
```

The first was well-formed and reached the connector, which reported the real
reason. The second was rejected *before* any call — an agent booking into last
week is a bug that would otherwise ship silently as a calendar entry nobody
sees.

Two invariants are enforced by test rather than by convention: every tool step
sits **after** its loop's gate, and no seeded loop publishes to LinkedIn.

| Tool | Connector | Does |
| --- | --- | --- |
| `calendar.schedule` | Calendar | Places approved posts at their publish times |
| `gmail.draft` | Email | Saves the approved reply as a draft — never sends |
| `sheets.log` | Sheets | Appends one row per run to a log spreadsheet |
| `slides.deck` | Slides | Turns an approved outline into a deck |

`sheets.log` stamps its own timestamp rather than letting the model supply one:
a model-invented date in a log is worse than no date at all.

### Gate notifications

The reason a Chat connector earns its place. When a run enters `awaiting-go`,
Thor posts to Slack with the loop name, the last artefact, and a link straight
to `/loops`. Semi-autonomous work is only useful if you find out it needs you
without going to look.

Fire-and-forget by design: a chat outage must never hold up the engine or fail
a run, and "not connected" is the normal case rather than an error worth
shouting about.

A tool that cannot act does **not** fail the run: the work upstream is still
valid, and the artefact records exactly what went wrong.

## 10. Write protection

[`lib/guard.ts`](../lib/guard.ts). The mutating endpoints approve autonomous
work, delete memory and spend money on model calls, and had no check at all.
Two layers: cross-origin writes are refused outright, and when
`THOR_API_SECRET` is set every mutating call must present it. Reads stay open so
the cockpit renders.

```
$ curl -X POST /api/memory -H 'origin: https://evil.example' -d '{"text":"x"}'
{"error":"Cross-origin writes are refused."}
```

## Verifying model IDs

```bash
npm run verify:models
```

The IDs in `lib/models.ts` were written from memory and never called. A wrong
one fails at the worst moment — mid-conversation, or halfway through an
unattended loop — and surfaces as "the stack is down" rather than "that model
does not exist". One minimal call per role, non-zero exit if any configured
role is broken, so it can gate a deploy. Roles whose provider has no key are
reported as skipped: a missing key is a choice, a wrong ID is a bug.

## Tests

`npm run verify` runs typecheck, the tests and the build in one command — the
same three steps the (currently disabled) CI workflow runs, so the two cannot
drift. See the README for why CI is off.

`npm test` — 77 tests on the pure core, no API keys, via Node's built-in runner.

They earned their keep on the first run by catching a **live routing bug**:
`"what is our runway looking like"` routed to the Researcher rather than
Finance, because the generic stem `"what is"` earned the multi-word specificity
bonus and outscored the domain term `"runway"`. Any question opening with
"what is" was being hijacked. Generic interrogative stems now score a flat 0.4 —
enough to break a tie, never enough to beat a real domain term.

Covered: attendance scoring and the near-scorer cutoff, model routing and the
one-way escalation to Opus, the loop gate (including the regression that
rejection must be terminal), tool argument validation and the two structural
invariants above, the store driver seam, compare-and-set under
contention, write serialisation under 50 concurrent mutators, style metrics learned from real diffs, cadence arithmetic,
and the Phoenix combine formula's negative branch.

## Fixed after review

Four defects found by grilling the build, each verified fixed:

1. **Specialist Attendance was invisible in the 3D cockpit.** The eased
   attendance value was read during render and passed to children as a number,
   so it froze at whatever it was on the last React render (~0) — the node
   never turned amber, the link never lit, the traffic packet never ran.
   Children now read the ref inside their own `useFrame`; only label styling,
   which genuinely needs a render, uses a boolean prop.
2. **Rejection was not terminal.** `advance()` had no status guard, so a stray
   call could walk a rejected run back to its gate and undo a human's "no".
3. **The Social screen was disconnected from the engine.** It rendered a second,
   hardcoded loop model. That model is deleted; the screen now reads
   `/api/loops`, derives "needs you" from runs genuinely sitting at a gate, and
   carries the GO gate inline. Channel figures are labelled as sample data.
4. **No streaming** — see section 5.

## Endpoints

| | |
| --- | --- |
| `POST /api/thor` | attendance + routing + memory + style, then learn |
| `GET /api/thor` | which parts of the stack are reachable |
| `GET/POST /api/loops` | list; `start` · `advance` · `approve` · `reject` · `observe` |
| `GET/POST/DELETE /api/memory` | read, add, forget |
| `GET/POST /api/style` | profile; record an edit; `more-my-style` |

## Configuration

```bash
ANTHROPIC_API_KEY=...   # judgment (Opus), vision (Sonnet), extract (Haiku)
GOOGLE_API_KEY=...      # quick (Flash), hard (Pro)
```

Each role's model is individually overridable (`THOR_MODEL_QUICK`, etc.), and
both provider base URLs are overridable — which is how the end-to-end run above
was exercised against a local stand-in.

## What is not built

Named honestly, because the gap between this and the real Apex is all
integration work:

- **Google Chat and WhatsApp** are not built — Slack was chosen for "Chat".
  WhatsApp in particular needs Meta Business verification, which is a process
  rather than a patch.
- **Model IDs are unverified against a live endpoint** in this environment —
  `npm run verify:models` is the tool, but it needs real keys.
- **No retry or backoff on provider calls.** A transient 429 fails a loop step
  today; the artefact records it honestly, but it should retry.

- **No image generation.** The described "branded graphics rendered as code /
  photos via Imagen" path is not implemented.
- **Vision role is routed but untested** — there is no upload surface yet.
