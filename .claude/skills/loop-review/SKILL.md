---
name: loop-review
description: Pick the next "In review" task from the Spirality queue in the tracker, independently verify its pull request (`npm run verify` + code review + a real test pass), then either mark it "Ready to launch" and ping Dane to merge, or send it back to "Rework" with notes. Designed to be run on a timer with `/loop 30m loop-review`. Never merges on its own.
---

# Loop: Review

Step 3 of 3 in the Spirality development loop (spec → build → review).
See `docs/LOOP_ENGINEERING.md` for the whole system.

Each run verifies **one** task's PR, so Dane only ever sees PRs that already
passed an independent check.

## Before anything: one reviewer

Two review passes verifying the same ticket overwrite each other's verdict.
Spirality has no scheduled runner yet, so: **do not start this loop if
another session is already running it.**

## Ticket access: the direct script, not the connector

```bash
npm run clickup -- queue --status "In review"                                 # FIRST LINE is the one to review
npm run clickup -- get --task <id>                                            # the task, the recorded PR, the send-back count
npm run clickup -- comments --task <id>                                       # the PR URL and every earlier verdict live here
npm run clickup -- verdict --task <id> --pass --if-status "In review" --body-file -   # RECORD THE VERDICT FIRST — the gate reads this
npm run clickup -- verdict --task <id> --fail --if-status "In review" --body-file -   # ... or the send-back, same shape
npm run clickup -- ask --task <id> --status "Ready to launch" --body-file -   # pass: card + status together
npm run clickup -- ask --task <id> --status "Needs your input" --body-file -  # a judgment call only he can settle
npm run clickup -- status --task <id> --status Rework --if-status "In review" # send back (assignees auto-cleared)
npm run clickup -- comment --task <id> --body-file -                          # a plain note
npm run clickup -- waiting [--task <id>]                                      # read-only: is this ACTUALLY waiting on Dane?
```

## The two columns

Detail goes **left** (the description). The **right** column carries only the
operator card. Handing a ticket to Dane is one command, not two: `status`
refuses to set `Ready to launch` or `Needs your input` and points at `ask`:

```
@@ASKED     his own words that caused this ticket, verbatim — never invented
@@WHEN      optional — when and where he said it
@@CONTEXT   the problem and the fix in plain English, 50-100 words (enforced)
@@NEEDED    the specific ask, under a banner he can spot without reading
@@EVIDENCE  required ONLY when the ask costs money or cannot be undone
```

### A `Ready to launch` card must carry a link he can click

If the work has **any visible surface**, the card names a URL he can open and
says what he should see there. Spirality is tooling, so the surface is
usually a command: give the exact command to paste and the output it prints.
If there is a page, give its URL. Then two or three lines of **what to look
for**, in his words.

**No link, on work with a visible surface, is a review FAILURE** — send it
back. Work with genuinely no visible surface says so in one line (*"nothing to
look at; this is a check that runs in CI"*).

## Workflow

1. **Take the next task.** The first line of `queue --status "In review"`. If
   none, report "nothing to review" and stop. Read the task (`get`) and its
   comments (`comments`) to find the PR the build loop recorded.

2. **Check out the PR in a worktree.** Reuse the build worktree if it is still
   there, or add one from the PR branch:
   `git worktree add .claude/worktrees/<slug>-review -b <branch>-review origin/<branch>`.
   Run `npm ci` if there is a lockfile. Merge `origin/main` in first so you
   test the code as it would land.

   **A conflict is a fast send-back.** If `get` shows `main: ... conflict`
   (the relay's `MAIN MOVED:` note) and that merge of `origin/main` does
   conflict, stop here: `verdict --fail` with "conflicts with main after
   PR #<merged>, in <files>", then `status --status Rework --if-status "In
   review"`. Do not spend a test pass on code that cannot land as it is. If
   the merge goes in cleanly after all, the note is out of date; carry on.

3. **Verify independently — do not trust the build loop's word.**
   - Re-run the gates: `npm run verify`.
   - Run `/code-review` on the branch diff for correctness and quality.
   - **Actually exercise it.** Open the affected screen and walk the task's
     "How to test" steps. A green test suite is not proof the feature works.
   - Check the ticket: are all acceptance criteria met? Any Non-goals
     violated? Every `CLAUDE.md` engineering rule kept (nothing
     project-specific hard-coded, modules moved not rewritten, every ClickUp
     write read back, a failed step says so)?
   - Check the premise: a defect ticket must cite its mechanism, and where the
     build found the premise wrong, the correction must be on the ticket.
   - **This repository is public.** Grep the diff for anything that looks
     like a key, token or password. One hit is a send-back, whatever else is
     right.

4. **Decide — and record the verdict BEFORE you move anything.**

   ```bash
   npm run clickup -- verdict --task <id> --pass --if-status "In review" --body-file -   # or --fail
   ```

   **`--if-status` is required, and it is the guard that matters.** A review
   takes minutes, and the ticket may have moved meanwhile. If the command
   exits 3, **re-read and stand down**: do not write the verdict, do not move
   the status, take the next task.

   `Ready to launch` is Dane's "safe to merge" signal, and `ask`/`status` both
   **refuse** to set it unless the newest verdict on the ticket is a PASS.

   `--body-file -` takes your one-line reason on stdin — what you ran, what
   you walked through, what convinced you. Then:

   - **Pass** → `ask --status "Ready to launch"`. `@@ASKED` carries the
     instruction the ticket came from; `@@CONTEXT` says in 50-100 words what
     changed and what he will see; `@@NEEDED` is the merge approval, with the
     PR link, the preview link, the exact address and clicks to check it, and
     **how to merge**, in exactly these words:

     > **To merge:** reply with one of the merge phrases as the whole comment
     > and nothing else — `merge`, `merge it`, `ship it` or `approve` (the
     > list is `mergePhrases` in `spirality.project.json`). The relay
     > (`com.spirality.relay`, every 10 minutes) re-checks every gate, merges
     > PR #N and moves this ticket. "merge PR #N" is *not* a phrase and does
     > nothing. If `./scripts/install_loop_runner.sh --status` says the relay
     > is not loaded on the Mini, tell a session **"merge PR #N"** instead.

     (Write it into the card as plain lines, not a blockquote — ClickUp deletes
     `> ` lines.) Do **NOT** merge.
   - **Fail, and a machine can fix it** → `verdict --fail` first (its FIRST
     LINE is the reason the board shows — one short clause), then
     `status --status Rework --if-status "In review"`. Do not fix it yourself
     inside the review step — keep build and review separate.

     **`verdict --fail` refuses on what would be the fourth send-back** (exit
     3) and prints what each round found. Three rounds means the **spec** is
     wrong, not the build: `ask --status "Needs your input"` with all three
     rounds named one line each and `@@NEEDED` offering named options
     (respec / split / drop).
   - **Fail, and only a human can settle it** (ambiguous task, contradictory
     acceptance criteria, a product decision) → `ask --status "Needs your
     input"` with named options to choose between.

5. **Report** the task and your verdict, then finish.

## Guardrails

- **Never merge autonomously.** `Ready to launch` ≠ merged. Dane merges by
  writing a merge phrase on the ticket (the relay is his hands and re-checks
  every gate, `verify` included) or by telling a session to. The review loop
  never does.
- **Only Dane moves a task out of `Ready to launch` or `Needs your input`.**
- **Independence is the whole point.** Re-run everything; don't rubber-stamp.
- **Never write a verdict past a refused guard.**
- **Never force a fourth send-back through.** `--fourth-round-anyway` is a
  written claim for the case where Dane has already settled the ticket.
- **A gap you noticed is not a ticket.** A finding outside this PR goes in
  your verdict note and your run report, not into the queue, unless a real
  failure actually cost something.
- If the PR has merge conflicts with main, send it back to `Rework` with a
  note — don't resolve conflicts blind.
- Keep review comments plain-language and specific enough that the next build
  pass can act on them without re-reading the code.
