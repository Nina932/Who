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

[`lib/store.ts`](../lib/store.ts). Flat JSON under `.thor/`, written
temp-then-rename so a crash can't leave a half-written file, and serialised
through a per-collection promise chain because Next route handlers run
concurrently and would otherwise lose writes.

```
.thor/loop-runs.json  .thor/loop-learnings.json
.thor/memory.json     .thor/style-profile.json  .thor/style-samples.json
```

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

| Connector | Scope | Why |
| --- | --- | --- |
| Drive | `drive.readonly` | An agent that can delete your files is a different risk |
| Calendar | `calendar.events` | Needed to place approved work |
| Email | `gmail.readonly` + `gmail.compose` | **compose, not send** — Thor drafts, a human presses send |

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

## 9. Write protection

[`lib/guard.ts`](../lib/guard.ts). The mutating endpoints approve autonomous
work, delete memory and spend money on model calls, and had no check at all.
Two layers: cross-origin writes are refused outright, and when
`THOR_API_SECRET` is set every mutating call must present it. Reads stay open so
the cockpit renders.

```
$ curl -X POST /api/memory -H 'origin: https://evil.example' -d '{"text":"x"}'
{"error":"Cross-origin writes are refused."}
```

## Tests

`npm test` — 61 tests on the pure core, no API keys, via Node's built-in runner.

They earned their keep on the first run by catching a **live routing bug**:
`"what is our runway looking like"` routed to the Researcher rather than
Finance, because the generic stem `"what is"` earned the multi-word specificity
bonus and outscored the domain term `"runway"`. Any question opening with
"what is" was being hijacked. Generic interrogative stems now score a flat 0.4 —
enough to break a tie, never enough to beat a real domain term.

Covered: attendance scoring and the near-scorer cutoff, model routing and the
one-way escalation to Opus, the loop gate (including the regression that
rejection must be terminal), store write serialisation under 50 concurrent
mutators, style metrics learned from real diffs, cadence arithmetic, and the
Phoenix combine formula's negative branch.

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

- **LinkedIn, Chat, Google Slides/Sheets** are still unbuilt. Google Drive,
  Calendar and Gmail are wired; the rest are not.
- **No connector-backed loop step.** The connectors work, but no loop step calls
  them yet — so an approved post is not yet auto-placed on the calendar.

- **No image generation.** The described "branded graphics rendered as code /
  photos via Imagen" path is not implemented.
- **Vision role is routed but untested** — there is no upload surface yet.
