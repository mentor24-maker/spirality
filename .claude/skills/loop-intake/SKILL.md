---
name: loop-intake
description: Take the oldest "Requested" ticket (a request Dane filed from the tracker page), write it up as a proper spec (or several, one per pull request) with his words kept verbatim, and hand every resulting ticket to him in "Needs your input" to approve with "go". Runs unattended on the Mini as its own launchd lane. Never writes code, never queues anything itself.
---

# Loop: Intake

The step before step 1. `loop-spec` is a session with Dane; this is the
unattended version for the requests he files himself from the tracker page
(`/new`), which land in `Requested`. See `docs/LOOP_ENGINEERING.md` for the
whole system and `docs/LOOP_CONTRACT.md` for the statuses.

Each pass handles **at most one** `Requested` ticket. You write tickets; you
do NOT write code, open a worktree, or touch a pull request.

## Ticket access

Every touch goes through **`npm run clickup -- <command>`**, a full standalone
command each time. Doppler supplies the token; on the Mini the runner names
this lane's own sign-in (`TRACKER_TOKEN_LOOP_INTAKE`). The moves this pass
makes:

```bash
npm run clickup -- queue --status Requested                     # the requests, first line = the one to take
npm run clickup -- get --task <id>                              # his title and his words
npm run clickup -- comments --task <id>                         # anything he added since
npm run clickup -- task --name "..." --status Requested --tags <tag> --body-file -   # a further slice
npm run clickup -- describe --task <id> --body-file -           # REPLACE the description with the spec
npm run clickup -- ask --task <id> --status "Needs your input" --body-file -          # hand it to him
npm run clickup -- comment --task <id> --body-file -            # a plain note (failures)
```

Every one of those reads its own write back and exits non-zero when it did not
stick. **A non-zero exit is a failure you report**, never one you talk past.

## Workflow

1. **Find the request.**

   ```bash
   npm run clickup -- queue --status Requested
   ```

   Empty: print exactly one line, `loop-intake: no Requested ticket — nothing
   to do.`, and stop. Write nothing anywhere.

   Otherwise take the **first line** (the door orders priority-then-oldest;
   a request from the page carries no priority, so the first line is the
   oldest). Read it with `get` and `comments`.

2. **Keep his words.** His words are the ticket's **name** and its
   **description** exactly as `get` prints them, plus any comment of his on
   the ticket. Copy them byte for byte; never tidy, shorten or "fix" them.

   **A ticket that already has an `## Asked` heading was specced by an
   earlier pass that stopped before handing it over** (a slice filed just
   before a crash, say). Do not spec it again: his words are the fenced block
   under `## Asked`, the spec is already there; go straight to step 5 for that
   ticket alone.

3. **Decide: clear, or a question.** Read the repository as far as you need
   to (`CLAUDE.md`, `docs/`, the files the request touches) to know what it
   would take. A request is **too unclear to spec** when two reasonable
   builders would build different things from it, or when the outcome he
   wants cannot be told from his words. Then do not guess:

   - Post the question with `ask` (step 5's card), with `@@NEEDED` holding the
     question, named options where you can give them.
   - **Change nothing else**: no `describe`, no new ticket.
   - Report and stop.

   Known gap (`docs/LOOP_CONTRACT.md`): his answer moves the ticket to
   `Queued` with its raw words still the description, and the build loop's
   own "too vague, ask" rule is what stops it there. Say so in `@@CONTEXT`
   ("your answer sends it to the build queue as written").

4. **Write the spec.** Build it from `.claude/skills/loop-spec/SKILL.md`
   step 2 and 3: the same sizing rules (one pull request's worth,
   independent, reviewable in a couple of minutes) and the same description
   shape, with one heading added first:

   ````
   ## Asked
   ```
   <his title>

   <his description, verbatim>
   ```

   ## Goal
   ## Scope
   ## Non-goals
   ## Affected files / artifacts
   ## Acceptance criteria
   ## How to test
   ## Risk
   ````

   If his text itself contains a line of three backticks, fence it with four
   (or with `~~~`) so the block cannot close early. Never a `> ` blockquote:
   the script refuses them.

   **Affected files are real paths, checked**, and the "How to test" steps
   follow `loop-spec`'s rule: a link he can click, or an exact command with
   the output it should print.

   **One pull request's worth:** `describe` the request's own ticket with the
   spec. Keep its name unless it fails `loop-spec`'s naming rule (what breaks
   and who feels it); a name you cannot improve without changing his meaning
   stays as he wrote it.

   **More than one:** this ticket becomes the **first** slice (smallest and
   safest first). File each further slice FIRST, before you rewrite this
   one, so a failure leaves his request untouched:

   ```bash
   npm run clickup -- task --name "..." --status Requested --tags request-form --body-file -
   ```

   Each slice gets the same shape, the same `## Asked` block (his whole
   request, verbatim), the same tags as the original (`get` prints them;
   `request-form` when it has none), and, right under `## Asked`:

   ```
   ## Order
   Sliced from <original id> ("<original name>"), slice <n> of <total>.
   Waits on: <id of the slice it needs merged first>
   ```

   (Leave out the `Waits on:` line for a slice that needs nothing first.)
   They are filed as `Requested` so no build loop can claim one before he has
   approved it. Then `describe` the original with slice 1, whose `## Order`
   names the other slices' ids.

   File at **normal** priority or none. Never Urgent, never High.

5. **Hand every ticket to him.** For the original and each slice, one `ask`:

   ```
   @@ASKED
   <his title and description, verbatim — the same words as under ## Asked>
   @@CONTEXT
   What you understood him to want and what this ticket does about it, in
   plain English, 50-100 words. For a slice: which slice of how many, and
   what the others cover.
   @@NEEDED
   Reply "go" to queue it as written, or reply with what to change.
   ```

   If `ask` refuses because **his own comment is the newest** on the ticket
   (exit 2), that comment is part of the request you just read, not an answer
   to a question: run the same `ask` again with `--after-his-answer`.

6. **Account for every write.** Collect the outcome of each `task`,
   `describe` and `ask`. If any one failed (non-zero exit, a read-back that
   did not match):

   - Post a `comment` on the **original** ticket naming each failed step and
     the ticket it was for, and what was left in which status.
   - Print the same, starting `FAILED:`.
   - Never print a success line for that step.

   A slice that was filed but whose `ask` failed is still in `Requested` with
   `## Asked` in its description: the next pass hands it over (step 2).

7. **Report** in a few lines: the request (id and exact name), each ticket
   now in `Needs your input` (id and exact name), and anything that failed.

## Guardrails

- **One request per pass.** Never a second `Requested` ticket in the same
  pass, even when the first was quick.
- **Never move a ticket anywhere but `Needs your input`**, and only with
  `ask`. Never `Queued`: his "go" is what queues it (the relay's hand-back).
- **Never invent his words.** `@@ASKED` and `## Asked` are his, verbatim.
- **Never code.** No worktree, no branch, no pull request, no edit to the
  repository.
- **Never Urgent.** Urgent is his lane.
- **Plain language** in names, specs and cards: the reader is Dane.
