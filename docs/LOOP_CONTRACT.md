# The loop contract

This is the one written statement of how a ticket moves through the
development loop that builds StarCaster, WaveCenter and Spirality. Each
project links here instead of restating it. If a project's own docs and this
file disagree, this file is right and the project's docs are a bug.

Every rule below was checked against StarCaster's code as of 2026-10-11:
`scripts/builder/loopStatuses.js`, `machineComment.js`, `operatorCard.js`,
`costlyAsk.js`, `mergeOnComment.js`, `waitingOnOperator.js`, `loopTrail.js`,
`sendBackRounds.js`, `busRelayPlan.js`, `autoMergeLane.js`,
`clickupTicketLink.js`, `pullRequestTitle.js`, `wipCap.js`,
`pipelineSweep.js`, `scripts/pipeline.mjs` and `scripts/clickup_direct.mjs`.
Where a rule exists because something went wrong, the incident is named with
its date, so the next person to want to "simplify" it can see what it costs.

Three kinds of rule appear below, and the difference matters:

- **Code rules**: the script refuses or acts on its own. These are what the
  code does today.
- **Skill rules**: written in the loop's skill file and followed by the agent;
  no script checks them. Each is marked *(skill rule)*.
- **Conventions**: how the ClickUp list is set up or how the team works;
  nothing in code reads them. Each is marked *(convention)*.

Some refusals have a **written override**: a flag that walks past the
refusal and leaves a line in the session's transcript saying so. Every one is
named where its rule is stated. An override is for a person who has checked
by eye, never a loop's shortcut.

## The words used here

- **Ticket**: one piece of work, a task in a project's **Loop Queue** list in
  ClickUp.
- **Loop**: an agent session that runs one step of the work on a timer.
  There are three: `loop-spec` writes tickets (run by hand, with Dane),
  `loop-build` turns a ticket into a pull request, `loop-review` checks that
  pull request independently.
- **Pull request (PR)**: the proposed code change on GitHub, waiting to be
  merged into `main`.
- **The operator**: Dane. The only person who decides what ships.
- **The machine**: any loop, script or relay. Never a person.
- **The relay**: a pass that runs every few minutes, reads Dane's comments on
  tickets in his two statuses and carries out what they say. StarCaster's is
  `bus-relay`. Spirality's is `npm run clickup -- relay` (the launchd job
  `<launchdPrefix>.relay`, every 10 minutes), built from the package's
  `mergeOnComment` and `busRelayPlan`; it carries out the **merge phrase** on
  `Ready to launch` and the **hand-back** on `Needs your input`. WaveCenter
  does not run one yet.

## The eight statuses

Every ticket is in exactly one of these, shown here in display order (the
code's `STAGE_ORDER`, which is how the scripts print them; a ClickUp board
may order its columns differently, see "Known differences today"):

| Status | What it means | Whose move |
|---|---|---|
| `Requested` | Dane asked for it from the tracker page; nobody has specced it yet | machine (loop-intake) |
| `Rework` | review sent it back; a branch, an open PR and review notes already exist | machine |
| `Queued` | waiting for a build loop to pick it up | machine |
| `Building` | a build loop has claimed it and is writing the code | machine |
| `In review` | the PR is open and waiting for, or getting, an independent review | machine |
| **`Needs your input`** | a loop has stopped and asked Dane a question only he can settle | **Dane** |
| **`Ready to launch`** | built, independently reviewed, green; waiting for Dane's word to merge | **Dane** |
| `Live` | merged and shipped (or deliberately closed); out of the open view | nobody |

The two in bold are **Dane's statuses** and ask different things of him:
`Needs your input` wants an **answer**, `Ready to launch` wants a **yes**.
On a normal day he can ignore the other six.

`Requested` is first on the board and no build loop claims it: the build
loop never builds from his unspecced words. The intake pass (`loop-intake`,
its own lane on the Mini) turns each request into specced tickets and hands
every one to him in `Needs your input`; his "go" queues it. It exists only in the tracker (see "Known differences
today").

Facts about the list itself:

- `Live` is a **closed-type** status in ClickUp, not merely the last one.
  That is what makes finished work leave the open view. *(Convention: list
  setup. No code checks it; all three live lists are set up this way.)*
- `Live` is the **only** finished status the loop's own status list names
  (Dane's decision, 2026-09-02). `complete`, `closed` and `done` are not
  synonyms. StarCaster's work-in-progress count (`wipCap.js`) reports a
  ticket wearing one of them by name as unrecognised; other readers (the
  `task-open` check, for one) treat any status of ClickUp's closed or done
  type as finished. Before that decision two parts of StarCaster disagreed
  about what "done" meant, four names against one, and both were steering
  the loop at once.
- There is no `Won't do` status. A ticket that is not going to be built is
  closed as `Live` with the `wont-do` tag and a comment saying what was
  decided. A real finding not worth a slot is tagged `deferred` instead.
  *(Convention: no code reads either tag.)*

### Why `Rework` is its own status (2026-08-31)

A send-back used to return to `Queued`, where it looked exactly like work
nobody had started. "52 queued" read as 52 fresh tickets when six were
half-built with open PRs; send-backs lost their place in line, so
normal-priority rework never beat fresh high-priority work (#419, #446, #447
and #449 went stale that way); and the work-in-progress count lied. Dane
named the status: "Recycle" was rejected because recycling loses the thing's
form, and here the branch, PR and notes all survive.

## Who may move a ticket, and how

Every move goes through the project's ClickUp script
(`npm run clickup -- <command>`), never the claude.ai ClickUp connector and
never the ClickUp web page, because the script is the only door with the
checks on it. Every write is read back before the command reports success.

| From | To | Who | How, and what has to be true |
|---|---|---|---|
| `Requested` | `Needs your input` | loop-intake | `ask`, one request per pass, the oldest first. Before the move the description is the spec in `loop-spec`'s shape with his words verbatim under a first `## Asked` heading, and the card's `@@ASKED` is those words; `@@NEEDED` says reply "go" to queue it, or what to change. A request too big for one pull request is sliced: each further slice is filed in `Requested` (so no build loop can claim it) and handed over the same way. A request too unclear to spec gets the question on the card and nothing else changes. *(Skill rule: the door checks the card, not the spec.)* |
| `Rework` or `Queued` | `Building` | loop-build | `claim`. It reads the ticket's status itself and refuses (exit 3) if that status is not `Rework` or `Queued`; then it hands over to `status` guarded on the status it just read. `status` reads the ticket again, refuses if it has moved, and only then writes. That is still check-then-write, not an atomic swap: the guard narrows the window in which two passes can both claim, it does not close it, which is why only one build loop runs per project. The guard is on what `claim` read, not on what `queue --claimable` listed: a ticket listed as `Queued` that has since moved to `Rework` is still claimed. |
| `Building` | `In review` | loop-build | *(Skill rule.)* Only after the PR is open, its body links the ticket, and `pr-opened` has recorded it on the ticket (see "Markers"). `status` does not check for a PR. |
| `Building` | `Needs your input` | loop-build | `ask`, with an operator card. Used when the gates fail and the fix is out of scope, the ticket is too vague, or the work is too big for one pass. |
| `In review` | `Ready to launch` | loop-review | `verdict --pass --if-status "In review"`, then `ask --status "Ready to launch"`. `ask` refuses unless the newest review verdict on the ticket is a PASS. |
| `Rework`, `Queued`, `Building` or `In review` | `Live` | loop-build or loop-review | `fixup-live --if-status <status>`, for a catch-up ticket only ("Find out why PR #N ... will not merge": no `PR opened:` line of its own, a `- PR:` line under `## The branch`) whose PR GitHub reads as merged. It moves the ticket, reads it back, clears assignees and posts one note naming the merge; Dane is never asked (SP-288). `ask` refuses such a ticket, and refuses a second card on a ticket already in that status of his whose card he has not answered. |
| `In review` | `Rework` | loop-review | `verdict --fail --if-status "In review"`, then `status --status Rework --if-status "In review"`. |
| `In review` | `Needs your input` | loop-review | `ask`. Required instead of a fourth send-back (see "Four rounds, then ask"). |
| `Needs your input` | `Queued`, `Rework` or `Live` | Dane, by replying | The relay moves it on his reply. The relay reads the ticket's PR state first, then decides. If his reply answers a machine-written question card and is a close phrase ("close it") → `Live`, whatever that PR state says: it closes the ticket even when its PR is still open (that PR is left untouched and the note says so) or its state could not be read. With no card on the ticket (for example one parked by `status --no-card`), a close phrase is not treated specially and goes by the PR like any other reply (Spirality's relay does not move a ticket with no card at all; see "Known differences today"). Any other reply goes by the ticket's PR: none, or closed unmerged → `Queued`; still open → `Rework`; already merged → `Live`; state cannot be read → nothing moves. |
| `Ready to launch` | `Live` | Dane, by a merge phrase | The relay merges the PR and closes the ticket, after re-checking every gate (see "Merge phrases"). |
| `Ready to launch` | `Live` | StarCaster's relay, with no word from Dane | **StarCaster only: auto-merge Lanes A and B** (see "StarCaster's auto-merge lanes"). |
| any | `Live` + `wont-do` tag | Dane's decision | Killing a ticket. *(Convention.)* |

Four rules sit over that table:

1. **Only `ask` may put a ticket into `Needs your input` or `Ready to
   launch`.** `status` refuses both. Since 2026-08-22, when two tickets
   reached `Ready to launch` with no passing review and Dane approved both in
   good faith, `ask` also refuses `Ready to launch` without a PASS verdict.
   Written overrides: `status --no-card` sets either status without a card
   (still refused into `Ready to launch` without a PASS), and
   `--operator-asked` (on `ask`, or on `status --no-card`) skips the PASS
   check.
   Both `ask` and `status --no-card` also refuse (exit 2, nothing written) to
   hand a ticket to Dane when **his own comment is already the newest** on
   it: a machine owes the next move, and handing it back would make him
   answer twice (2026-08-23). If the comments cannot be read they refuse with
   exit 1 rather than guess. Written override: `--after-his-answer`, for a
   genuinely new question.
2. **No loop takes a ticket out of Dane's two statuses.** Once it is handed
   to him it stays handed to him until he acts. A loop that could quietly
   reclaim its own escalation would defeat the checkpoint. His reply is him
   acting; the relay is only his hands. *StarCaster extension:* auto-merge
   Lanes A and B take a `Ready to launch` ticket to `Live` after a one-hour
   window in which he did not object.
3. **No loop moves a ticket into `Live` on its own judgement.** A merge Dane
   authorized, or his own decision to close it, does. *StarCaster
   extension:* auto-merge Lanes A and B, which merge on a standing policy he
   ruled on instead of a per-ticket word.
4. **A pass never ends with its ticket in `Building`.** *(Skill rule.)* No
   loop claims from `Building`, so a ticket left there is unreachable, not
   late. Before a build pass reports, its ticket is in `In review`, handed
   back to `Rework` or `Queued` with a comment saying why, or escalated with
   `ask`.

### Assignment is the handoff signal

Moving a ticket into one of Dane's statuses **assigns Dane**. Moving it into
any machine status **clears every assignee**. `status` and `ask` both do this
themselves and verify it stuck, from the write's own response rather than a
second read. Written overrides on `status`: `--assign <id>` names the
assignee instead, `--clear-assignees` clears them even on a move into
Dane's status, and `--no-auto-assign` turns the rule off for that one move. Dane's one view is ClickUp's "Assigned to
me", which works across every project's space; a ticket in his status but
not assigned to him is invisible to him, and is treated as a defect, not a
cosmetic slip.

### The claim order

loop-build takes **every `Rework` ticket before any `Queued` one**:

- `Rework`: oldest first (by the ticket's creation date, not by when it was
  sent back), **priority ignored**. Priority says what to
  *start*; rework is not started, it is finished. Ordering it by priority
  recreated the same starvation one tier down.
- `Queued`: priority first (urgent, high, normal, low; anything else last),
  then place, then oldest first. A ticket's **place** is its place in the
  queue (1, 2, 3 ...), set by `POST /projects/<slug>/tickets/order` (SP-249):
  at the same priority, a ticket with a place comes before one without, lower
  place first. Ordering some tickets moves the project's other placed
  tickets nobody has started (`Requested`, `Queued`) down after them,
  keeping their order, so no two waiting tickets share a place; a started
  ticket is never rewritten by a reorder.
  Place never beats priority, and a ClickUp task has none.

Every list of tickets in one status (`queue --status`, the Tasks page) uses
the same rule: priority, then place, then oldest.

`npm run clickup -- queue --claimable` prints them in exactly that order;
the first line is the one to take. A `Rework` ticket is finished on its
existing branch and PR, never on a second one.

### A ticket that waits on another (2026-10-27)

A ticket that builds on another says so on a line of its own in its
description:

```
Waits on: <ticket id or link>[, <ticket id or link> ...]
```

The line may sit in a list item, a quote or bold (`- **Waits on:** <id>`).
Both `queue --claimable` and `claim` read it from the same text, the
markdown description, and apply the same rule:

- While any ticket it names is still open, **wherever that ticket lives**
  (this list or another), `queue --claimable` leaves it out and says on
  stderr which ticket it skipped and why, and `claim` refuses it (exit 3,
  nothing written).
- A named ticket that cannot be read (a misspelled id, say) holds it back
  the same way: `queue` says "could not be read", `claim` exits 1.
- A `Waits on:` line that names something that is not a ticket id or link
  (`aaa1 and bbb2`, `aaa1 (the API ticket)`, `aaa1; bbb2`) holds it back
  too, and says what it could not read. Separate ids with commas.

Once every ticket it names is closed it takes its normal place in line.
Prose that mentions waiting does nothing; only the line counts
(`lib/waitsOn.js`).

**Why (2026-10-27):** the tracker plan had to be filed one wave at a time, so
a build loop could not start a step before the step it builds on had merged,
and Dane looked for the plan in the Loop Queue and could not find it.

### Two passes, one ticket (2026-08-22)

Claiming is check-then-act: read the status, compare, write. That is only
safe because every claim and every verdict names the status it expects
(`--if-status`) and refuses, writing nothing, if the ticket has moved. On
2026-08-22 at 3:41am two review passes checked the same PR at once; the
slower one, working from a 25-minute-old snapshot, wrote `Ready to launch`
over the faster one's FAIL and over a fresh `Building` claim. Since then:

- `verdict` refuses to run without `--if-status "In review"`. Written
  override: `verdict --no-guard`.
- A review **claims its ticket visibly before checking anything**, by setting
  the Loop note to `🔍 being checked — a review pass started <date> <time>`.
  *(Skill rule: `verdict` does not check for the note.)*

### Four rounds, then ask (2026-08-25)

A ticket may be sent back three times. On what would be the fourth, review
escalates to Dane with `ask` instead: three rounds means the spec was wrong,
not the builder. The round count is never stored; it is counted from the
`REVIEW:` verdict comments already on the ticket. `verdict --fail` refuses
the fourth send-back. Written override: `verdict --fourth-round-anyway`.

## Who is talking: the author

**What the code does today (SP-26, 2026-11-14):** in the tracker every
comment carries its author, and every author is either a **person** or a
**machine** (an actor of kind `human` or `machine`). Each loop signs in with
its own machine seat (`loop-build`, `loop-review`, `relay`, `hand-run`, ...),
never with Dane's, so who wrote a comment is a fact read off the comment,
not a guess.

- A comment is **machine-written** when its author is a machine actor.
- A comment is **Dane's** when its author is his actor (the project's
  operator) and that actor is a person. Nothing in the text changes that:
  if he quotes or pastes a machine card, above or below his words, the
  comment is still his.
- The door hands every comment to the readers with its author's kind
  (`user.kind`, `human` or `machine`), and the readers ask that and nothing
  else (`isMachineAuthored` and `isOperatorAuthored` in
  `lib/machineComment.js`). A comment whose author's kind could not be read
  is not counted as a machine's.
- No stamp is written. Comments imported from ClickUp keep the old
  `[machine] posted by a loop under Dane's token — not his word` line as
  history: the importer gave each one the author its stamp named, the
  readers ignore the line, and the tracker page leaves it off when it shows
  the comment.
- The ClickUp door, kept for a project still on ClickUp, posts every comment
  under Dane's token, so there the author cannot say who wrote it. That door
  alone still writes the stamp as the last line of each comment it posts,
  and turns it back into the same author kind on every read, so the readers
  ask one question on either tracker.

**Why (2026-09-01, then 2026-11-14):** on ClickUp, every loop posted under
Dane's token, so an `ask` card was read ten minutes later as Dane replying.
The relay handed the ticket back to `Queued`, it vanished from his "Assigned
to me", and a build loop would have built the very thing that had been
escalated. The stamp fixed that, but read the other way it could silence
him: a card he pasted under his own words made his whole comment read as a
machine's, and the auto-merge lane needed a second test (`quotesMachineText`)
to tell. In the tracker the author answers both, so the stamp was retired.

## Markers: the exact lines the loop reads back

These are the only comment shapes the machine acts on. Each has one writer
and is read back by the same parser its consumer uses; prose that merely
mentions the words does nothing.

### `PR opened: <url>`

```
PR opened: https://github.com/<owner>/<repo>/pull/<number>
```

`pr-opened` (loop-build, before it hands the ticket to review) writes it as
the first line of a comment. The reader accepts it at the start of **any**
line of a comment, not only the first. It is **the only** way a ticket names
its PR; PRs mentioned any other way in the comments are ignored. If there are
several, the newest wins, so a rebuilt ticket points at its latest PR.

`pr-opened` first checks the other direction: the PR body must carry a link
to this ticket, or it refuses (exit 4) and writes nothing. The check finds
the link anywhere in the body, not only on a line of its own, and accepts
`http://` as well as `https://`, and the `/t/<team id>/<id>` form as well as
`/t/<id>`. Then it reads its own comment back and fails the run if the merge
step could not parse it.

The PR title is the ticket's name, byte for byte. `pr-opened` does **not**
check this. In StarCaster the rule lives in `npm run ship`
(`pullRequestTitle.js`), which titles the PR from the ticket and only warns,
loudly, when it cannot; it never stops a ship over it. Elsewhere it is a
*(skill rule)*.

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

### `MAIN MOVED:` — main changed under an in-flight ticket

```
MAIN MOVED: PR #<merged> -> PR #<this ticket's PR> — no-overlap | same-files | conflict | cannot-tell
```

Written by `main-moved`, which the relay runs after every merge it makes (a
session that merged by hand runs `npm run clickup -- main-moved --pr <n>`).
It goes on every ticket in `Building`, `In review` or `Rework` whose
recorded PR is still open against the same base, and never on Dane's two
statuses: each ticket's status is re-read just before its note is posted, so
one that moved to his statuses during the relay pass is skipped. A branch
that already contains the merged PR is not told. One ticket whose comments
cannot be read is reported and skipped; the rest are still told. The kind comes from `git merge-tree`, a merge done in memory with
no checkout: `no-overlap` (none of the same files, merges cleanly),
`same-files` (shared files, still merges cleanly), `conflict` (names the
files), `cannot-tell` (the check did not run, treated as `same-files`, never
as clean). The pair of PR numbers is the duplicate guard: one note per merge
per PR. `get` prints the newest one on its `main:` line.

What the loops do with it: loop-build merges `main` in and re-runs `verify`
before handing over to review on anything but `no-overlap`; loop-review sends
a `conflict` straight back to `Rework`, without spending a test pass first.
The note moves no status by itself.

**Why (2026-10-27, task 86bctjffu):** two tickets built at once branch from
the same `main`; the second learned the first had merged only at review or at
Dane's merge word, then went round the whole cycle again.

**`Ready to launch` is kept current too (SP-294).** Right after the same
merge, the relay checks every `Ready to launch` ticket whose recorded PR is
open against the same base, with the same in-memory `git merge-tree`. It
writes no `MAIN MOVED:` note there (his inbox is not a log); the only comment
it ever writes on his ticket is the `CONFLICT TICKET FILED:` line below:

- **Merges cleanly:** it catches the branch up through GitHub
  (`gh pr update-branch`, an ordinary merge of `main` in, never a force
  push), so CI re-runs and the PR is current and green when he says merge.
  No comment is written. While another PR holds the merge window it leaves
  the branch for his word, and a window that cannot be read is reported; it
  never takes the window, because a PR that lands only on his word would
  hold it for the full 45 minutes. While a catch-up ticket for that PR is
  still with the loops (Queued, Building, Rework or In review), its builder
  owns the branch and it is not touched.
- **Conflicts:** it files the catch-up ticket now ("Resolve the merge
  conflict on PR #N", since `git merge-tree` found the overlap), and writes
  the same `CONFLICT TICKET FILED:` comment on his ticket that the merge step
  writes at his word, so that step finds it on file and files no second. The
  branch is not touched.
- **Cannot tell:** nothing is done, and the pass reports it.

It moves no status and never resolves a conflict. His merge word, if already
given, still stands. A ticket that left `Ready to launch` during the pass is
skipped.

**Why (2026-11-13, SP-294):** a PR waiting on his word went stale silently,
and the conflict showed only when he said merge. Since 10/29 that happened to
70 of the 281 PRs that went live; his merge wait has a p90 of 8.6 hours, all
of it time the fix could have been under way.

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
- A **conflict hand-off** (the branch conflicts with `main`) files a new
  `Queued` ticket in the Loop Queue for the build loop to catch the branch
  up; a person is needed only if filing that ticket fails, and the comment
  then says so in bold. The hand-off is a `refused:` marker, so it is not
  spent either. Older hand-offs written as `conflict hand-off on PR #<n>`
  with no `refused:` are read the same way.
- An unchanged hand-off is normally quiet, with two exceptions. A pass that
  has **just filed** the conflict ticket says so, because the actor is new.
  And a hand-off that has **stalled** is announced: no conflict ticket was
  filed (and the branch is not expected to clear on its own), the marker's
  time cannot be read, the hand-off is more than 24 hours old, or the same
  refusal has come back three or more times. The stall announcement goes to
  the **bus** (StarCaster's shared channel), not to the ticket; the ticket
  only gets its `[merge-on-comment]` marker re-stamped with a fresh time, and
  only if the bus post succeeded, so the next reminder is a day away and a
  failed post is retried next pass.
- The **newest** marker on the thread decides. A machine stamp (on a
  marker imported from ClickUp, or posted by the ClickUp door) is removed
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
text. Each section marker stands **alone on its own line**, with the
section's text on the lines below it; text on the same line as a marker is
not accepted (the parser reads it as text before the first section and
refuses):

```
@@ASKED
his own words that caused this ticket, verbatim. Never invented.
@@WHEN
optional: when and where he said it
@@CONTEXT
the problem and the fix in plain English, 50 to 100 words
@@NEEDED
the specific ask, with named options where possible
Your move: Merge | Close | Reply — a short reason
@@EVIDENCE
required when the ask costs money, changes a plan, or cannot be undone
```

The rules `ask` enforces:

- `@@ASKED`, `@@CONTEXT` and `@@NEEDED` must be present and non-empty. No
  section may appear twice, and no text may sit before the first section.
- `@@CONTEXT` is **50 to 100 words**. Under 50 it cannot be acted on; over
  100 it is the wall of text the card replaced.
- `@@NEEDED` **ends with one line naming his move**: `Your move: Merge`,
  `Your move: Close` or `Your move: Reply`, then a short reason. The ticket
  page reads that line to draw the button for the move (Merge, Close), with
  the reply box underneath for anything else. A card never tells him to move
  a ticket himself ("move this ticket to Live yourself" is refused): the
  page cannot, and only the relay moves his tickets, on his word. *(SP-68,
  after SP-64's card asked exactly that.)*
- **No `> ` blockquotes**, in a card or a description. ClickUp deletes
  quoted lines on save, silently. Quote Dane's words inside a fenced code
  block instead. `ask` refuses a blockquote in `@@ASKED`, `@@CONTEXT`,
  `@@NEEDED` and `@@EVIDENCE`; it does not check `@@WHEN`, so keeping
  blockquotes out of that one is on the writer.
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

### A file link names a commit, never a branch (2026-11-09)

Every GitHub file link a loop writes on a ticket (a card, a test step, a
comment, a description) names a commit (`.../blob/<commit>/<path>`), `main`
for a file already on `main`, or the pull request's files tab
(`.../pull/<n>/files`). Never a branch: the relay merges with
`--delete-branch`, so a branch link goes dead the moment Dane merges. On
2026-11-04 he clicked "Read the page" on SP-105, a link to
`blob/setup-review/...`, and got GitHub's 404 (SP-178). `comment`, `ask`,
`describe`, `task`, `verdict` and `pr-opened` refuse a branch link outside a
fence, exit 2, nothing written.

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
backticks, bold and italic markers, invisible characters), dash variants
(en dash, em dash, minus sign and similar) become a plain `-`, letter case
and repeated spaces are ignored, and trailing `.`, `!` and whitespace are
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
2. the comment is Dane's: his actor wrote it, and it is not a machine's (see
   "Who is talking");
3. the newest review verdict on the ticket is a PASS, **and his comment is
   not older than it** (one with the very same timestamp passes), so a
   "merge" from an earlier round cannot release a PR rebuilt since;
4. the ticket has a `PR opened:` line;
5. that PR passes GitHub's own reading (`githubGate` in
   `mergeOnComment.js`). The main points: it is open and not a draft; its
   checks are green (a PR with no checks is refused: unverified is not
   green; checks still running are waited on); and it does not conflict
   with `main`. If GitHub reports a conflict but `git merge-tree` merges
   `main` in cleanly, the two sources disagree, so no conflict is claimed:
   the relay merges `main` into the branch locally, pushes, and decides
   again on a later pass. If it is merely behind `main`, the relay catches it up and
   waits for checks to re-run rather than merging on a stale green. GitHub's
   unclear answers are never read as yes: `UNKNOWN` (still computing) is
   waited on, and `UNSTABLE` and `BLOCKED` are refused. Only `CLEAN` or
   `HAS_HOOKS` merges. The code is the full list.

A merge conflict is never resolved by a script (merging `main` in when git
finds no conflict is a catch-up, not a resolution). Any refusal is written on
the ticket in plain words, once (the stalled hand-off above is the
exception), and leaves the authorization unspent.

**Why (2026-08-21):** on 2026-08-20 three tickets Dane had approved by comment
sat unmerged for hours until a person noticed. The checkpoint was doing its
job; the wait after it was pure friction. The relay moves the hands, not the
decision.

**Where the ticket goes after the merge.** `Live`, unless the ticket's
description carries, on a line of its own, a declaration that another slice
is still to come:

```
Next slice: <what the next slice is>
```

Then the ticket goes back to `Queued` (assignees cleared) for the next build
pass, and the merge record on the ticket says so. `Next slice: none` reads as
no next slice. Prose about slices is deliberately not read: a ticket moves on
a declaration, never on how a paragraph was worded. The build pass that
narrows a description to one slice writes the line
(`mergeDestination` in `relayLane.js`).

**Why (2026-10-13, Spirality):** "merge PR #4" sat four hours on a sliced
ticket, and the session that finally merged it by hand also had to drag the
ticket back to `Queued` for slice 2 by hand.

**Work that is left after the merge gets its own ticket.** When a pull
request leaves steps that can only be done after it merges, by a hand-run
session (moving a web address, a deploy that needs Dane's word), the session
or loop that opens the pull request files those steps as a ticket of their
own, waiting on this one, before the hand-over. `Live` takes a ticket out of
the open view, so steps written only in a doc or on a closed ticket are
forgotten.

**Why (2026-11-10, Spirality):** SP-164, "spirality.alphire.agency shows
StarCaster's small Tasks page: point it at the tracker's own page", went
`Live` when PR #135 merged on 2026-11-09. The move it was for was written in
docs/TRACKER_MVP.md as steps for later, and no ticket held them. The next
day Dane asked why the page had not changed.

On a `Needs your input` ticket, a reply that is exactly a **close phrase**,
matched the same whole-comment way, closes the ticket as `Live`, but only
when it is his answer to a machine-written question card on that ticket.
On a ticket with no card (one parked by `status --no-card`, say), "close it"
is an ordinary reply and goes by the PR's state like any other. The full
list (`CLOSE_PHRASES` in `busRelayPlan.js`):

```
close
close it
close this
close this ticket
close the ticket
close it please
please close it
please close
yes close it
yes, close it
ok close it
ok, close it
closed
```

"done" and "nothing to do" are deliberately **not** close phrases: Dane
writes them after doing what a card asked of him, which means carry on. The
relay reads the ticket's PR state before deciding, but a close phrase that
answers a card is decided before that state is consulted, so it closes the
ticket even when the PR is still open (the PR is left alone and the note
says so) or its state could not be read.

On a **`Ready to launch`** ticket a close phrase is read on the same terms
(his answer to the newest machine card; a `HELD BY HAND` note newer than the
card withholds it; an answer already carrying the done reply is spent), with
one rule more, because that status waits on a merge: the ticket moves to
`Live` only when its work **is merged**. That is its own PR, or, when it has
no PR of its own, the PR it was filed to unstick (the `- PR:` line under
`## The branch` in a catch-up ticket's description). Otherwise the relay
replies under his word once, saying why (`[bus-relay-close-refused]`), and
leaves the ticket where it is; the same word closes it on the first pass
after the merge. The ticket page's **Close** button, shown when the newest
card's move is `Close`, posts the first close phrase as his reply.

### A project's own pre-merge step (2026-11-09)

A project can add one step of its own to the merge: `preMergeCommand` in its
`spirality.project.json`, a command written as a list (the program, then each
argument as its own string; no shell reads it), for example
`["node", "scripts/apply_migrations.mjs"]`. With no key there is no step, and
the merge is exactly as above.

When it is set, the relay runs it from the repository root once every check
above says merge, and before `gh pr merge`. Its environment carries:

| Variable           | What it holds                              |
|--------------------|--------------------------------------------|
| `LOOP_PR_NUMBER`   | the pull request's number                  |
| `LOOP_PR_URL`      | its address on GitHub                      |
| `LOOP_HEAD_SHA`    | the commit its branch is at, about to merge |
| `LOOP_BASE_BRANCH` | the branch it merges into                  |
| `LOOP_TICKET_ID`   | the ticket Dane said "merge" on            |

- **Exit 0**: the relay merges, with `--match-head-commit <LOOP_HEAD_SHA>`, so
  a push that lands after the step ran makes GitHub refuse the merge rather
  than merge work the step never saw. The step's last lines of output go in
  the `Merged:` note.
- **Any other exit, a stop by signal, a step that cannot start, or one still
  running after 10 minutes**: nothing is merged. The relay refuses through the
  ordinary refusal above (`pre-merge-step-failed`), naming the step and its
  last lines of output, and Dane's word stays unspent: each later pass runs
  the step again and merges once it passes, saying nothing new while it fails
  the same way. "The same way" means the same command failing the same way
  (the same exit code, signal, time-out or start failure); the output is
  quoted in the note but never compared, so a timestamp in it does not make
  a fresh refusal every pass. A step that ran and failed may have made changes
  of its own, and the note says so. Because it can run again, a step must be
  safe to run twice.
- A dry run (`relay --dry-run`) says it would run the step, and runs nothing.

Nothing runs after the merge, and nothing in Spirality knows what a project's
step does.

**Why (2026-11-09, SP-185):** before WaveCenter moved onto this loop, its own
merge lane applied a pull request's database change to the live database from
the exact commit about to merge, and merged nothing if that failed. The relay
had no place for it (WaveCenter's WC-164 waits on this).

### StarCaster's auto-merge lanes (a StarCaster extension)

StarCaster's relay merges some `Ready to launch` tickets **with no word from
Dane** (`autoMergeLane.js`). This is a standing policy, not a per-ticket
word: Lane A was ratified with his rulings on 2026-08-24, and Lane B was
added on 2026-09-04 after a night of work on the pipeline's own tooling,
which Lane A did not cover, went seven hours with no merge while he slept:

- **Governance first, in both lanes.** A PR that touches any governance path
  is refused outright, whatever else it holds: `.github/`, `.claude/`,
  skills, any `CLAUDE.md`, `docs/DOCTRINE.md`, `docs/LOOP_ENGINEERING.md`,
  `scripts/check_*`, `scripts/install_*`, `scripts/git-hooks/`, and the
  merge machinery itself with its tests. A machine may never auto-merge a
  change to the rules that govern machines. Since SP-199 the list has two
  halves: the floor every project shares, in `lib/autoMergeLane.js`
  (instruction files, CI and agent configuration, the check, install, hook
  and shell families, and this package's own merge, claim, review and
  tracker-door modules), and the project's own `governancePaths`. StarCaster's
  own entries (`server.js`, `docs/DOCTRINE.md`, its ClickUp client, its ship
  step and the rest) are `lib/fixtures/starcasterGovernancePaths.json`, which
  SP-25 writes into its settings; a test proves the two halves together block
  everything StarCaster's code blocked. `lib/mergeMachineryGovernance.test.js`
  fails the build if a file that can merge, or that the merge step imports, is
  one a lane would carry.
- **Lane A:** every file the PR changes is a test, a file under `docs/`, or a
  Markdown document.
- **Lane B:** every file is either Lane A material or a script under
  `scripts/` ending `.js`, `.mjs`, `.cjs`, `.ts` or `.json`. Shell scripts
  (`.sh`) and files with no extension do not count. A PR may mix the two
  kinds; it runs in the widest lane any one of its files needs.

So "every file is a test, a document or a script" is necessary, not
sufficient: the governance check comes first.

The relay announces the ticket, waits a **one-hour** window, and merges
unless Dane comments in that hour. A comment cancels unless its author is a
machine actor, so anything his actor wrote, whatever it quotes, is always
read as his objection. Nothing else is loosened: the PASS
verdict and every PR check in the list above are still required. It is
capped per hour and per day, turns itself off on trouble, and can be stopped
with a switch phrase on any ticket or the bus. Spirality and WaveCenter have
no lanes.

**Spirality's relay runs the lanes (SP-202, SP-203).** `npm run clickup --
relay` reads the project config's `autoMergeLanes`; with `[]` it reads and
writes nothing more than before. With lanes listed it runs
`lib/relayAutoMerge.js` after the merge-phrase and hand-back steps, on every
`Ready to launch` ticket that pass did not merge or close:

- It announces an eligible ticket, and the hour runs from the tracker's own
  time for that comment.
- A comment from Dane in the hour cancels it; a comment by a machine actor
  does not.
- At the end of the hour it reads the PR from GitHub and asks the same gate
  a merge phrase does (`githubGate`): a PASS verdict on file and no newer
  send-back, an open PR, green checks, current with main, no conflict.
  Checks still running: it waits and says nothing. Red, conflicting, closed
  or a draft: it cancels, and the ticket waits on his merge phrase as
  before. Behind main: it catches the branch up through GitHub and a later
  pass merges it once the checks re-run green.
- Anything that moves main (the catch-up or the merge) first takes the
  **merge window** (`lib/mergeWindowLease.js`, kept in
  `merge-window-lease.json` in the repository's git folder): one PR at a
  time per repository, so two lane merges cannot reset each other's checks.
  Another PR in the window means wait; an unreadable window means no merge.
  The window is freed when its PR merges, closes, is refused or is
  cancelled, and after 45 minutes at most.
- The merge is the phrase merge's own steps in the door: the project's
  pre-merge step if it has one, `gh pr merge --squash` pinned to the commit,
  and only a PR GitHub reads back as `MERGED` counts. Then one merge note on
  the ticket, the move to `Live` (or `Queued` for a `Next slice:` line), read
  back, the `MAIN MOVED:` notes, and one line on the bus.
- **A merge that ran and cannot be confirmed turns every lane off** there
  and then, says so on the bus, and stays off until "resume auto-merging".
- The stop and resume phrases are read from the bus (`busProject`) and from
  every ticket the relay read that pass (`Ready to launch` and `Needs your
  input`); a stop is kept in the ledger. An unreadable bus or ledger, or a
  project with no bus, counts as stopped.
- The ledger (`auto-merge-ledger.json` in the repository's git folder,
  never committed) records each merge the moment it lands, for the hourly
  and daily caps and the daily digest on the bus. An unverified pass or a red
  main after a lane merge disables the lanes and says so on the bus.
- A config with lanes but no `governancePaths` list runs no lane.
- An announcement posted while the lane only rehearsed (SP-202) said nothing
  would merge, so it still ends in one "would merge" note
  (`[auto-merge-rehearsal]`), never a merge.

StarCaster stays on its own relay until SP-25 switches it over.

## "Is this waiting on Dane?" — the three verdicts

No agent tells Dane something is waiting on him without running
`npm run clickup -- waiting --task <id>` first. It decides from four live
facts and nothing else: the status, whether Dane is assigned, whether the
newest comment is his (by the rule in "Who is talking"), and, in his two
statuses, the live state on GitHub of the ticket's recorded pull request.

The checks run in this order, and the first that applies decides:

| Order | Verdict | Exit code | When |
|---|---|---|---|
| 1 | **CANNOT TELL** | 1 | The ticket could not be read, it has no readable status, or its assignees or its comments could not be read. A failed read decides before anything else, even if Dane's comment would have been newest. |
| 2 | **NOT waiting on Dane** | 0 | His own comment is the newest word on it: a machine owes the next move, whatever the status says. |
| 3 | **NOT waiting on Dane** | 0 | The status is a machine status. |
| 4 | **NOT waiting on Dane** | 0 | It is `Ready to launch` and its pull request is already merged or closed: a machine owes the move to Live (or the next move), not Dane. |
| 5 | **WAITING ON DANE** | 3 | The status is one of his two, he is assigned, and the newest comment is not his. |
| 6 | **CANNOT TELL** | 1 | It is in his status but not assigned to him (a half-finished handoff). |

CANNOT TELL is never treated as either of the others.

A pull request whose state GitHub did not give back is never counted as
merged: the verdict is what it would have been without it, and the reason
says the state could not be checked. In `Needs your input` the pull
request's state is only reported, never decisive: a question there is still
his to answer, even about a closed pull request.

Run with no ticket, it checks every open ticket in two lists, the Loop
Queue and StarCaster's Agent Response list, and says how many it checked
and how many it could not decide, so "nothing is waiting" and "I could only
read four of them" never look the same.

**Why (2026-08-23):** twice in one evening an agent told Dane something was
waiting on him when it was not, once reading a terminal buffer and once a
stale memory of the list, and he acted on it both times. His words: "The
issue is making assumptions and stating them with confidence. It has come up
many times."

## How a project adopts this contract

1. In the project's own `docs/LOOP_ENGINEERING.md`, replace the sections that
   restate statuses, owners, markers, the card, merge phrases and the
   `waiting` verdicts with one link to this file, pinned to the Spirality
   release the project depends on.
2. Keep in the project's docs only what is genuinely that project's: its ids,
   its gates, its deploy story, and any project-only lane (StarCaster's
   auto-merge lanes, for example), each saying which rule of this contract it
   extends.
3. If the project's code does something this contract does not say, that is
   a ticket in Spirality's Loop Queue: either the contract grows, or the
   project's behaviour changes. Never a silent local edit.

## Known differences today (2026-10-11)

Written down so nobody mistakes them for the contract:

- **Board order differs per list.** The order in "The eight statuses" is
  the code's display order (`STAGE_ORDER`). Read from ClickUp's API on
  2026-10-11, the three live lists have the same seven statuses and no
  others, in these orders:
  - Spirality: `Queued`, `Rework`, `Building`, `In review`,
    `Needs your input`, `Ready to launch`, `Live`
  - WaveCenter: `Queued`, `Building`, `Rework`, `In review`,
    `Needs your input`, `Ready to launch`, `Live`
  - StarCaster: `Queued`, `Building`, `Rework`, `In review`,
    `Ready to launch`, `Needs your input`, `Live`

  In all three `Queued` is first because it is the open-type status, which
  ClickUp puts first, and `Live` is the closed-type status at the end. The order
  on the board changes nothing the machine does: claim order comes from
  `queue --claimable`, not from the board.
- **WaveCenter has no relay.** There a merge phrase or a reply is acted on
  only when a session next looks. **Spirality's relay merges on a merge
  phrase** and moves a `Needs your input` ticket on his reply to its card
  (`npm run clickup -- relay`). It has no party line, so his answer on the
  ticket counts as delivered by being written there; and for the same
  reason it has no "first time relayed" marker, so a ticket with **no**
  machine-written card is reported and left where it is, where StarCaster's
  bus-relay would move it on a fresh reply. On every project nothing merges
  without Dane's word.
- **Spirality's relay files the conflict ticket but checks nothing locally
  and announces no stall.** On a conflict it files the `Queued` catch-up
  ticket and records it (`CONFLICT TICKET FILED: PR #<n>`) on the waiting
  ticket, as above. That record counts as "on file" only while its ticket
  is in `Queued`, `Rework`, `Building` or `In review`: once the catch-up has
  left those (it landed in `Ready to launch` or `Live`, or is parked on
  Dane), a fresh conflict on the same PR files a new catch-up ticket and the
  record says the first one landed but `main` moved again. A catch-up ticket
  that cannot be read is reported as unchecked, never as on file. It runs
  no `git merge-tree` cross-check, so every
  hand-off reads "no local check was attempted" and the ticket asks its
  builder to find out first. It has no bus, so a stalled hand-off is not
  announced; a filing that fails is retried on the next pass.
- **Any reply to an intake card queues the ticket.** The relay does not
  read what Dane said on a ticket `loop-intake` handed over: "go", "change
  the title" and an answer to a question all move it to `Queued` (no PR, so
  the hand-back's `Queued` row), and the builder reads his comment there. An
  answer to an intake *question* therefore queues a ticket whose description
  is still his raw request, and the build loop's own "too vague to build,
  `ask`" rule is what stops it. If that costs something, it is its own
  ticket.
- **`Requested` exists only in the tracker.** StarCaster's and WaveCenter's
  ClickUp Loop Queue lists do not carry it, so a request filed from a page
  can only be a tracker ticket.
- **Only StarCaster has auto-merge lanes.** See "StarCaster's auto-merge
  lanes" above.
