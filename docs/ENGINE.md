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

## 5. Persistence

[`lib/store.ts`](../lib/store.ts). Flat JSON under `.thor/`, written
temp-then-rename so a crash can't leave a half-written file, and serialised
through a per-collection promise chain because Next route handlers run
concurrently and would otherwise lose writes.

```
.thor/loop-runs.json  .thor/loop-learnings.json
.thor/memory.json     .thor/style-profile.json  .thor/style-samples.json
```

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

- **No real connectors.** Drive, Email, Calendar, Chat, LinkedIn, Google
  Slides/Sheets are in the roster and inert. Nothing in the source material
  reveals how the original authenticates or writes to them.
- **No scheduler.** Cadences are declared and loops run on demand. A cron
  trigger firing `startRun` is the missing piece, not a redesign.
- **No image generation.** The described "branded graphics rendered as code /
  photos via Imagen" path is not implemented.
- **Vision role is routed but untested** — there is no upload surface yet.
