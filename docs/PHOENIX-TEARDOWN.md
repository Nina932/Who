# Phoenix — how the For You feed actually works

> **Note.** The interactive version of this was removed from the product. The
> analysis stands, and the machinery it proved — a live, inspectable, tunable
> scoring pipeline that reports its own blind spot — became `/week`, where the
> candidates are your actual work rather than someone's timeline. An essay
> about X's algorithm did not belong inside a business-operations tool.

The second image you sent is an explainer of X's recommendation pipeline:
Grok reading your signals on the left, a feed of engagement bait in the middle,
and "Phoenix scores and ranks content to maximize engagement and platform
goals" on the right.

I could not reach the Facebook post itself — `facebook.com` is blocked by this
environment's egress policy — so I went to the primary source instead. **It
checks out.** Phoenix is real, and the code is public.

---

## 1. What's actually true

On **20 January 2026**, xAI open-sourced the algorithm powering the For You
feed at [`xai-org/x-algorithm`](https://github.com/xai-org/x-algorithm) — a full
rewrite of the 2023 Scala codebase, now Rust and Python. Four components:

| Component | Job |
| --- | --- |
| **Home Mixer** | Orchestration. Eight sequential stages from query hydration to response. |
| **Thunder** | In-memory store of recent in-network posts, fed by Kafka. |
| **Phoenix** | The Grok-derived retrieval *and* ranking model. |
| **Candidate Pipeline** | Reusable Source / Hydrator / Filter / Scorer / Selector framework. |

The claims in the infographic that survive contact with the source:

- **Grok is genuinely the engine.** The transformer is ported from the Grok-1
  open-source release, adapted for recommendation with custom input embeddings
  and attention masking.
- **Hand-engineered features are gone.** The repo states X eliminated "every
  single hand-engineered feature and most heuristics from the system."
- **It optimises engagement.** The ranking head predicts **19 actions** and a
  weighted sum of those predictions *is* the relevance score.

## 2. The pipeline, stage by stage

### Retrieval — two towers

A **user tower** encodes your engagement history into one embedding; an **item
tower** encodes every post in the corpus. Similarity is a dot product, and
top-K by that similarity cuts millions of candidates to hundreds. The item side
is precomputed, which is why this is affordable at all.

Phoenix builds its view of you from roughly your **last 128 engaged posts** —
liked, replied, watched, bookmarked. Not who you are. What you just did.

### Ranking — the transformer, with one critical constraint

The retrieved set goes through a transformer that scores each candidate. The
design decision worth the whole teardown, quoted from the repo:

> "Candidates cannot attend to each other during inference. This is a critical
> design choice that ensures the score for a candidate doesn't depend on which
> other candidates are in the batch."

Candidates attend to **you** and to **your history**, and otherwise only to
themselves — diagonal masking. It makes scores independent, cacheable, and
reproducible. In the visualisation this is the lattice: two lit cyan columns
(user + history, visible to everyone) and an amber diagonal (self only). Every
other cell is dark, and that darkness is the guarantee.

Published config for the released "mini" checkpoint: embedding dim **128**,
**4** layers, **4** heads, history length **127**, candidate length **64**,
vocab **1M** each for user/item/aumorpheus.

### Scoring — 19 heads, one weighted sum

One forward pass predicts all 19 simultaneously. From
`home-mixer/scorers/weighted_scorer.rs`, the real constant names:

```
FAVORITE_WEIGHT      REPLY_WEIGHT         RETWEET_WEIGHT
QUOTE_WEIGHT         SHARE_WEIGHT         SHARE_VIA_DM_WEIGHT
SHARE_VIA_COPY_LINK_WEIGHT                CLICK_WEIGHT
PROFILE_CLICK_WEIGHT QUOTED_CLICK_WEIGHT  PHOTO_EXPAND_WEIGHT
VQV_WEIGHT           DWELL_WEIGHT         CONT_DWELL_TIME_WEIGHT
FOLLOW_AUMORPHEUS_WEIGHT
NOT_INTERESTED_WEIGHT  MUTE_AUMORPHEUS_WEIGHT
BLOCK_AUMORPHEUS_WEIGHT    REPORT_WEIGHT
```

Fifteen positive, four negative. And the combine step:

```
combined = Σ apply(score_i, WEIGHT_i)

if combined < 0 → (combined + NEGATIVE_WEIGHTS_SUM) / WEIGHTS_SUM * NEGATIVE_SCORES_OFFSET
else            → combined + NEGATIVE_SCORES_OFFSET
if WEIGHTS_SUM == 0 → max(combined, 0)
```

That branch is not decoration. Negative scores get **squashed into a narrow
positive band** rather than being allowed to run away. A post has to be
actively reported or blocked to be genuinely buried; mild dislike barely
moves it. `VQV_WEIGHT` is conditional — video shorter than a minimum duration
doesn't earn it.

### Selection

Sort by score, apply an aumorpheus-diversity adjustment so one account cannot
stack the feed, take top K, run final visibility and dedup checks, respond.

## 3. The thing the infographic is really about

Read the 19 heads again and notice what is missing. There is a head for **like,
reply, repost, quote, share, DM-share, copy-link, click, profile-click,
quoted-click, photo-expand, video-view, dwell, dwell-time, follow** — and four
for **not-interested, mute, block, report**.

There is no head for *is this true*. Not because anyone suppressed one — because
truth is not an action a user takes, and this system is built entirely out of
actions users take. It is a faithful optimiser of a target that simply isn't
accuracy.

Now consider what outrage does to those heads. Outrage is *excellent* at
**reply** (disagreement is a reply, not a like), excellent at **dwell**, strong
at **quote** and **share**. Its only brake is the four negative heads, and those
require a user to take a deliberate, effortful action — reporting something is
much rarer than arguing with it. So the machine does exactly what it was asked
to do, and *"WAKE UP. Everything is connected."* outranks a sourced thread with
a methodology in the replies.

That is not a conspiracy. It is a correctly-functioning weighted sum. Which is
the more uncomfortable finding.

## 4. What I built

`/phoenix` — the pipeline as a place you fly through, in five stages, with a
live model underneath. Everything recomputes as you move a control.

| Stage | What you see |
| --- | --- |
| **01 Signals** | The six signal axes from the source image, feeding a live core whose intensity tracks total signal energy |
| **02 Retrieval** | User tower, item tower, the corpus as a 4,200-point cloud, and the top-K survivors with real cosine scores |
| **03 Ranking** | The attention mask: two lit context columns, an amber self-attention diagonal, everything else dark |
| **04 19 heads** | All nineteen predictions for the top post, live, with negatives in red |
| **05 For You** | The ranked feed, bars coloured by how much of the score came from outrage |

**Controls.** Six signal sliders (the user tower's input) and all 19 action
weights. Move `sentiment` up and watch the conspiracy cluster climb. Drag
`REPORT_WEIGHT` toward zero and watch the brakes come off.

**A readout that keeps the system honest:** average outrage and average veracity
of the top 5 versus everything else. Veracity is displayed and is an input to
nothing — exactly as in the real system.

### Real vs. ours

| | |
| --- | --- |
| Two-tower retrieval → transformer ranking | **Real** |
| Candidate isolation masking | **Real** |
| The 19 action names | **Real** — the constants from `weighted_scorer.rs` |
| The combine formula and its negative branch | **Real** |
| Aumorpheus-diversity decay in selection | **Real** |
| Every weight **value** | **Ours.** xAI published architecture and a mini checkpoint, not production weights. |
| The prediction function | **Ours.** A transparent feature function, because a black box teaches nothing. |
| The corpus | **Ours.** Twelve posts, half echoing the bait in the source image, half substantive. |

Implementation: [`lib/phoenix.ts`](../lib/phoenix.ts) for the model,
[`components/phoenix/PhoenixScene.tsx`](../components/phoenix/PhoenixScene.tsx)
for the world.

## Sources

- [xai-org/x-algorithm](https://github.com/xai-org/x-algorithm) — the repository
- [phoenix/README.md](https://github.com/xai-org/x-algorithm/blob/main/phoenix/README.md) — architecture and model config
- [home-mixer/scorers/weighted_scorer.rs](https://github.com/xai-org/x-algorithm/blob/main/home-mixer/scorers/weighted_scorer.rs) — the 19 weights and the combine step
- [X's algorithm source code drops](https://ppc.land/xs-algorithm-source-code-drops-what-it-reveals-about-the-platforms-feed-mechanics/) — release context
- [How X's Open Source Recommendation Algorithm Works](https://singhajit.com/system-design/x-twitter-for-you-algorithm/) — independent walkthrough
