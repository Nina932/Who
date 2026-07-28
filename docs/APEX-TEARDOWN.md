# Apex — product teardown

An analysis of the product built by **Reznikov Engineering**, reconstructed from
the source material available. This document is the reasoning behind the
implementation in this repository; read it first if you want to know *why* the
app is shaped the way it is.

---

## 1. Evidence, and its limits

Being precise about what is observed versus inferred matters here, because the
build is downstream of it.

| Source | Status |
| --- | --- |
| `facebook.com/share/195HdJkcjs` | **Not retrievable.** Blocked by this environment's egress policy (HTTP 403 on CONNECT). |
| `reznikov-engineering.com` | **Not retrievable.** Same policy denial. |
| Screenshot — page profile | Read in full. |
| Screenshot — post + desk photo showing the running product | Read in full, including crops upscaled 3–5× to recover on-screen text. |

So: **two photographs**, one of which is a phone picture of a monitor. Every
claim below is traceable to something legible in those images. Where a
conclusion is an inference rather than an observation, it says so.

## 2. Who is building it

From the page profile:

- **Reznikov Engineering** — 12K followers, 4 following, 43 posts
- Categories: **AI creator · Engineering service**
- Bio: *"Building Apex | The autonomous AI co-founder that learns, runs, and scales your solo business…"*
- Site: `reznikov-engineering.com` · Instagram: `reznikov_engineering`
- Located at Nelkin 8 — consistent with the product's own weather readout, **Tel Aviv**
- The operator's name, from the app's greeting: **Ruben**

This is a solo builder shipping in public, and the product is aimed at exactly
that person. The greeting is hard-coded to one operator; the product is
single-tenant by design.

## 3. The thesis

> "The autonomous AI co-founder that learns, runs, and scales your solo business."

And from the post:

> "This is a huge leap towards a true **AI workforce**, building the capable,
> trustworthy partner I always envisioned."

Two words carry the positioning. **Co-founder**, not assistant — it holds
context and initiative rather than waiting for instructions. **Workforce**, not
model — plural, specialised, with a hierarchy. The competitive claim is not
"better answers"; it is *organisational structure*.

## 4. Surfaces observed

### 4.1 Overview — the cockpit

The primary screen. A single full-bleed canvas with no navigation chrome:

- A large, intensely lit **core orb** dead centre — the system itself
- Named agents in orbit around it, connected by curved links
- A flowing field of long ambient curves behind everything
- Ambient HUD in the top-left: `13:08` · `31°C` · `FRI, JUL 24` · `TEL AVIV · PARTLY CLOUDY`
- Greeting: `GOOD AFTERNOON, RUBEN`
- **`ON THIS DAY`** — *"1969 — Apollo 11 splashed down safely in the Pacific Ocean, returning the first humans to walk on the Moon to Earth."*
- Three status lamps: `● APEX` `● LOCAL` `● VOICE`
- A line reading `Last · dignity (Question…)` — a last-interaction marker
- Top centre: `● SPEAKING · TAP TO STOP`
- Left-of-centre, large: **`Specialist Attendance`**, with `Live` above it

The second screenshot catches the same app in its dark idle state behind the
Facebook overlay — `22:07` · `MON, JUN 15` · `24°C` · `TEL AVIV · PARTLY CLOUDY`
· `GOOD EVENING, RUBEN` · `● APEX ● LOCAL ● VOICE`, with a nav label reading
`OVERVIEW`. This is the more reliable colour reference: the app is **near-black
with cyan accents**. The blue flood in the desk photo is the core's glow blowing
out the camera exposure.

### 4.2 Social Command Center

On the second monitor, a conventionally-structured scrolling page — and the
contrast with the cockpit is deliberate. Legible:

- Title `SOCIAL COMMAND CENTER` with an `← Exit` chip
- Filter tabs: `All` · `Instagram` · `Facebook` · `LinkedIn`, each with a status dot
- A **`NEEDS YOU`** block: *"All channels connected and strategies set. Nothing needs your attention."*
- **`PLATFORMS`**: per-channel cards. The Instagram card is accented magenta and shows `6.1K` followers against a second stat, with an `Open Instagram →` action. A neighbouring card shows `10.9K`.
- **`GOAL LOOPS`**: three rows, each rendering a **five-stage pipeline** of chips joined by dashes.

The goal loops are the most important thing on the screen and the least
eye-catching — which is the correct hierarchy for autonomous work.

## 5. The roster, read off the screen

Labels fall into two visual tiers. Bright, larger, high-contrast:

**Strategist · Researcher · Chief of staff · Sales · Marketing · Ops · Social ·
Engineering · Design · Editor · Finance · Developer · Analytics**

Dimmer, smaller, greyed:

**Drive · Email · Calendar · Chat · Memory**

That split is a real distinction, not a rendering artefact: the bright tier are
*agents* (they have judgement and can be spoken to), the dim tier are
*capabilities* (surfaces reached through agents). Memory sits between the two —
labelled like a capability but drawn at agent brightness. Node rings also differ
in colour, with warm/amber rings on several business-domain nodes and cyan on
the rest, which reads as **state, not category** — see below.

## 6. The four mechanics that make it a product

Anyone can render a glowing graph. These are the parts that constitute the
actual invention.

### 6.1 Voice turn-taking

> "Voice system is completely rebuilt — far more natural and reliable… No more
> battling with it, just hands-free work."

The complaint being solved is *battling* — talking over the system, waiting for
it to finish, repeating yourself. `SPEAKING · TAP TO STOP` is the tell: the
interrupt is a first-class, always-visible control. This is a turn-taking
problem, not a transcription-accuracy problem.

**Implemented here:** `lib/useVoice.ts` — continuous recognition that
self-restarts, a four-state floor model (`idle → listening → thinking →
speaking`), and a hard interrupt that cancels synthesis mid-sentence and returns
the floor immediately.

### 6.2 Specialist Attendance — the headline feature

> "The new Specialist Attendance means Apex can now call in the right expert
> agent, like our Marketing or Engineering specialists, when we dive deep into a
> topic."

The mechanic: **the operator never picks an agent.** They talk to Apex, and Apex
decides mid-conversation who belongs in the room, then pulls them in visibly.
"Dive deep into a topic" implies this fires on subject matter, not on an explicit
command. The amber rings on some nodes are almost certainly this state being
rendered — attendance highlighted in a colour reserved for it.

**Implemented here:** `lib/orchestrator.ts`. Each agent carries a routing
vocabulary; an utterance is scored against all of them, with longer and
multi-word terms weighted higher. The winner attends, near-scorers are consulted
in the background, and the matched terms are surfaced in the UI so the operator
can see *why* that seat was called. Routing is deliberately transparent rather
than embedding-based — an opaque decision would undercut the "trustworthy
partner" claim, and it lets the node light up the instant the operator stops
talking instead of after a model round-trip.

### 6.3 Ambient presence

Clock, weather, greeting, and a piece of almanac trivia are not features. They
exist so the machine is *already there* when you walk up, rather than something
you launch. It is the difference between a co-founder and a tool.

**Implemented here:** `lib/ambient.ts`, with a local almanac so the surface
renders identically with no network.

### 6.4 Goal loops with explicit autonomy

The five-stage pipelines are standing objectives that run on a cadence. The
critical design question for any autonomous system is *where it stops*, and a
staged pipeline answers it visually: you can see which stage is running and which
stage is a gate.

**Implemented here:** `lib/social.ts` models each loop with an explicit autonomy
level — `draft only`, `approve to ship`, `full autonomy` — and stages carry a
`gated` state rendered in the attention colour, because a gate is the only kind
of stage that will ever cost the operator time.

## 7. Design language

Decoded from the screenshots and reproduced in `app/globals.css`:

| Element | Reading |
| --- | --- |
| Background | Near-black `#04070a`, with a shallow radial cyan well rather than flat black |
| Primary | Cyan `#3fe0f0` — anything the system knows or is doing |
| Attention | Amber `#f2c14e` — **exclusively** for attendance and human-required gates |
| Type | Uppercase, ~`0.22em` tracking, mono-ish, ~10px for all labels |
| Numerals | Large, thin, tabular — clock and stats |
| Containers | Pill chips and hairline-bordered glass panels; no solid fills |
| Motion | Slow orbital drift, a breathing core, a sweeping scan line at the crown |

The single most important rule: **amber is never decorative.** One glance tells
the operator whether anything wants them. Spending it anywhere else destroys the
signal.

## 8. Observed vs. inferred

| Claim | Basis |
| --- | --- |
| Agent names, roster tiers | **Observed** — legible in the screenshot |
| Ambient HUD, status lamps, On This Day | **Observed** |
| `SPEAKING · TAP TO STOP`, voice rebuild | **Observed** (UI + post text) |
| Specialist Attendance exists and calls in experts | **Observed** (UI + post text) |
| Social Command Center structure and sections | **Observed** |
| Amber = attendance state | **Inferred** from colour split across nodes |
| Routing is domain/keyword-driven | **Inferred** from "when we dive deep into a topic" |
| Autonomy levels per loop | **Inferred** from the five-stage pipeline structure |
| Specific agent charters and vocabularies | **Authored here** — the names are real, the job descriptions are ours |
| Follower/reach numbers beyond `6.1K` and `10.9K` | **Authored here** as plausible sample data |

## 9. What this repository is

**Apex is Reznikov Engineering's product. This implementation is called Thor** —
a distinct name, because it is an independent build rather than a copy carrying
someone else's brand.

A working implementation of the product described above, built from the analysis
rather than from any of Reznikov Engineering's code — which was never
accessible. It is an independent reconstruction of a publicly-demonstrated
concept.

| Mechanic | Implementation |
| --- | --- |
| Cockpit / constellation | `components/Constellation.tsx` — canvas, ~460-particle core, orbital drift, link traffic |
| Specialist Attendance | `lib/orchestrator.ts` + `components/SpecialistCallout.tsx` |
| Voice turn-taking | `lib/useVoice.ts` + `components/VoiceStatus.tsx` |
| Ambient presence | `lib/ambient.ts` + `components/HudHeader.tsx` |
| Agent roster | `lib/agents.ts` — 18 seats across four families |
| Social Command Center | `app/social/page.tsx` + `components/social/*` |
| Model layer | `app/api/apex/route.ts` — attendance decided first, model speaks from one seat |

The gap worth naming: the real Apex has **integrations** (Drive, Email,
Calendar, Chat) and **persistent memory**. Both are drawn in this
reconstruction's roster and both are inert — they are wiring to real accounts,
not interface work, and nothing in the source material reveals how that wiring
is done.
