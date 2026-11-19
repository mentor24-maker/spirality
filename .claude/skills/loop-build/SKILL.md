---
name: loop-build
description: Pick the next claimable task (all "Rework" first, then "Queued") from the Spirality queue in the tracker and build it end-to-end into a pull request — in its own git worktree, passing `npm run verify` — then move the task to "In review". Designed to be run on a timer with `/loop 30m loop-build`. Never edits main, never merges.
summary: Builds the next ticket into code
about: >
  This is the builder. It takes the next ticket that is ready to build (one
  sent back for fixes first, then the oldest queued one), writes the change in
  its own separate copy of the code, runs every check, and opens a pull
  request: a proposed change waiting for approval. Then it hands the ticket to
  review. It runs by itself on a timer, one ticket at a time. It never changes
  the main code directly and never merges anything; only Dane does that.
---

# Loop: Build

Step 2 of 3 in the Spirality development loop (spec → build → review).
See Spirality's `docs/LOOP_ENGINEERING.md` (in Spirality's folder, three folders
up from this skill's base directory, not in a project's checkout)
for the whole system.

Each run builds **one** task into **one** PR. Under `/loop` it repeats,
draining the queue one clean PR at a time.

## Before anything: one claimant

Claiming a ticket is check-then-act (a read, a comparison, a write), which is
only sound with exactly one build pass running. On the Mini the build lane's
runner (`scripts/loop_runner.sh`) holds a lock, `$LOG_DIR/$SLUG-loop-build.lock`,
so only one runner runs and its passes run one after another. A session
started by hand holds no lock, so **it does not build while the lane is
loaded**.

**First tell which one you are.** The lane's runner, `scripts/loop_runner.sh`,
exports `LOOP_RUNNER_PID` to every pass it starts:

```bash
echo "${LOOP_RUNNER_PID:-}"
```

- **Set** (a number): you ARE the build lane's own pass, and the runner's
  lock (`$LOG_DIR/$SLUG-loop-build.lock`) is yours: it is what makes you the only
  one. Carry on. A loaded lane, a held lock and a running `loop_runner.sh`
  are you, not a second builder. (On 11/4 two build passes in a row stood down
  here, each naming its own runner's process, and two tickets sat in Rework.)
- **Empty**: you were started by hand. Run
  `scripts/install_loop_runner.sh --status`; if `loop-build` shows
  `loaded:   yes`, stop and report that the lane is running, unless Dane has
  asked for this pass by hand (then claim only through `claim`, which is
  guarded on the ticket's status). Otherwise carry on.
- **Whenever you stop for this reason**, the first line of your report is
  exactly `LANE STOOD DOWN: <why, in one line>`, and nothing else ever starts
  with those words. The setup wizard reads a new project's first lane passes
  for that line (`npm run onboard:lanes`), never for wording, because a pass
  that is the lane says "I am the lane, not a second one" too.

A ticket in `Building` is not proof that a pass is building it. A pass that
dies (killed, out of time, out of session) leaves its ticket there, and
nothing claims from `Building` (SP-101: SP-92 sat a day that way). So every
pass begins with this, **once, before it claims, never later** (later, the
marker is your own claim and it would hand back the ticket you are building):

```bash
npm run clickup -- pass-reconcile
```

A `claim` made by the build runner's pass writes a claim marker naming the
ticket; the hand-off (`status` or `ask`) clears it. A hand-run session never
writes one, so its ticket is never taken back. `pass-reconcile` reads the
marker the last pass left: if that ticket is still in `Building`, its pass is
gone, and it goes back to `Rework` (it has a PR) or `Queued` (it has none),
guarded on `Building`, with one note read back naming the claim time and any
unpushed worktree from around then. **Nothing is deleted.** Run by hand while
the runner is running, it leaves the marker alone. Exit 0 nothing to do,
3 handed one back (both normal: carry on and claim). Exit 1 (a write failed)
or 2 (could not tell) keeps the marker for the next pass to retry: **stop the
pass there and report it**. `claim` refuses, with exit 1, to write over a
marker whose ticket is still in `Building` or cannot be read, because that
marker is the only record of the stranded ticket. A claim refused at its guard
(exit 3) clears the marker it wrote. Any other `Building` ticket is not yours:
leave it.

## Then: is there room for another ticket?

Right after `pass-reconcile` (so a ticket it handed back is not counted) and
before any claim, ask whether the work in flight is already at the
work-in-progress cap Dane sets on the Settings page (Spirality's SP-238):

```bash
npm run clickup -- wip-check
```

It counts the tickets in flight (an open pull request whose ticket is in
`Building` or `In review`, and a `Building` ticket with no pull request yet)
against the page's cap, prints one line, and exits:

- **0**, `room: 2 of 5 in flight`: carry on and claim.
- **3**, `full: 5 of 5 in flight (<ticket ids>)`: claim nothing. The first
  line of your report is exactly `WIP CAP REACHED: <the full: line>`, and the
  pass ends there. This is a normal outcome, not a failure: with every merge
  dating every other open pull request, more open work ships slower
  (`lib/wipCap.js` explains). Rework does not count, and is not claimed
  either while the cap is full.
- **1**, could not tell (GitHub or the tracker did not answer): carry on and
  claim, and say in your report that the cap was not applied this pass. The
  cap fails open on purpose: refusing on a passing outage would stop all work.

`CLAUDE_LOOP_WIP_CAP` overrides the page's cap for a session started by hand;
on the lane the page's value always wins.

## Ticket access: the direct script, not the connector

Every ticket touch (the tracker, since the switch from ClickUp) goes through **`npm run clickup -- <command>`** — a full
standalone command each time (shell state does not survive between tool
calls). Doppler supplies the token; you never see or handle it. The moves this
loop makes:

```bash
npm run clickup -- pass-reconcile                                      # FIRST: hand back the ticket a dead pass left in Building
npm run clickup -- wip-check                                           # THEN: room under the Settings page's cap? exit 3 = full, claim nothing
npm run clickup -- queue --claimable --note-holds                      # FIRST LINE is the task to claim (all Rework, then Queued)
npm run clickup -- claim --task <id>                                   # safe claim; exit 3 = moved, waits on a ticket or shares a file: take the next
npm run clickup -- likely-files --task <id> --files <path>,<path>      # an older ticket naming no files: add its Likely files: line first
npm run clickup -- get --task <id>                                     # header + body; also shows any recorded PR, send-back rounds and attachments
npm run clickup -- attachments --task <id> --to /tmp/<id>-attachments  # save the ticket's files, to read before building
npm run clickup -- comments --task <id>                                # the review notes live here on a Rework ticket
npm run clickup -- pr-opened --task <id> --pr <pr-url> --human-hours <N> --body-file -   # record the PR — REQUIRED, and it verifies itself
npm run clickup -- status --task <id> --status "In review"             # hand off (assignees auto-cleared)
npm run clickup -- ask --task <id> --status "Needs your input" --body-file -   # escalate: card + status together
npm run clickup -- comment --task <id> --body-file -                   # a plain note
npm run clickup -- waiting [--task <id>]                               # read-only: is this ACTUALLY waiting on Dane?
npm run clickup -- describe --task <id> --body-file -                  # REPLACE the description (left column)
```

**`describe` REPLACES the description.** The spec and acceptance criteria live
there; an outcome report is a `comment`, never a `describe`.

**Escalating is one command, not two.** `status --status "Needs your input"`
refuses on its own. Use `ask`, whose body is the operator card:

```
@@ASKED     his own words that caused this ticket, verbatim — never invented
@@WHEN      optional — when and where he said it
@@CONTEXT   the problem and the fix in plain English, 50-100 words (enforced)
@@NEEDED    the specific ask; give him named options where you can.
            Its LAST line is his move: "Your move: Merge", "Your move: Close"
            or "Your move: Reply", then a short reason (enforced). Never tell
            him to move a ticket himself; offer "Your move: Close" instead.
@@EVIDENCE  required ONLY when the ask costs money or cannot be undone
```

**Hand-offs that are genuinely his** (CLAUDE.md names four): a real secret
value, a billing screen, a browser login, or a decision only he can make.
Each of those is an `ask`, saying which of the four it is. Anything else, you
run yourself.

**A real secret value goes in on the Doppler dashboard, never by a command
(`DOCTRINE 4.1`, SP-394).** The Doppler command that sets or uploads a secret
shows the value: with no value it echoes what he types and waits for a line
holding only `.`, and with one it prints the value back, `--silent` or not.
On 11/18 that line on UB-7 stored nothing, he replied "done", and the ticket
went on with no keys. `ask` refuses a card whose `@@CONTEXT` or `@@NEEDED`
carries it (exit 2). The card instead:

- **Names each key, and says per key who makes the value.** "You make this
  one up: any long random string; a password manager can make one", or "You
  get this from <where>, under <which page>". Never leave him waiting for a
  value nobody will give him.
- **Links the dashboard page** for the project's `dopplerProject` and
  `dopplerConfig` in `spirality.project.json`:
  `https://dashboard.doppler.com/workplace/<workplace>/projects/<project>/configs/<config>`.
  `<workplace>` is the one field
  `doppler me --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).workplace.slug))'`
  prints (only that field, never the token preview).
- **Says what happens after his "done":** the lane checks the names.

**When the ticket comes back after his reply,** check before building:

```bash
doppler secrets --only-names --project <project> --config <config>
```

It prints names, never values. Every key the card named is there: build. Any
is missing: build nothing; a fresh `ask` naming the missing keys, with the
same dashboard link, and the ticket waits on him again.

**SQL for Dane to run goes in the SQL handoff block (`DOCTRINE 6.5`).** Never
paste the SQL and never list bare paths. One block per file, in the order they
run, in `@@NEEDED` above the `Your move:` line; plain text, never in a code
fence (a fenced link cannot be clicked); two blank lines above and below each
block; one line outside the block saying what the file changes and whether it
touches anything that exists. The link names a commit, never a branch: a file
already on `main` links by `main`, a file only on your branch by the pushed
commit (`git rev-parse HEAD` after `git push`). A whole card:

```
@@ASKED
<his words that caused the ticket, verbatim>

@@CONTEXT
<50-100 words: what the file is for, and why only he can run it>

@@NEEDED
Run this file in the database's SQL editor, then reply here.

It adds two new fields to assets; it changes nothing that exists.


#################### RUN SQL IN SUPABASE ####################

https://github.com/<owner>/<repo>/blob/<commit>/docs/SQL/<file>.sql

##########################################################


Your move: Reply "ran it" once it has run, so the pull request can go to review.
```

The fence above is only this page showing you the card; the card's text has
none.

## Never say something is waiting on Dane without checking

```bash
npm run clickup -- waiting --task <id>
```

Exit **0** nothing of his / **3** something IS his / **1** could not tell.

## Workflow

1. **Claim the next task.**

   ```bash
   npm run clickup -- pass-reconcile
   npm run clickup -- wip-check
   npm run clickup -- queue --claimable --note-holds
   npm run clickup -- claim --task <id>
   ```

   `wip-check` exit 3 (`full:`) ends the pass before the queue is read
   ("Then: is there room for another ticket?" above).

   `--claimable` returns every `Rework` ticket before any `Queued` one —
   rework oldest-first, then queued by priority-then-oldest. A `Rework` ticket
   is a send-back: it already has a branch, an open PR and review notes.
   Finishing one is cheaper than starting something new. If the list comes
   back empty, report "queue empty" and stop — do not invent work.

   `claim` reads the ticket's own status and guards the write on it. Exit 3
   means it moved underneath you, or its `Waits on:` line names a ticket
   still open (or a line it cannot read) — take the next task. Exit 1 on a
   `Waits on:` ticket that cannot be read: say so on the ticket, take the
   next.

   **Same files as work in flight (SP-351).** A `Queued` ticket that shares
   any file with an open pull request, or with a ticket in `Building` that
   has no pull request yet, is held: `--claimable` leaves it out
   (`skipped <id>: held for shared files: ...`), `claim` refuses it with
   exit 3, and `--note-holds` tells the held ticket once which tickets and
   files hold it. Take the next ticket in its place; the held one takes its
   normal place in line the moment those pull requests merge or close. It is
   not waiting on Dane and needs no `ask`. A `Rework` ticket and a merge
   fix-up ticket are never held: their pull request already exists. The
   files are the ticket's `Likely files:` line (`docs/LOOP_CONTRACT.md`).
   When the queue prints `note <id>: names no files it will change` for the
   ticket you are about to claim (or `claim` exits 2 saying so), read its
   spec, work out the repository files it will change, write them with
   `likely-files --task <id> --files <path>,<path>`, then run `claim` again,
   which checks them. When the queue prints `same-file check NOT applied`,
   carry on and say so in your report, as for the cap.

   **A `Queued` ticket for a hand-run session only.** When the ticket at the
   head of the queue says in its description that only a hand-run session may
   build it, this pass never builds it, but it does re-check, every pass,
   whether what it waits on is still open. Skipping it on the last comment's
   reasons is how Spirality's SP-25 sat in `Queued` for 31 hours after both
   its blockers had cleared (Spirality's SP-296), with nothing telling Dane.

   - **List its blockers:** every id on its `Waits on:` line, plus each
     blocker its newest hold-back comment names: another ticket, or a word
     Dane must write on a bus ticket (such as "resume auto-merging").
   - **Re-check each blocker now, never by copying the last comment.** `get`
     each named ticket (closed or `Live` = cleared); for a word on a bus
     ticket, read that ticket's `comments` for it. A blocker clearing on
     another ticket adds no comment to this one, so the old reasons are no
     evidence at all.
   - **All cleared:** hand the ticket to Dane with `ask --status "Needs your
     input"`. The card says which blockers cleared, when, and how this pass
     checked each one, and that the ticket is ready for a hand-run session.
     Then take the next ticket as usual; the pass does not build it.
   - **Some still open:** skip it. The skip note (your log line, and any
     comment) names only the blockers still open, each with what was checked
     ("SC-791 is still In review"). Never "nothing has changed since …" on
     its own, and never a blocker that has cleared.
   - **A blocker that cannot be checked** (its ticket unreadable, another
     tracker out of reach): name it in the skip note as unreadable. It is
     never counted as cleared.
   - **Do not repeat the same skip comment every pass.** Write a new comment
     only when the still-open blockers differ from what the newest note
     already says; otherwise the log line is enough.

   **On a `Rework` ticket, do NOT start a second branch.** `get` prints the
   recorded PR. Check out that branch into a worktree
   (`git worktree add .claude/worktrees/<slug> -b <branch> origin/<branch>`),
   read the send-back in `comments`, fix what it named, and push to the SAME
   PR. A `MAIN MOVED: ... — conflict` note newer than the send-back is part of
   the rework even when review did not name it.

   The eight statuses are `Requested → Rework → Queued → Building →
   In review → Needs your input / Ready to launch → Live`. `Requested` is
   Dane's unspecced words from the tracker page: never claimed, never built
   from; a spec pass owns it. Two belong to Dane and no loop
   may set or clear them except through `ask`. **Assignment is the handoff
   signal**: moving into his statuses assigns him; moving into a machine
   status clears assignees. `status` enforces both and verifies they stuck.

2. **Get an isolated workspace — MANDATORY.** One worktree and one branch per
   task, off the latest `main`. Never build in the main folder; never edit
   `main` (a hook blocks it). Run this as ONE command:

   ```bash
   MAIN="$(git rev-parse --path-format=absolute --git-common-dir | sed 's#/\.git$##')" && \
     git -C "$MAIN" fetch origin --quiet && \
     git -C "$MAIN" worktree add "$MAIN/.claude/worktrees/<task-slug>" -b <task-slug> origin/main && \
     cd "$MAIN/.claude/worktrees/<task-slug>" && \
     if [ -f package-lock.json ]; then npm ci; fi
   ```

   `<task-slug>` = short kebab-case name from the task. Do ALL work for this
   task inside that worktree.

3. **Build to the acceptance criteria.** Implement exactly what the task's
   Scope and Acceptance criteria describe. Respect the Non-goals. Keep every
   rule in `CLAUDE.md` → "Engineering rules": nothing project-specific
   hard-coded in substrate code; move StarCaster's modules with their tests,
   never rewrite; every ClickUp write read back; a failed step says so.

   **Read the ticket's files first.** When `get` prints `attachments:` lines
   (anything but `attachments: (none)`), they are part of the spec. Save them
   outside the repository and read every one (pictures and text both; the
   Read tool opens a picture) before writing any code:

   ```bash
   npm run clickup -- attachments --task <id> --to /tmp/<id>-attachments
   ```

   It prints `saved <path> (<size> bytes)` per file and exits non-zero naming
   any file that did not save; a file that did not save is a failure you
   report, never one you build past. Never copy a file into the repository or
   a pull request. `attachments: COULD NOT BE READ` means the ticket's files
   are unknown: say so on the ticket and in your report, and never treat it
   as none.

   **Apply the kind he chose before building (SP-346).** `get` prints the
   ticket's `kind:`. When Dane's reply to the intake card (or any later
   comment of his) names a different kind than that line (Feature, Fix,
   Operational or Documentation), his word wins: set it and read it back
   before any code,

   ```bash
   npm run clickup -- classify --task <id> --kind <the kind he named>
   ```

   and fix the description's `## Kind` line with `describe` if it has one.
   A `kind: (none)` ticket whose description has a `## Kind` line gets that
   kind the same way. Never guess one otherwise.

   **Verify the premise before building it.** A defect ticket is a claim to
   check, not a spec to obey. If the premise is wrong, post the correction on
   the ticket FIRST (a `comment`), then build what is true.

4. **Run the gates — the definition of done.**

   **Catch up with `main` first.** Another ticket may have merged while you
   built. Run `npm run clickup -- get --task <id>` and read its `main:` line:
   the relay writes a `MAIN MOVED:` note on your ticket after every merge.
   On anything but `no-overlap` (or always, it is cheap), merge it in now,
   before review finds it: `git fetch origin && git merge origin/main
   --no-edit`. A real conflict here is yours to resolve, inside the task's
   scope, with the conflicted files read and understood, never by taking one
   side blind.

   ```bash
   npm run verify
   ```

   `verify` is the ONE name for the gates; CI runs the same script. If your
   task adds a new kind of check (typecheck, build, a test suite), add it to
   `verify` in `package.json` so every later task inherits it. If a gate fails
   and you cannot fix it **within the task's scope**, `ask` and stop. Do not
   force a broken build through, and do not widen scope to chase an unrelated
   failure.

   If the change has a visible surface, open it (the `run` skill, or
   `npm run dev` once it exists) and walk the ticket's "How to test" steps
   yourself. Say in the PR where you looked and what you saw.

5. **Add a plain-English work-log entry.** Write one new file,
   `docs/work-log/<YYYY-MM-DD>-<branch>.md` (today's date, Mountain time, and
   this task's branch name): a heading `## <date> — <title> (#PR)`, then what
   changed and why it mattered, the way you would explain it to a
   non-programmer. One file per PR, so two PRs built at once never clash on
   the log. This entry rides in the task's own PR, so the log lands on `main`
   with the work. Never add entries directly on `main`. `docs/WORK-LOG.md` is
   the older history, closed to new entries: never edit it.

   You do not have the PR number yet. **Never amend a pushed commit to add
   it** — that needs a force-push, which is forbidden. Either commit the code,
   push, open the PR, then add the work-log entry as a second commit; or open
   the PR as a draft first, read the number, then write the entry.

6. **Commit and open the PR.**
   - Inspect `git diff --cached` before committing: no stray edits, no
     generated files, no `.env`. **This repository is public.**
   - Commit message ends with the Co-Authored-By trailer.
   - **The PR title is the ticket name, copied exactly**
     (`npm run clickup -- task-name --task <id>` prints it). Dane pairs the
     Live tickets against the deploy list by name.
   - Push the branch and open a PR to `main` with `gh pr create`. The body
     must include **the ticket link `pr-opened` reads**, on a line of its
     own: the ticket's page, `Ticket: <trackerUrl>/t/SP-12`, with the
     `trackerUrl` written in `spirality.project.json`
     (`Ticket: http://mac-mini.local:4180/t/SP-12`). Not the `url:` line
     `get` prints: that is the API address the loop itself uses. `pr-opened`
     refuses
     without it and prints the exact line, a plain-language
     summary, and the task's "How to test" steps. End with the Generated-with
     trailer.
   - **Link files by commit, never by branch**, in the PR body and on the
     ticket: a GitHub file link names a commit (`.../blob/<commit>/<path>`, the commit from `git rev-parse HEAD` on the pushed branch), `main` for a file already on `main`, or the pull request's files tab (`.../pull/<n>/files`), never a branch: the branch is deleted when Dane merges and the link 404s. `comment`, `ask`, `describe` and `task` refuse a branch link (exit 2).
   - Wait for the `verify` check: `gh pr checks <pr> --watch`. If no check
     appears after a couple of minutes, `gh pr view <pr> --json
     mergeable,mergeStateStatus`: `CONFLICTING` means merge `origin/main` in
     (`git merge origin/main --no-edit && git push`); only on `MERGEABLE` is
     an empty nudge commit the right move.
   - **Only ordinary pushes.** If a push is rejected because the branch is
     behind, merge `origin/main` in — never rebase-and-force.

7. **Record the PR on the ticket — with the command, and check what it says.**

   ```bash
   echo "Why that estimate: <one line>" | \
     npm run clickup -- pr-opened --task <id> --pr <pr-url> --human-hours <N> --body-file -
   ```

   It refuses if the PR body has no link back to the ticket, posts the one
   line the review and merge steps read (`PR opened: <url>`), and parses it
   back. **A non-zero exit fails the run** — do not hand the ticket to review.

   **`--human-hours` goes on every time.** It is the Reporting page's count of
   how much human programmer work the loops did (SP-78). Estimate it from the
   finished pull request, the same way every time: the hours an experienced
   programmer **new to this code** would take to read the ticket, find their
   way around the files it touches, make the change, write the tests and get
   it through review. Not how long this pass took, and not a guess at what
   Dane would pay. Whole or half hours, more than 0 and at most 200 (anything
   else exits 2 and writes nothing; a job worth more than 200 should have been
   sliced). The reason is ONE line on stdin, starting `Why that estimate:`,
   naming what drove the number (e.g. "Why that estimate: a new module with
   tests, two existing tests extended, one skill file edited"). On a `Rework`
   ticket, the newest `PR opened:` comment is the one counted, so if you
   record the PR again, estimate the whole pull request as it now stands.

8. **Hand off to review.** **A catch-up ticket** ("Find out why PR #N
   (<branch>) will not merge", no PR of its own: you merged `main` into that
   PR's branch and skipped `pr-opened`) can find its PR already merged by
   the relay while you waited on the checks. After your "Done:"
   comment, run `npm run clickup -- fixup-live --task <id> --if-status
   Building`. Exit 0: that PR is merged, so the ticket is now Live with a
   note naming the merge; finish, nothing for review or Dane. Exit 4 (not
   merged yet): hand off as below. Exit 1: say so in your report and hand off
   as below.

   Otherwise: `npm run clickup -- status --task <id> --status
   "In review"`. Leave it unassigned (it is the machine's turn). **Do NOT
   merge** — merges happen only on Dane's explicit say-so. `loop-review` takes
   it from here.

9. **Report** which task you built and the PR number, then finish.

## Guardrails

- **A PASS MAY NOT END WITH ITS TICKET STILL IN `Building`.** `Building` is a
  status no loop claims from, so a ticket left there is unreachable, not late.
  Before you report, the ticket is in `In review` (finished), `Rework` or
  `Queued` (handed back on purpose, with a comment saying why), or
  `Needs your input` (escalated with `ask`).
- **YOU CANNOT PROMISE TO COME BACK.** A pass ends when it stops producing
  output. If you are waiting on checks, wait inside the pass, then move the
  ticket. If you cannot wait, hand it back to `Rework` with an honest note.
- **One task, one worktree, one PR.** Never build two tasks in one branch.
- **The PR and the ticket must name each other.** `pr-opened` enforces both
  directions.
- **Never touch a task that is not `Rework` or `Queued`.** `claim` refuses them.
- **Never set `Ready to launch` and never clear `Needs your input`.** Those
  are Dane's. A build loop never sets either one and never merges.
- If the task description is too vague to build safely, `ask` for a
  `loop-spec` pass — don't guess. Name in `@@NEEDED` what is missing.
- **If a task is bigger or riskier than one unattended pass should build**,
  `ask` before building and offer named slices, smallest-and-safest first.
  Then build only the slice he names, narrowing the description with
  `describe` first.
- **A ticket title is a short, plain statement of what the ticket does**,
  starting with a verb:
  *"Move WaveCenter from ClickUp to Spirality tracker"*, not
  *"WaveCenter still runs on ClickUp: move it to the tracker"*. Fix a cryptic name on the ticket first, then copy it to the PR.
- Leave the worktree in place until the PR merges; `loop-review` may reuse it.
