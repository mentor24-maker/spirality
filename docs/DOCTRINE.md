# Doctrine

Rules that earned their place. Every one below traces to a specific incident,
and each is written with the evidence attached — because a rule without its
story gets deleted by the next person who finds it inconvenient.

This is not a style guide. How the tracker page looks and reads is
[UI_DOCTRINE.md](UI_DOCTRINE.md). This is the set of things that cost hours,
and what to do instead.

## Where these rules came from

The loop was built inside StarCaster, before it had a name of its own, so its
lessons were written into StarCaster's `docs/DOCTRINE.md`. When the loop became
Spirality, they stayed behind. On 2026-11-15 (SP-318) every section about the
loop, and every general rule both repositories need, moved here; Dane's word
for it: *"there is much within the Starcaster doctrine that directly applies to
Spirality … I leave it to you to sort out the parts of Starcaster's doctrine
that should be migrated to Spirality."*

Three things follow from that, and a reader needs all three:

- **The section numbers are StarCaster's.** Code that came across with the
  loop cites them (`DOCTRINE 3.11`, `docs/DOCTRINE.md §2.5`), so a number means
  the same rule in either repository. A gap in the numbering is a section
  about StarCaster's own application — its Builder, its tenants' sites, its
  credentials screens, its database — which stays in StarCaster's doctrine.
  A reference written "StarCaster's §5.21" points there.
- **The incidents are told as they happened.** They name what existed then:
  ClickUp, its ticket ids (`86bb…`), `scripts/clickup_direct.mjs` (now
  `scripts/clickup.mjs`, `npm run clickup`, which talks to the tracker),
  `scripts/builder/…` (now `lib/…`), StarCaster's pull request numbers. The
  story is the evidence, so it is not rewritten.
- **Where Spirality differs today, a line says so.** It starts *In Spirality
  now*. A rule's "Do this" is kept current; the incident above it is not.

A rule that both repositories need is kept in both: StarCaster's copy is its
own to keep. A rule about the loop lives only here (CLAUDE.md, "Loop code lives
only in Spirality"), and StarCaster's doctrine points to it.

**Adding a rule.** Number it after the last section of its part (the next one
in part 6 is 6.26), so a number is never reused for a different rule in
either repository. Write the incident, then **Do this**.


---

## 1. Diagnosis

### 1.2 Verify against the live system; do not reason from the code

Every genuine defect in the credentialing work surfaced by *running* code, not
reading it. Three of them were introduced during that same work:

| Defect | Would reading have caught it? |
|---|---|
| Rate-limit guard inverted, endpoint returned nothing at all | No — the line read correctly |
| `400 → MISSING` mislabelled an expired YouTube key as "not configured" | No — the mapping looked sensible |
| Facebook verified against global env values, though its credentials are per-project | No — required knowing the data |

The same pass found an **expired YouTube API key** nobody was looking for.

**Do this:** exercise the real path — call the endpoint, drive the route
handler, hit the provider. "It should work" is not evidence.

### 1.3 Query the specific resource before declaring a platform broken

**Incident.** GitHub's `/actions/runs` listing showed no run for a branch, so it
looked like CI was not firing; a PR was closed, reopened, and given an empty
commit to force it. The runs had existed the whole time — the *general* listing
was stale, while the workflow's own endpoint (`/actions/workflows/ci.yml/runs`)
showed both completed successfully.

**Do this:** when an API result seems impossible, check a second, narrower
source before acting on the first.

### 1.7 A quota that blocks writes but not reads looks exactly like an outage

**Incident (2026-08-17).** Five ClickUp writes failed in a row with "Rate limit
exceeded. Please wait 1171 minutes" — nearly twenty hours. It read as the whole
integration being down account-wide, and the work (a task and a wrap-up post)
was parked in a file on the Desktop to wait it out.

Two things made it look worse than it was. Plain reads (`search`,
`get_workspace_hierarchy`) kept answering normally throughout, so the failures
looked arbitrary rather than budgeted. And the chat endpoints reported **"wait
NaN minutes"** — a JavaScript not-a-number leaking into operator-facing text,
which reads as a broken connector rather than a spent allowance.

The countdown itself was honest: four readings taken across three hours (1171,
1023, 998, 992 minutes) all resolved to a single fixed reset, matching the raw
`retryAfter` to within eleven seconds. It was a real rolling ~24h window.

**The part that mattered: there were two limits, not one.** The *connector*
(claude.ai's ClickUp bridge) budgets writes over ~24 hours. ClickUp's own API
limits by the MINUTE — about 100 requests, reset in 60 seconds — and was
nowhere near its ceiling. A personal API token talking straight to
`api.clickup.com` was never blocked at all. Nothing had to wait.

**Do this:** when a hosted integration reports a limit measured in *hours*, it
is the integration's quota, not the upstream provider's — provider limits are
almost always per-minute. Check whether a direct path exists before waiting.
`scripts/clickup_direct.mjs` is that path here — run as `npm run clickup --
<command>`, it covers the full loop surface (queue/get/comments/status/
comment/task/chat/lists; bare `npm run clickup` prints the list). It prints
the provider's true `x-ratelimit-*` headers so the two buckets can be told
apart, and verifies every write by reading the result back.

**Corollary:** a retry-after rendered as `NaN`, `undefined` or `Infinity` is not
evidence about the wait. It means the value was missing — go and find the real
one before planning around the number on the screen.

**In Spirality now:** tickets live on the tracker, and `npm run clickup` (`scripts/clickup.mjs`)
talks to it; ClickUp is a read-only archive, and the claude.ai connector is
never used (CLAUDE.md). The rule about limits measured in hours still holds
for every hosted integration.

---

## 2. Error messages and hand-offs

### 2.1 A confident wrong message is worse than a bare error code

The old X client appended the same advice to **every** failure:

> StarCaster uses OAuth 1.0a user context (four fields from the same X app)…
> Do not put an app-only Bearer token in Access Token.

For the 2026-07-29 failure, every sentence was wrong. It read as authoritative
and sent an hour in the wrong direction. A bare `401 Unauthorized` would have
been more useful, because it would have prompted a look rather than a wild goose
chase.

**Do this:** classify first, advise second. If the cause cannot be determined,
say what happened and stop. `lib/credentialErrors.js` holds the vocabulary;
clients supply the cause-specific fix only when they know it.

Two tests exist purely to keep this honest — they assert the code does **not**
volunteer bearer-token advice or portal steps when it cannot classify a failure.

### 2.2 Say what to do, in terms of the thing the operator touches

Compare:

- ✗ *"Cron credentials differ from session — deploy cursor/promote-social-cron-publish-fix"*
- ✓ *"scheduled posts would fail… Check the `X_*` environment variables on Vercel Production, then redeploy — env var edits do not reach the running deployment until you do."*

Branch names, internal flags, and function names mean nothing to the person
holding the problem.

### 2.3 Name the specific thing, not the category

*"If you changed it recently, redeploy"* invites a guess. *"This deployment was
built 2026-07-29T21:14:02Z (3 days ago), commit 0a83d71"* can be checked against
what you actually did.

### 2.5 A person is a human being — an agent is not, and a hand-off must say which

`person` and `human` mean a human being. In practice, Dane. An agent session is
an **agent session** — never a person, a human, somebody, or anyone. Ratified in
vault `doctrine/TERMINOLOGY.md` (2026-08-29), under the same rule that retired
"banner" and "harness": doctrine states rules in words with exactly one referent.

This is not house style. It is the answer to the only question that matters at a
hand-off — *whose hands does this need, and are they Dane's?*

Ticket 86bbmfc15 (PR #434) sat blocked for four days. The merge step hit a real
conflict and behaved correctly, but its messages did not. It told Dane *"your
approval is still standing — you do not have to say merge again"* and *"it will
merge on a later run, once the branch is caught up."* Its log and help text
called the actor it needed **a human**. An agent read that log and told Dane the
system had "stopped and asked for a person," so he concluded he was the blocker
and had missed a prompt. He was not the blocker, no prompt existed, and the
actor actually requested — an agent session, asked for on the bus — was not
listening, because nothing consumes those messages. The wrong word hid a missing
actor for four days, and the conflict itself was three lines.

**Do this:** at any hand-off, name which of the two it needs. A hand-off that
cannot name a specific waiting actor does not get to imply one. Passive voice is
the tell — *"once the branch is caught up"* reads as a process underway until you
ask who is doing the catching up. If nothing is going to pick the work up, the
message says so plainly.

**And do not over-correct.** Most existing uses are right and must stay: *"a
human eye is the only gate that exists"*, *"only a HUMAN exports a token by
hand"*, *"an Urgent flag is a human override"*. The test is not the word, it is
the referent — replace it only where the actor is genuinely an agent session.

### 2.6 The actor has one source, or two code paths will name two

§2.5 made every hand-off name the actor it waits on. That is necessary and it is
not sufficient. On 2026-08-30 the merge step named its actor correctly, and a
second code path in the same pass named a different one.

PR #444 was approved and its branch needed catching up with `main`. The catch-up
merged cleanly and the **push** lost a race — another session had pushed to the
same branch seconds earlier, so git rejected it with `fetch first`.
`branchCatchUp` reported `PUSH_FAILED`; `clickup_direct.mjs` mapped it to
`kind: 'unknown'`; `mergeOnComment.conflictHandOffNotice` read that, chose the
actor `later-pass`, and wrote the true sentence — *"It will be merged on the next
run."* Nothing needed to act.

Then the filing path ran. It files on `gate.action === 'conflict'` alone and
never reads the local verdict, so it opened a ticket titled *"Resolve the merge
conflict on PR #444"* — for conflict markers that did not exist; `git merge-tree
--write-tree` on the two branches exits 0 with a clean tree — and posted a second
comment naming the build loop as the actor. The two comments landed 200
milliseconds apart saying different things. The ticket then sat two hours in
Ready to launch, because a reader believes whichever one they read last, and
neither named actor was going to move it.

**Do this:** derive the actor once and let every consumer read that one value —
the notice, the filing decision, the log line. Where two readers exist, a test
asserts they cannot disagree on the same fixtures, the way the verdict parser
already guards its own pair. An actor computed twice is two actors.

The tell is a condition that stops short of the value it is deciding about:
`if (!filed && !dryRun)` asks whether a ticket already exists and whether this is
a real run, and never asks the one question it is answering — *is there anything
to resolve?* Closing it is task 86bbq80j5.

### 2.7 Every time quoted to the operator is Mountain time — never UTC

Dane works in **Mountain time (`America/Denver` — MDT in summer, MST in
winter)**. So does everything he reads: the Mac Mini's clock, the loop logs
under `~/loop-logs/`, the launchd logs, and every ClickUp Loop note. GitHub and
the ClickUp API do not — they hand back UTC, with a trailing `Z`.

On 2026-09-01 a report to him quoted `mergedAt=2026-09-01T17:21:59Z` in the
same breath as a Mini-log line reading `10:37`, and he had to ask which clock
was which. He had asked before. His words that morning: *"You are back to
using UTC as a basis. It is now 11:12 AM my time. Please make note of this in
doctrine so we don't have to keep discussing time zones."* A standing
instruction given verbatim is a keeper.

**Do this:** convert every API timestamp to Mountain time before it reaches a
reply, a ticket note, a bus post or an operator card — `mergedAt`, `date`,
`createdAt`, `date_updated`, all of them. Mini-log and Loop-note times are
already local; leave them alone. If a raw value must be quoted (a log excerpt,
a `gh` line pasted as evidence), label it once with the zone so the reader is
never left converting. The `@@MEASURED 8:04pm` line on an operator card is the
same rule from the other side: it is the clock that dates the card, and it is
his clock.

```
TZ=America/Denver date -r 1756747319                       # shell, from an epoch
new Date(x).toLocaleString('en-US', { timeZone: 'America/Denver' })   # node
```

Two clocks in one report is one question he has to ask every time, and this
section exists so that he never has to ask it again.

**In Spirality now:** loop notes are tracker comments, and `npm run clickup -- comments`
prints them in Mountain time. GitHub still answers in UTC.

### 2.8 A refusal that cannot clear must not promise that it will

§2.1 is about a message whose **diagnosis** is wrong. This is the opposite and
costs more: a message whose diagnosis is right every single time, and whose
**prognosis** is invented.

On 2026-09-02, task 86bbqw49y sat in "Ready to launch" for twelve hours with its
pull request already merged and its work live in production. The merge-on-comment
step read Dane's `merge`, went to GitHub, found PR #513 already merged, and
declined. That was correct — there was nothing left to merge. It then said this,
every ten minutes from 06:26 to 10:40 UTC (12:26 to 4:40am Mountain time):

```
Merge not performed. PR #513 is not in a state that can be merged safely.
Why: the PR is already merged.

Your approval is still standing — you do not have to say "merge" again. Every
later pass re-checks this ticket, so the moment the reason above is dealt with
it goes through on its own. You will only hear from this step again if the
answer changes.
```

Nothing will deal with it. No later pass can. "Already merged" is terminal, and
the sentence promising otherwise is exactly what stopped anyone looking. Three
reasons appeared on that one ticket, all carrying the same reassurance, and only
one of them was transient:

| Count | Reason | Can a later pass clear it? |
|---|---|---|
| 16 | the PR is already merged | **No — terminal** |
| 3 | no "PR opened:" comment on this ticket | **No — terminal** |
| 6 | no review verdict on this ticket | Yes |

Two thirds of the refusals told the reader to wait for something that was never
coming. Then the repeat-suppressor noticed the reason had not changed and
silenced them, so the ticket went from reassuring-and-wrong to saying nothing at
all. **Dedup without escalation converts a loud wrong answer into a quiet one**,
which is not an improvement — it is the same defect with the evidence removed.

**Do this:** classify every refusal reason as `terminal` or `transient` **at the
point it is raised**, never by inferring from its wording later. A reason with no
classification is a build error, not a default. Only a transient reason may say
the approval stands and the pass will retry. A terminal one drops that sentence
entirely, says plainly what it needs instead, posts **once**, and then escalates
rather than repeating — and it names who must act, an agent session or Dane, in
the active voice (§2.5).

The general form is worth carrying past merges: **a message can be completely
accurate about the present and still lie about the future, and the lie is the
expensive half, because it is the part that tells the reader to stop looking.**

**In Spirality now:** the classification is `lib/refusalClass.js`: every refusal names a
code from `REFUSAL_CODES`, and every code says whether a later pass can
clear it.

---

## 3. Designing checks

### 3.1 A registry, never a chain of branches

`runConnectionOpsTest` picked between providers with an eight-arm `if/else`
whose `else` threw *"No test handler for this platform yet"*. Buffer and YouTube
were both configured and live; neither had an arm, so neither could be tested at
all. **30 providers were configurable, 8 testable.**

The structural fix — a provider → verifier registry (`lib/credentialVerify.js`)
— took that to **17 of 30**, and adding a provider is now a row rather than a
new code path.

**Do this:** when a feature must cover a set that grows, make membership data.
A chain of branches silently omits whatever nobody remembered to add.

### 3.2 "Cannot check" is a third outcome — never a pass, never a failure

Telegram's old test only confirmed the fields were *filled in* and never
contacted Telegram, so it passed with a bogus token. That is worse than no test,
because it manufactures confidence.

`NOT_VERIFIABLE` is therefore its own result, rendered distinctly in the UI, and
the message says *"presence of the values was checked, not validity."*

**Do this:** if you did not verify something, do not let the output look like
you did.

### 3.9 The second run is a different program — run it before you believe the first

Reconciling the delraytennis import shipped three defects in one afternoon,
all invisible on the first run and all obvious on the second:

- The decisions file was rebuilt from the "still outstanding" list. A
  decision that WORKED moved its page off that list, so the file silently
  erased every call that succeeded — three operator decisions became zero
  between two identical commands.
- `createAsset` always inserts, and the blob copy it follows overwrites in
  place. Applying twice registered all 73 images a second time; nothing
  looked wrong anywhere except a library that had quietly doubled.
- The image step asked "is this photo already on the page?" while counting
  its own output, so a re-run would place nothing at all — freezing the page
  on whatever shape the first run happened to write.

**Do this:** anything that looks idempotent gets run twice and diffed
before it is believed. A record rebuilt from what is *outstanding* loses
what *succeeded* — rebuild from what is known and only ever add. An
"already present" test must exclude the thing you are about to write.

### 3.10 A write that normalizes to nothing looks exactly like a success

The reconcile runner passed the section list in the shape the database
COLUMN uses rather than the shape the serializer takes. The serializer does
not reject it: it reads no sections and writes an empty page. Fourteen
pages were emptied in one run, each one reporting "wrote 1 section", and
the only reason it was caught is that the database was checked instead of
the script's own output.

**Do this:** read the record back immediately after writing it and compare
it against what you sent — count and identity, not just "no error". Stop on
the first mismatch, before the next record is touched, and print the
restore command. A tool's own log is not evidence about the database.

### 3.11 A survey that skips what it cannot read has not surveyed anything

Asked whether deleting a project would harm a sibling, a sweep of all 95
project-scoped tables reported "nothing anywhere is owned by the old
project" — and the delete then failed outright. The sweep was written as
`if (error) continue`, so nineteen tables were never actually checked, and
one of them was `dev_sessions`, whose `project_id` is the wrong TYPE. That
table was both the answer to the question and the reason the operation
broke, and it had been silently discarded.

The re-probe was nearly as misleading: a `HEAD`-style count request returns
no response body, so every one of those errors came back with an empty
message. "Error, but blank" reads as noise rather than a finding.

**Do this:** a sweep reports three numbers — checked, empty, and **could not
check** — and the third is never folded into the second (§3.2). When a
probe errors, print the code and the message before deciding it is
uninteresting, and re-issue it in a form that actually returns an error body.
An advisory given from a partial sweep should say which parts were partial.

### 3.12 A guard placed after the refusal it exists to pre-empt is unreachable

The merge step was taught to notice a `review-gate` check that had answered an
older question and **re-run** it rather than merge on it (task 86bbmk7pv, PR
#443). The decision logic was pure, tested from nine angles, and correct. It was
also, in the one mode it was written for, dead code.

The step's first rule is *never merge past a red check*. In enforcing mode a
stale gate **exits 1** — so it IS a red check, `githubGate` answered `refuse`,
and the function returned three lines above the staleness question. Ticking the
branch-protection box would have produced exactly the deadlock the ticket was
written to prevent.

Two things hid it. The feature ships **advisory first** (exit 0), and in advisory
mode the stale check reads green, the refusal never fires, and the block is
reached — so every trial and every test exercised the reachable half. And the
wiring test asserted only that the staleness call appeared *before the merge
command*, which stayed true with the code unreachable: it pinned a boundary that
could not move, so it could not fail.

**Do this:** when a check exists to handle a specific failure state, prove it is
**reached while the system is in that state** — not merely that it is called
somewhere before the action. Two questions catch it:

- *What else answers first?* List the branches that return before yours. A guard
  that interprets a red signal must sit above the rule that refuses on red
  signals; a stale red means "run it again", and only the re-run's answer is a
  real refusal.
- *Which mode did I test?* A feature with an advisory phase and an enforcing
  phase is two programs. Green in the harmless one is not evidence about the
  other, and the enforcing path is the one with the consequences.

An ordering test must pin the boundary that can actually move — here,
*staleness before the red-check refusal*, not *staleness before the merge*.
Break it on purpose and watch it fail; an assertion that survives the bug it
names is decoration.

### 3.13 A watchdog that runs only where its subject runs cannot see the case it exists for

Slice E of the NODES plan (task 86bbhbadj, PR #469) had to make *silence*
detectable: a job that fails writes a log line, but a job that never fires
writes nothing anywhere, and nothing is indistinguishable from a quiet week.

The obvious build is a check on the machine that owns the job — it has the
data, it is already awake when the job runs, and it needs no coordination. It is
also useless, and useless in the exact scenario the feature was written for.
**The machine being switched off takes the watchdog out with the job.** A
schedule evicted by an OS update, a Mini unplugged, a launchd job that never
reloaded after a restart: in every one of those the watcher and the watched die
together, and the silence goes unreported by the one thing built to report it.

So the beats go on a surface **both** machines read (a ClickUp ticket), and the
check runs from whichever machine is awake — including, and especially, the one
that does **not** own the job. `scripts/run_bus_relay.sh` performs it *before*
the ownership test, which reads oddly until you see why: the non-owning machine
was already waking every ten minutes to say "not my job" and exit, and that idle
wake is the only vantage point in the system that survives the owning machine
being dead.

**Do this:** for any check whose subject is a machine, a process or a schedule,
ask *what takes both of us out at once?* If the answer is "the thing I am
watching for", the check is in the wrong place. Put the evidence somewhere
neither party owns, and read it from somewhere the failure cannot reach.

The corollary is a resolution question, and it is the cheap half: the shared
record only needs to be as fine-grained as the absence you must notice. Slice E
pushes one row per machine per day, because the requirement is "a day-long
absence is visible", not "a ten-minute one is". A finer clock would have been
more writes, more noise and no more detection.

**In Spirality now:** the shared surface is the tracker, which both machines reach.
Moving StarCaster's pipeline watchdogs into Spirality, for every project, is
SP-260.

### 3.14 An unpopulated field is not an empty answer

The same slice reads its roll call out of a ClickUp task description. Driven
against the live API, ClickUp answered a `GET` with `markdown_description: ""`
for a task whose description it was holding **perfectly well** — the text
arriving under `description` instead. The reader preferred the markdown field,
so it handed the parser an empty string for a record that was entirely intact.

The parser then did the reasonable thing and read an empty string as *an empty
roll call*: no beats recorded yet. Which would have announced **every scheduled
job in the system as having gone quiet, all at once**, off a field that was
simply not filled in. For a monitoring feature that is the worst available
failure: an alarm that cries wolf is an alarm nobody reads, so a false-alarm
storm does not merely add noise, it disables the real alerts behind it.

It was caught only because the thing was run against the live service instead of
reasoned about — the code is correct against the API as documented.

**Do this:** when a provider can return a field empty, decide explicitly which
of two things "empty" means — *a confirmed absence* or *nothing was read* — and
make the two render differently (§3.2, §3.11). Where the record you write always
carries something (a preamble, a header, a marker), a wholly empty read is
**unreadable**, never zero results. And consult every field that could carry the
value rather than one by preference; a provider populating a different field
than the one you wrote is a real behaviour, not a corruption.

**In Spirality now:** `tracker/import.mjs` reads both fields when it brings a ClickUp
ticket across (`markdown_description || description`).

### 3.18 A watchdog that is awake, correct and unread is indistinguishable from coverage

§3.13 asks *where* a watchdog runs. This asks the two questions that remain once
it is running in the right place, and a check can pass both of §3.13's tests and
still miss everything.

The twelve hours in §2.8 were not unwatched. **Three watchdogs were awake and
pointed straight at that ticket, and none of them reached Dane.**

| Watchdog | Cadence | What it saw | Why it did not land |
|---|---|---|---|
| `stale-ready` | every 10 min, on the Mini, inside `run_bus_relay.sh` | `READY TO LAUNCH — 1 ticket in the stage, 0 past 24h / Nothing is stuck.` | Its threshold is **24 hours**. The ticket was stuck twelve. It reported all-clear, honestly. |
| `reconcile` | by hand only | Named the ticket exactly: *"sits in ready to launch but PR #513 is already MERGED"* | Nothing schedules it, and its finding goes to the bus. |
| merge-on-comment | every 10 min | Refused 25 times, correctly | Reassured while refusing (§2.8). |

Note what is *not* wrong here. Every one of them was correctly placed by §3.13's
rule, running on the right machine, reading live state, and telling the truth.
The instinct on discovering this was to schedule `reconcile` — and that would
have found the same thing sooner and filed it into the same unread channel.
**The cadence was never the problem.** The two failures were:

- **Threshold.** Twenty-four hours is a reasonable grace period for a ticket
  nobody has looked at. It is far too patient for one the operator has
  personally approved: he stated an expectation the moment he typed `merge`, and
  he noticed inside a day, so the machine must notice sooner than he does. Dane
  ruled on this the same day, verbatim: *"Yes → tickets carrying your merge
  comment get a short fuse (1–2h)"*.
- **Destination.** All three write to the bus. The bus was not read. A finding
  in an unread channel is not a quieter alert — **it is silence wearing an
  alert's clothes**, and it is worse than having no watchdog at all, because it
  reads as coverage on the board and nobody builds the thing that would have
  worked.

**Do this:** for every check, answer two questions in writing before believing
it works. *What is the longest this can be wrong before somebody who cares finds
out by other means?* — if that number is smaller than the threshold, the
threshold is wrong. And *who reads where this lands, and how would I know if
they stopped?* — if there is no answer, the check is not finished, however
correct its logic.

A threshold is a claim about who is allowed to notice first. Whenever the
operator has stated an expectation — an approval, a `merge`, a deadline — the
clock starts there and runs faster than his patience, not slower.

Measure that clock from the event itself, never from a record's `date_updated`:
any edit resets it, so on 86bbqw49y the twenty-five automated refusal comments
would each have reset the very clock built to catch them.

**In Spirality now:** the short fuse is built: `lib/staleReady.js` gives a ticket carrying
Dane's merge word a shorter threshold than an untouched one. And an alarm no
longer waits on the bus being read: it is texted to the alert phone (SP-163).

### 3.19 Break-test a check in the PASSING direction too — a false positive is worse than a miss

2026-09-03, writing `check_builder_only_notes.cjs` (86bbunq4c).

Every check here gets broken on purpose to prove it can fail. That is half the
job. The other half is proving it can **pass**, and it is the half that gets
skipped, because a green check feels like the finished state rather than a
claim to be tested.

This one caught a leak correctly and then flagged a note that was correctly
guarded: an inline `<BuilderOnlyNote …>text</BuilderOnlyNote>` written on a
single line. The scan walked backwards from the match looking for an opening
tag, and met that line's own CLOSING tag first. Only writing the compliant case
and running it found that.

**A false positive on a gate is worse than a missed defect**, and the asymmetry
is not close. A miss costs one bug. A check that fails work which is already
correct teaches people to reach for `SKIP_CONVENTIONS=1` — and that switch is
not per-rule, so one annoying check disables every check in the file. The
cheapest way to lose a whole gate is to make it cry wolf once.

So a check ships with two rehearsals, not one:

- the defect it exists for → it must fail;
- the **compliant** version of the same code → it must pass.

Related: §3.12 (a guard after the refusal is unreachable) and §3.11 (a survey
that skips what it cannot read has surveyed nothing) — this check fails when it
scans zero files for exactly that reason.

---

## 4. Secrets

### 4.1 The rule is about EXPOSURE, not custody

Standing rule, and the test is one question: **would this render the value
somewhere a person or a log could read it?**

- **No — the agent runs it.** A command that moves a secret between two stores
  without displaying it: `doppler secrets get X --plain | gh secret set X`.
  Nothing reaches the screen, the clipboard, the transcript, or a field where it
  could be mislabelled.
- **Yes — the operator runs it.** Anything that makes a value *visible* or
  *new*: reading one out, generating one (`openssl rand`), pasting into a
  browser form, a billing screen, a login. StarCaster's `scripts/diagnose_x_auth.js` is the
  model for tooling that must not cross the line — it prints lengths and
  first/last four characters, never a value.

**The pipe has a direction, and only one end is safe** (2026-09-01). The example
above works because `doppler secrets get --plain` writes to stdout, where a pipe
swallows it, and `gh secret set` echoes nothing. Reverse it and the rule inverts:
**`doppler secrets set` prints the value it just wrote**, and `doppler secrets
delete` prints the remaining secrets table — full values, all of them. `--silent`
suppresses info messages, not those tables. An agent moving a credential INTO
Doppler that way exposed a live ClickUp token and a Google API key in one
session, while believing it was following this section.

So: Doppler belongs on the `get` side of a pipe, never the `set` side. A value
that has to be *entered* into Doppler goes in through the dashboard, by Dane —
that is the "makes a value new" case, and it always was. And before piping a
secret anywhere, check what the receiving command prints on success; "it moves
between two stores" is not the test, "does anything render it" is.

Deleting a GitHub secret is refused outright by the session's safety classifier
(three attempts, 2026-08-31). That is correct behaviour, not a bug to route
around: hand the click over and say in one line why.

**Why it is stated this way** (2026-08-31). The rule used to read "the operator
runs the command that touches the real value", and it was applied as though it
were about **custody** — who holds the secret. It was written after the
2026-07-13 incident where `.env.local` was visible on a TV in a photo, so it was
always about **visibility**.

Read as custody, it did the opposite of its job. Setting up the review gate's
CI token, the operator was handed the GitHub secrets browser form — and pasted
a ClickUp token into the **Name** box twice, with two different tokens. GitHub
encrypts and masks secret *values*; it does not protect *names*. Both tokens sat
in the settings UI as plain labels and are in the repository's audit history
permanently, which no deletion reaches. The agent had a pipe available that
would have shown nothing and had no Name box to get wrong, and declined to run
it on the strength of this rule.

**Do this:** prefer the pipe over the form precisely *because* the form has a
field the value can land in wrongly. A rule written to prevent exposure must
never be applied in a way that creates it — when the two readings disagree, the
one that keeps the value off every screen is the correct one.

---

## 5. Code and tests

### 5.2 A bare `setInterval` in a required module hangs every test

`lib/rateLimiter.js` held one, which kept the Node event loop alive forever. Any
test that required a route — directly or transitively — never exited. Now
`.unref()`'d: cleanup still runs under a server, where the HTTP listener holds
the loop open.

**Do this:** `.unref()` module-level timers in anything a script may import.

### 5.3 `$?` after a pipe is the pipe's exit code

`npm run typecheck | tail -5; echo $?` reports `tail`'s status, not `tsc`'s. Redirect
to a file and check the real code, or the gate is theatre.

### 5.5 Tests must not depend on ambient state

Two tests broke on ambient conditions, not on defects:

- One asserted a missing-token reason, but ran in a checkout with no build
  stamp, so a different guard fired first. The fix was to reorder the code —
  report the missing **token** first, because that is the part the operator must
  supply, while the stamp is written by every deploy.
- One assumed a provider was unconfigured; a later slice made it verifiable.

**Do this:** make such tests skip explicitly, or remove the dependence.

### 5.19 A cache must not remember a failed question as an answer

2026-08-30, found in review of PR #448 (Connections 1/7). `lib/projectScope.js`
asks each table once whether it has both tenant columns, and remembers the
answer for the life of the process:

```js
const probe = await sbQuery({ table, query: 'select=project_id,owner_user_id&limit=1' });
const supported = probe.ok;          // ← the bug, in one line
SUPPORT_CACHE.set(tableName, supported);
```

`probe.ok` is false for two situations that are **not the same fact**:

| What happened | What it means | Cacheable? |
|---|---|---|
| 400 naming the column, 404 on the relation | Postgres answered: the columns are not there | Yes — it is a property of the table |
| 502, cold start, dropped connection | The question never arrived | **No** — it is a property of the moment |

Both were stored as "this table has no tenant columns", permanently. And
`scopedListQuery`/`scopedIdQuery` respond to that by returning the caller's
query **with no project filter appended at all** — which is a reasonable
behaviour for a table that genuinely is not tenant-scoped, and a catastrophic
one for a table that is. Every scoped read in that process then returned every
project's rows. On `project_connections` that is one client reading another
client's decrypted OAuth tokens; review reproduced it with a single simulated
502.

Note what makes this invisible. There is no error, no empty result, no slow
query — the unscoped read is *faster* and returns *more* data, and every store
above it reports `ok: true`. It also cannot be reproduced by running the
software normally, because the cache is only wrong after a failure that is by
definition rare and transient. It is a bug that exists exclusively in
production, exclusively after a hiccup, and exclusively in the direction of
handing out too much.

**The rule.** A negative cache entry must be justified by an answer, never by
the absence of one. If a probe can fail for reasons unrelated to the thing
being probed — and any probe crossing a network can — then a failure must be
classified before it is stored, and an unclassifiable failure is not stored at
all. Answering "unknown, ask again next time" costs one extra round trip on the
next call; answering "no" costs the whole process.

**Fixed at both ends, deliberately** (PR #448), because they fail differently:

1. `supportsProjectColumns` caches only a definitive answer. A transient
   failure returns false for that one call and re-probes on the next, so the
   process heals itself.
2. `lib/projectConnectionsStore.js` refuses to *execute* a query that did not
   come back scoped — `requireScopedQuery` checks for `project_id.eq.` and
   returns a 503 rather than run it. The insert path already did this;
   the read, list and delete paths did not.

The second is the one that matters, and it generalises: **the guard belongs
where the damage happens, not only where the mistake originates.** Fixing only
the cache leaves every future caller of `scopedIdQuery` trusting that a
returned query is a scoped query, which is exactly the assumption that failed
here. A store handling secrets should verify the filter is present rather than
assume the helper added it — cheap, local, and it does not depend on anyone
remembering this incident.

**Prove a fix.** Simulate the transient failure specifically; a missing column
does not exercise this path, because that failure is correctly cached.
`scripts/builder/projectConnectionsStore.test.js` does it with a fault switch
that fails the NEXT probe with a 502 and nothing else — then asserts three
things: the read is refused, the token appears nowhere in the refusal, and the
very next call recovers to a correctly scoped 404. Break either end and that
test fails; both were reverted and watched to fail before the fix was believed.

**Where else this shape lives.** Anything that probes once and remembers.
`git grep -n "CACHE.set" lib/` is the starting point — the question to ask of
each is "can this probe fail without telling me anything about the thing I am
probing?", and if it can, "what does the cached wrong answer authorise?"

### 5.20 A screen that paints is not a screen that works

2026-09-01, PR #506 → fixed by #509. The Media Manager module shipped with
rename sending `PUT` to `/api/assets/:id`. `routes/assets.js` handles **PATCH**
and **DELETE** for that path and nothing else, so the request fell through
unmatched. Renaming a file did nothing at all. Delete, on the same card, was
fine.

It shipped past every gate, because the closing check verified the grid
**rendered**: the module drew its chrome, fetched real assets, and showed them
with names, sizes and dates. Not one write action was exercised.

The optimistic local state is what makes this class of defect so quiet. The
break test reproduces it exactly:

```
PASS  the rename is reflected immediately
FAIL  the rename SURVIVES A RELOAD
```

The name changes on screen the instant you press Enter, because the component
set its own state. Everything looks correct until the page is reloaded, and
nobody reloads while admiring their own feature.

**So: a check on anything that writes must reload and read it back.** Not
re-render from memory — reload, refetch, and assert the value came back from
the database. The same duty applies to the closing "where I looked at it"
sentence: naming the screen you opened is not enough if you only watched it
paint.

The sibling failure lives one section up (§3.10): a write that normalizes to
nothing looks exactly like a success. This is its front end — a write that
never happened looks exactly like one that did.

**This rule was broken the day after it was written.** 2026-09-02, task
86bbt72jw: the Card Manager's settings were verified in its Live Preview, which
renders from component state. Every control worked on screen and not one value
reached the database. See §5.22 — knowing to reload is not enough if you reload
the surface that cannot see the write.

### 5.22 The surface you verify on decides what you are able to see

2026-09-02, tasks 86bbt62dy and 86bbt72jw — twice in two days, on one feature,
in two different ways. Both times the work was verified, both times the
verification was real, and both times it was performed somewhere that
structurally could not show the defect.

**Once by rendering a different code path.** 86bbt52fa added fifteen Card
Manager controls, checked on `builder-preview.html` — the harness page, which
renders the module's PUBLIC component. The controls were there. In the Builder,
where the operator actually opens the module, `renderModulePreview` had no
branch for that type and drew nothing at all. He refreshed repeatedly and saw
an empty panel. The check was honest and answered a question nobody had asked.

**Once by reading back component state.** 86bbt72jw's settings were exercised in
the Card Manager's Live Preview, which re-renders from React state. Every
control moved the sample card. None of the values reached the database (StarCaster's §5.21).
A surface that shows you what you just typed cannot tell you the write failed —
it will agree with you forever.

The shared shape is not "we tested the wrong thing". It is that **a convenient
surface and the operator's surface are different programs**, and only one of
them is the deliverable. `builder-preview.html` exists precisely because it
needs no database, no login and no fixture — which is the same sentence as *it
does not exercise the database, the session or the real page*.

**So: the closing check runs on the surface the operator uses, reached the way
he reaches it.** For this repo that usually means signing in and driving the
real Builder, not the harness; and for anything that writes, reading the value
back out of the DATABASE or the published page, not out of the editor that just
sent it. §5.20 says reload and read it back. This says: and make sure the thing
you reload is the thing he opens.

The harness pages keep their job — they are how `check:render` and
`check:panels` stay cheap enough to run every time. They are instruments for
regression, not evidence that a feature works where it ships.

### 5.26 A probe must ask a question the thing can ANSWER — a malformed question's honest error reads as absence

2026-09-03, found while building the blog links manager (86bbu4qh5), fixed in
PR #555. `lib/blogPostsStore.js` decided whether a Supabase table existed by
selecting one column from it:

```js
const probe = await sbQuery({ table, query: 'select=id&limit=1' });
const ok = probe.ok || !isMissingTable(probe.error);
```

`blog_post_categories` is a pure join table. Its primary key is
`(post_id, category_id)` and **it has no `id` column at all**. So Postgres
answered, correctly and permanently:

```
column blog_post_categories.id does not exist
```

`isMissingTable()` matches on `does not exist`, so that reply — a true
statement about a COLUMN — was read as the TABLE being gone. The store then
used the local JSON file for every read and every write of that join, and said
nothing.

That is not cosmetic. Vercel's filesystem is read-only (landmine 6), so the
fallback write vanishes: **assigning a category to a blog post reported success
and never persisted, and listing posts by category returned an empty list on a
blog that had them.** Both symptoms look exactly like "this tenant has no
categories yet", which is why nobody chased it.

**This is the third sibling of a family already on the books, and it is
distinct from both:**

| | The failure | The rule |
|---|---|---|
| §5.19 | A transient 502 cached forever as "no tenant columns" | Do not remember a **failed question** as an answer |
| StarCaster's §5.21 | A 409 refusal answered with the caller's own input | Do not fall back when the database **refused** |
| **§5.26** | A question the table cannot answer, read as absence | Do not ask a question the thing **cannot answer** |

Nothing was flaky and nothing refused. The probe was simply the wrong question,
and its correct answer was misread. The fix names a column each table actually
has (`PROBE_COLUMN = { posts: 'id', join: 'post_id' }`), pinned by
`scripts/builder/blogStoreTableProbe.test.js`.

**The general form:** a feature probe, a capability check, a health check and
an existence check all turn an error string into a boolean. Before trusting
that boolean, ask what ELSE could produce that string — and make the probe
specific enough that only the fact you care about can produce it.

### 5.31 An empty screen that does not say WHY reads as a broken one

2026-09-03. The operator reported three things as broken in one day. All three
were behaving correctly:

| what he saw | what was true |
|---|---|
| `/tags?tag=junior%20tennis` showed no posts while the manager said 13 | all 13 were DRAFTS; the public feed asks for `status=published` |
| "You Might Also Like" flashed and vanished on a live post | it matched by CATEGORY, and no post on the platform has one |
| "No posts match your filters" for a `?tag=` the dropdown showed as "All Tags" | no post carries that tag; the `<select>` had no matching `<option>` |

Not one was a code defect in the thing he pointed at. Each cost real diagnosis
time, and in each case the answer was a single sentence the screen could have
said itself. **He cannot read the database, so "empty" and "broken" are the
same picture.**

The rule: anything that can render empty names the value and the cause.
"No posts tagged 'junior tennis'", not "no results". "This post is not in any
category, so there is nothing to match on", not a blank space. Where two
screens count the same thing differently — the manager's 13 and the site's 0 —
**each says what it counts**, or the operator is left to reconcile them by
hand: `listTags` now returns `livePostCount` beside `postCount` (#577).

Two things that make an explanation worse than none:

- **On a public page the explanation is for the BUILDER only.** A visitor gets
  nothing at all. That is StarCaster's §5.29, and it is why the empty state needs
  `liveSite` before it needs good wording.
- **Compute the number where the emptiness is decided.** The popup counts the
  posts it actually loaded, not the row's stored count — two reads at two
  moments, and summarising from the wrong one reports a figure nobody measured.

### 5.33 A check that could not run must not exit 0 — and must not exit 1 either

The browser harnesses under `scripts/ui/` are the only gates CI cannot run, so
their exit code is the whole of what a script, a log skim or an unattended pass
ever sees. Two of them were observed on 2026-09-02 printing an excellent
refusal and exiting **0**. `check:panels`'s own text says it best — *"without a
project the builder renders an empty page and every assertion passes on zero
panels, which is worse than failing"* — and then, at the time, it agreed with
itself and exited 2 while three of its siblings did not.

The audit (task 86bbt6hgx) found eight such paths. `check_screens` had four in
one file: no fixture project (*"these checks are hollow"*), a project that
would not activate (*"screens may render empty"*), a rate-limited run
(*"treat everything above as unreliable"*), and measuring not one screen —
all ending at `process.exitCode = failures.length ? 1 : 0`. Run with no project
id against a live server it printed **"9 screen-width combination(s) checked,
0 skipped, 0 failing"** and exited 0, which is byte-for-byte what a clean sweep
prints. `check_nav_controls` collected every control whose fixture variant was
missing, printed the list, and then never let it near the exit code — with all
variants gone it would print *"OK — all 0 controls move the rendered page"*.

**Three verdicts, one shared module** (`scripts/ui/harness-exit.mjs`):

| exit | meaning |
|---|---|
| 0 | ran, and what it measured was correct |
| 1 | ran, and what it measured was **wrong** — the code under test has a defect |
| 2 | **could not take a reading** — says nothing about the code |

Same scheme as `npm run throughput`, and the same answer `doctor:node` gives
with CANNOT TELL rather than PASS.

**The 1-vs-2 half matters as much as the 0-vs-2 half, and is easier to get
wrong.** Four vacuity guards already exited 1, each with a sentence reading
"that is a failure, not a pass" — correct when 1 was the only non-zero code
available, and wrong now: an unseeded fixture, a stale build, a throttled
server and a missing variant are all faults of the **instrument**. Reporting
them as 1 sends whoever reads the log hunting a defect in code that may be
perfect. The rule of thumb: *if the code under test could be flawless and this
could still happen, it is a 2.*

A real failure outranks a could-not-tell — a screen that overflowed its
viewport overflowed it, whatever else about the run was hollow. A **pass**
never does, because a pass over something nobody measured is the whole defect.

**And the ranking is worth nothing unless the failures are counted FIRST.**
The first version of this fix stated the rule above, encoded it in `verdict()`,
wrote it down here — and then broke it in three places, because each harness
called `cannotTell()` *above* its failure block. `cannotTell()` exits on the
spot, so the refusal short-circuited and the real failures were never even
printed. Measured on the review pass: break the preview renderer and
`check_render` said `COULD NOT TAKE A READING` where `main` had correctly said
`FAILED` — the fix introducing the exact mistake it was written to remove.
Worse in the general case, `check_render` counts a contract as `measured` only
*after* it renders, so a change breaking all 41 gave `failures = 41,
measured = 0` and reported "not a failure of your change either".

So: **compute the verdict, then act on it.** Never `if (blind) refuse()` above
`if (failures) fail()` — the two guards read as independent and are not.
`check_screens` is the model (`verdict({ failures, blind })` into a single
`process.exitCode`), and `scripts/builder/harnessExitCodes.test.js` asserts on
the *position* of those calls, because an assertion that merely proved both
exist passes on the broken ordering.

**A tool that never judges the code has no honest use for exit 1.**
`check:shots` photographs two builds and files the pairs that differ, leaving
the judgement to the operator's eye — so it cannot discover a defect, and its
every stop (no shell on the control scene, the control differing from itself, a
scene rendering nothing, ClickUp refusing the upload) is a broken camera. It
answers 0 or 2, never 1. Where a stop genuinely *is* the change's fault — the
preview surface no longer rendering — the gate that says so is `check:render`,
with a real failure and a real 1.

**Corollary, learned twice in one file: a source-scanning test must read the
source with comments stripped.** These harnesses carry long comments quoting
the very calls they replaced, so a test grepping raw source matches its own
documentation. It bit the `stdio: 'ignore'` assertion, then the `process.exit(2)`
one, then a `process.exit(1)` count that found two — the call, and the sentence
saying there was only one.

**In Spirality now:** two schemes are live, and that is a contradiction in the sense of
§6.17, recorded here rather than changed in passing. `pass-reconcile` and
the throughput watchdog answer as this section says (2 = could not tell).
`npm run clickup -- waiting` is older: 0 not waiting, 3 waiting, 1 could not
tell (`docs/LOOP_CONTRACT.md`), and every lane reads those codes. A new check
uses 0, 1 and 2.

---

## 6. Working in the loop

### 6.1 One worktree per thread, and trust nothing about the working directory

The shell's working directory can silently reset between commands. A relative
path therefore ran against the wrong folder mid-task.

**Do this:** use absolute paths, or re-assert the directory in the same command.
Verify with `git status` in **both** folders before concluding where an edit
landed.

### 6.2 Catch up `main` before merging, and read what the conflict tells you

A conflict is information, not an obstacle. When `main` had replaced the eight-arm
chain that a branch was editing, the right resolution was not to re-home the
branch's addition but to **delete it** — the newer phases covered the same ground
better, and its warning could not even fire in production. Resolving a conflict
mechanically would have preserved dead weight.

The converse costs more, because nothing announces it: a merge with **no**
conflict is not evidence the two sides agree. §6.11 is that case — two branches
contradicting each other's rules without sharing a line.

And before any of that: **confirm the conflict is real.** A forge can report
one that git cannot reproduce, and the word alone is enough to start somebody
editing files that never conflicted — §6.13.

### 6.3 State results, not intentions

`CLAUDE.md`'s definition of done is the standard: run the gates and report what
they printed. "It should work" is not done. Passing commands are done.

### 6.4 Housekeeping is the agent's job — do it quietly

**Standing instruction from the operator, 2026-08-08, verbatim:**

> *"Count me as 100% on board with any and all housekeeping tasks along the
> way. I'm a big fan of cleaning up after ourselves as we go. I just don't
> have the brain power to manage it myself, so again, I'm asking you to just
> deal with all those chores as quietly and efficiently as possible without
> bringing me into it unless I am doing something wrong to actively cause a
> problem, in which case, make me aware of it as soon as possible and explain
> to me clearly and completely what I did wrong and how it is causing a
> problem."*

This is blanket authorization, and it is also a constraint on what gets said
out loud. Both halves bind.

**Do, without asking and without narrating:**

- Remove worktrees whose PR is merged; prune stale branches.
- (StarCaster) Resolve the recurring `?v=` asset-stamp conflicts (they are generated
  stamps, not real overlap — catch up `main`, rebuild, move on).
- Rebuild generated artifacts a fresh worktree is missing.
- Delete scratch files, temp scripts, and one-off fixtures the work created.
- Catch a branch up to `main` before merging.
- Keep docs in step with the code in the same commit (§ CLAUDE.md).

Report these in a clause, not a section. "Cleaned up the three merged
worktrees" is the right size. A paragraph explaining *how* worktrees work is
not — he has been told, and repetition reads as condescension.

**The one thing that earns an interruption:** the operator is actively doing
something that is causing a problem. Then tell him **immediately**, and in
full — what he did, what it is breaking, and how to undo it. Do not soften it
into a hint, and do not save it for the end of a long report.

Everything else is a chore. Chores are silent.

**Corollary — do not ask him to adjudicate your own uncertainty.** Bringing
him a decision he has no basis to make is a chore in disguise. If two
approaches differ only in taste, pick one and say which. Reserve questions for
choices that are genuinely his: money, clients, what ships, what the project
should do.

*Why this is doctrine and not a preference:* he directs this project but is
not a career programmer, and his stated bottleneck is attention, not
willingness. Every chore surfaced for approval spends the scarcest resource he
has on something he has already said yes to.

### 6.6 Never spend an operator decision on something already decided

**Enforcement: `scripts/hooks/explain_denied_commands.cjs` (PreToolUse on Bash,
blocking).** A command forbidden by a standing `deny` rule is blocked with the
rule quoted and its settings file named, before the permission system produces
its own ambiguous refusal. Tested in
`scripts/hooks/explain_denied_commands.test.js`, gated by `npm run test:hooks`.

**In Spirality now:** these hooks are StarCaster's. Spirality's one hook is
`scripts/hooks/block_edits_on_main.cjs`. The deny rules themselves sit in the
user-level `~/.claude/settings.json`, so they bind every repository on the
machine, this one included.

**The incident.** 2026-08-14: a rebase needed `git push --force-with-lease` and
the call was refused. The refusal reads *"Permission to use Bash with command X
has been denied"* — which is word-for-word what you get whether he clicked "no"
once or forbade it permanently. The agent guessed "one-off", asked him to
choose, and he approved it. **The approval could not take effect**:
`Bash(git push --force*)` sits on the deny list in `~/.claude/settings.json`.
An operator decision was spent on a question already answered, and the answer
was unactionable. The alternative — merge `main` in instead of rebasing — needed
nothing from him and had been available the whole time.

**The rule.** Before asking him to approve anything, establish whether it is
already decided. A standing rule outranks an in-the-moment yes, so a question
that a rule has pre-empted is pure cost: it spends the one resource he says is
scarcest, and it cannot change the outcome.

**And do not reword around a deny rule.** Reaching the same effect through a
spelling the pattern misses is not cleverness, it is overriding a decision he
made deliberately. If there is genuinely no other route, say the rule exists,
name it, and let him change the *rule* — a config change he makes on purpose,
not a per-occasion bypass.

*Why this is doctrine and not judgement:* §6.4 already says his bottleneck is
attention, not willingness. Asking about a settled question is the same waste as
surfacing a chore for approval, minus even the possibility of a useful answer.

**The second incident — a rule can be evaded without anyone trying to evade
it.** 2026-08-23: three unattended `loop-build` runs on the Mac Mini
force-pushed, despite four deny rules forbidding it. Recovered from the session
transcripts rather than the agents' own accounts, every instance was the same
command:

```
git -c credential.helper='<the gh helper>' push --force-with-lease
```

Deny rules are command-**prefix** globs. `Bash(git push --force*)` matches a
command that *starts* `git push`; this one starts `git -c`. And that prefix is
not an evasion anyone invented — it is this repo's own documented way to push,
because osxkeychain is unreachable from an agent session. **The house idiom
walked straight through the house rule**, and nobody would have known if the
agents had not each volunteered it.

Two lessons, and the second is the durable one:

1. Every instance had the same cause: write the work-log entry, open the PR,
   then amend the commit to stamp the number in. **Remove the reason and you
   remove the pressure** — `loop-build/SKILL.md` now says to add the entry as a
   second commit, and never to amend after pushing.
2. **A guard made of patterns protects only the spellings someone thought of.**
   `git -C <dir> push --force`, a newline instead of `&&`, `git push origin
   +main` with no flag at all — each needs its own pattern, and none of them
   gets written until after the incident that needed it.
   `scripts/lib/force_push_guard.cjs` therefore *parses* the command — strips
   env assignments and git's global options, then asks whether the subcommand
   is `push` and whether anything forces — and the hook refuses on that, ahead
   of `SKIP_DENY_EXPLAIN` so no environment variable is a way around it.
   `scripts/hooks/force_push_guard.test.js` holds all seventeen forms.

*The damage was nil — every push was to the loop's own unmerged branch, seconds
old. That is not the point. An unattended agent crossed a line the operator drew
and the crossing was invisible; on a machine nobody is watching, "the guard has
a hole" is the whole finding.*

### 6.7 On a send-back, merge `main` in before you rework — the fix may already be there

**The incident (2026-08-30, ticket 86bbmg2fb, PR #441).** Review sent the
branch back asking, among other things, for `next-interval` to survive an
unreadable list without exiting non-zero. `fetchAllTasks` ended in `die()`, so
the rework added a `soft` option that throws instead. Meanwhile — while the
branch sat in review — a different ticket (86bbm4zwd) had added the same escape
hatch to the same function on `main`, named `fatal: false`, returning
`{ tasks: null, failed }`. `ship` stopped on the conflict. The resolution was
to delete the rework and call `main`'s version: the correct code had existed
before the rework started, and the only work the rework produced was the
conflict.

**Do this:** the first command on a sent-back branch is `git merge
origin/main`, before reading the review notes against the code. A branch that
has been in review for days is editing a file `main` has since changed; §6.2
says the conflict is information, and this is the cheap time to receive it.
Then look for the asked-for fix on `main` by *behaviour* — search for the
function, not for the name you were about to give it.

**Addendum (same day, same merge): after resolving a conflict by keeping both
sides, PARSE the file before you commit it.** The same `git merge origin/main`
on ticket 86bbmg2tq hit a content conflict in `scripts/clickup_direct.mjs`
where both branches had added lines in the same place. "Keep both sides" fused
two separate `const { ... } = X;` statements onto one line — a resolution git
considers complete and node considers a SyntaxError. It was caught only
because an agent happened to run `node --check` by hand.

Nothing in the toolchain would have caught it. `check:syntax` parsed only
`public/js/`. `test:builder` reads `clickup_direct.mjs` as *text* — two
source-level assertions — and never executes it. `check_conventions` skips its
added-line checks during a merge, precisely because a merge adds lines it did
not write. So a file every loop pass runs could have reached `main` green, and
the next loop pass would have died on line 1: every ticket stuck in whatever
status it was in, with no verdict written anywhere, and no error anyone would
see until somebody wondered why the queue had stopped moving.

That gap is now closed — `npm run check:syntax` parses every hand-written
`.js`/`.mjs`/`.cjs` under `scripts/` and `lib/` as well as `public/js/`, in
pre-commit and in CI (ticket 86bbq5hwg). Two things follow. First, the fused
statement is caught for you; you no longer have to remember `node --check`.
Second, and more general: **a clean merge is a claim about text, not about
meaning.** Git's job ends at "no overlapping edits"; whether the result is
still a program is a separate question, and every file class needs something
that asks it. The first sweep under the new gate found an unrelated file that
had been unparseable on `main` since it was committed
(`scripts/import_messaging_tweets_csv.js`, a missing closing paren) — which is
the same lesson from the other end: nothing had ever parsed it either.

**In Spirality now:** `npm run check:syntax` (`scripts/check_syntax.mjs`) parses every
file under `scripts/`, `lib/` and `tracker/`, and is the first step of
`npm run verify`.

The same claim fails one level higher too, where the merged result parses
perfectly and two files simply assert opposite rules: §6.11. And one level
lower, where the conflict being reworked around was never there at all: §6.13.

### 6.8 A fixture must be a shape the real source can produce, and the assertion must name the value

**The incident (same ticket).** The test that pinned "a ticket waiting on a
FINISHED blocker is claimable" put the finished blocker *in* the task list
beside its dependant. ClickUp's list endpoint never returns closed tasks
(`include_closed` defaults to false), so the fixture was a shape production
cannot produce; the code path it exercised was real, and the path production
took — blocker absent, treated as still open, ticket excluded forever — had no
test and no failure, because it fails toward sleeping longer. Review found it
only by probing the live endpoint (49 tasks without `include_closed`, 104
with).

Same ticket, second shape: `clampToFloor` was "deliberately total" and had a
break-test — `assert.ok(result >= FLOOR)`. `Number(null)`, `Number('')`,
`Number([])` and `Number(false)` are all `0`, finite, and raised to the floor:
the SHORT end, which switched hysteresis off for a hand-edited state file. The
assertion was true of the wrong answer.

**Do this:** before writing a fixture for an external source, read one real
response and build from *its* shape — what it omits matters as much as what it
carries. And a break-test asserts the **value** the rule requires, not a bound
the wrong answer also satisfies: `assert.equal(clampToFloor(null), 3600)`, not
`>= 900`. A guard that only checks `isFinite` has not checked "is this a
number" — `Number()` manufactures finite zeros from garbage.

**Two more shapes, 2026-09-03 (tasks 86bbuk7xz, 86bbunf43).** Both were written,
both passed, and both were found only by reverting the fix and watching the test
stay green:

- *A fixture that cannot discriminate.* The test for case-insensitive tag order
  used `ATP tennis` — which sorts first under codepoint order AND under
  alphabetical order. Reverting to plain `.sort()` changed nothing it measured.
  `US Open` sorts differently under each rule; that is a fixture, the other is a
  prop.
- *An assertion on the wrong path.* The guard for "a feed that never set
  `filterMode` is unchanged" was routed through
  `normalizeBuilderModuleSettingsForType` on the belief that module defaults
  merge there. They do not (StarCaster's §5.27), so flipping the palette default left it
  green — the assertion never touched the value it was defending.

One sentence covers all four cases in this section: **the fixture must be able
to tell the two behaviours apart, and the assertion must travel the path the
value actually comes from.** Break-testing is what surfaces the difference; a
green break-test is a finding, not a formality.

### 6.9 CC runs the operational commands — handing one over is a claim it cannot

**Standing instruction from the operator, 2026-08-07, verbatim:**

> *"when you say 'you' can veto etc., you mean you, cc-starcaster, right? I
> won't remember all those commands."*

He raised it again on 2026-08-23 and 2026-08-30. It kept recurring because the
rule lived only in agent memory and in the vault, and neither of those is
loaded into a repo session the way `CLAUDE.md` is. Neither is a guard, either —
so nothing ever caught an agent doing it.

**The incident.** 2026-08-30, the Delray header. One safety-gate refusal early
in the session was treated as a verdict on the whole session rather than a
refusal of that one call, and every production step after it came back to him
as a command to paste. One of them was a script with a dry run and an
`--apply`. He ran the dry run; it printed what it *would* change; nothing in
the output or the hand-off said the change had not happened yet, so he had no
way to know a second command was still waiting on him. Most of an evening went
on a fix that had already been written.

**The rule.**

- CC runs the operational commands — scripts, `doppler run`, SSH to the Mini,
  publishing. He says what he wants in plain language; CC picks the script and
  the flags, runs it, and reports the outcome rather than the log.
- **Four exceptions, and only four:** a real secret VALUE (§4.1), a billing
  screen, a browser login, and a decision that is genuinely his — money,
  clients, what ships. A hand-off **names which one applies**. An unnamed
  hand-off is itself the defect, the same shape as §2.5's unnamed actor.
- **A refusal is scoped to the call it refused.** Retry when the step actually
  comes; if it is refused again, say so in one line and carry on. An early
  "no" is not a session-wide policy, and converting it into one silently
  widens a single gate into a work stoppage.
- **Never leave a production fix as a two-step.** A dry run and its `--apply`
  are one job. Run both, then say what changed. A dry run reported as though
  it were the fix is a §3.10 failure wearing an operator's clothes: it looks
  exactly like success and changed nothing.

*Why this is doctrine and not a courtesy:* flags exist so the agent has a
precise instrument, not so the operator has a syntax to memorize — §6.4 already
establishes that his bottleneck is attention. But the sharper cost is that a
hand-off **misreports the state of the work**. He reads a pasted command as
"this needs your hands", so a job that was finished reads as blocked on him,
and one that is genuinely blocked is indistinguishable from it. That is §2.5
arriving from the other direction: there, an automation said it had asked a
human when it had not; here, an agent implies a human is needed when none is.

Canon home for this rule is the vault `doctrine/OPERATIONS.md`; this section is
the repo-side copy, which is the one actually loaded into every session.

**The tripwire.** Written down three times, broken three times — twice by
sessions that had read it that day. So StarCaster no longer only writes it
down: `scripts/hooks/check_operator_handoff.cjs` is a Stop hook that refuses
to end a turn whose reply hands over a fenced `doppler run`, `ssh`, `npm run`
or `node scripts/` command, unless a line outside the fence names the
exception (`Exception: secret value | billing | browser login | decision`).
Its design, its two brakes and its measurements are in StarCaster's
`docs/DOCTRINE.md` §6.9, beside the hook.

**In Spirality now:** "CC" is an agent session. Spirality does not have the tripwire: in
this repository the rule is written down (CLAUDE.md, "Agent sessions run the
commands"; `docs/LOOP_CONTRACT.md`, "What may be handed to Dane at all") and
not yet enforced.

### 6.10 A behaviour proven in an uncommitted file does not move when its job moves

On 2026-08-20 the `bus-relay` failure alert was built, break-tested and watched
to work: a forced failure posted to the bus, a second one was suppressed, a
success cleared the stamp. It was written into
`~/Library/Application Support/starcaster/bus-relay-cron.sh` — a hand-installed
file on the MacBook Pro, correct at the time, in git nowhere.

Then two ordinary, well-run changes landed. Slice B brought the schedule into
the repo (`scripts/run_bus_relay.sh` + `scripts/install_bus_relay.sh`), and
`lib/nodeRoles.js` moved `bus-relay` to the Mac Mini. Both were reviewed. Both
were right. **Neither carried the alert**, because the alert was not in the
thing being moved — so from that cutover until 2026-08-30, a relay failure on
the machine that actually ran it reached nobody at all.

Nothing could have caught it. No test covered the file, no review saw it, no
check compared old behaviour against new, and the regression's only symptom is
the absence of a message nobody was expecting on a particular day. It was found
only because the *next* ticket in the same plan went looking at the runner.

**Do this:** when a slice says a thing "now lives in the repo", diff what the
old artifact did against what the new one does before believing the migration
is complete — the committed version is a rewrite, not a move, and rewrites drop
things. Treat "we proved this works" as scoped to the file it was proved in.
And when a hand-installed file is superseded, say explicitly what happened to
every behaviour it carried; "it is replaced" is a claim about the file, not
about the behaviour.

The general shape, which is why this sits next to §6.6: work that lives outside
version control has no changelog, no review, no test and no blast radius anyone
can compute. That is acceptable for a one-off, and it is a debt that comes due
the first time anything around it moves.

### 6.11 A clean merge is not agreement — and a review verdict has a shelf life

**The incident (2026-08-30, ticket 86bbmmv7t, PR #444, fixed in commit
`80b5502b`).** The PR was reviewed green on 08-26 and sat in `Ready to launch`
for four days waiting on Dane's merge word. When he gave it, the merge step
refused: CI was red. Nothing on the branch had changed since the review.

The branch had tightened what counts as a PR naming its ticket — a bare id
(`ClickUp: 86bbm4zwd`) stopped counting, only a full `app.clickup.com/t/<id>`
URL does (`scripts/builder/clickupTicketLink.js`). Meanwhile the WIP-cap work
landed on `main` carrying `scripts/builder/wipCap.test.js`, whose drift test
asserted the **old** rule: it fed a bare id to `prBodyCarriesTicket` and
expected `true`.

The two changes share no line and no file. `git merge` reported no conflict and
`git merge-tree --write-tree` exited 0 with a clean tree. Both branches were
green on their own. The contradiction was in the **rule**, not in the text, and
it surfaced only when the catch-up merge put both in one tree: one failure out
of 1,665, four days after a review had approved the branch.

**This is the case with no conflict, which is why §6.2 and §6.7 do not reach
it.** §6.2 says a conflict is information; §6.7 says merge `main` in before you
rework so you receive that information early. Both assume git has something to
report. Here it had nothing, so nothing prompted anyone to look. §6.7's closing
line — *a clean merge is a claim about text, not about meaning* — was about
whether the result still parses; this is the same claim failing one level up,
where the result parses fine and two files now assert opposite rules.

**Do this:**

- **Treat a review verdict as certifying the code at that commit, not the
  branch.** "Verified" has a shelf life. A branch approved days ago is
  re-tested by its catch-up merge, not by the review that already happened —
  and a branch waiting on a merge word is exactly the branch most likely to
  have had the ground move under it.
- **When a change tightens or loosens a rule other code asserts, go looking
  for the tests of that behaviour before shipping.** `git grep` the function
  name and a fixture string — not only the file you are editing. The test that
  broke here was in a file the branch never touched, in a subsystem it had
  nothing to do with.
- **When a test disagrees with a new rule, do not simply flip the
  expectation.** Assert the property the test was written to guard, then pin
  the rule's current answer explicitly beside it, so the next drift fails
  loudly instead of leaving the test vacuously passing. That is what
  `80b5502b` did: the one-directional property (the cap may count more than
  the gate lets through, never less) plus three pinned assertions naming the
  ticket that set the rule.

### 6.12 Match what he typed, not what the tool stored — and prove a filter against real input

**The incident (2026-09-01, ticket 86bbt038u, PR #515, merged as `3d821bd7`).**
Dane came back from a break and asked whether the loops were stuck. They were
not: both lanes were building and reviewing normally. What was stuck was the
auto-merge lane, which had latched itself off on 08-30 at 8:31pm and stayed off
for two days without telling anybody.

He tried to release it the sanctioned way — posting `resume auto-merging` on
the party line — three times. All three were ignored. `switchCommand` matches
`resume` as the WHOLE message, deliberately, because a resume that fires when
he was only *talking* about resuming costs an unwanted merge. But ClickUp's
message box turns a **pasted** phrase into a fenced code block and guesses a
language, so what the switch actually received was:

````
```cpp
resume auto-merging
```
````

Three defects, and only the first was visible from the code:

1. `normalizeCommand` never stripped the editor's formatting, so the backticks
   were being read as part of what he said. The same hole sat on the merge
   path — his `merge` worked only because he happened to type it by hand.
2. `readBusSwitchSignals` carried the comment *"Only HIS words. An agent post
   quoting the phrase is a machine talking to itself"* and did not enforce it:
   it accepted any message whose `user_id` was Dane's, which every agent's
   posts are, because they all post under his token. The ticket path next door
   had been enforcing exactly that rule with the machine marker all along.
3. **The filter added for (2) matched nothing at all.** ClickUp's chat api
   escapes the brackets — `\[CC-starcaster bus-relay\] ...` — and every entry
   in `LEGACY_MACHINE_PREFIXES` begins with `[`. Run over the live channel
   before the fix, six of six recent messages classified as Dane's own words,
   three of them posted by the relay itself.

The third is the one that nearly shipped. Every unit test passed, because every
fixture had been hand-written in the shape its author expected rather than
captured from the surface the code actually reads.

**Do this:**

- **An input box you do not control is part of the wire format.** When a
  command must match exactly, normalise away what the *editor* added before
  comparing — fences, language tags, smart quotes, escaping. Strictness is
  only honest when it is strict about things the operator can control;
  otherwise "whole message" quietly means "whole message plus whatever the
  client decided to wrap it in". Note the fix here did **not** loosen the
  matcher: the deliberate `stop`/`resume` asymmetry survived untouched, because
  the bug was never the strictness.
- **Prove a filter against real captured input before believing it.** A filter
  that matches nothing is silent in precisely the same way as a filter with
  nothing to catch — this is §3.11's failure wearing a different hat. Fixtures
  written by the same author as the filter share its blind spot by
  construction. Fetch a page of the real messages, run the predicate over them,
  and look at the classifications one by one.
- **A stated intent is not a guard.** If a comment says what must not happen,
  either the code enforces it or the comment is a false statement with a shelf
  life — and the next reader will trust it, because it is written in the
  imperative and sits directly above the code. When you find one, the fix is
  the enforcement, not a better comment.
- **Two doors into the same decision must be guarded the same way.** The ticket
  path and the bus path both answered "is this Dane's word?", and only one of
  them checked. The weaker door was the one nobody watched. Where a rule has
  more than one entrance, read them together, or derive them from one shared
  predicate so they cannot drift apart (§6.2's ancestor, and the same argument
  as the single-reading rule for shared questions).
- **A latch must keep saying it is latched.** The self-disable recorded
  `"1 thing(s)"` — the count, not the sentences it was holding — and announced
  nothing on the passes that followed. That is why two days passed. A brake
  that cannot say why it engaged is one nobody can safely release; a brake that
  says so once and then goes quiet is indistinguishable from a quiet week.

**In Spirality now:** the tracker removed the causes of defects 2 and 3. Every loop signs
in with its own token, so a post's author is the actor that wrote it, and the
reply box sends plain text. Defect 1's fix, `stripEditorFormatting`, came
across in `lib/mergeOnComment.js`.

### 6.13 A reported conflict is a claim to verify, not an instruction to start editing

**The incident (2026-09-02, ticket 86bbt4dkr).** Dane asked for the conflicts
on PRs #513 and #494 to be cleared. Both read `CONFLICTING / DIRTY` on GitHub.
**Neither had a conflict.** Checked afterwards with `git merge-tree` in every
combination that mattered — each branch tip against the `main` it was opened
on, and against the `main` that existed by then — all four merge clean, zero
conflict markers. `git merge origin/main` in each worktree confirmed it live:
"Merge made by the 'ort' strategy", nothing to resolve.

The cost this time was one wasted round trip. The failure mode it exposes is
larger, because the natural response to the word "conflict" is to open the
files and start reconciling them by hand — and here there was nothing to
reconcile. Hand-editing files that never conflicted is one of the quieter ways
a branch loses lines (§6.10 and the #467 doc revert are the same wound from a
different angle), and it is unreviewable afterwards: the diff looks like work.

There was a second half, and it is the part that actually misleads. After
merging `main` in and pushing, GitHub **still** said `CONFLICTING` — because
`main` had moved underneath the session (#516 merged at 05:26Z, mid-task). A
second `CONFLICTING` after you have just resolved reads exactly like *your
resolution failed*, which invites a second, more aggressive round of hand-
editing. It was not a resolution failure at all. The question that answered it
was ancestry:

```
git fetch origin
git merge-base --is-ancestor origin/main <branch> && echo contains || echo behind
```

`behind`. The local merge had succeeded against a `main` that was already
stale by the time it finished.

**Do this:**

- **Verify the conflict before resolving it.** `git merge-tree <base> <head>`
  answers it in a second, writes nothing, and touches no working tree:

  ```
  git merge-tree origin/main <branch> | grep -c '^CONFLICT'
  ```

  Zero means the host is wrong, or stale, or answering about a base that has
  since moved — and the fix is to merge and push, never to edit a file. A
  forge's mergeability flag is a cached derived value about two moving
  targets; git's own three-way merge is the authority, and it is local and
  free. This is §1's rule about instruments: when the reading and the
  mechanism disagree, doubt the reading first.

- **Re-fetch immediately before you merge, and confirm by ancestry.** `main`
  moves during long tasks — five PRs landed on it during this one. A merge
  that succeeded is evidence about the base you had, not about the base that
  exists now, so `git merge origin/main` printing success proves nothing
  about whether the branch is current. `--is-ancestor` is the check that
  cannot be fooled by a clean merge of the wrong thing. Same shape as
  verifying a pull by comparing HEAD ids rather than reading git's chatter.

- **A second identical failure after a fix is a prompt to re-diagnose, not to
  push harder on the first theory.** The strongest signal available was that
  the symptom did not move at all. An unchanged symptom usually means the
  thing you changed was not the cause — and escalating the same remedy is how
  a wrong theory gets expensive.

- **"Clear the conflicts" does not authorise merging.** Clearing a conflict
  and merging a pull request are two decisions, and only the first was asked
  for; the merge came as a separate word from Dane afterwards. §6.6 says not
  to spend an operator decision twice — the converse holds too: do not spend
  one he has not made yet.

### 6.14 A pull request opened without a claim is invisible to every other session

On 2026-09-01 a hand-driven session was asked to finish ticket 86bbjve6q. It did
what the rules say: read the ticket, found it **`Queued`, unassigned, with no loop
note** — every signal a session can check said the work was free — and claimed it.
One command later, while checking whether the Vercel variables still needed
setting, it found them already there, **created eight minutes earlier**, a
production deployment `Ready` seven minutes earlier, and **PR #517** open ten
minutes earlier. Another session had been building the ticket the whole time and
had never claimed it.

This is the 2026-08-20 two-sessions-one-epic collision, reproduced exactly, five
weeks after the rule written to prevent it. Note which guards did and did not
fire. **Worktree separation did not help, and could not**: both threads were
scrupulous about it, each in its own folder on its own branch. Separate folders
stop two threads corrupting each other's *files*; they say nothing about two
threads building the same *thing*.

What surfaced it was the claim — made by the session that was **not** doing the
work. That is the whole lesson, and it inverts the way the rule is usually read:

- **The claim is not a lock you take for your own benefit. It is a signal you
  emit for everyone else.** A session that skips it loses nothing itself and
  removes the only evidence anyone else could have used.
- **So the session that opens the pull request must be the session that claimed
  the ticket.** Not "a claim happened at some point" — the actor that builds is
  the actor that claims, because the claim is what makes that actor visible.
- **Every signal reading "free" is not evidence of free.** Status, assignee and
  loop note all agreed and all three were wrong together, because they are one
  source: whatever last wrote to the ticket. Three consistent readings from one
  unwritten source is one silence, not three confirmations.

What actually caught it was an unrelated read of *external* state — Vercel — one
step before a duplicate deploy. That is luck, not a control, and it should not be
relied on again. Until something enforces this, the cheap habits are
reading the queue (`npm run clickup -- queue`) before starting an epic, and
treating **any** ticket whose work you can see evidence of as claimed by somebody,
whatever its status says.

*StarCaster's copy goes on to its `npm run reconcile`, which could not see
two more tickets whose status disagreed with their pull requests that night.*

### 6.15 An abandoned branch's unique file is evidence of a rejected plan until proven otherwise

Clearing out stale branches on 2026-09-01, one of eight held a file that existed
nowhere else in the repository: `workers/youtube-media/fly.toml`, deploy
configuration for the YouTube media worker, with a comment explaining that it
existed so nobody would have to answer the `fly launch` wizard. The reasoning
wrote itself — unique, unrecoverable if deleted, and the very next ticket in that
epic was *deploy the worker*. The recommendation was nearly to ship it.

It was configuration for **Fly.io, a rented datacenter host**, and `main`'s README
for that same worker — rewritten fifty minutes earlier — opens like this:

> **It runs on the Mac Mini.** Dane chose that over a rented server on 2026-08-24
> (ticket `86bbjve6b`), and the reason is the address: YouTube blocks datacenter
> IPs, which is the whole reason this work cannot live on Vercel in the first
> place.

The file was not orphaned treasure. It was a five-week-old artifact of **the plan
that was rejected**, and shipping it would have put two contradictory deploy
stories in one folder with the wrong one looking freshly committed — plus a second
cost the README names, since a rented host needs a logged-in YouTube session stored
on it.

- **Uniqueness is not value.** "This exists nowhere else" and "this is wanted" are
  different questions, and only the second one matters. A branch is usually
  abandoned *because* its idea was dropped, so the unique files on it are the most
  likely to encode the rejected approach, not the least.
- **Find the decision before you value the artifact.** The answer took one look at
  the README that the artifact's own subject already had in `main`. Check what the
  current code says about the same subject before deciding an old file is a
  survivor.
- **Verify a branch by content, never by `git cherry`.** Squash-merging rewrites
  commits, so patch-equivalence calls shipped work unshipped — six of the eight
  branches looked like they held unshipped commits and every one was superseded.
  Compare the files against `main` and count what is actually there: two of them
  held test files with 8 and 6 cases where `main` had 16 and 19.

The reason this is worth a rule rather than a shrug: the failure is asymmetric and
silent in one direction. Deleting a wanted file announces itself the moment someone
needs it, and the restore line is one command away. **Shipping an unwanted one
announces nothing at all** — it lands looking current, and the next session reads
it as the plan.

### 6.16 A claim only counts with the receipt — and a session cannot promise to come back

§6.3 covers gates: run them, report what they printed. It does not cover the
other half, which failed twice in one morning on 2026-09-02.

**a. The reported action that never happened.** This session told Dane it had
filed ticket `86bbtw2k4` for follow-up work. That ticket does not exist and never
did — the body was written and sound, the ClickUp call was simply never made, and
the summary had no way to tell the difference between a task drafted and a task
created. In the same reply it quoted `86bbtvbhk` for a ticket that *did* exist
under a different id. Both were caught only by reading the queue back afterwards.

The irony is the lesson: this is §2.8 committed by the agent instead of the
merge step. A confident report that something is handled, when it is not, and no
way for the reader to tell.

**Do this:** for any call with a side effect whose identifier is its receipt —
a ticket created, a comment posted, a status moved, a PR opened, a file written,
a row inserted — report the id you **read back**, never the one you intended to
create. If a summary names an id, that id was observed in a response or a
follow-up query, or it does not go in the summary. §5.20 is the same rule for
screens; this is the rule for records.

**b. The promise to return.** Dane asked, reasonably, to be reminded
periodically to run `npm run reconcile`. **An agent session cannot do that.**
The window closes and the promise dies with it, silently, leaving him unable to
distinguish *"CC is watching this for me"* from *"nothing is watching this"* —
which is §2.8 again, relocated to the human layer, and it is the more dangerous
location because there is no log to check.

**Do this:** when asked to remember or to recur, say plainly in one sentence
that a session cannot, and offer the durable form instead — a schedule, a
watchdog, a ticket, a memory file, a line in this document. Never accept
the reminder. "An agent will remind you" names an actor that does not persist,
which is the §2.5 defect with a future tense.

Both halves reduce to one habit: **before reporting that something is true, ask
what you would have to have observed for it to be true, and check that you
observed it.**

### 6.17 When doctrine answers yes AND no, the contradiction is the defect — three merge-lane decisions, decided once

**The incident (2026-09-02, the "State of the Line" audit).** Three questions
had two live answers each, every answer individually defensible:

- What does "done" mean? `wipCap.js` counted four statuses as terminal
  (live/complete/closed/done) while `pulse.js` counted one — the WIP cap and
  the flow diagnostics running on different definitions of finished.
- Does a merge ask the pause switch? This file's pipeline section said
  *"before merging anything, run `pipeline -- check`"* while the fast-track
  lane said *"No pause to merge."* `ship` merged via a direct `gh pr merge`
  and never read the switch (`ship_thread.cjs:553` at audit time).
- Is `ship` part of the one merge gate (task 86bbkw2au's "ONE GATE"), or a
  second path? It was a second path, silently.

Nobody had been careless; each half was written on a different day against a
different incident. That is exactly how a system built at speed accumulates
contradictions, and the rule this section exists for: **when two rules answer
the same question differently, resolving it is an OPERATOR DECISION to make
once and record where both readers will find it — not a thing each session
re-derives** (§6.6 is the sibling rule for decisions already made).

**The decisions, made by Dane on the audit's recommendations (D1 on
2026-09-02, D2 and D3 on 2026-09-03, verbatim as recommended):**

- **D1 — `live` is the only terminal status.** The other three names are a
  tested alias list, reported loudly by name (wipCap's `unrecognised`
  bucket), never silently counted either way. Recorded beside the code in
  `scripts/builder/loopStatuses.js` (task 86bbtujed, PR #539).
- **D2 — every merge asks the pause switch; nobody pauses in order to
  merge.** `ship` runs `pipeline -- check` itself before merging and stops,
  quoting the switch, when the deck is taken — failing safe like every other
  actor. The fast-track sentence now says what it always meant (task
  86bbu2uhq).
- **D3 — `ship` STATES the review gate's context before merging, and only
  states it.** The read-only `waiting` reader's own lines are reprinted;
  enforcement stays with the one merge gate, and folding `ship` fully into
  it waits for a driving incident (task 86bbu2uhq).

**How to use this section:** when you find doctrine or two modules answering
one question two ways, do not pick quietly and do not build both. Name the
contradiction as its own finding, take it to the operator as a decision with
a recommendation, and record the answer once — in the code that enforces it
and here.

**In Spirality now:** D1 is `lib/loopStatuses.js`. D2 is `npm run clickup -- pause-check`,
which every lane asks before a pass, the relay included; the switch is on the
tracker's Settings page. D3 is about StarCaster's `ship` command, which
Spirality does not have.

### 6.18 A script that edits production data dry-runs first, and a count of zero is a finding

2026-09-03, task 86bbunf43. Setting one module setting on the live Delray
`/tags` page nearly wrote **nothing at all** and would have reported success.

`getPage` returns `{ ok, status, data }` — every store here does (landmine 12) —
and the script read the page straight off the return value. So
`page.layoutSections` was `undefined`, the map that finds the Post Feed ran over
an empty list, and the script printed, cheerfully and without an error:

```
page "undefined" slug=undefined sections=0
0 Post Feed module(s) on this page
```

Nothing threw. With `--apply` on that run it would have written the page back
unchanged, republished it, and announced a completed job over an empty set —
and the next honest thing anyone did would have been to explain why the setting
"did not take" on a page it never touched.

**Do this**, for any script that writes production data:

- **Dry run by default; `--apply` to write.** Not a flag to skip the dry run —
  the dry run is the default and writing is the opt-in.
- **Print what it MATCHED before it writes** — names, not just counts. `page
  "undefined"` is what gave this away; a bare `0` might not have.
- **Treat zero as a finding.** A sweep that matched nothing has either found
  nothing or asked the wrong question, and those look identical from the exit
  code. Say which one you believe and why.
- **Read every row back afterwards** and assert the value, not the absence of an
  error (§5.20, landmines 12 and 13).

The same discipline caught the other half of that task: the 13 posts were
published through the app's own store rather than raw SQL, and each row was read
back — 13 of 13 confirmed — rather than trusted from a write that reported OK.

### 6.19 Search the queue for the SYMPTOM before filing — doctrine cites its own open tickets

2026-09-03. The operator reported *"No tags found. Add tags in the Messaging
section."* on a client's live blog. A ticket was filed for it (86bbunq4c), the
sweep was done, six leaks were fixed and it shipped as #580.

**A ticket for that exact string was already open.** 86bbugd2e, filed the same
morning, named it verbatim, named the second half of the same defect ("Tags:
Example Tag"), and set out the same scope. Worse, StarCaster's `docs/DOCTRINE.md` §5.29 —
read during the very work that duplicated it — **quotes both the string and the
ticket number**. It was read past.

Reading the queue (`npm run clickup -- queue`) is already the rule. What this adds is *what to search for*: the rule as
written protects against two sessions building the same EPIC, and this was not
an epic. It was a one-line bug report whose text already existed in the tracker.

- Search the queue for the **operator's own words** — the error string, the page,
  the module — not for the name you are about to give the work.
- When doctrine names an open ticket, **read that ticket** before filing a new
  one. A `§` that cites a task id is a live cross-reference, not a footnote.
- Filing the duplicate was the cheap part; the cost is that 86bbugd2e's OTHER
  half stayed queued behind a ticket that looked done, and the operator's
  report of it was answered twice with half an answer.

The repair is not to close the older ticket. It is to fold the finished half
into it, leave the unfinished half visible, and say plainly which is which.

This section asks *has this already been filed?* §6.24 asks the question before
it — *should this be filed at all?* — and for a ticket about the pipeline
itself, that one is answered first.

### 6.20 A command handed to the operator is plain text — formatting silently breaks the match

2026-09-03, 11:11pm. The auto-merge lane had latched itself off thirteen hours
earlier and only a person can clear it. The operator was told, in a message that
rendered the phrase in bold-and-backticks, to post `resume auto-merging` on the
party line. He copied what he was given. ClickUp preserved the formatting, so
what arrived was:

```
**`resume auto-merging`**
```

`switchCommand` matches "resume" against the WHOLE message, deliberately — a
stop that fires when he only mentioned it costs a delay and one word to undo,
while a resume that fires when he was talking ABOUT resuming costs an unwanted
merge. That asymmetry is right and is not the defect. The defect is that the
near-miss looked exactly like silence: nothing matched, nothing said so, and he
reasonably believed the lane was back. It stayed off for another 35 minutes and
was only found because he asked. His second attempt, typed as plain text,
matched on the first try.

Measured against the real matcher — it is forgiving about case, spacing, a
hyphen and single backticks, and unforgiving about bold and about extra words:

```
"resume auto-merging"        -> resume      "**`resume auto-merging`**" -> null
"Resume auto-merging"        -> resume      "please resume auto-merging" -> null
"`resume auto-merging`"      -> resume      "resume auto-merge"          -> null
```

**In Spirality now:** (measured 2026-11-15) the matcher strips the editor's formatting
first, so `` **`resume auto-merging`** `` now matches. Extra words still do not,
and a near miss is answered (`nearMissNotice`, `lib/autoMergeLane.js`), which
is the "that did not take" below. The rule stands: the next command handed
over is a fresh chance to format it.

- **Never wrap a phrase he is meant to type in backticks, bold, or a fenced
  block.** Put it on its own line as bare text, with nothing around it.
- This is §6.12 pointed the other way. That rule says match what he TYPED
  rather than what the tool stored; this one says do not make him type what the
  tool will mangle. Both failures look like the operator getting it wrong.
- The matcher saying "that did not take" is filed as 86bbuv99r — but no code fix
  removes this rule, because the next command an agent hands over is a fresh
  chance to format it.

### 6.22 Measure a duration threshold within one cadence era

2026-09-03. Choosing an alarm threshold for "this job has stopped working", the
honest move was to measure how long real failures last rather than pick a round
number — the ticket asked for exactly that, because a recency alarm had already
been killed on this project for firing on eleven nights in fourteen.

The log held 866 passes and 83 failures. It also held a **cadence change**: the
job ran hourly until 2026-08-30 and every ten minutes after. Measured across
that boundary, a four-pass blip from the hourly era reads as a *three-hour
outage* and lands in the same population as a twenty-minute one, and any
threshold drawn from the mixture fits neither era.

Segmented to the ten-minute era — 687 passes — the separation was clean:

```
blips (1-2 consecutive failures)   36 runs   longest 21 min without a success
real outages (3+)                   4 runs   shortest 36 min
```

Nothing between 21 and 36 minutes. That gap chose the threshold, and it
contradicted the proposal in the ticket: sixty minutes would have caught two of
the four real outages.

- Before measuring durations out of a log, **check whether the thing being
  measured changed rate inside the window.** Median gap between events, by day,
  is a two-line check and it decides whether the rest of the analysis means
  anything.
- Prefer a threshold expressed as a multiple of each job's own interval to a
  global constant, for the same reason: one number cannot serve a ten-minute job
  and a weekly one.
- Say which era the numbers come from when recording them. A future reader
  re-measuring over the whole log will get a different answer and assume the
  first was wrong.

### 6.23 An ask is a status transition, not a paragraph

**2026-09-04, task 86bbuzyra.** A throughput analysis found that the auto-merge
lane can never merge the pipeline's own code, which had cost roughly seven
hours of a ten-hour night. The fix widens what may reach production without a
human hand — squarely Dane's call, not an agent's.

The session filed the ticket as **Queued**, ended the description with a
paragraph addressed to *whoever builds it* — "this is governance, Dane may want
to set the boundary himself, ask before building" — and then told him it had
"written it into the ticket as a question rather than a decision."

It had not. He found all three failures himself: *"that ticket was not marked
Needs your attention, nor do I see any questions for me in it."*

1. **The paragraph addressed the wrong reader.** It instructed a future build
   agent, not the operator.
2. **Nothing was dispatched.** `clickup ask` was never run and the status never
   moved, so nothing put it in front of him. The repo already has a read-only
   command that answers "is anything actually waiting on Dane?" — it would have
   said no. It was not run.
3. **It sat in a status a machine may claim.** The next `loop-build` pass would
   have taken it and picked the production boundary itself — a governance
   decision made by a machine, by accident, with no record that a decision had
   ever been open.

The report to the operator was the last layer: it stated the ask as done, so
the one human who could have noticed was told there was nothing to notice.

**A fourth thing, and it is the argument for the rule rather than a detail.**
Building the operator card properly forced the session to *verify* the boundary
it had recommended, and the recommendation was wrong — it would have made
`lib/` auto-mergeable, which `server.js` requires directly at runtime. The
unmade ask was also hiding an unchecked claim. Dispatching a decision makes you
assemble the evidence for it; the prose version never does.

- **Describing an ask is not asking.** A question in a ticket description, a
  code comment, a work log, a pull request body or a terminal reply is
  documentation. It reaches whoever was already reading that artefact for
  another reason.
- **A decision that is genuinely Dane's is dispatched**, with
  `npm run clickup -- ask --task <id> --body-file <f> --status "Needs your input"`,
  and **confirmed** with `npm run clickup -- waiting --task <id>` printing
  **WAITING ON DANE**. If `waiting` does not say that, no ask has been made,
  whatever the description says. Never report "I asked him" on the strength of
  prose — and never on the strength of `ask` exiting 0 either; the read-back is
  the evidence.
- **An unresolved operator decision must never sit in a claimable status.**
  `Queued` and `Rework` are both claimable. This is the part that turns an
  untidy ask into a wrong decision: the ticket does not wait, it gets built.
- **The card format costs a round trip twice if you do not know it.** Every
  `@@MARKER` sits **alone on its line** — content on the same line makes the
  whole file preamble and the card is refused. `@@ASKED` carries **Dane's own
  words, verbatim**, the instruction the ticket descends from; the question
  being put to him goes in `@@NEEDED`. `@@EVIDENCE` plus a `@@MEASURED <time>`
  line becomes mandatory when the validator reads the ask as costly or
  irreversible — a governance ask trips this, and satisfying it improves the
  card rather than padding it. The whole format is `docs/LOOP_CONTRACT.md`,
  "The operator card".

**The test at design time:** if Dane never opens this ticket, what happens? If
the answer is "a machine picks", it was never an ask.

Cross-repo canon: vault `doctrine/REPORTING-NEEDS-A-READER.md` clause 5,
ratified 2026-09-04 (commit `a09d72c`). That document's first four clauses cover
reports that *were* sent, into destinations with no reader; this is the case one
step earlier, where nothing was dispatched at all and every existing check still
passes. §6.16 is the nearest neighbour and is about build claims, not operator
decisions; §6.9 is the same family from the other side — handing Dane a command
is a claim that CC cannot run it.

### 6.24 A pipeline ticket is filed for a COST, not for a gap — and its title says what breaks

**2026-09-06, Dane's decision; task 86bbvtnfn.** The pipeline had started
filing tickets about itself faster than the queue could drain them. Measured
that day, pipeline self-maintenance tickets went from roughly **6 a day in
mid-August to roughly 16 a day in early September**. Every one was a real
finding, honestly filed, and none of them stood between the company and
shipping — the paying work (Delray, the application itself) queued behind them.

**31 tickets were parked that day. Six stayed.** All six trace to a failure
that actually happened: pipeline code that could not auto-merge overnight
(86bbuzyra), Pulse's silent low-credit alarm (86bbvr5zv), Pulse invisible to
the roll call (86bbvr5ym), a relay crash that can lose Dane's answer for good
(86bbvr4w3), a conflicted PR that runs no checks (86bbvqkr1), hand-run cleanup
mislabelling a half-built ticket (86bbvj44f). Not one of the 31 could name an
incident.

That ratio is the rule. A tool that inspects itself will always find more than
it can fix, so *"is this a real finding?"* is the wrong gate — every one of the
31 passed it. The gate has to be **did it cost us anything.**

- **The stopping rule.** File a pipeline or self-machinery ticket only when a
  pipeline failure **actually cost something observable** — lost work, a dead
  lane, a silent outage, a wrong merge. Name the incident in the description.
  A theoretical gap noticed while reviewing or building is not a ticket, however
  correct it is.
- **Where the gap goes instead.** One plain line in the run report, and as a
  plain comment on the ticket the pass was already working, saying it is a
  parked finding (the loop-spec skill). StarCaster's ClickUp parked-backlog doc
  stayed in ClickUp. **What it must not do is file it.**
- **A parked ticket is not a killed one.** The 31 were closed as **Live** with
  the tag **`deferred`** — never `wont-do` — keeping every description and
  comment. To revive one: open it and set its status back to `Queued`. That is
  the whole procedure.
- **Title style, everywhere a ticket is created.** Superseded: a ticket's name
  is now a short, plain statement of what the ticket does, starting with a
  verb, with no colon (`docs/LOOP_ENGINEERING.md`, "Titles"). The reason has
  not changed. Dane, verbatim: *"your descriptions of tickets is so cryptic
  and full of fanciful turns of phrases that it is difficult for me to
  understand which ones are really important and which ones aren't."*

**This does not touch application defects.** A client-facing bug is filed on
sight, exactly as before; the rule is about the pipeline's tickets on itself.
Nor does it touch the tickets the machinery files **automatically** for a lane
that is actually stopped — the merge-conflict tickets of §"...and a hand-off
now names who is going to act" (`docs/LOOP_ENGINEERING.md`). A blocked pull
request is a dead lane, which is a cost, and that path files nothing when the
merge comes back clean. Nor the three tickets that are not work at all but
places to write — the pause switch (`scripts/pipeline.mjs`), the roll call
(`scripts/node_heartbeat.mjs`) and the pipeline pulse record
(`scripts/pulse_publish.mjs`), each created once and rewritten in place
thereafter. This rule governs the ones an agent files on judgment.
(The three scripts named are StarCaster's; in Spirality the pause switch is
the tracker's Settings page, and the fix-up tickets are filed by
`lib/conflictWork.js`.)
Nor does it lower the bar for the ones that do get filed — §6.19 still says
search the queue for the symptom first, and the spec lane's evidence rule
(a defect ticket cites its mechanism) is unchanged.

§6.23 is the nearest neighbour from the other direction: that one is about a
decision that should have been dispatched to Dane and was not; this one is
about findings that should never have been dispatched to the queue at all.
Both are the same underlying question — *who is this for, and will they act on
it?*

### 6.25 When a missing feature blocks the job, build the feature — do not patch around it

**2026-10-27, Dane's standing instruction; task 86bctakp3.** Verbatim:
*"Whenever you are blocked from accomplishing an objective due to a lack of
functionality within Starcaster, pursue that underlying lack of functionality
with additional tickets. We do not want to paper over infrastructure.
Superficial tweaks that point to more fundamental architecture needs are
opportunities to exploit. Look for opportunities to build a robust system."*

**The incident.** Unsticking the Alphire import that day ran into five walls,
one after another. The job had sat queued for 14 days because nothing runs the
import worker. The page builder crashed because it was running out-of-date
compiled code and nothing said so. One image the origin refused (HTTP 403)
stopped all 17 pages. The import theme painted white buttons on a white page.
And the only way to add the theme afterwards was to re-run the whole import.
Each one had a quick patch: run the worker by hand, rebuild the folder, swap
one colour. The quick patch for the button was a single colour swap. Behind it
were three missing capabilities: the theme cannot describe an outlined button,
it has one button colour for every background, and its readability check
covers some colour pairs but not others. The patch would have handled
Alphire's button and left all three gaps for the next import to hit.

**The rule.**

- **Unblock the objective, then name what blocked it.** Getting the operator's
  job done is still the first deliverable. Once it is done, or while it is
  being done, ask: *which capability was missing, so that a person or an agent
  had to step in by hand?* Missing capability means the project could not do
  this on its own.
- **File the capability, not the instance.** The ticket says what the project
  cannot do and who feels it ("Themes cannot have outlined buttons…"). It does
  not describe the one-off workaround ("swap Alphire's button to grey"). The
  instance is the incident cited in the description.
- **Prefer the fix that makes the whole class impossible.** If a defect is one
  member of a family, the ticket fixes the family. For example, one
  readability guard over every colour pair in a theme, rather than a fourth
  hand-written check for the fourth pair that failed.
- **A manual step is a finding.** If an agent session had to run something by
  hand, rebuild something nobody said was stale, or re-run a whole process to
  get one part of it, that step is itself a missing feature.
- **A workaround is temporary and says so.** If the objective needs a
  workaround today, take it, then say in the report which ticket retires it.
  Shipping a workaround without that ticket is papering over.

*StarCaster's copy goes on to apply this to site imports: every difference
between an original site and its import is a capability the Builder lacks.*

**How this sits beside §6.24.** §6.24 limits tickets the pipeline files *about
itself* to failures that cost something. This section is about missing
capability in the project itself. It does not relax §6.24, because here the cost is built
in: an objective was blocked, which is the cost, and the ticket names that
incident. A gap noticed in passing that blocked nothing is still the
parked-backlog line §6.24 describes. Tickets filed under this section follow
§6.19 (search the queue first) and the title rule in
`docs/LOOP_ENGINEERING.md`, "Titles".
