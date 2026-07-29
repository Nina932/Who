# The assistant layer

The operational engine remembers reality. The assistant turns that into a day.
Neither is useful alone: without the engine underneath, the assistant is a
chatbot giving generic advice; without the assistant, the engine is a
mechanical workflow tool.

The claim this layer makes is that its advice is checkable. Everything below
exists to make that true rather than to say it.

---

## 1. Memory that cannot be flattened

`lib/knowledge.ts`. Six kinds, and the distinction between them is enforced,
not labelled:

| | |
| --- | --- |
| **Fact** | Observably true. "G8's production worker is not deployed." |
| **Decision** | A choice made. "Broad UI expansion is paused." |
| **Hypothesis** | A belief not yet tested. |
| **Preference** | How you want to work. Constrains; never justifies. |
| **Commitment** | A promise with a date. Without a date it is rejected. |
| **Recommendation** | Output of the advisory layer. Never an input to it. |

Four rules make the typing load-bearing:

- **A hypothesis can never be evidence** for anything except another
  hypothesis. This is the single most important line in the system. Without
  it, "petroleum may be the wedge" becomes "petroleum is the wedge" in two
  hops and nothing in the output distinguishes them.
- **A recommendation can never be evidence.** Advice built on advice is how a
  system talks itself into a position nobody checked.
- **Confidence is derived, not declared** — capped by the weakest link in the
  chain and by provenance (`observed` > `stated` > `inferred` > `guessed`). A
  recommendation resting on a guess is `low`, whatever it says about itself.
  A single-source claim can never be `high`.
- **Everything goes stale.** A fact about a moving codebase has a 21-day shelf
  life; a decision 90; an untested hypothesis 30, after which the fact that it
  is untested becomes its own finding.

`validate()` returns the violations, and the API **rejects** an entry that
would corrupt a chain rather than storing it and reasoning from it later. The
brief surfaces any violation it finds instead of swallowing it.

## 2. Product state

`lib/products.ts`. A case is one commitment; a product is the longer object
that can look busy every week and never move. So every rule is a comparison
across time, not a snapshot:

| Rule | Fires when |
| --- | --- |
| `phase-stalled` | The phase has held longer than that phase reasonably holds |
| `carried-blocker` | A blocker has been open more than two weeks |
| `expansion-under-blocker` | Two or more capabilities shipped *after* a blocker opened |
| `milestone-unevidenced` | No exit condition has live evidence after three weeks in phase |
| `no-commercial-motion` | Everything shipped recently is internal |
| `too-many-active` | More products active than one person can carry |
| `untested-hypothesis` | An assumption carried past its shelf life while work was planned around it |

`expansion-under-blocker` is the one worth the file. Adding surfaces while the
thing that gates release stays open is the most reliable signal that the hard
problem is being avoided, and it is invisible from any daily view because
every one of those days was productive.

Exit conditions are the spine. A milestone with zero evidenced conditions is
drawn as zero — and **stale evidence does not count**, because a proof from
six weeks ago about a system that has changed since is a memory of a proof.

## 3. Every recommendation has the same shape

`lib/advisory.ts`. Seven fields, all required:

```
Recommendation
Reason
Evidence          entry ids — facts, decisions and commitments only
Expected benefit
Trade-off
Would change if   ← the falsifier
Confidence        derived from the evidence, not asserted
Rule              which condition fired
```

`wouldChangeIf` is the one that matters. Advice you cannot argue with is advice
you cannot check, so a tested invariant requires every advisory to carry a
falsifier and a stated cost. Another asserts that no advisory anywhere cites a
hypothesis.

## 4. The brief

`lib/brief.ts`. Derived, never composed. A model may be asked to phrase it; a
model is never asked what is true, because an assistant that writes a
plausible day is worse than none — it is a confident one.

Every item traces to a case's turn, a release blocker, or a dated commitment,
and carries three fields a task list does not have: **why it matters**, **why
it matters today**, and **what delaying it costs**.

Four things it does that a list does not:

**Capacity honesty.** Planned hours minus what the calendar already holds.
With no calendar connected it says exactly that rather than assuming the day
is empty.

**An explicit cut.** What was moved out of today and which test it failed —
the rule being that work touching no customer, no release blocker and no
commitment is not today's work. Nothing is silently dropped; a test asserts
every candidate appears in exactly one of the two lists.

**Avoidance.** Anything appearing in three consecutive briefs without moving
is surfaced on its own. A thing you keep not doing is information about you,
not about the thing. The counter resets when a day passes without it.

**One product gets the blocker hour.** Not a simplification — a brief that
schedules blocker work on two stuck products contradicts the same system's
advice about running too many things at once, and a split day unsticks
neither. The product carrying its blockers longest wins, and the brief says
which and why:

> FinAI gets today's blocker time — it has carried its blockers longest. G8 is
> also blocked, and splitting a day across both reliably unsticks neither.

A blocker's hours are **one protected hour, not an estimate**. Nobody knows
what a blocker costs until they sit with it — which is part of why it is still
open — and a made-up figure would turn the day's arithmetic into fiction.

![The brief](screenshots/brief.png)

## 5. Intelligence, filtered rather than forwarded

`lib/signals.ts`. The value is entirely in the discarding, and one rule makes
discarding safe:

> **Relevance is measured against your current blocker first, your stack
> second, and your phase third.**

A better model is genuinely interesting and is **not** act-now when the thing
stopping your release is worker deployment. That is not a judgement about the
model; it is arithmetic about where the constraint is. Rank by novelty instead
and you get trend-chasing with extra steps.

Four verdicts, three of them reachable with no model at all:

| Verdict | |
| --- | --- |
| **Act now** | Lands on a current blocker, or is a deprecation / vulnerability / pricing change in your stack, or replaces work you planned to build |
| **Evaluate soon** | Touches your stack, but your constraint is elsewhere |
| **Watch** | Real, not yet yours |
| **Ignore for now** | Touches nothing you have |

Only `act-now` interrupts; everything else goes to a digest and is not lost.
On the example feed that is two alerts out of five, and the two it picks are a
PostgreSQL capability landing on FinAI's live-deployment blocker and a runtime
deprecating an API G8 depends on — while a genuinely better model is correctly
told to wait.

When a model *is* available, `extractTags` uses it for one job only: pulling
concrete keys out of raw text. It is never asked whether something matters.
With no key it reports the missing key and the signal stays unclassified
rather than being quietly filed as irrelevant.

## 6. The interruption gate

Five tests — does it require a decision, require an action, change a plan,
create risk, is it time-sensitive. **Two must pass** to earn an interruption.
An assistant that interrupts on one gets muted within a week, and then it is
not there for the things that did matter.

![Product state](screenshots/products.png)

## 7. Where the seam is

`knowledge.ts`, `advisory.ts`, `products.ts`, `brief.ts` and `signals.ts` are
pure and run in the browser. `assistant-store.ts` holds everything touching
disk or a provider. The brief is built **server-side** so the UI and anything
handed to a model come from one derivation — two derivations of "what should I
do today" is one too many.

## 8. Not built

- **Nothing writes to the feed.** `Signal` is a shape with a classifier and
  worked examples behind it; no RSS reader, no crawler, no provider changelog
  poller fills it. The filtering is real and the source is not.
- **Market intelligence is one input away from real.** The classification
  works; what is missing is anything watching the market.
- **No calendar.** `bookedHours` is a field the UI can set and a Calendar
  connector could fill. Until it does, capacity says so.
- **Conversational modes.** Daily Operator, Chief of Staff, Technical
  Intelligence and the rest are five framings of one truth system. The truth
  system exists; the framings are surfaces, not engines.
- **Calibration.** Phase patience, blocker patience and the three-brief
  avoidance threshold are constants. They should be learned.
