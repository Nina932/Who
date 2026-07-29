# Authority

Morpheus should be able to discuss almost anything and do almost any digital
work. That is not the same as holding administrator credentials to every
account you own, and the two get conflated because both arrive through the
same consent screen.

The design is **broad visibility, extensive tools, persistent memory,
controlled execution.**

---

## 1. Four levels

`lib/authority.ts`.

| | | |
| --- | --- | --- |
| **1** | Observe | Read repositories, calendars, logs, mail, dashboards, deployments, news |
| **2** | Prepare | Draft the email, the patch, the PR, the deployment plan, the report |
| **3** | Execute reversible | Create a branch, run tests, file an issue, update internal state |
| **4** | Ask first | Send, publish, merge, deploy, buy, transfer, delete, rotate credentials |

The boundary that matters is between three and four, and three rules make it
more than a label:

- **Level 4 cannot be raised away.** `MAX_AUTOMATIC_LEVEL` is 3, the ceiling
  saturates there, and the API *clamps and says so* rather than storing a 4 it
  would then ignore. A boundary that can be switched off is a default.
- **Irreversible implies level 4.** Enforced by a test over the whole registry,
  not by remembering. Adding a capability that cannot be undone and marking it
  level 3 fails the build.
- **Deny beats allow.** Always. A denial cannot be argued away by a broader
  grant, and `allow` cannot reach a level-4 capability at all — otherwise it
  becomes a way to configure the boundary away.

The default policy is **prepare-only**: Morpheus reads widely, drafts freely,
and changes nothing. That is the setting a person can actually leave running
while they work out whether they trust it.

## 2. The registry is fine-grained where it counts

`mail.draft` and `mail.send` are two capabilities at two levels. So are
`invoice.draft`/`invoice.send`, `deploy.plan`/`deploy.production`, and
`repo.patch`/`repo.merge`. "Email access" as a single permission is exactly how
an assistant ends up able to send.

Every capability carries a `consequence` written to be read at an approval
prompt — *"It reaches a person and cannot be recalled"*, not *"requires
gmail.send scope"*.

![The authority screen](screenshots/authority.png)

## 3. Never a raw credential

`lib/broker.ts`. The model never holds a credential — not in a prompt, not in
context, not in a tool argument. It holds a **grant**: an opaque id naming one
capability, valid for 90 seconds and one use. Redeeming resolves the actual
token server-side, at the moment of the call.

```
capability requested
      ↓
policy decides            deny → 4 → spend → ceiling
      ↓
short-lived grant issued  90s, single use, scopes only
      ↓
redeemed                  one operation
      ↓
expires
      ↓
audited                   issue, redemption, and every refusal
```

Four properties, each tested:

- A grant past its expiry is refused.
- A single-use grant cannot be redeemed twice.
- An approval for one capability never authorises another.
- A serialised grant contains no token, secret, key or password — asserted by
  scanning the JSON, so a future field cannot quietly leak one.

Grants live in memory and die with the process; a restart should invalidate
outstanding authority, not preserve it. Editing the policy resets the broker,
so tightening takes effect immediately rather than at the next expiry.

## 4. The tools go through it

`runTool` in `lib/tools.ts` is the only path to the world, and the Loops Engine
calls it rather than `tool.run`. A loop running past its human gate is still
not permission to act.

Each tool **declares** which capability it is; it does not decide. A tool that
checked its own permission would be a tool that could be argued out of it. Two
tests hold the line: every tool's capability must be registered, and no tool
may claim a level-4 one — those exist so they can be approved deliberately,
not so an autonomous workflow can reach them.

A refusal is a *result*, not an exception. The loop records what was refused
and why, which is the artefact worth having when somebody asks later why
nothing was sent.

## 5. The audit

Every issue, every redemption, and every refusal. The refusals are the rows
worth reading: a successful redemption is the system working, and a refused one
is the only evidence you will get that something tried.

## 6. Models

`lib/models.ts`. Groq is not the brain; it is the fast path.

| Role | Served by | Why |
| --- | --- | --- |
| `quick` | GPT-OSS 120B on Groq → Gemini Flash | Latency-bound. A voice turn half a second late is a worse answer than a duller one that arrives now. |
| `hard` | Gemini Pro → GPT-OSS 120B | Reasoning. Groq is present only so the role survives on one key. |
| `judgment` | Claude Opus, **and nothing else** | See below. |
| `vision` | Claude Sonnet | Images and documents. |
| `extract` | GPT-OSS 120B → Claude Haiku | Cheap, repeated, structured. |

**`judgment` has exactly one candidate, deliberately.** It is the role reached
when a turn is consequential — pricing, contracts, firing someone, spending
money. With no frontier key it reports itself unavailable rather than quietly
answering from the fast tier:

> No ANTHROPIC_API_KEY configured. This is a consequential-judgment call and
> will not be answered by a cheaper model — a fast wrong answer here is worse
> than none.

A silent downgrade on exactly the questions where being fast and wrong is most
expensive is the worst thing a router can do, and it is invisible: the answer
still arrives, still fluent.

## 7. Answer modes

`lib/intent.ts`. Morpheus answers anything, but *how* changes:

| | |
| --- | --- |
| `direct` | Ordinary knowledge, answered from the model |
| `current` | Depends on facts that change — fetch and cite, or say you cannot check |
| `business` | From the case ledger and product state. Never from recall |
| `code` | Read the repository first. A remembered codebase is a different codebase |
| `action` | Name the capability, its level, its consequence. Do not act before the level allows |
| `consequential` | Escalate to judgment; carry evidence, a trade-off, a falsifier |

Deterministic and offline — putting the "is this dangerous?" question inside
the thing being guarded is backwards. **Action is checked first**, because
"send the invoice to Halden" is a request to act phrased as a sentence about
the business, and getting that order wrong is how an assistant answers
helpfully *and* sends the email.

## 8. Voice

`lib/voice.ts`. An original profile, not an impersonation — reproducing a
specific film character's voice would be someone else's performance wearing
this system's name, and derivative besides. The register is describable
without copying anybody:

> A deep, deliberate, faintly metallic voice with controlled bass resonance.
> Calm authority rather than menace. Short pauses before conclusions. Never
> cheerful without reason, never raised.

One expressive rule: **delivery tightens with risk.** Not louder — fractionally
quicker and a shade less resonant, the way a person drops the performance when
something actually matters. A voice that sounds identical announcing the
weather and announcing that money is about to leave your account is a voice you
stop listening to. The floor is never crossed; no risk level makes Morpheus
hurried.

The browser gives pitch, rate and voice choice. Real metallic timbre needs ring
modulation, and `SpeechSynthesis` output cannot be routed into a Web Audio
graph. `deliveryFor` is the seam a licensed TTS backend would honour.

## 9. Not built

- **Nothing redeems a grant from the UI yet.** `withAuthority` accepts a
  `grantId`, the API returns one, and the Loops Engine path uses the
  request-and-redeem flow — but there is no "approve this specific pending
  action" button wired to a waiting tool call.
- **Scopes are names, not enforcement.** A redeemed grant hands its scope list
  to the action; the connectors do not yet narrow their OAuth token to it.
- **No sandbox.** `sandbox:exec` and `sandbox:write` are registered
  capabilities with no sandbox behind them.
- **No spend metering.** The limit is checked per action; nothing tracks
  cumulative spend across a day.
