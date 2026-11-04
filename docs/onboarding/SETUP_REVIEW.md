# Setting up a product on Spirality: what Normie's setup taught us, and a wizard

Normie was the first product brought onto Spirality from scratch. This page
looks back at how that really went, names every hold-up, and designs a setup
wizard so the next product, PressPlay, can come on in minutes. Written for
SP-105, "Streamline project setup process", from Dane's words:

> With the Normie project set up, let's analyze the process we just went
> through and design a streamlined approach that allows a user to do it in a
> few minutes by entering the required data and going through a wizard.
> Identify any bottlenecks or hold-ups to the process so we can analyze them
> together. I have another project — PressPlay — with a github repository,
> and an app on vercel that I want to import next.

Nothing here is built yet. The wizard becomes tickets once Dane has gone
through the hold-ups and answered the questions at the end.

Where the times come from: every ticket's comments
(`npm run clickup -- comments --task <id>`), the merged pull requests
(`gh pr list --state merged`, in both repositories) and `docs/work-log/`.
All times are Mountain time. A time that could not be found says
"not found". Checked on 2026-11-03 at about 9 PM.

The plan this followed is [NORMIE.md](NORMIE.md); the general checklist is
[ONBOARDING_A_PRODUCT.md](../ONBOARDING_A_PRODUCT.md).

## In one paragraph

From Dane's "A, B, and C https://github.com/mentor24-maker/normie" (Sun 11/1,
5:42 PM) to the last Normie pull request merged (Tue 11/3, 7:35 PM) took
**about 50 hours** and **15 tickets** (3 to plan, 7 in Spirality, 5 in
Normie), and Normie's loops **still do not run**: NO-6, the ticket that
installs them, has not started. Dane wrote 36 words ("go", "merge", "done a")
on those tickets, 6 of them repeats, 4 because nothing was listening for the
first. The build loops' own estimate of the work is 59.5 programmer hours. Most of the 50 hours was not work: it was waiting, overnight for
Dane's "go", in line behind other tickets in Spirality's one build lane, and
for a person to start Normie's sessions by hand.

## 1. What happened with Normie

Who: **loop** is one of Spirality's unattended lanes on the Mini
(`loop-intake`, `loop-build`, `loop-review`, the relay). **Hand-run** is an
agent session Dane started himself (signed in as `hand-run` or
`normie hand-run`). Normie's sessions ran on Dane's MacBook, in
`~/WebApps/normie/.claude/worktrees/` (NO-3 and NO-4 say so); Normie's
review and relay steps were signed in as `normie loop-review` and
`normie relay` but were started by hand too, since no Normie job runs on the
Mini. **Dane** is Dane, and where a step was one of his four hand-offs it
says which.

"Card" is the card asking Dane for "go" (or for a step of his). "Wait" is the
gap from one step to the next.

### Planning (Spirality, by the loops)

| # | Ticket | What | Who | Times (Mountain) | Waits |
|---|---|---|---|---|---|
| 1 | SP-80 "Github repository field for Projects?" | Dane's request; slice A adds the repository field to the tracker's projects (PR #62) | Dane asks; loops build | card 11/1 4:48 PM; Dane "A, B, and C …" 5:42 PM; PR 11:55 PM; review passed 11/2 12:17 AM; Dane "merge" 8:53 AM; merged 8:57 AM | 6h13m answer to build; 8h36m overnight for "merge" |
| 2 | SP-88 "Nobody has written down what a new product needs to run on Spirality: a checklist" | `docs/ONBOARDING_A_PRODUCT.md` (PR #67) | loops | card 11/1 11:59 PM; Dane "go" 11/2 8:53 AM; PR 11:13 AM; review passed 11:43 AM; "merge" 12:20 PM; merged 12:23 PM | 8h54m overnight for "go"; 2h20m go to PR |
| 3 | SP-89 "Normie is not set up on Spirality yet: plan its onboarding as tickets" | `docs/onboarding/NORMIE.md`, files SP-95 to SP-99 (PR #68) | loops | card 11/2 12:31 AM; "go" 8:52 AM; PR 12:41 PM; review passed 1:05 PM; "merge" 1:23 PM; merged 1:25 PM | 8h21m overnight for "go"; 3h49m go to PR |

### Spirality's own fixes, so a second product can sit beside it

| # | Ticket | Who | Times (Mountain) | Waits |
|---|---|---|---|---|
| 4 | SP-95 "Normie's loops would take over Spirality's tracker sign-ins and stop Spirality's loops: give each product its own" (PR #70) | loops | card 11/2 1:03 PM; "go" 1:23 PM; PR 1:57 PM; **sent back** 2:09 PM; PR again 2:33 PM; review passed 2:42 PM; "merge" 4:04 PM; merged 4:29 PM | one review round (24 min); 1h22m for "merge"; 25 min merge word to merged |
| 5 | SP-96 "A second product's ticket commands and doctor read Spirality's Doppler keys: take the Doppler project from the settings file" (PR #73) | loops | card 1:34 PM; "go" 1:37 PM (twice); PR 5:50 PM; review passed 6:19 PM; "merge" 6:30 PM; merged 6:33 PM | **4h13m in line** go to PR |
| 6 | SP-97 "A second product's loop runners would write into Spirality's logs and share its locks: name them from the settings file" (PR #74) | loops | card 2:04 PM; "go" 2:40 PM; PR 6:27 PM; `MAIN MOVED … conflict` 6:33 PM; **sent back** for the conflict 6:50 PM; rework done 6:59 PM; review passed 7:22 PM; "merge" 8:00 PM; merged 8:05 PM | **3h47m in line**; one conflict round (49 min from `MAIN MOVED` to passing review) |
| 7 | SP-99 "The tracker's GitHub repository field can disagree with a product's settings file and nobody notices: check one against the other" (PR #75) | loops | card 3:06 PM; "go" 3:22 PM (again 3:28 PM); PR 8:08 PM; review passed 8:26 PM; "merge" 9:46 PM; merged 10:29 PM | **4h46m in line**; 43 min merge word to merged |

### Normie's home in the tracker and Doppler

| # | Ticket | Who | Times (Mountain) | Waits |
|---|---|---|---|---|
| 8 | SP-98 "Normie has no tracker project, Doppler project or loop sign-ins, so no loop can take its work: set them up" (PR #76) | loops; then **Dane** for three steps: the Doppler project (**a browser login**), the `tracker:signins create` command (**real secret values**), the repository field on the project's Edit page (**a browser login**); and a choice (**a decision of his**) | card 11/2 2:35 PM; "go" 2:40 PM; waited on SP-95 (merged 4:29 PM) and SP-96 (merged 6:33 PM); build pass found the sign-in command as written could not work and asked 7:31 PM; Doppler project `normie` created 7:55 PM (Doppler's own record); Dane "done a" 8:00 PM; PR 8:42 PM; review passed 8:59 PM; "merge" 9:45 PM; merged 10:08 PM | 4h51m go to build (waits on two fixes); **29 min for Dane's three steps**; 23 min merge word to merged |

SP-98 also filed NO-1 to NO-6 in Normie's project. A hand-run session wrote
the "go" cards for NO-1 and NO-3 at 11/2 11:49 PM; the others got theirs
when the ticket they wait on was done.

### In Normie's repository (hand-run sessions, Dane's choice "a")

| # | Ticket | Times (Mountain) | Waits |
|---|---|---|---|
| 9 | NO-1 "Every Normie pull request fails CI at the dependency audit: clear the high-severity advisories" (Normie PR #61) | card 11/2 11:49 PM; "go" 11:51 PM, **again 11/3 9:13 AM**; PR 9:31 AM; review passed 9:51 AM; "merge" 10:06 AM; merged 10:08 AM | **9h22m before the "go" was acted on** (overnight, nothing running); 18 min go to PR |
| 10 | NO-3 "No loop knows Normie's tracker, Doppler or repository ids: add its spirality.project.json" (Normie PR #62) | card 11/2 11:49 PM; "go" 11:51 PM, **again 9:14 AM**; paused 9:36 AM (Normie's commit hook runs its CI checks, which fail until NO-1 lands); PR 10:14 AM; review passed 10:16 AM; "merge" 10:49 AM; merged 10:51 AM | same overnight wait; 38 min paused behind NO-1 |
| 11 | NO-2 "Normie's main can change without a green check: name its CI check verify and protect main" (Normie PR #63) | card 10:15 AM; "go" 10:50 AM; PR 10:56 AM; review passed 10:59 AM; "merge" 11:29 AM; merged 11:33 AM; `main` protected and read back 11:36 AM | protection had to wait for the renamed check to pass on `main` |
| 12 | NO-4 "A session in Normie's repository cannot reach its tickets: copy in the ticket door and its npm scripts" (Normie PR #64) | card 10:58 AM; "go" 11:29 AM; **stopped** 11:41 AM: Spirality's doctor asked Normie for a ClickUp key it never uses; PR 3:57 PM (after SP-103 below); review passed 4:01 PM; "merge" 4:31 PM, **again 5:51 PM**; merged 5:54 PM | **4h16m stopped** on a Spirality bug; **1h23m before the "merge" was acted on** |
| 13 | SP-103 "A product on the tracker fails doctor for a ClickUp key it never uses: ask for CLICKUP_API_TOKEN only from products on ClickUp" (Spirality PR #81), found by NO-4 | hand-run files it 11:44 AM; "go" 11:52 AM; PR 1:37 PM; review passed 1:56 PM; "merge" 2:18 PM; merged 2:48 PM | 30 min merge word to merged |
| 14 | SP-104 "Four tests run git in a scratch repository but write to the real one when a commit hook runs them: clear git's repository settings in tests" (Spirality PR #82), found by NO-4 | filed by a hand-run session on Dane's "proceed on NO-5, then file the unsafe test ticket" (11/3; time not found); PR 6:35 PM; review passed 6:43 PM; "merge" 7:05 PM; merged 7:15 PM | not on Normie's critical path; NO-4's tests had written commits into Normie's real branch, undone by hand |
| 15 | NO-5 "A session in Normie's repository can edit main and has no loop to follow: copy in the loop skills, the main-branch hook and the loop rules" (Normie PR #65) | card 6:01 PM; "go" 6:12 PM, **again 7:07 PM**; PR 7:22 PM; review passed 7:26 PM; "merge" 7:34 PM; merged 7:35 PM | **55 min before the "go" was acted on** |
| 16 | NO-6 "Normie's loops do not run on the Mini: install its loop lanes" | **not started**: still `Requested`, no card, no comments. No `com.normie` job is installed on the Mini (checked: `launchctl list`, `~/loop-logs`). The Mini's checkout at `~/WebApps/normie` is still at `a94ee0d`, from before NO-1 to NO-5 merged, so it would have to be pulled before installing. Finish time: not found. | |

### Adding it up

- **Elapsed:** about 50 hours from Dane's answer to the last merge, and not
  finished. The longest single waits were overnight: 8h36m, 8h54m and 8h21m
  for Dane's word on SP-80, SP-88 and SP-89, and 9h22m for NO-1 and NO-3.
- **Dane's words:** 36 on these tickets ("go", "merge", "A, B, and C",
  "done a"), 6 of them repeats. NO-1, NO-3, NO-4 and NO-5 were repeated
  because nothing acted on the first (hold-up 5); on SP-96 and SP-99 the
  second "go" came 3 and 6 minutes after the first, while Spirality's relay
  was running, and why is not found.
- **Dane's own hands-on time:** the three SP-98 steps took 29 minutes from
  the ask to "done a". Starting the hand-run sessions for NO-1 to NO-5:
  not measured.
- **Work, by the loops' own estimates** (the newest `Human-hours estimate`
  on each ticket's PR): 59.5 hours. Spirality 42.5 (SP-88 4, SP-89 6,
  SP-95 7, SP-96 6, SP-97 5, SP-98 2, SP-99 5, SP-103 2.5, SP-104 5); Normie
  17 (NO-1 3, NO-2 1.5, NO-3 1.5, NO-4 6, NO-5 5). SP-80 has none (its PR
  came before estimates, SP-78).
- **Review:** two send-backs (SP-95, a real hole; SP-97, a conflict with
  `main`). Every other review passed first time.

## 2. The hold-ups

Each says what held things up, how long, why, and what a wizard could do
about it: **remove** it, **shorten** it, or **cannot touch** it (a real
secret value, a billing screen, a browser login, or a decision that is
genuinely Dane's).

1. **Spirality's code still assumed one product.** Sign-ins shared by name
   (SP-95), Doppler project typed in (SP-96), log and lock names typed in
   (SP-97), the repository field unchecked (SP-99), a ClickUp key asked of
   every product (SP-103), tests that write into a commit hook's repository
   (SP-104). Cost: SP-98 could not start until SP-95 and SP-96 merged,
   4h51m after Dane's "go"; NO-4 stopped 4h16m for SP-103. Why: Spirality
   had only ever served itself. **Wizard: removes it for PressPlay**, because
   these six are fixed. A seventh would only show when a third product
   meets it; the wizard's first step, a read-only check of everything, is
   where it would show.

2. **Overnight waits for Dane's word.** 8h36m (SP-80 "merge"), 8h54m (SP-88
   "go"), 8h21m (SP-89 "go"). Why: the cards came around midnight. **Wizard:
   shortens it.** The decisions he made one ticket at a time (which repository,
   the merge phrases, auto-merge, how the first tickets get built) are
   asked once, up front, in one sitting. The time of day stays his.

3. **One ticket per step, each with its own "go", review and "merge".**
   15 tickets and 36 words from Dane. The Normie steps alone (NO-1 to NO-5)
   were five pull requests in Normie's repository, three of them copies of
   Spirality files (the settings file, 41 files of the ticket door, the
   skills and rules). Why: the plan made every step a ticket, so a person
   could check each. **Wizard: shortens it.** A copy that is checked by
   machine (every file byte for byte identical to a named Spirality commit,
   as NO-4's review did) needs one pull request, not three, and one
   "merge". The pull request stays; `main` never changes unchecked
   (rule 1).

4. **Waiting in line in Spirality's one build lane.** SP-96 4h13m, SP-97
   3h47m, SP-99 4h46m from "go" to a pull request, behind other work
   (SP-95's send-back, and the tickets of PRs #71 and #72). Why: one build lane builds one ticket at a time, and
   setup tickets queued with everything else. **Wizard: removes it.** The
   setup steps are commands the wizard runs, not tickets in a queue.

5. **Nothing listened for Dane's word in Normie's project.** His "go" on
   NO-1 and NO-3 sat 9h22m overnight; "merge" on NO-4 sat 1h23m; "go" on
   NO-5 sat 55 min. He wrote each a second time. Why: the relay (the job
   that acts on "go" and "merge") runs only when it is installed, and
   Normie's install is the last ticket, NO-6, so until then a person had to
   start Normie's relay by hand. **Wizard: removes it.** It installs the
   product's lanes, the relay first, as soon as the product has a tracker
   project and its sign-ins, before any ticket is filed there.

6. **Dane started every Normie build session by hand.** NO-1 to NO-5, his
   choice (a) on SP-98, because Normie's loops did not exist yet. Cost: not
   measured, but every gap between one Normie ticket's merge and the next
   one's card (NO-3 merged 10:51 AM, NO-4 card 10:58 AM; NO-4 merged
   5:54 PM, NO-5 card 6:01 PM) is a session he was sitting at. **Wizard:
   removes it**, for the same reason as 5: with the lanes in early, the
   product's first real tickets are built unattended.

7. **The settings file came before the repository could hold it.** The
   sign-in command reads the product's settings file from the folder it runs
   in, but the settings file (NO-3) needs the build lane's actor id that the
   sign-in command makes. The build pass on SP-98 found the command as
   written would have made nothing for Normie, and worked round it with a
   temporary settings file in `/tmp`. Cost: part of the 4h51m on SP-98, not
   measured on its own. **Wizard: removes it.** It writes the settings file
   once, from what was entered, uses it for the sign-ins, then fills in the
   actor id and reads the file back through `lib/projectConfig.mjs`.

8. **The product's own CI was already failing.** Normie's dependency audit
   failed on every pull request (NO-1), and Normie's commit hook runs the
   same checks, so NO-3 could not even commit until NO-1 merged (38 min
   paused). **Wizard: cannot touch the fix**, which is work in the product
   (and which updates to take is Dane's decision), **but shortens the
   surprise**: its first, read-only step runs the product's checks on a
   clean copy of `main` and says before anything else whether they pass.

9. **Protecting `main` has to wait for the check to exist.** NO-2 renamed
   Normie's CI job to `verify`, merged, waited for that check to pass on
   `main`, and only then turned protection on (11:33 AM to 11:36 AM).
   Cost: minutes. **Wizard: handles the order**: workflow first, protection
   once the check has run green on `main`, then read back with
   `gh api repos/<githubRepo>/branches/main/protection`.

10. **Three steps only Dane could do, in three different places.** The
    Doppler project (the Doppler dashboard, **a browser login**); the
    `tracker:signins create` command in Terminal (**real secret values**:
    it writes the sign-in tokens into Doppler, and sessions are refused
    Doppler writes); the repository field on the project's Edit page (**a
    browser login**: the tracker lets only a person change a project). Cost:
    29 minutes. **Wizard: shortens it, cannot remove it.** The secret-store
    write stays his. The repository field could be set by the same command
    that makes the project, if Dane agrees a command he runs may set it
    (question 3). The Doppler project could be made by the Doppler command
    line in that same Terminal step (question 4).

11. **The loops' tests reached into the product's real repository.**
    NO-4's copied tests, run by Normie's commit hook, put a scratch commit
    on the real branch and a fake author "T" into Normie's git settings,
    undone by hand. Fixed by SP-104. **Wizard: removes it for PressPlay**
    (fixed), and the read-only first step runs the copied tests once in a
    scratch copy before anything is committed.

12. **The install step was left for last and has not happened.** NO-6 waits
    on NO-2, NO-5 and SP-97, all merged, but nothing has picked it up: it is
    still `Requested`, and no loop works Normie's project. The Mini's Normie
    checkout is still at `a94ee0d`, before NO-1 to NO-5. Cost: from NO-5's merge (11/3
    7:35 PM) and counting. **Wizard: removes it**, by moving the install to
    the middle (hold-up 5) and pulling (or cloning) the product's checkout
    on the Mini as its own step.

13. **A preview no loop could open.** NO-1's review could not open
    Normie's Vercel preview: the session's connector was refused (403), so
    "open the page" was left for Dane. Cost: not measured. **Wizard: cannot
    touch it** (a Vercel sign-in is **a browser login**), but it can record
    the product's preview address pattern so the review card links it.

## 3. The wizard design

### What it is

One command, run on the Mini from Spirality's own folder, in a session that
is **not** one of Spirality's lanes (the installer reloads the lane it runs
in):

```bash
npm run onboard -- --product <slug>
```

It is plain Node and bash (rule 8). It asks its questions in the Terminal,
or reads them from a file, `onboard/<slug>.answers.json`, so a rerun asks
nothing twice. It keeps a step log, `<logDir>/<slug>-onboard.log`, and every
step is safe to rerun: each one first checks whether it is already done,
and skips it if so. It never prints a secret.

`npm run onboard` does not exist yet. Nothing below is built.

### What a person enters

Every value the product needs, asked once. Defaults in brackets come from
the slug or from the **tracker home's** own settings file (the product that
runs the tracker, today Spirality's `spirality.project.json`); none is
typed into the wizard's code (rule 2).

| Field | What it is | Normie's value | Default | Whose |
|---|---|---|---|---|
| Product name | What the tracker shows | `Normie` | | Dane (a decision) |
| GitHub repository | `owner/name` | `mentor24-maker/normie` | | Dane (a decision) |
| Product slug | Short name: logs, locks, the tracker project | `normie` | name, lower case | |
| Ticket prefix | The start of every ticket id | `NO` | first two letters, upper case | Dane (a decision) |
| Doppler project / config | Where the product's loop keys live | `normie` / `dev` | slug / `dev` | |
| launchd prefix | The start of every job label on the Mini | `com.normie` | `com.<slug>` | |
| Checkout on the Mini | Where the product's main copy lives | `~/WebApps/normie` | the folder beside the tracker home's | |
| The product's check | The command CI and the loops run as `verify` | `npm run verify:full` | `npm run verify` | |
| Node version | What the product needs | `22` (its `.nvmrc`) | read from `.nvmrc` or `package.json` `engines` | |
| Merge phrases | What Dane writes to mean "merge this" | `merge`, `merge it`, `ship it`, `approve` | the tracker home's `mergePhrases` | Dane (a decision) |
| Lanes that may merge without Dane | `autoMergeLanes` | none | none | Dane (a decision) |
| Extra protected files | Added to `governancePaths` | `.cursorrules` | the tracker home's list | Dane (a decision) |
| Hosting | Where the app deploys, and its preview address, if any | Vercel (preview check on every pull request) | none | |
| What the product is | Two or three sentences for its `CLAUDE.md` | (Normie's existing guide kept) | | Dane (a decision) |

Not asked, because they are found or follow from the above:
`operatorUserId` (Dane's existing actor, found by name: `1`);
`machineUserId` (the new `<slug> loop-build` actor: Normie's `8`);
`logDir`, `trackerUrl`, `trackerApiUrl` (the tracker home's values);
`tracker` `"api"`; `workspaceId`, `spaceId`, `loopQueueListId` `"0"` (no
ClickUp); `legacyMachinePrefixes` `[]`; `productScripts` `{}`; no
`trackerPort` (only the tracker home sets it).

### What it does, in order

Each step names how it checks the step stuck (read back, rule 5), and what
it prints if it did not (rule 6). A failed step stops the wizard with a
`FAILED: <step>: <what was seen>` line and the rerun command; nothing after
it runs.

**0. Look before touching anything (read only).**
- GitHub: the repository exists, this Mac's `gh` can push to it, and its
  plan allows branch protection (`gh api repos/<githubRepo>/branches/main/protection`
  answers, or answers "not protected"; a `403 Upgrade to GitHub Pro` means
  it cannot, see part 4).
- The Mini: the checkout folder (cloned on a clean `main` if absent), the
  Node version, `claude` signed in, the Doppler command line signed in.
- The tracker: reachable at `trackerApiUrl`; whether the project, prefix
  and `<slug> …` actors already exist; that the prefix is not taken.
- Doppler: whether the project and config exist.
- The product's own check, on a clean copy of `main`: passes or not
  (hold-up 8). Spirality's tests that would be copied, run once in a scratch
  copy of the product (hold-up 11).
- Prints one table: each item `ready`, `will do`, or `BLOCKED: <why>`.
  Any `BLOCKED` stops here, before anything is written.

**1. Write the settings file**, in a scratch folder, from the answers and
the found values; check it with `lib/projectConfig.mjs` (the same check
every loop uses). Read back: `node scripts/project_config.mjs githubRepo`
from that folder prints the repository.

**2. Stop for Dane: the secret store** (**real secret values**). The
wizard prints one block to paste into Terminal, made from the answers:
make the Doppler project and config if step 0 found none, then
`tracker:signins create` against the scratch settings file with
`TRACKER_DB` set to the tracker home's database. It makes the tracker
project with its prefix, the five `<slug> …` actors and their tokens, and
writes the tokens into the product's Doppler project. The wizard waits for
Enter, then reads back: `tracker:signins check` (every seat answers as
itself, and the tracker home's seats still answer as theirs), and the
project's row in the tracker. It writes `machineUserId` into the settings
file and checks the file again.

**3. Stop for Dane: the repository field** (**a browser login**), the
project's Edit page at `<trackerUrl>/projects/<slug>/edit`, unless
question 3 lets step 2 set it. Read back: `npm run clickup -- repo-check`
from the scratch folder says the field and `githubRepo` agree.

**4. One pull request in the product's repository**, on a branch off
`main`: the settings file; the CI workflow with one job named `verify`
running the product's check; the ticket door and its npm scripts; the four
loop skills, the main-branch hook and `docs/LOOP_ENGINEERING.md`; the "How
to work with Dane" and "Where the work is tracked" sections added to its
`CLAUDE.md` (its own guide kept). Every copied file is compared byte for
byte with the Spirality commit it came from, and the PR body names that
commit. Read back: from a fresh worktree of the branch, `npm run doctor`,
`npm run clickup -- whoami` (answers as `<slug> hand-run`) and
`npm run clickup -- queue` (empty) all pass, and CI's `verify` check is
green on the pull request.

**5. Stop for Dane: "merge"** (**a decision of his**). Until the product's
relay runs, the wizard is what is waiting, so it merges on his word typed
into the wizard, through the same gates the relay checks (green `verify`,
up to date with `main`). Read back: the merge commit on `main`, and CI's
`verify` green on it.

**6. Protect `main`**, now that `verify` has passed on `main`: the required
check `verify`, up to date, admins included, force pushes and deletion off,
no review required. Read back: `gh api repos/<githubRepo>/branches/main/protection`
shows exactly that.

**7. Install the lanes on the Mini** from the product's checkout, pulled to
the new `main`: `scripts/install_loop_runner.sh`, relay first. Read back:
`./scripts/install_loop_runner.sh --status` shows every job loaded, and
each log has a `START` line after its first pass.

**8. Hand over.** Files one ticket in the product's own project, assigned
to nobody, for its first real piece of work if Dane named one (question
5), and prints the page to watch: `<trackerUrl>/list/<slug>`. Read back:
the ticket answers `npm run clickup -- get`.

Dane's stops, all four of his hand-off kinds marked: step 2 (**real secret
values**; also **a billing screen** if the Doppler plan needs one), step 3
(**a browser login**, unless question 3), step 5 (**a decision**), and the
answers to the fields marked "Dane" above (**decisions**). If the GitHub
plan blocks protection (step 0), that is **a billing screen** or **a
decision** (make the repository public), and the wizard stops there.

### What can be one command, and what needs a ticket first

| Part | Today | Needs |
|---|---|---|
| Step 0, the read-only look | pieces exist (`npm run doctor`, `repo-check`, `tracker:signins check`) | a ticket: one script that runs them for a product not yet set up, plus the GitHub plan check |
| Step 1, writing the settings file | by hand (NO-3) | a ticket: generate it from answers; the check is already `lib/projectConfig.mjs` |
| Step 2, the sign-ins | one command (`tracker:signins create`), but it needs a settings file in the folder it runs from | a ticket: let it take the settings file's path, so no `/tmp` workaround (hold-up 7) |
| Step 3, the repository field | only the page | a ticket, only if Dane says yes to question 3 |
| Step 4, the copy into the product | by hand, three tickets (NO-3, NO-4, NO-5) | a ticket: copy a named list of files from a named commit, compare them, open one PR. Later, the shared package (`docs/PLAN.md`) replaces the copy |
| Step 5, merging on his word | the relay, once installed | nothing new if the lanes go in at step 7 and step 5 waits for the relay; a ticket if the wizard merges itself |
| Step 6, protecting `main` | one `gh api` command (NO-2) | folded into the wizard; no ticket of its own |
| Step 7, the lanes | one command (`install_loop_runner.sh`) | nothing; the wizard runs it |
| The wizard itself, putting it together | | a ticket, last |

## 4. PressPlay, next

### What is known

From the request: PressPlay has a GitHub repository and an app on Vercel.
`gh repo list mentor24-maker` finds a repository named `pressplay` there,
and it is **private**.

**This page is public, so it says no more about what that repository
holds.** The full look-over, done the way [NORMIE.md](NORMIE.md) looked
over Normie (its files, its checks, its Vercel project, its keys), is in a
comment on SP-105 in the tracker, which is not public. Whether any of it
may be written here is question 2.

What can be said here, because it is about Spirality's side or about
GitHub's rules rather than PressPlay's code:

- **`main`'s protection: not possible on the current plan.** GitHub answers
  `403 Upgrade to GitHub Pro or make this repository public to enable this
  feature`, for branch protection and for rulesets alike. Without it, rule 1
  ("`main` never deploys unchecked") cannot be held by GitHub.
- **No check of its own that a loop could run as `verify`.** A `verify`
  has to be written, not repaired (details on the ticket).
- **On the Mini:** no checkout. **Doppler:** no `pressplay` project.
  **The tracker:** no PressPlay project (read from a copy of the tracker's
  database); prefixes taken are `SP`, `SC`, `WC`, `NO`.

### What the wizard needs from Dane before it can start

- That `mentor24-maker/pressplay` is the right repository (question 1).
- What to do about protecting `main` on a private repository, and whether
  PressPlay's details may appear on Spirality's public pages (question 2).
- What PressPlay's `verify` should check (question 6).
- The ticket prefix (`PP`?), the merge phrases, auto-merge, and two or three
  sentences on what PressPlay is, for its `CLAUDE.md`.
- The address to put in the tracker project's website box.

### Which of Normie's hold-ups would hit PressPlay

| Hold-up | PressPlay |
|---|---|
| 1. Spirality assumed one product | fixed; step 0 would show a new one |
| 2. Overnight waits | asked once, up front, with the wizard |
| 3. One ticket per step | one pull request with the wizard |
| 4. In line in Spirality's build lane | gone with the wizard |
| 5. Nothing listening for his word | gone if the lanes go in at step 7 |
| 6. Hand-run sessions | gone with 5 |
| 7. Settings file before the repository | gone with the step 2 ticket |
| 8. CI already failing | **different, and bigger**: no check to repair; a `verify` has to be written |
| 9. Protection waits for the check | **blocked**: private on a plan without protection |
| 10. Dane's three places | the same, shortened by questions 3 and 4 |
| 11. Tests reaching the real repository | fixed |
| 12. Install left for last | gone with the wizard order |
| 13. Previews no loop can open | the same: Vercel previews need a Vercel sign-in |
| New: a private repository, a public Spirality | every page, card and pull request here that names PressPlay's files is public (question 2) |

## Questions for Dane

1. **Is `mentor24-maker/pressplay` the repository to bring on?** (Yes / a
   different one: name it.)
2. **PressPlay is private, and GitHub will not protect `main` on the current
   plan.** Options: (a) upgrade to GitHub Pro (**a billing screen**), so
   protection works and the repository stays private; (b) make PressPlay
   public, as Spirality and Normie are (everything in it becomes public; the
   ticket comment lists what that includes); (c) bring it on unprotected,
   with the loops' own rules as the only guard, and say so on every card.
   And, whichever you pick while it stays private: may Spirality's public
   pages (this one, the onboarding plan, pull requests) describe PressPlay's
   files, or do those details stay on its tickets in the tracker?
3. **May the command you run in step 2 also set the project's GitHub
   repository**, so you never open the Edit page? Today only a person may
   change a project. (a) Yes, from the command you run yourself; (b) no,
   keep the Edit page.
4. **Doppler project: dashboard or command line?** (a) The wizard's step 2
   block makes it with `doppler projects create`, in the same paste;
   (b) you keep making it in the dashboard first.
5. **Who merges the setup pull request, and when do the lanes go in?**
   (a) The lanes go in first, from a branch, so the relay merges on your
   word like every other ticket; (b) the wizard merges on your word typed
   into it, then installs the lanes (the order above); (c) as Normie did:
   separate tickets, each through the queue.
6. **What should PressPlay's `verify` check?** It has no check of its own
   today. (a) Only that it builds, to start; (b) the build plus a lint and
   the offline test the ticket comment names; (c) something else.
7. **How much should one setup pull request carry?** (a) Everything in step 4
   at once, every copied file checked by machine; (b) two: the settings file
   and CI first, then the door and skills.
8. **Normie's install (NO-6) has not started.** (a) Leave it for the wizard
   to do as its first real run; (b) have a hand-run session do it now, after
   pulling the Mini's Normie checkout up to date.
9. **Which order for the wizard tickets?** The table in part 3 lists six.
   Suggested, smallest and safest first: the sign-ins taking a settings file
   path; the read-only look; the settings file; the copy-and-compare; the
   wizard that ties them together.
