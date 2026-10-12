# Loop Engineering on Spirality

How Spirality is built: a **spec → build → review** loop, the same process
StarCaster runs, pointed at Spirality's own ClickUp queue. Dane specs work in
plain language; agent sessions build it into pull requests and independently
review them; Dane merges. Nothing reaches `main` without a passing CI check
and his word.

This file was seeded from WaveCenter's copy on 2026-10-11. Spirality's job is
to make it ONE document for every repository that runs the loop; until then it
reads as WaveCenter's did, with the names changed.

This is the seed version. StarCaster grew a bus relay, auto-merge lanes,
pacing curves and a heartbeat over three months of incidents; Spirality
starts with the parts that were right from day one and adds the rest only
when a real cost shows up. Where a rule here was learned on StarCaster, its
guide (`~/WebApps/starcaster/docs/LOOP_ENGINEERING.md`) has the incident.

## The three steps

| Step | Skill | Who runs it | What it does |
|---|---|---|---|
| 1 | `loop-spec` | a session, with Dane | interviews him, files small tasks with acceptance criteria and test steps |
| 2 | `loop-build` | a loop | claims the next task, builds it in its own worktree, passes `npm run verify`, opens a PR, hands it to review |
| 3 | `loop-review` | a loop | independently re-verifies the PR, then hands it to Dane (`Ready to launch`) or back to build (`Rework`) |

The skills live in `.claude/skills/`; Claude Code discovers them nowhere else.

## ClickUp access — the ids, written down once

Every ClickUp touch goes through **`npm run clickup -- <command>`**
(`scripts/clickup.mjs`, wrapped in Doppler by `package.json`, so the token is
supplied without any agent or human handling it). The claude.ai connector's
shared budget starves under loop traffic; ClickUp's own API allows about 100
requests a minute. Use the connector only when the script itself is broken,
and say so.

| Thing | Id |
|---|---|
| Workspace ("Alphire AI Agency") | `90141423066` |
| Spirality **space** | `90146476540` |
| **Loop Queue list** (Spirality) | `901418065068` |
| Dane's inbox — his **developer** seat, dane@alphire.agency | `48012725` |
| The machine — **Pulse** / mentor24, holds the token; **never assign it** | `54254347` |
| StarCaster's Loop Queue — a different project; **never file Spirality work there** | `901418546619` |

**Id trap:** a space id where a list id belongs earns ClickUp's misleading
"Team not authorized" 401. `npm run clickup -- lists` resolves list ids by
name.

**Whose seat the token is.** Dane is two members of this workspace: his own
developer seat (`48012725`) and Pulse, the workspace's service account
(`54254347`). The API token in Doppler acts as **his own seat** — `npm run
clickup -- whoami` says "Acting as: Dane" — exactly as StarCaster's does. So
every comment the script posts ends with a `[machine]` marker line, stamped
at the one place comments are sent, and every reader that asks "did Dane
speak last?" skips stamped comments. Never assign Pulse.

The everyday commands (`npm run clickup` bare prints the full list):

```bash
npm run clickup -- whoami                                       # proves the token works; says who it acts as
npm run clickup -- queue --claimable                            # first line = the task loop-build should claim
npm run clickup -- queue --status "In review"                   # first line = the task loop-review should take
npm run clickup -- get --task <id>                              # header + body, recorded PR, send-back count
npm run clickup -- comments --task <id>                         # the comments, oldest first, Mountain time
npm run clickup -- waiting [--task <id>]                        # is this ACTUALLY waiting on Dane? exit 0 no / 3 yes
npm run clickup -- task --name "..." --status Queued --priority high --tags epic --body-file -   # file a ticket
npm run clickup -- claim --task <id>                            # loop-build's atomic claim
npm run clickup -- status --task <id> --status "In review"      # a machine-status move; assignees auto-cleared
npm run clickup -- ask --task <id> --status "Needs your input" --body-file -   # hand it to Dane: card + status + assignment
npm run clickup -- pr-opened --task <id> --pr <pr-url>          # record the PR (required; verifies both directions)
npm run clickup -- verdict --task <id> --pass|--fail --if-status "In review" --body-file -   # the review verdict
npm run clickup -- describe --task <id> --body-file -           # REPLACE the description (left column)
npm run clickup -- comment --task <id> --body-file -            # a plain note
npm run clickup -- tag --task <id> --add wont-do                # kill or park (see below)
```

Every write reads itself back. A 200 from ClickUp proves a request landed,
not that the right thing did: statuses are per-list (a bare PUT returns 200
for a status the list does not have), descriptions can save empty, and
ClickUp **deletes `> ` blockquote lines** from comments and descriptions
without saying so. The script refuses a blockquote before sending.

## The seven statuses — and the two that are yours

| Status | What it means | Whose move |
|---|---|---|
| `Rework` | review sent it back — a branch and a PR already exist | machine |
| `Queued` | waiting for a build loop to pick it up | machine |
| `Building` | a loop is writing the code | machine |
| `In review` | a loop is checking that code against the task | machine |
| **`Needs your input`** | stuck — a question or decision only you can settle | **yours** |
| **`Ready to launch`** | built and independently verified, waiting for your go | **yours** |
| `Live` | merged and shipped — closed, out of your open view | — |

The two human statuses ask different things. `Needs your input` wants an
**answer**: a loop stopped and wrote you a plain-language question. `Ready to
launch` wants a **yes**: nothing is wrong, it is finished and waiting on the
merge only you authorize. On a normal day you can ignore the other five.

**`Rework` exists** so a half-built ticket is never mistaken for one nobody
has started. loop-build drains every `Rework` ticket before any `Queued` one,
oldest first, priority ignored: priority says what to *start*; rework is not
started, it is finished.

Two rules keep it honest:

- **No loop ever puts a ticket into `Live`.** Only a merge does, and only you
  authorize a merge.
- **No loop ever takes a ticket out of `Needs your input` or `Ready to
  launch`.** Once handed to you it stays yours until you act. (StarCaster has
  a relay that reads your reply and moves the ticket for you. Spirality does
  not yet: when you answer a question, also drag the ticket back to `Queued`,
  or tell a session to.)

`Live` is a **closed**-type status in ClickUp. That is what makes finished
work disappear from the open view. The click-by-click setup of this status
set is `docs/CLICKUP_SETUP.md`.

### Assignment is the handoff

Your "what needs me" is ClickUp's own **Assigned to me**, which spans every
space. Loops assign you when a ticket enters one of your two statuses and
clear assignees when it returns to a machine status; the `status` command
enforces both and verifies they stuck. A ticket in a machine status with you
still assigned is a bug.

### The operator card

Anything a loop puts in front of you arrives as one comment in a fixed shape,
posted by `ask` together with the status move so the two can never come apart:
your own words that caused the ticket (in a fence, verbatim), what's going on
in 50-100 plain words, and the ask under a red **NEEDED FROM DANE:** banner,
last on the card. An ask that spends money or cannot be undone must carry the
command that proves it, its real output, and when it was run.

Detail goes in the **description** (left, wide); the card is the only thing in
the **comments** (right, narrow).

### Killing and parking a ticket

There is no `Won't do` status. A ticket you decide against closes as `Live`
plus the **`wont-do`** tag and a comment saying nothing shipped. A ticket that
is real but not worth a queue slot right now closes as `Live` plus the
**`deferred`** tag, keeping its description and comments; reviving it is
setting the status back to `Queued`.

### Titles

A ticket's name says in plain words **what breaks and who feels it**, or what
you will be able to do once it ships. The diagnostic sentence goes in the
description.

## The two traces a ticket must carry

- **`PR opened: <url>`** — written by `pr-opened`, which first checks that the
  PR body links back to the ticket, then reads its own comment back with the
  same parser the review step uses.
- **`REVIEW: PASSED — …`** or **`REVIEW: sent back to Rework — …`** — written
  by `verdict`. `Ready to launch` is refused unless the newest verdict is a
  PASS, from both doors (`ask` and `status --no-card`).

A send-back counts its round. **The fourth is refused**: three send-backs
mean the spec was wrong, not the build, and the ticket goes to you with the
three reasons listed and named options (respec / split / drop).

## How to run it

**They run on the Mac Mini.** Since 2026-10-11 both lanes run unattended on
the Mac Mini (account `daneofearth`, checkout `~/WebApps/spirality`) as
launchd agents, `com.spirality.loop-build` and `com.spirality.loop-review`,
beside StarCaster's. Each keeps the committed `scripts/loop_runner.sh` alive
across crashes and reboots; each pass is a fresh headless Claude Code session
that pulls `main`, runs one skill, and sleeps 30 minutes. A pass has a
two-hour time limit. Nobody starts a loop by hand while those are loaded: a
second claimant makes the check-then-act claim unsound.

So the question is never "shall I start one", it is "what is it doing":

```bash
ssh mac-mini 'cd ~/WebApps/spirality && ./scripts/install_loop_runner.sh --status'   # installed? alive? lock? last pass?
ssh mac-mini 'tail -40 ~/loop-logs/spirality-loop-build.log'                          # what the last build pass said
ssh mac-mini 'tail -40 ~/loop-logs/spirality-loop-review.log'
```

Three things the log can say that need a person:

- **"THIS PASS COULD NOT SIGN IN TO CLAUDE."** The Mini's Claude sign-in
  expired. Only Dane can sign in, at the Mini's own screen or Screen Sharing
  (an ssh sign-in does not reach launchd). Then restart the jobs:
  `launchctl kickstart -k gui/$(id -u)/com.spirality.loop-build` and the same
  for `loop-review`.
- **"hit the time limit"** twice on one ticket: a gate that will not go green.
  Read the ticket and hand it back or `ask`.
- **Nothing written for hours** while the queue has work: `--status` says
  whether the runner is alive. A stale lock clears itself on the next start.

**Merges still need a session.** There is no relay yet: when you comment
`merge` on a `Ready to launch` ticket, a Claude Code session has to see it and
merge. Tell one, or leave one watching.

### Starting one by hand — only when the Mini's agents are unloaded

Two commands, each in **its own session**, from any folder in the repo (the
loop makes its own worktree per task):

```
/loop 30m loop-build
/loop 30m loop-review
```

### Installing or moving the runner

`./scripts/install_loop_runner.sh` on the machine that will own the loops,
from its **main checkout** (never a worktree). It refuses if `npm`, `doppler`,
`claude` or `git` is missing. `--uninstall` removes both agents. Before
installing on a second machine, uninstall on the first: two machines claiming
is the collision the lock exists to prevent.

**The checkout must sit on a clean `main`.** The runner pulls only a clean
`main`; on any other branch every pass runs that branch's code and never sees
merged work. `--status` prints a `WARNING` when this is so, and the installer
warns too. The runner was first installed from its own branch (it was not on
`main` yet), so once that pull request merges, put the Mini back:
`git -C ~/WebApps/spirality checkout main && git -C ~/WebApps/spirality pull`.

Your day:

1. **Morning:** run `loop-spec` in a session, answer its questions, approve
   the task list.
2. **During the day:** the loops build and review. Each `Ready to launch`
   ticket lands in *Assigned to me* with a preview link and test steps.
3. **When you're ready:** tell a session **"merge PR #N"**. It merges only
   with the `verify` check green, then sets the ticket `Live`.
4. **When a ticket asks you a question** (`Needs your input`): answer as a
   comment on the ticket and move it back to `Queued` (or tell a session to).

### What the `verify` gate is

`npm run verify` is the ONE name for the definition of done. CI runs it on
every pull request; the build loop runs it before opening a PR; the review
loop runs it again. Today it parses every script and runs the unit tests. As
the app grows, each new kind of check (typecheck, build, browser test) is
added to that script, and every lane inherits it at once.

### Safety — why this is wired the way it is

- `main` is what ships. A hook refuses edits on `main`; every change is a
  branch, a PR and a green check.
- No loop merges. Ever. `Ready to launch` is a request, not an action.
- Every write to ClickUp is verified by reading it back.
- Urgent priority is yours alone; the script refuses to set it without a
  written claim that you asked.
- The repository is public. The review loop greps every diff for anything
  that looks like a key.

## The work log

`docs/WORK-LOG.md` is a plain-English record, newest first, one entry per
merged PR, written inside the PR it describes. It is for you, not for the
machine.

## Cost

A loop is an agent running continuously, so it spends tokens whether the
output is good or not. Start with one build loop on small, self-checking
work, confirm the value, then widen.

## First-time setup checklist

1. ✅ The **Loop Queue** list exists in the Spirality space (2026-10-11).
2. ⬜ Its statuses are the seven above, in order, with `Live` closed —
   `docs/CLICKUP_SETUP.md`, done by Dane in the ClickUp web app.
3. ✅ The three skills live in `.claude/skills/`.
4. ✅ Doppler holds the ClickUp token in `spirality/dev` (as a reference to
   StarCaster's, so there is one token to rotate). `npm run clickup -- whoami`
   prints "Token valid. Acting as: …".
5. ⬜ A dry run: one `loop-build` pass on the smallest ticket, then one
   `loop-review` pass, before trusting it with the rest.
6. ✅ The scheduled runner on the Mac Mini (2026-10-11).
