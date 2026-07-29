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

## 9. Voice

Every capability is reachable by voice — asking for work, reviewing the plan,
approving, rejecting, cancelling, checking the result. Voice is another
interface to the same engine, never a way around it:

```
text  ─┐
voice ─┼─→ intent → pending action → authority decision → grant → tool
ui    ─┘
```

### A generic "yes" never approves anything

The word can come from a television, a recording, another conversation, or
Morpheus's own speaker. So approval requires an action-specific phrase carrying
a reference that was spoken aloud a moment earlier:

> "This sends an email to David at david@example.com, subject 'G8 deployment
> update'. It reaches a person and cannot be recalled. Say: *approve send
> 1001*."

Never "do you approve?" — a prompt that does not say what will happen is a
prompt that trains people to say yes. The reference must match as its own
token, so "742" does not approve 7421.

### Morpheus cannot approve itself

Its own audio is both the closest to the microphone and the most likely to
contain the exact phrase, having just read it out. So:

| | |
| --- | --- |
| Speaker active | approval recognition off |
| Self-playback | never valid |
| Uploaded audio | never valid |
| Remote call audio | never valid |
| No authenticated session | rejected |
| Floor is not `awaiting-approval` | heard as dictation |

That last row is what stops a dictated email containing the phrase from
approving itself.

### Not every level-4 action may be finished by voice

| Action | Voice |
| --- | --- |
| Send email, invite attendees, post to a channel | Phrase |
| Publish, send invoice, merge protected branch | Phrase **and** on-screen preview |
| Production deploy, purchase | Phrase initiates; **security key** authorises |
| Move money, rotate credentials, migrate a database, delete files | **Never** |

Unlisted level-4 capabilities default to `never`. Fail closed: a capability
added later without a considered entry must not become voice-approvable by
omission, which is how a default quietly becomes a policy.

A voiceprint is not an authentication factor. Voices can be recorded and
synthesised.

### Cancelling is deliberately easier than approving

Approval needs the exact phrase and the reference. `stop`, `cancel`, `never
mind`, `forget it` all match loosely and need no reference. The asymmetry is
the point: making it hard to stop something is a far worse failure than making
it easy, and an operator scrambling to cancel should not have to remember a
number.

### Receipts, not "Done"

> "The draft was saved in Gmail. Nothing was sent."
> "The deployment request was rejected because the production approval expired."

A completion with no returned evidence is reported as *unverified* rather than
as success.

## 10. The binding — the correction that mattered

A grant bound only to a capability authorises a **category**. Approve "send
this email to David" and, until expiry, the same grant satisfies any
`mail.send` — different recipient, different body. The operator approved a
sentence they heard; the system authorised a permission.

So arguments are frozen *before* approval and hashed, and the hash is bound
into the grant:

```ts
interface Grant {
  capabilityId: string;
  pendingActionId?: string;    // this action, not this kind of action
  argumentsHash?: string;      // SHA-256 of the canonical arguments
  operatorSessionId?: string;  // an approval is not transferable
}
```

All three are checked at redemption and all three must match. Four properties,
each tested:

- **Changing anything material invalidates the approval.** Swap the recipient
  and the hash changes; no existing grant satisfies it.
- **An omitted binding is a mismatch, not a pass.** "No hash offered" would
  otherwise be the easiest way around the entire mechanism.
- **A mismatch does not spend the use.** One wrong presentation must not burn a
  legitimate approval.
- **Amending supersedes rather than edits.** "Change the recipient to Maria"
  cancels the original and creates a new action with a new reference and a new
  hash. The previous approval does not still apply — it becomes unredeemable.

Canonical serialisation sorts keys and drops `undefined`, so a JSON round-trip
cannot invalidate an approval. That matters: spurious invalidation trains
people to re-approve reflexively, which is worse than not asking.

## 11. Sessions, step-up, and the executed action

Three things were shapes rather than mechanisms. All three are now real.

### The session is proven, not supplied

`operatorSessionId` was a string the caller chose — and anything that can
choose its own session id can forge one, which made "an approval is not
transferable between sessions" decorative.

A session is now issued server-side against a random token delivered in an
httpOnly cookie. The **id is `sha256(token)`**, so the record never contains
the token: a stolen session record is not a stolen session, for the same
reason password hashes exist. The id can therefore appear in the audit log
without the log becoming a key store.

### Step-up is a challenge, not a boolean

`steppedUp: true` was a field the caller set. It is now a nonce issued
server-side, bound to one pending action and one session, single-use, expiring
in two minutes. The response must prove possession of `MORPHEUS_STEPUP_SECRET`
— something the model has never seen and cannot produce from the transcript.

Compared in constant time, and **burned on a wrong answer** so a challenge is
not an oracle to guess against. With no secret configured, step-up *fails* —
an unconfigured second factor blocks the actions requiring one rather than
waving them through.

WebAuthn is the shape this is built for: the secret becomes a hardware key and
`verifyStepUp` becomes an assertion check. Nothing else moves.

### Scopes gate the call

A redeemed grant handed back a scope list that nothing checked — the connector
used whatever the stored OAuth token allowed, which is broader. The grant was a
promise, not a constraint.

Now every connector call names the scope it needs, checked **before the token
is fetched**, so a call the grant does not authorise never gets as far as
holding a credential. `undefined` means "outside the authority layer" — a
status probe, the OAuth dance — and is deliberately distinct from `[]`, which
means "granted nothing" and refuses everything.

This surfaced a real mismatch: `sheets.log` declared `cases:write` while the
Sheets API needs `spreadsheets`, so every call would have been refused. Two
accurate capabilities replaced the borrowed ones, and a test now asserts that
each tool's capability carries the scope its connector demands.

### A refusal starts the approval flow

`runTool` no longer dead-ends on `needs-approval`. It freezes the arguments,
creates a pending action, and returns the read-back — so the operator hears
exactly what will run. `executeApproved` then runs the tool against the
**frozen** arguments, presenting the binding at redemption.

Verified end to end against a running server:

```
approve without a session   → "No session."
sign in                     → session issued
propose calendar.propose    → "…Deleting it costs a click. Say: approve propose 1001."
approve by voice            → true
execute                     → "Nothing was placed on the calendar.
                               Skipped: … google OAuth is not configured."
```

That last line is the receipt working: it reports what actually happened rather
than "Done".

And the one that matters most:

```
approve 1003                → true
amend 1003                  → "The previous approval no longer applies." (new ref 1005)
execute 1003                → "1003 is cancelled, not approved."
```

## 12. Exactly once

Two failures a sequential test cannot see, both found by review and both real.

### What "exactly once" does and does not mean

It does **not** mean exactly-once external execution. For an arbitrary
provider that is generally not achievable without provider cooperation, and
claiming it would be the most dangerous sentence in this document.

What is achieved is **effectively-once within one process**: an atomic claim,
a stable idempotency key, and — the part that matters most — a refusal to
treat an ambiguous outcome as a failure.

What is **not** proven: multi-instance claiming (the concurrency test runs two
calls in one Node process; the Redis compare-and-set is implemented, not
demonstrated), crash recovery at each point in the sequence, and
provider-side deduplication.

### The audit log repeated itself

`flush()` called `audit()`, which returns the whole in-memory log — so
flushing after every operation persisted the same rows again and again. Three
events became six stored rows, the first written three times.

Reproduced before fixing, and again after:

```
before:  events: 3 | persisted rows: 6
         issued:mail.draft, redeemed:mail.draft, issued:mail.draft,
         refused:mail.send, redeemed:mail.draft, issued:mail.draft

after:   events: 3 | persisted rows: 3
```

`drainAudit()` returns only what has not been handed out and advances a
cursor; `audit()` still returns everything, because reading a log for display
must not consume it.

An audit log that repeats itself is worse than none — it looks like more
happened than did.

### …and then the fix lost entries instead

The first attempt trimmed the log past 2000 entries and moved the cursor down
with it, which silently destroyed un-persisted rows. **2100 events in, 2000
out, 100 gone.** The comment claiming that could not happen was wrong, and the
test — `assert.ok(drained.length <= 2000)` — was written to accommodate the
bug rather than catch it.

Now only the *already-drained* prefix is reclaimed. If nothing has been
drained, nothing is discarded, and the log grows. Unbounded memory is a worse
*looking* failure than silent evidence loss and a far better one: it is
visible, and it does not quietly rewrite history.

Entries carry a monotonic `seq`, because a missing row is invisible in a list
of timestamps and obvious in a sequence. A backlog past ten thousand records
itself as an event — a stopped persister should not read as a quiet period.

The test now records **10,000 events without draining and requires all
10,000** back, with a gap-free sequence.

### Execution was a race with a comment on it

`executeApproved` read the status, checked it, then wrote it. Two requests
arriving together both saw `approved`, both passed, and both would have run —
the same email twice.

Claiming is now a compare-and-swap inside a single `mutate`, which is
serialised per collection and, on the Redis driver, guarded by a server-side
compare-and-set. Exactly one caller can observe `approved` and write
`executing`.

Behind it is an **idempotency ledger** keyed on `capabilityId:actionId` — the
same key a retry would carry and a different action never collides with.

The ledger records that execution was *claimed*, not that it *happened*. Those
are different facts and the difference is where doubles come from.

### Three outcomes, not two

`failed` used to mean "nothing happened", and that is unsafe. A request can
reach a provider, be performed, and have its response lost. Retrying on that
basis sends the email twice.

| | |
| --- | --- |
| `completed` | The provider answered. It happened. |
| `failed` | The request demonstrably never left — validation, policy refusal, no connector. Safe to retry, ledger released. |
| `outcome-uncertain` | The request left and no answer came back. **Terminal.** Nothing retries automatically; the ledger entry stays. |

`googleFetch` distinguishes them: a 4xx is a decision the provider made, a 5xx
or a thrown network error is genuinely unknown. That travels up through
`ToolResult.uncertain` to the execution status.

Tested by firing two `executeApproved` calls with `Promise.all` and asserting
exactly one claims it, and by asserting `outcome-uncertain` is terminal.

## 13. One way out

`runTool` being safe is worth nothing if another module imports
`createMailDraft` directly. `tests/seam.test.ts` reads the source and refuses
any import of a connector mutation from outside `lib/tools.ts`, refuses
`tool.run(` in the Loops Engine, and refuses a direct connector call in any
API route.

It immediately found one: `loops.ts` imported `postToSlack` for gate
notifications, so a message left the process without passing the boundary. A
notification is small, but "small" is not a category the boundary knows about.

It now goes through `withAuthority` under a new `notify.operator` capability —
level 3, distinct from `chat.post`. Under the default ceiling of 2 it does not
fire, which is correct: Morpheus prepares rather than acts until told
otherwise.

### Reversible, compensatable, irreversible

Calling that notification "reversible" was wrong. Deleting a Slack message
does not undo its delivery — it needs a permission and a retained message id
this does not have, and somebody may already have read it.

Capabilities now carry an `effect`:

| | |
| --- | --- |
| `reversible` | Undone completely, by us, nothing left behind |
| `compensatable` | A side effect escaped; the best remedy is a follow-up |
| `irreversible` | Nothing can be done |

`notify.operator` is compensatable. A test asserts that a compensatable
capability's consequence does not read as undoable.

### The list is derived, and the connector enforces at runtime

The hard-coded `MUTATIONS` array was a list somebody would forget to add to —
`export async function sendInvoice` would ship and the test would stay green.
It is now read out of the connector source: any exported async function
issuing a non-GET request. The OAuth lifecycle is excluded **by name**, so
that exclusion is a decision to disagree with rather than a gap.

Static analysis still cannot see a renamed import, a namespace import, a
dynamic import or a re-export. So `googleFetch` refuses any mutating request
that arrives without a declared capability scope. That catches a *call*, not
an import — the boundary holds even when reached by a route the test cannot
model.

A test rather than a convention, because a convention is a thing people
remember until the afternoon they are in a hurry.

## 14. Renames

Never rename a product with unrestricted substring replacement. `authorization`
contains `thor`.

Use path-level renaming, exact identifier replacement, exact environment-prefix
replacement, case-sensitive whole-word matching — and afterwards, review URLs,
protocol constants, headers and grant types by hand, because those are the ones
nothing exercises without live credentials.

`tests/naming.test.ts` catches the class. Structured renaming prevents the
damage.

## 15. Not built

This is not production-safe, and the gaps are architectural rather than
cosmetic. In the order they should be closed:

**These claims would be too strong, and are not made:** that audit rows can
never be lost under any condition (the durable append is a JSON document, not
a database with a uniqueness constraint); that execution is exactly-once
against a provider; that Redis compare-and-set is *proven* to serialise two
instances; or that a failure means nothing happened.

1. **A session proves continuity, not identity.** A random server-issued
   cookie proves "same browser", not "this is the authorised operator". There
   is no `operatorId`, no workspace, no authentication method or strength on
   the record. Anything reachable over a network needs real login before the
   session binding means what it claims.
2. **Step-up is a shared secret.** Cryptographically real *only* while the
   secret lives outside both Morpheus and the browser — so it is a development
   and CLI-authenticator mechanism, not the approval method for a normal user.
   WebAuthn/passkeys is the replacement, and `verifyStepUp` is the one function
   that changes.
3. **Voice approval is not a conversation.** The floor model and the audio
   provenance rules exist and the API honours them, but the browser microphone
   does not own the floor — the client sends it. `self-playback` is a flag,
   not acoustic echo detection. For high-risk actions voice should only
   *begin* approval; a device confirmation should finish it.
4. **Enforcement is not yet everywhere.** Slack now checks its scope; LinkedIn
   does not. Read operations have capabilities registered but are not gated
   the way mutations are, and reads can expose mail, customer records, source
   and logs.
5. **Distributed claiming is implemented, not proven.** The concurrency test
   runs two calls in one Node process, which exercises the local
   serialisation path only. Proving it needs two instances against a shared
   Redis, plus killing the winner at each point: after claim before ledger,
   after ledger before request, after request before response, after provider
   success before local completion.
6. **No provider idempotency or reconciliation.** The key exists and is
   stable; nothing passes it to a provider that supports one, and nothing
   searches Gmail or Calendar for an action marker before retrying. An
   `outcome-uncertain` action currently waits for a person.
7. **State is per-process.** Sessions, pending actions and challenges live in
   memory. Grants dying on restart is intended; being signed out and losing
   pending approvals because a request reached another instance is not.
   Sessions, pending actions, approval evidence, audit records and the
   idempotency ledger belong in a transactional store; one-use grants and
   challenges belong in Redis with expiry.
8. **No sandbox.** `sandbox:exec` and `sandbox:write` are registered
   capabilities with nothing behind them — no isolated filesystem, no limits,
   no timeout, no network policy, no non-root user. Until that exists they
   should be denied rather than treated as reversible execution.
9. **No cumulative spend control.** The limit is per action. Nothing tracks
   spend per day, per vendor, per product, or total pending.
10. **Morpheus scopes are not OAuth scopes.** The redeemed list is an
   application-level authority scope; the underlying token may still be
   broader. That is only acceptable while the connector checks the grant
   before every operation and no other path exists — which the seam test now
   holds. Separate connections per permission level would be the outer
   control.

The execution truth model comes before the voice milestone: lossless durable
audit, atomic durable lease, attempt records separate from completion
evidence, provider idempotency keys, reconciliation, multi-instance proof,
crash-point recovery. Only then one complete path under realistic conditions — authenticated operator speaks, action
prepared, arguments frozen, consequence read back, action-specific approval,
step-up where required, atomic claim, one-use redemption, a real connected
service, verified result, one accurate audit trail, spoken receipt — and
survive retries, concurrent calls, restarts and altered commands.
- **No sandbox.** `sandbox:exec` and `sandbox:write` are registered
  capabilities with no sandbox behind them.
- **No spend metering.** The limit is checked per action; nothing tracks
  cumulative spend across a day.
