# The loop contract

This is the one written statement of how a ticket moves through the
development loop that builds StarCaster, WaveCenter and Spirality. Each
product links here instead of restating it. If a product's own docs and this
file disagree, this file is right and the product's docs are a bug.

Every rule below was checked against StarCaster's code as of 2026-10-11:
`scripts/builder/loopStatuses.js`, `machineComment.js`, `operatorCard.js`,
`costlyAsk.js`, `mergeOnComment.js`, `waitingOnOperator.js`, `loopTrail.js`,
`sendBackRounds.js`, `busRelayPlan.js` and `scripts/clickup_direct.mjs`. Where
a rule exists because something went wrong, the incident is named with its
date, so the next person to want to "simplify" it can see what it costs.

## The words used here

- **Ticket**: one piece of work, a task in a product's **Loop Queue** list in
  ClickUp.
- **Loop**: an agent session that runs one step of the work on a timer.
  There are three: `loop-spec` writes tickets (run by hand, with Dane),
  `loop-build` turns a ticket into a pull request, `loop-review` checks that
  pull request independently.
- **Pull request (PR)**: the proposed code change on GitHub, waiting to be
  merged into `main`.
- **The operator**: Dane. The only person who decides what ships.
- **The machine**: any loop, script or relay. Never a person.
- **The relay**: StarCaster's `bus-relay` pass, which runs every few minutes,
  reads Dane's comments on tickets in his two statuses and carries out what
  they say. Spirality and WaveCenter do not run one yet.

## The seven statuses

Every ticket is in exactly one of these, shown here in board order:

| Status | What it means | Whose move |
|---|---|---|
| `Rework` | review sent it back; a branch, an open PR and review notes already exist | machine |
| `Queued` | waiting for a build loop to pick it up | machine |
| `Building` | a build loop has claimed it and is writing the code | machine |
| `In review` | the PR is open and waiting for, or getting, an independent review | machine |
| **`Needs your input`** | a loop has stopped and asked Dane a question only he can settle | **Dane** |
| **`Ready to launch`** | built, independently reviewed, green; waiting for Dane's word to merge | **Dane** |
| `Live` | merged and shipped (or deliberately closed); out of the open view | nobody |

The two in bold are **Dane's statuses** and ask different things of him:
`Needs your input` wants an **answer**, `Ready to launch` wants a **yes**.
On a normal day he can ignore the other five.

Three facts about the list itself:

- `Live` must be a **closed-type** status in ClickUp, not merely the last
  one. That is what makes finished work leave the open view.
- `Live` is the **only** finished status (Dane's decision, 2026-09-02).
  `complete`, `closed` and `done` are not synonyms; a ticket wearing one of
  them is reported by name as unrecognised. Before that decision two parts of
  StarCaster disagreed about what "done" meant, four names against one, and
  both were steering the loop at once.
- There is no `Won't do` status. A ticket that is not going to be built is
  closed as `Live` with the `wont-do` tag and a comment saying what was
  decided. A real finding not worth a slot is tagged `deferred` instead.

### Why `Rework` is its own status (2026-08-31)

A send-back used to return to `Queued`, where it looked exactly like work
nobody had started. "52 queued" read as 52 fresh tickets when six were
half-built with open PRs; send-backs lost their place in line, so
normal-priority rework never beat fresh high-priority work (#419, #446, #447
and #449 went stale that way); and the work-in-progress count lied. Dane
named the status: "Recycle" was rejected because recycling loses the thing's
form, and here the branch, PR and notes all survive.

## Who may move a ticket, and how

Every move goes through the product's ClickUp script
(`npm run clickup -- <command>`), never the claude.ai ClickUp connector and
never the ClickUp web page, because the script is the only door with the
checks on it. Every write is read back before the command reports success.

| From | To | Who | How, and what has to be true |
|---|---|---|---|
| `Rework` or `Queued` | `Building` | loop-build | `claim`. It reads the ticket's own status and refuses to write (exit 3) if the ticket has moved since. |
| `Building` | `In review` | loop-build | Only after the PR is open, its body links the ticket, and `pr-opened` has recorded it on the ticket (see "Markers"). |
| `Building` | `Needs your input` | loop-build | `ask`, with an operator card. Used when the gates fail and the fix is out of scope, the ticket is too vague, or the work is too big for one pass. |
| `In review` | `Ready to launch` | loop-review | `verdict --pass --if-status "In review"`, then `ask --status "Ready to launch"`. `ask` refuses unless the newest review verdict on the ticket is a PASS. |
| `In review` | `Rework` | loop-review | `verdict --fail --if-status "In review"`, then `status --status Rework --if-status "In review"`. |
| `In review` | `Needs your input` | loop-review | `ask`. Required instead of a fourth send-back (see "Four rounds, then ask"). |
| `Needs your input` | `Queued`, `Rework` or `Live` | Dane, by replying | The relay moves it on his reply. Where it goes depends on the ticket's PR: none, or closed unmerged → `Queued`; still open → `Rework`; already merged → `Live`. A reply that is a close phrase ("close it") → `Live`. If the PR's state cannot be read, nothing moves. |
| `Ready to launch` | `Live` | Dane, by a merge phrase | The relay merges the PR and closes the ticket, after re-checking every gate (see "Merge phrases"). |
| any | `Live` + `wont-do` tag | Dane's decision | Killing a ticket. |

Four rules sit over that table:

1. **Only `ask` may put a ticket into `Needs your input` or `Ready to
   launch`.** `status` refuses both. Since 2026-08-22, when two tickets
   reached `Ready to launch` with no passing review and Dane approved both in
   good faith, `ask` also refuses `Ready to launch` without a PASS verdict.
2. **No loop takes a ticket out of Dane's two statuses.** Once it is handed
   to him it stays handed to him until he acts. A loop that could quietly
   reclaim its own escalation would defeat the checkpoint. His reply is him
   acting; the relay is only his hands.
3. **No loop moves a ticket into `Live`.** Only a merge Dane authorized, or
   his own decision to close it, does.
4. **A pass never ends with its ticket in `Building`.** No loop claims from
   `Building`, so a ticket left there is unreachable, not late. Before a build
   pass reports, its ticket is in `In review`, handed back to `Rework` or
   `Queued` with a comment saying why, or escalated with `ask`.

### Assignment is the handoff signal

Moving a ticket into one of Dane's statuses **assigns Dane**. Moving it into
any machine status **clears every assignee**. `status` and `ask` both do this
themselves and verify it stuck. Dane's one view is ClickUp's "Assigned to
me", which works across every product's space; a ticket in his status but
not assigned to him is invisible to him, and is treated as a defect, not a
cosmetic slip.

### The claim order

loop-build takes **every `Rework` ticket before any `Queued` one**:

- `Rework`: oldest first, **priority ignored**. Priority says what to
  *start*; rework is not started, it is finished. Ordering it by priority
  recreated the same starvation one tier down.
- `Queued`: priority first (urgent, high, normal, low; anything else last),
  then oldest first.

`npm run clickup -- queue --claimable` prints them in exactly that order;
the first line is the one to take. A `Rework` ticket is finished on its
existing branch and PR, never on a second one.

### Two passes, one ticket (2026-08-22)

Claiming is check-then-act: read the status, compare, write. That is only
safe because every claim and every verdict names the status it expects
(`--if-status`) and refuses, writing nothing, if the ticket has moved. On
2026-08-22 at 3:41am two review passes checked the same PR at once; the
slower one, working from a 25-minute-old snapshot, wrote `Ready to launch`
over the faster one's FAIL and over a fresh `Building` claim. Since then a
review **claims its ticket visibly before checking anything**, by setting the
Loop note to `🔍 being checked — a review pass started <date> <time>`, and
`verdict` refuses to run without `--if-status "In review"`.

### Four rounds, then ask (2026-08-25)

A ticket may be sent back three times. On what would be the fourth, review
escalates to Dane with `ask` instead: three rounds means the spec was wrong,
not the builder. The round count is never stored; it is counted from the
`REVIEW:` verdict comments already on the ticket.

## Who is talking: the machine stamp

**What the code does today:** every loop and script posts to ClickUp under
**Dane's own API token**, so every comment a machine writes comes back from
ClickUp with Dane's user id on it. The user id therefore does **not** say who
wrote a comment.

> StarCaster's `docs/LOOP_ENGINEERING.md` still describes a two-account
> model, where the machine posts as a separate "Pulse" service account. The
> code does not do that. This contract states what the code does. A separate
> machine identity is still the better long-term fix; until it exists, the
> stamp below is the rule.

So every comment a machine posts carries a **stamp** as its last non-empty
line:

```
[machine] posted by a loop under Dane's token — not his word
```

- The stamp is added at **one choke point**, the function in the ClickUp
  script that sends every request, so a newly added caller cannot forget it.
  It is added whether the comment is plain text or ClickUp's rich-text form,
  and adding it twice is impossible.
- A comment is **machine-written** if its last non-empty line starts with
  `[machine]`. Comments from before the stamp existed are recognised by a
  bracketed tag at the very start (`[CC-starcaster ...]`, `[auto-merge]`,
  `[bus-relay]`, `[reconciler]` and similar).
- A comment is **Dane's** only if it carries his user id **and** is not
  machine-written.
- If Dane quotes a machine card and types his words *under* it, it is still
  his. If he types *above* a pasted card, the stamp ends up last and the
  comment reads as a machine's. At the escalation that fails safe (his
  ticket stays with him, loudly). Anywhere a misreading would cause an
  action instead of a stall, the caller must ask a second question; the
  stamp alone is not enough there.

**Why (2026-09-01):** before the stamp, an `ask` card posted under Dane's
token was read ten minutes later as Dane replying. The relay handed the
ticket back to `Queued`, it vanished from his "Assigned to me", and a build
loop would have built the very thing that had been escalated. The same
mistake made `waiting` say "not waiting on Dane" while five approved merges
sat parked.

## Markers: the exact lines the loop reads back

These are the only comment shapes the machine acts on. Each has one writer
and is read back by the same parser its consumer uses; prose that merely
mentions the words does nothing.

### `PR opened: <url>`

```
PR opened: https://github.com/<owner>/<repo>/pull/<number>
```

A line of its own, written as the first line of a comment by `pr-opened`
(loop-build, before it hands the ticket to review). It is **the only** way a
ticket names its PR;
PRs mentioned anywhere else in the comments are ignored. If there are
several, the newest wins, so a rebuilt ticket points at its latest PR.

`pr-opened` first checks the other direction: the PR body must carry the full
ticket link, `https://app.clickup.com/t/<id>`, on a line of its own, or it
refuses. The PR title is the ticket's name, byte for byte. Then it reads its
own comment back and fails the run if the merge step could not parse it.

**Why (2026-08-22):** four approved tickets had no `PR opened:` comment, so
the merge step correctly refused to guess which PR they meant, and two of
those PRs had no ticket link either.

### `REVIEW: PASSED` and `REVIEW: sent back to Rework`

```
REVIEW: PASSED — <one-line note>
REVIEW: sent back to Rework — <one-line note>
```

Written only by `verdict` (loop-review). A line counts as a verdict if it
starts with `REVIEW`, an optional colon, and then `PASSED` or `SENT BACK`
(any letter case). The destination after "sent back to" is not read, so
older verdicts that say "sent back to Queued" still count as send-backs.

**Why the verdict words are required (2026-09-01):** the reader used to
accept any line starting with "Review". The operator card loop-review posts
beside a PASS contains a line starting "Review re-ran everything...", which
is newer than the verdict, so four approved tickets were refused overnight
with "the most recent review verdict is not a PASS".

### `[merge-on-comment]`: spent and unspent authorizations

When the relay acts on Dane's merge phrase, it writes a threaded reply on his
comment so the same answer is never posted twice:

```
[merge-on-comment] merged PR #<n> at <time> — <ISO timestamp>
[merge-on-comment] refused: <reason> — <ISO timestamp>
```

- **`merged ...` is spent forever.** That authorization is never looked at
  again; re-deciding a merged PR is the one mistake that cannot be undone.
- **`refused: ...` is not spent.** Every later pass re-decides it. While the
  same reason still holds, nothing new is posted; the moment the reason
  changes or goes away, it merges on his original word. He never has to say
  "merge" twice.
- A **conflict hand-off** (the branch conflicts with `main` and a person has
  to resolve it) is a `refused:` marker, so it is not spent either. Older
  hand-offs written as `conflict hand-off on PR #<n>` with no `refused:` are
  read the same way.
- The **newest** marker on the thread decides. The machine stamp is removed
  before the marker is read.

**Why (2026-08-22, 2026-08-23):** two tickets refused for a missing
`PR opened:` comment were fixed by hand minutes later and never looked at
again. The next day eleven `Ready to launch` tickets sat on approvals spent by
a conflict hand-off whose own comment promised "your merge still stands";
Dane said "merge" on one of them twice, four hours apart.

### `HELD BY HAND —`

A machine comment whose first line starts `HELD BY HAND —` tells the relay
that Dane is working the ticket in his own session: his comments are still
passed on, but the ticket is **not** handed back to the queue. A newer
question card from a loop ends the hold. Dane quoting the line is not a hold.

**Why (2026-10-03):** a ticket Dane was driving by hand went back to `Queued`
on his mid-task comment, and a build pass claimed it four minutes into his
own work.

## The operator card

Everything a loop puts in front of Dane is a short **card** in the comments
(the narrow right-hand column). Detail and the spec go in the ticket
**description** (the wide left-hand column). `ask` takes the card as plain
text with these sections, each on its own line:

```
@@ASKED     his own words that caused this ticket, verbatim. Never invented.
@@WHEN      optional: when and where he said it
@@CONTEXT   the problem and the fix in plain English, 50 to 100 words
@@NEEDED    the specific ask, with named options where possible
@@EVIDENCE  required when the ask costs money, changes a plan, or cannot be undone
```

The rules `ask` enforces:

- `@@ASKED`, `@@CONTEXT` and `@@NEEDED` must be present and non-empty. No
  section may appear twice, and no text may sit before the first section.
- `@@CONTEXT` is **50 to 100 words**. Under 50 it cannot be acted on; over
  100 it is the wall of text the card replaced.
- **No `> ` blockquotes anywhere**, in a card or a description. ClickUp
  deletes quoted lines on save, silently. Quote Dane's words inside a
  fenced code block instead.
- `@@EVIDENCE` is **required** when `@@NEEDED` asks for money (spend, buy,
  pay, subscribe...), a plan change (upgrade...) or something irreversible.
  It must hold a fenced block with the command and what it printed, and a
  line `@@MEASURED 8:04pm` saying when it was run, in his time.
- After posting, `ask` reads the comment back and fails if Dane's words did
  not survive.

The card renders with a red banner, `NEEDED FROM DANE:`, so he can find the
ask without reading.

**Why (2026-08-22):** two tickets stalled because the reasoning arrived as a
long comment in the narrowest column; one sat in his inbox for a day
demanding an answer that was never needed. The first two cards ever posted
lost his own words to the blockquote deletion. The evidence rule came from a
2026-08-23 escalation that asked him to upgrade a plan on a diagnosis that
re-measuring showed was wrong.

### What may be handed to Dane at all

Only four kinds of thing: a **real secret value**, a **billing screen**, a
**browser login**, or a **decision that is genuinely his**. The card says
which. Everything else, a loop does itself.

## Merge phrases

On a ticket in `Ready to launch`, a comment from Dane that is **exactly** one
of these, the whole comment and nothing else, authorizes the merge:

```
merge
merge it
ship it
approve
```

Before matching, the formatting his editor adds is removed (code fences,
backticks, bold and italic markers, invisible characters, dash variants),
letter case and repeated spaces are ignored, and trailing `.` or `!` is
dropped. Anything longer is just a comment: "merge after the other one
lands" and "do not merge this yet" do nothing.

**Why the formatting is stripped (2026-09-01, 2026-09-06):** ClickUp turned a
pasted phrase into a code block, and later a formatted copy arrived as
`**resume auto-merging**`. Both times Dane typed the right words several
times and nothing happened. Strict must mean strict about what he said, not
what his editor did to it.

Before merging, the relay checks, on that pass, that:

1. the ticket is in `Ready to launch` **now** (the same word on any other
   status does nothing);
2. the comment carries Dane's user id (a machine comment always ends in the
   stamp, so it can never be exactly a merge phrase);
3. the newest review verdict on the ticket is a PASS, **and his comment is
   newer than it**, so a "merge" from an earlier round cannot release a PR
   rebuilt since;
4. the ticket has a `PR opened:` line;
5. that PR is open, not a draft, its checks are green (a PR with no checks
   is refused: unverified is not green), and it does not conflict with
   `main`. If it is merely behind `main`, the relay catches it up and waits
   for checks to re-run rather than merging on a stale green.

A merge conflict is never resolved by a script. Any refusal is written on the
ticket in plain words, once, and leaves the authorization unspent.

**Why (2026-08-21):** on 2026-08-20 three tickets Dane had approved by comment
sat unmerged for hours until a person noticed. The checkpoint was doing its
job; the wait after it was pure friction. The relay moves the hands, not the
decision.

On a `Needs your input` ticket, a close phrase (`close`, `close it`,
`close this`, `please close`, `closed` and a few similar, matched the same
whole-comment way) closes the ticket as `Live`.

## "Is this waiting on Dane?" — the three verdicts

No agent tells Dane something is waiting on him without running
`npm run clickup -- waiting --task <id>` first. It decides from three live
facts and nothing else: the status, whether Dane is assigned, and whether the
newest comment is his (by the rule in "Who is talking").

| Verdict | Exit code | When |
|---|---|---|
| **NOT waiting on Dane** | 0 | His own comment is the newest word on it (a machine owes the next move, whatever the status says), **or** the status is a machine status. |
| **WAITING ON DANE** | 3 | The status is one of his two, he is assigned, and the newest comment is not his. |
| **CANNOT TELL** | 1 | The ticket, its assignees or its comments could not be read, **or** it is in his status but not assigned to him (a half-finished handoff). Never treated as either of the others. |

Run with no ticket, it checks every open ticket and says how many it checked
and how many it could not decide, so "nothing is waiting" and "I could only
read four of them" never look the same.

**Why (2026-08-23):** twice in one evening an agent told Dane something was
waiting on him when it was not, once reading a terminal buffer and once a
stale memory of the list, and he acted on it both times. His words: "The
issue is making assumptions and stating them with confidence. It has come up
many times."

## How a product adopts this contract

1. In the product's own `docs/LOOP_ENGINEERING.md`, replace the sections that
   restate statuses, owners, markers, the card, merge phrases and the
   `waiting` verdicts with one link to this file, pinned to the Spirality
   release the product depends on.
2. Keep in the product's docs only what is genuinely that product's: its ids,
   its gates, its deploy story, and any product-only lane (StarCaster's
   auto-merge lanes, for example), each saying which rule of this contract it
   extends.
3. If the product's code does something this contract does not say, that is
   a ticket in Spirality's Loop Queue: either the contract grows, or the
   product's behaviour changes. Never a silent local edit.

## Known differences today (2026-10-11)

Written down so nobody mistakes them for the contract:

- **Board order differs per list.** The order above is the one the code
  uses for display. Spirality's Loop Queue matches it, plus ClickUp's default
  `to do` status in first place, which no loop uses. StarCaster's and
  WaveCenter's lists show `Queued` first and `Rework` third, and StarCaster's
  shows `Ready to launch` before `Needs your input`. The order on the board
  changes nothing the machine does.
- **Spirality and WaveCenter have no relay.** On those two products a merge
  phrase or a reply is acted on only when a session next looks.
