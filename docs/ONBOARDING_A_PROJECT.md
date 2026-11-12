# Onboarding a project onto Spirality: the checklist

Everything a project (Normie, say) needs before its development can run on
Spirality's loops, in one place. Until now the answer was spread across the
project config, the installer, the tracker and Doppler. This page is the
list; planning a real project's setup (SP-89, "Normie is not set up on
Spirality yet: plan its onboarding as tickets") starts from it.

Each item says:

- **What** it is, in plain words.
- **Where** it lives.
- **Who** does it: an agent session, or Dane, and then which of his four
  hand-offs it is (a real secret value, a billing screen, a browser login, or
  a decision only he can make).
- **Check**: the command or screen that shows it is done.
- **Today**: **automated** (a command does it), **manual** (a person or a
  session does it by hand, step by step), or **missing** (nothing does it
  yet, so a ticket has to build it first).

Spirality's own values are given as the worked example throughout.

Worked example: Normie, [docs/onboarding/NORMIE.md](onboarding/NORMIE.md),
every item below walked for one real project, with its tickets.

Looking back: how Normie's setup really went, its hold-ups, and a setup
wizard for the next project, [docs/onboarding/SETUP_REVIEW.md](onboarding/SETUP_REVIEW.md).

A project already on ClickUp: how WaveCenter's move went, where the wizard
stopped and what was left over, [docs/onboarding/WAVECENTER.md](onboarding/WAVECENTER.md).
StarCaster's jobs outside its lanes that touch ClickUp, and the plan for
each before it moves, [docs/onboarding/STARCASTER.md](onboarding/STARCASTER.md).

## The way in: one command

On the Mini, from Spirality's own folder, in a Terminal that is not one of
Spirality's lanes:

```bash
npm run onboard -- --project <slug>
```

(`--product <slug>`, the option's old name, still works.)

It asks Dane only the answers that are his decisions, once (kept in
`~/loop-logs/onboard/<slug>.answers.json`), then runs every item below in
order: the read-only look, the start (only for an empty repository: its
first commit, see section 1), the clone (the project's `main` into its
checkout folder, only when that folder does not exist yet), the settings file, the sign-ins (**real secret values**: it shows
the commands and asks `Run these now? [y/N]`; on Dane's y it runs them in his
Terminal, on anything else it prints them and stops), the bus (below), the copy into the project's repository as
one pull request, the lanes and the setup ticket, the merge (Dane's merge
phrase on that ticket: **a decision**) and protecting `main`. Each step
checks first whether it is already done, so a rerun after a failed step
picks up there and asks nothing twice. A failed step prints
`FAILED: <step>: <what was seen>` and the rerun command; the step log is
`~/loop-logs/<slug>-onboard.log`. The steps and what changed from the plan:
[SETUP_REVIEW.md, part 3](onboarding/SETUP_REVIEW.md#3-the-wizard-design).

With `--no-prompt` (SP-125) it never reads the Terminal, so the tracker's
setup page can drive it: answers still missing, the sign-ins block and a
setup not merged yet each end the run with `STOPPED: <step>: ...` and exit 3
instead of waiting, and the rerun after Dane's move goes on from there.
Either way it keeps `~/loop-logs/onboard/<slug>.state.json` up to date: every
step's outcome (`done`, `skip`, `failed`, `stopped`, `running`, `pending`),
the stop (`kind` `answers`, `paste` with the block's lines in `commands`,
`merge` with the setup ticket's `link`, or `failed`), and `finished`. It holds
commands and links only, never a secret value.

### A project with a bus (StarCaster)

One of the questions is whether the project raises its alarms on a bus
(SP-204; what the bus is: [TRACKER_MVP.md, "The bus"](TRACKER_MVP.md#the-bus-starcasters-alarms)).
StarCaster does; WaveCenter and Normie do not, and the default is no. The
answer is `hasBus` in the answers file. On yes:

- the settings file names `"busProject": "<slug>-bus"`, so the copy puts it
  in the project's repository;
- the `bus` step, after the sign-ins, runs `npm run tracker:bus` with
  `TRACKER_DB` set to the tracker's own database. It makes the tracker
  project `<slug>-bus` ("<project name> bus", tickets `<PREFIX>BUS-1`
  onwards, the operator as its operator), reads it back, and checks that
  every loop sign-in of the project sees it. A loop sees every project, so
  there is nothing to grant, only that check;
- a bus project that is there already is left alone, so a rerun makes
  nothing new; one there under another operator is refused, because it may
  be another project's.

With no bus the step is skipped, and the settings file has no `busProject`.
An answers file written before the question was asked, with every other
answer in it, is not stopped for it: no bus stands. To give a project that
is already set up a bus, put `"busProject"` in its settings file in its own
pull request, and run `npm run tracker:bus -- --config <that file> --name
<project name>` on the Mini with `TRACKER_DB` set.

```bash
echo "the heartbeat stopped at 09:10" | npm run clickup -- bus-post --body-file -   # from the project's folder: posts, read back
```

### A project already on ClickUp (WaveCenter, StarCaster)

A project that already runs its own copy of the loop, with its tickets in a
ClickUp Loop Queue, is moved by the same command (SP-159). The wizard tells
it apart by its checkout: the folder is on this Mac, holds its own
`scripts/install_loop_runner.sh`, and has no `spirality.project.json` yet.
Only then does the answers step ask one more question, once:

- **Its Loop Queue list id** (blank: it is not on ClickUp, and the run is
  a new project's). Then **Dane's own ClickUp user id**, so the import files
  his old comments under him, **the old loop's ClickUp machine user id**, so
  the import files the old loop's own comments under the loops rather than
  under a stranger named "ClickUp user <id>" (the old loop's
  `scripts/clickup.mjs` names both), and **any other list to keep a copy
  of** (StarCaster's alarm list).

They go into the answers file as `clickupListId`, `clickupOperatorId`,
`clickupMachineUserId` and `clickupExtraLists`. Under `--no-prompt` (the
setup page's command) the wizard stops at the answers step instead, and the
setup page's answers form asks the same questions: the page sees the same
old loop in the checkout the answers name, and shows the four ClickUp boxes
under Dane's own. Leaving the list id blank there is "not on ClickUp", and
is kept, so the wizard does not stop for it again. Nobody edits the answers
file by hand.

With a list id, five more steps run after the sign-ins and before the copy,
in the order the switch runbook gives
([TRACKER_MVP.md, "Switching a project over"](TRACKER_MVP.md#switching-a-project-over)),
each skipped on a rerun once the step log has it done:

| Step | What it does | Good |
|---|---|---|
| `setup-check` | SP-252: writes the setup branch in the setup folder (`onboard:copy --check-only`: nothing pushed, no pull request), installs the project's packages there (`npm ci`) so its own git hooks run on the commit, and runs the project's own `npm run verify` on it. A red verify first retires the old loop's tests that check the files the setup writes (below), then runs again; still red fails the step **while the old lanes still run**. | `pressplay's own verify passes on spirality-setup, before anything is stopped` |
| `stop` | Reads the old lanes from the project's own installer (`--status`: each lane, its launchd label, its log), runs the snapshot's dry run (below) first, so a missing ClickUp token or list stops the run while the old loop still runs, then reads `--status` again and checks no pass is in flight (a log ending on a `START` with no `END`, unless the lane's `lock:` line says `none` or `STALE`, meaning its runner was killed mid-pass; a loaded lane whose `--status` names no log cannot be checked, and fails the step), and straight after that check runs that installer's `--uninstall`, reading `--status` back. Nothing slow sits between the check and the unload, so a pass that starts during the dry run is seen, not cut off. A project cloned in the same run that turns out to have an old loop stops at `clone`, before the sign-ins, so the rerun (or the setup page's form) asks the ClickUp questions. | `stop  stopped com.wavecenter.loop-build, ...` |
| `snapshot` | `tracker:snapshot`, a dry run (unless the stop step just ran it) then the real one: the Loop Queue list plus every extra list, saved and packed on the Mini. | every count OK |
| `import` | `tracker:import` into the tracker's database, a dry run then the real one. Unlike the others, it runs again on every rerun until `switch-check` has said Safe to switch, because the check's `NOT YET IMPORTED` and `STATUS DIFFERS` both mean "import again" (the import is safe to rerun, and brings an imported ticket ClickUp has changed since up to date). | nothing refused |
| `switch-check` | `tracker:switch-check`. | `Safe to switch.` |

Any of them failing prints `FAILED: <step>: ...` and the rerun command, and
nothing after it runs. A pass in flight is a failure too: nothing is
stopped, and the rerun after the pass ends goes on.

**Switched back to the old loop mid-setup.** If the setup stops after these
five steps (at `copy`, say) and the project's old lanes are put back
(`./scripts/install_loop_runner.sh --install` in its checkout), they write
to ClickUp again, and the import no longer has everything; while they run,
the project's `main` can move too, so the setup branch's verify may no
longer hold. So a rerun before the `lanes` step has begun reads the old
installer's `--status`, and if any lane is loaded again it says so
(`setup-check  <slug>'s old lanes are loaded again ...`, logged as
`stop | again`) and runs all five again, in order: the setup check (its
verify, while the old lanes still run), the snapshot's dry run, the stop, a
fresh snapshot, the import and the switch check. Only what the step log says
after that `again` line counts as done, so a rerun that fails part-way picks
up from there. A rerun whose old lanes stayed stopped skips the five, as
before.

The import run again brings in what the old lanes wrote: new tickets,
comments and replies, and, on a ticket already imported, its status, name,
description, priority, tags, assignee and Loop note, wherever ClickUp
changed it since (its report counts these as `updated`). It never writes
over a ticket someone changed in the tracker; that one is refused by name.
So the switch check after it can say Safe to switch.

Two limits. Once the `lanes` step has begun (any `lanes` line in the step
log, a failed one too), a loaded lane may be Spirality's own:
`onboard:lanes` loads them under the same labels and can fail after that.
So it is no longer read as the old ones coming back; if you put the old
lanes back after that point, stop them yourself before the rerun
(`./scripts/install_loop_runner.sh --uninstall` in the project's checkout)
and run the import and the switch check by hand (`docs/TRACKER_MVP.md`,
"How the loops switch over without a rewrite", steps 4 and 5). And old
lanes turned back on and off again before the rerun are not seen at all,
though they may have written to ClickUp: if that happened, run those two
steps by hand before you go on.

The stop step stops only the lanes the project's own installer names. A
project can have other launchd jobs that read its Loop Queue list
(StarCaster's `pipeline-pulse` and `weekly-report`); they keep running,
and anything they write to ClickUp after the import shows up in
`switch-check` as `NOT YET IMPORTED`, so the rerun imports it. What to do
with such jobs for good is part of that project's own switch (SP-25 for
StarCaster).

The three tracker scripts read their settings from the folder they run in,
and the project's checkout still holds its old loop. So the wizard writes a
**switch settings file**, `~/loop-logs/onboard/<slug>-switch/spirality.project.json`:
the project's new settings file with its ClickUp list, Dane's ClickUp
seat and the old loop's ClickUp machine seat put back, and the tracker home's data folder, and runs the scripts
from Spirality's folder in that folder. Doppler supplies the project's own
keys: its ClickUp token (`CLICKUP_API_TOKEN` must be in the project's
Doppler config) and, after the sign-ins, its tracker seats. The switch
check proves the seats the sign-ins step made for the project: a guest's
lanes named for it (`wavecenter loop-build`) and no operator seat, since
Dane's sign-in belongs to Spirality.

**The old loop's tests (SP-252).** A project that ran its own copy of the
loop has tests of that copy: StarCaster's `scripts/builder/` read its old
loop skills, `docs/LOOP_ENGINEERING.md` and `scripts/loop_runner.sh`, and
fail once the setup replaces them. One rule decides which are retired, never
a hand (`lib/onboardRetire.mjs`): the test file fails when run alone on the
setup branch (`node --test <file>`), passes when run alone on the commit the
branch started from (a scratch worktree beside the setup folder, removed
after), and names a file the setup writes, by path or by file name, itself
or through one file of the repository it names. Each one is deleted in a
commit of its own on the setup branch, and verify runs again. Retiring a
test can break a guard that checks the tests themselves (StarCaster's
`clickupReserveDoor` test looks for tests it then cannot find), so the rule
is applied again to whatever fails next, up to three rounds. The pull request lists every
retired file with the files it names, for review before merging. A test that
fails on main too, or names none of the setup's files, is never retired, so
the verify stays red and the wizard stops before the stop step. The list is
kept beside the setup folder (`<slug>-setup-retired.json`), and a verify that
passed is not run again on the same commit (`<slug>-setup-verified`).

The copy step then always runs with `--allow-replace`, since the setup
replaces the old copy's files, and its pull request lists every file of
the old copy it replaces, and every other file in the folders it writes
into, which it does not touch (nothing is deleted; the list is for the
reviewer, not a to-do list). The old copy's own `clickup` and `doctor` npm
commands are replaced with the loop's too, and the pull request names what
each one was, so one still wanted can be put back under another name before
merging (SP-172; the project's own `verify` is always kept). The lanes step installs the new lanes, under the same
launchd labels the old ones had.

The checklist below stays as what the wizard does, item by item, and how
to check each one by hand.

## The gaps, at a glance

The items below marked **missing**, gathered here so they can become tickets:

1. **No shared package yet.** A project cannot "pin a version" of the
   substrate (`CLAUDE.md`, "What we are building", point 3): there is no
   tagged release and nothing published. Today a project must carry its own
   copy of `scripts/`, `lib/` and `.claude/` (item 6). **That is the plan
   for now, not only a gap:** WaveCenter and StarCaster leave ClickUp as a
   wizard copy, like Normie, not by pinning a release. Dane chose this on
   2026-11-08, planning SP-23 and SP-25: *"a wizard copy now is fine for
   now."* The package (`docs/PLAN.md`, phases 1 to 5) is deferred, not
   dropped.
2. **Some of the copied code still said "spirality".** Both halves are
   fixed. SP-96 fixed the Doppler half: the npm scripts run `doppler run`
   through `scripts/with_doppler.mjs`, and `npm run doctor` checks, all with
   the `dopplerProject` and `dopplerConfig` the config names (item 3). SP-97
   fixed the runner: `scripts/loop_runner.sh` wrote `~/loop-logs/spirality-...`
   and printed a `com.spirality.<skill>` restart line whatever the config
   said; it now reads `logDir`, `projectSlug` and `launchdPrefix` from the
   config, like `scripts/install_loop_runner.sh` and `scripts/run_relay.sh`.
3. **Loop sign-ins were per lane, not per project.** Fixed by SP-95: a
   project that does not run the tracker gets machine sign-ins named for
   itself (`normie loop-build`), so its `create` can no longer re-issue
   Spirality's (item 4).
4. **The tracker project's GitHub repository field could disagree
   unnoticed.** Fixed by SP-99: SP-80 added the field, and the loops still
   read the repository from the project config's `githubRepo`, but
   `npm run doctor` now compares the two (item 4).

## 1. The GitHub repository

- **What.** The project's code, as `owner/name` (Normie:
  `mentor24-maker/normie`). Pull requests go there, and its `main` must never
  change unchecked (`CLAUDE.md`, engineering rule 1).
- **Where.** On GitHub. Inside it, the CI workflow
  `.github/workflows/ci.yml`, which runs `npm ci` then `npm run verify` on
  every pull request and every push to `main`; and a `verify` script in the
  project's `package.json` (Spirality's: syntax check, secret check, tests).
- **Who.** An agent session: copying the workflow, writing `verify`, and
  protecting `main` with `gh api` (the required check is `verify`; force
  pushes and deletions off). Making the repository itself, if it does not
  exist, is Dane's decision.
- **An empty repository** (SP-154). A repository made on GitHub with no
  files has no `main` branch yet. The look says so as `will do`, not
  BLOCKED: protecting `main`, the Node version and the check all wait for
  the first commit. The wizard's `start` step, right after the look, makes
  that commit and pushes it to `main`: the minimum the setup runs on, from
  `scripts/onboard/templates/starter/` (a `package.json` whose
  `npm run verify` runs the tests, with `engines.node` from the answers'
  `nodeVersion`, or this Mac's major Node version when that is empty; its
  `package-lock.json` for CI's `npm ci`; `.nvmrc`; a `.gitignore` covering
  `node_modules/`, `.env` and `.env.*`; a README naming the project; and one
  placeholder test). It chooses no framework or stack. It pushes without
  force and reads the result back from GitHub (`gh repo view --json
  isEmpty,defaultBranchRef` shows `main`, not empty, and `main` is the one
  commit pushed); a refused push or a read-back that does not match fails
  the step and nothing after it runs. A repository with any commit is never
  written to: the step says `already done (... already has a main branch)`.
  The starter answers to `npm run verify` only, so the look blocks an empty
  repository whose answers set another `checkCommand`.
- **A `package.json` with no `package-lock.json`.** On any project, empty
  or not, the look blocks a `main` that has a `package.json` but no
  `package-lock.json`, on its own row (`GitHub: package-lock.json on
  main`), because the `verify.yml` the setup copies runs `npm ci` with
  `cache: npm`, and both refuse without one (Upwork Blaster's first setup
  pull request failed CI that way). The fix it names: in a checkout of
  `main`, run `npm install --package-lock-only`, commit the
  `package-lock.json` it makes, push it, and run the setup again.
- **Check.**
  - `gh api repos/<owner>/<name>/branches/main/protection` shows
    `"contexts":["verify"]` and `"allow_force_pushes":{"enabled":false}`.
  - A test pull request shows a `verify` check that runs and goes green.
- **Today.** **Manual.** Spirality's own protection was set by hand; no
  script sets it for a new repository.

## 2. The project config file

- **What.** One JSON file of the project's ids, names, paths and phrases.
  Every substrate module reads it instead of a literal, so the same code
  serves every project.
- **Where.** At the root of the project's repository. The file is always
  named `spirality.project.json`, in every project (it is
  `CONFIG_FILE` in `lib/projectConfig.mjs`; there is no `<project>.project.json`
  name). `lib/projectConfig.mjs` finds it by walking up from the current
  folder and checks every key; `scripts/project_config.mjs` prints one value
  for the shell scripts. A missing required key, an unknown key or a
  malformed value stops the caller with a message naming the key.
- **Who.** An agent session writes it. Two values are Dane's decisions: the
  merge phrases and whether any lane may merge without him
  (`autoMergeLanes`).
- **Check.** From the project's repository:
  `node scripts/project_config.mjs githubRepo` prints the repository, and
  exits non-zero naming the key if anything in the file is wrong.
- **Today.** **Manual** (written by hand; the checking is automated).

The keys. "Required" means the file is refused without it. Spirality's value
is the example.

| Key | Required? | What it means | Spirality |
|---|---|---|---|
| `workspaceId` | required | The ClickUp workspace. Still checked even on the tracker; a project that never used ClickUp still has to fill it with digits. | `"90141423066"` |
| `spaceId` | required | The ClickUp space holding the project's lists. | `"90146476540"` |
| `loopQueueListId` | required | The Loop Queue list the loops drain. On the tracker, this value stands for the tracker project. | `"901418065068"` |
| `operatorUserId` | required | Dane's seat: every hand-off to him assigns it. On the tracker, his actor id. | `"1"` |
| `machineUserId` | required | The machine's seat, never assigned a ticket. On the tracker, `loop-build`'s actor id. | `"2"` |
| `githubRepo` | required | The repository pull requests go to, `owner/name`. | `"mentor24-maker/spirality"` |
| `dopplerProject` | required | The Doppler project holding the project's keys. | `"spirality"` |
| `dopplerConfig` | required | The config inside it the loops use. | `"dev"` |
| `launchdPrefix` | required | The start of every launchd label the installer makes. | `"com.spirality"` |
| `logDir` | required | The folder the runners write logs and locks to. | `"~/loop-logs"` |
| `mergePhrases` | required | What Dane writes on a ticket to mean "merge this" (at least one). | `["merge", "merge it", "ship it", "approve"]` |
| `governancePaths` | required | Files and folders a loop may not change unattended, and no auto-merge lane may carry, on top of the floor every project shares (`lib/autoMergeLane.js`). An entry ending `/` is a folder; a bare name is that file, or that module and its test, in any folder; any other path is one file. StarCaster's own entries are `lib/fixtures/starcasterGovernancePaths.json`. | `["CLAUDE.md", "docs/LOOP_ENGINEERING.md", "docs/DOCTRINE.md", ".claude/skills/", ".claude/settings.json", ".github/workflows/"]` |
| `autoMergeLanes` | required | Lanes allowed to merge without Dane; empty means none. | `[]` |
| `operatorName` | required | What the loops call the operator in anything he reads. | `"Dane"` |
| `projectSlug` | required | The project's short name: log and lock file names, the machine's sender tag, and the tracker project's slug. | `"spirality"` |
| `legacyMachinePrefixes` | required | Comment prefixes the project's loops used before the `[machine]` stamp. A new project: `[]`. | `[]` |
| `projectScripts` | required | Paths to the project's own scripts that substrate wiring tests read (`lib/projectScripts.js`). May be `{}`. | `{}` |
| `tracker` | optional | `"clickup"` (the default) or `"api"`, the tracker on the Mini. A new project: `"api"`. | `"api"` |
| `trackerPrefix` | optional | The start of every ticket id (`SP-12`). Capital letters and digits. Normie might use `NO`. | `"SP"` |
| `trackerPort` | optional | The port the tracker service listens on. **Only the project that runs the tracker sets it**; a project that uses Spirality's tracker leaves it out, so the installer installs no second tracker. | `4180` |
| `trackerHost` | optional | Where that service listens; with `trackerPort` only. | `"0.0.0.0"` |
| `trackerDataDir` | optional (required with `trackerPort`) | The folder holding the tracker database and its backups. | `"~/spirality-tracker"` |
| `trackerUrl` | optional (required with `"api"`) | The tracker's address for Dane's browser and the hand-over email. | `"http://mac-mini.local:4180"` |
| `trackerApiUrl` | optional | The address the loops themselves call; on the Mini, its own `127.0.0.1`. Defaults to `trackerUrl`. | `"http://127.0.0.1:4180"` |
| `trackerPublicUrl` | optional | The tracker's https address on the internet, through Tailscale Funnel; the API and the page (behind sign-in) answer there. **Only the project that runs the tracker sets it.** Port 443, 8443 or 10000. | `"https://mac-mini.tail7fc5c6.ts.net:8443"` |
| `trackerPageUrl` | optional | The https name people outside the home network open the tracker's page by, through a small forwarding site made from `trackerPublicUrl` (`docs/TRACKER_MVP.md`, "The page's own name"). Invite and reset emails link there when it is set. **Only the project that runs the tracker sets it**, and only once the name shows the sign-in screen. | `"https://spirality.alphire.agency"` |
| `tailscaleLabel` | optional (needed by the Funnel script) | The launchd job that keeps Tailscale running on that machine. | `"com.starcaster.tailscaled"` |
| `tailscaleSocket` | optional (needed by the Funnel script) | Tailscale's socket on that machine (it runs without root). | `"~/.tailscale/tailscaled.sock"` |

**The old names still work, for now (SP-130).** Until November 2026 two of
these were called `productSlug` and `productScripts` (and the setup's answers
file had `productName`). A settings file that still uses them loads exactly as
before: the reader (`OLD_NAMES` in `lib/projectConfig.mjs`) reads each old
name as its new one, and `node scripts/project_config.mjs productSlug` still
answers. A file that gives one field under both names with **different**
values is refused, naming both. To move a project over, its settings file
changes in one pull request, two lines:

```diff
-  "productSlug": "normie",
+  "projectSlug": "normie",
-  "productScripts": {},
+  "projectScripts": {},
```

The old names go away in a later ticket, once every project has moved over.

Seven of these may be overridden from the environment (Doppler) without
changing the file: `CLICKUP_WORKSPACE_ID`, `CLICKUP_SPACE_ID`,
`CLICKUP_LOOP_QUEUE_LIST`, `CLICKUP_OPERATOR_ID`, `CLICKUP_MACHINE_ID`,
`TRACKER_URL` and `TRACKER_API_URL` (`SCHEMA` in `lib/projectConfig.mjs`).

## 3. The Doppler project and its keys

- **What.** Doppler holds every secret the loops use; the repository holds
  only their names (it is public). Each project has its own Doppler project,
  named in `dopplerProject`, with the config named in `dopplerConfig`.
- **Where.** In Doppler. The list of names a project expects is
  `EXPECTED_SECRETS` in `scripts/lib/expectedSecrets.mjs`:

  | Key | What it is for |
  |---|---|
  | `TRACKER_TOKEN_LOOP_BUILD` | the build loop's tracker sign-in |
  | `TRACKER_TOKEN_LOOP_REVIEW` | the review loop's tracker sign-in |
  | `TRACKER_TOKEN_LOOP_INTAKE` | the intake loop's tracker sign-in |
  | `TRACKER_TOKEN_RELAY` | the relay's tracker sign-in |
  | `TRACKER_TOKEN_HAND_RUN` | a session started by hand |
  | `TRACKER_TOKEN_OPERATOR` | Dane's own sign-in, for the page |
  | `RESEND_API_KEY` | the key the tracker sends the hand-over email with |
  | `TRACKER_NOTIFY_TO` | Dane's address for that email |
  | `CLICKUP_API_TOKEN` | the ClickUp token; only needed while a project is still on ClickUp, or to import its ClickUp history (`tracker/import.mjs`) |

  A project that runs a lane of its own adds one more key per lane: see
  item 4, "A lane of the project's own".

  The email keys and `TRACKER_TOKEN_OPERATOR` belong with the project that
  runs the tracker server (they are marked `trackerHome`); a project using
  Spirality's tracker does not need them, and its doctor does not ask for
  them. `CLICKUP_API_TOKEN` is marked `clickup`: doctor asks for it only
  from a project that still talks to ClickUp, its `tracker` `"clickup"` or
  its `loopQueueListId` a real list (Spirality's is, the record kept to
  compare against). A project never on ClickUp (`tracker` `"api"`, ClickUp
  ids `"0"`, like Normie) needs no ClickUp key. The tracker also reads `TRACKER_NOTIFY_FROM` if it is there
  (optional, `tracker/notify.mjs`), and `TRACKER_URL` / `TRACKER_API_URL` can
  override the config (item 2). A runner never holds a token: it sets
  `TRACKER_TOKEN_NAME` to the secret's name, and the door reads the value
  inside its own `doppler run`.
- **Who.** Making the Doppler project is **Dane: a billing screen / browser
  login** (the Doppler dashboard). Putting values in is Dane's too (**a real
  secret value**): sessions are refused Doppler writes, so a session ships a
  script and Dane runs it. The tracker tokens are the exception: `npm run
  tracker:signins -- create` writes them itself, run by Dane on the Mini.
- **Check.** `npm run doctor` says which Doppler project and config it
  looked in (`Doppler project normie, config dev`), then prints every name
  that project needs as `present` or `MISSING`, names only, never values.
- **Today.** Making the project and putting values in: **manual**. The
  check: **automated** for any project (SP-96). Every npm script that needs
  keys runs through `scripts/with_doppler.mjs`, which reads `dopplerProject`
  and `dopplerConfig` from the config, so a copy reads its own project's
  keys with no edit.

## 4. The tracker project and its sign-ins

- **What.** The project's queue in the tracker on the Mini
  (`http://mac-mini.local:4180`): a project with its own slug and ticket
  prefix (Normie: `NO-1`, `NO-2`, ...), its GitHub repository, and one
  sign-in per loop lane.
- **Where.** In the tracker's database on the Mini (`trackerDataDir` of the
  project that runs it, Spirality's `~/spirality-tracker`). The project's
  slug is the config's `projectSlug`, its prefix `trackerPrefix`. The
  sign-ins are the seats in `TRACKER_SEATS` (`scripts/lib/expectedSecrets.mjs`).
- **How a second project's loops sign in** (decided on SP-95: each project
  its own). Every project's loops share the one tracker, but never an
  actor, because `create` gives a found actor a new token and that stops
  the old one.
  - The project that runs the tracker (its config sets `trackerPort`;
    Spirality) keeps the bare lane names (`loop-build`, `loop-review`,
    `loop-intake`, `relay`, `hand-run`) and holds the operator's own
    sign-in, `TRACKER_TOKEN_OPERATOR`.
  - Any other project (no `trackerPort`; Normie) gets one machine actor per
    lane named for itself and the lane (`normie loop-build`, ...), each
    token kept under the same secret names (`TRACKER_TOKEN_LOOP_BUILD`, ...)
    in **its own** Doppler project. It has no operator seat: its project's
    operator is Dane's existing actor, found by name, and never given a new
    token.
  - `create` and `check` refuse unless `doppler run` is for the config's own
    `dopplerProject`, so one project's run never reads or writes another's
    secrets. And once the tracker holds another project's tracker project,
    `create` gives a new token to an actor under a bare lane name (or to
    the operator) only when this run's Doppler project holds the
    operator's own working sign-in, which only the project that runs the
    tracker has. Otherwise it is a second project whose config wrongly sets
    `trackerPort`, about to take over the first project's sign-ins, and it
    is refused, whether or not that project's tracker project already exists (made
    by `create` or on the page). A guest's own seats, named for it, are
    never refused: a rerun after a lost token just re-keys them.
- **A lane of the project's own** (SP-180). A project that runs a lane
  beside the built-in ones (WaveCenter's `loop-handoff`) names it in its
  `spirality.project.json`:

  ```json
  "projectLanes": ["loop-handoff"]
  ```

  That one line gives the lane a machine seat, like the built-in ones
  (`loop-handoff` for the project that runs the tracker,
  `wavecenter loop-handoff` for any other), its token kept as
  `TRACKER_TOKEN_LOOP_HANDOFF` in the project's own Doppler project. Then:
  1. `npm run doctor` lists `TRACKER_TOKEN_LOOP_HANDOFF` as `MISSING`.
  2. A session runs `tracker:signins -- create` on the Mini again, from
     Spirality's folder (it needs no secret typed, so it is not Dane's to
     run). For a project other than Spirality, name its database and its
     settings file:
     `TRACKER_DB=~/spirality-tracker/tracker.db npm run tracker:signins -- create --name <slug> --config ~/WebApps/<slug>/spirality.project.json`.
     It makes the new actor, proves its token at the tracker and writes it
     into Doppler, read back, and leaves every other seat alone.
  3. `npm run doctor` shows it `present`; `tracker:signins -- check` (same
     `TRACKER_DB` and `--config`) names it.
  4. Only then install the lane: the project's own
     `./scripts/install_loop_runner.sh`, run in its main checkout on the
     Mini once the pull request that lists the lane has merged, then
     `--status` shows the lane `loaded:   yes`. A merge alone loads
     nothing: WaveCenter's WC-163, "Install the hand-off lane so
     member-ticked tasks reach the queue again", went Live on 2026-11-09
     with steps 2 and 4 undone, and its lane stayed off until 9:30 AM MT
     the next day.
     Until the config names it, the door refuses every pass of that lane:
     `TRACKER_TOKEN_NAME must name a loop's own tracker secret (...), not
     "TRACKER_TOKEN_LOOP_HANDOFF". A lane of this project's own signs in
     only once its name is in the project config's "projectLanes".`

  A lane name is lower-case words joined by single dashes, listed once, and
  never a built-in seat's name (`operator`, `loop-build`, `loop-review`,
  `loop-intake`, `relay`, `hand-run`) nor `name`, whose secret would be
  `TRACKER_TOKEN_NAME`, the variable every runner sets to say which secret
  to read. Anything else stops the config from loading, naming the entry,
  so a bad entry never reaches the built-in lanes' sign-ins.
- **Who.**
  - The project: `npm run tracker:signins -- create --name <project name>`
    makes it if it does not exist, or Dane makes it with the tracker page's
    Create Project form (**a browser login**).
  - The GitHub repository field (SP-80): `tracker:signins create` fills it
    from the config's `githubRepo` (SP-107), so the project's Edit page is
    no longer needed for it. A new project is made with it; an existing
    project with the field empty has it filled in; one that records a
    different repository is left alone, both are printed, and the command
    fails, for Dane to say which is right. Each write is read back. The
    tracker's website still lets only a person change a project.
  - The sign-ins: Dane runs `tracker:signins create` on the Mini, which
    makes each actor, gives it a token, proves it at the tracker and writes
    it into Doppler. For a project that does not run the tracker, with
    `TRACKER_DB` set to the tracker's database (Spirality's
    `~/spirality-tracker/tracker.db`), after Spirality's own. It runs from
    any folder given the project's settings file, `--config <path to
    spirality.project.json>`: the command and its Doppler wrapper both read
    that file, so its sign-ins land in that project's Doppler project, and
    no copy of the file in the current folder (the `/tmp` workaround on
    SP-98) is needed.
- **Check.**
  - `npm run tracker:signins -- check` asks the tracker who each seat's
    token is; every line must name its own seat.
  - The Projects screen at `trackerUrl/projects` lists the project with its
    prefix and repository.
  - `npm run doctor` (or `npm run clickup -- repo-check` alone) reads the
    project's repository field with the loop's own sign-in and compares it
    with `githubRepo`: the same is fine, an empty field is reported with the
    Edit form's address to fill it in, and a different one fails with both
    named. It only reads; `tracker:signins create` is what writes the field.
  - `npm run clickup -- queue` from the project's repository lists its
    tickets (empty at first) with no error.
- **Today.** The project and every project's sign-ins: **automated**
  (`tracker:signins create`), each project with its own (above). The
  repository field: **automated** (`tracker:signins create`, SP-107); its
  agreement with `githubRepo`: **automated** (`npm run doctor`, SP-99). The
  `tracker:signins` npm script runs under the config's own Doppler project
  (SP-96), so in another project's checkout it reads and writes that
  project's secrets, never Spirality's.

## 5. The loop lanes on the Mini

- **What.** The jobs that make the loops run without anyone at the keyboard:
  `loop-build`, `loop-review` and `loop-intake` (each a kept-alive runner
  starting a fresh Claude session every 30 minutes) and the relay (one pass
  every 10 minutes: merges on Dane's word, `MAIN MOVED` notes). Each is a
  launchd job (the Mac's own service manager: it starts a job at login,
  restarts it if it stops, and survives a reboot).
- **Where.** `~/Library/LaunchAgents/<launchdPrefix>.<job>.plist` on the
  Mini, made by `scripts/install_loop_runner.sh` from the project's own main
  checkout. The runners are `scripts/loop_runner.sh` and
  `scripts/run_relay.sh`. Logs are `<logDir>/<projectSlug>-<job>.log`. The
  labels and the log folder come from the config, so Normie's jobs
  (`com.normie.loop-build`, say) can sit beside Spirality's.
- **Who.** An agent session on the Mini, from the project's main checkout on
  a clean `main`. Signing Claude in on the Mini (`claude login`), if it is
  not, is Dane's (**a browser login**).
- **Check.** `./scripts/install_loop_runner.sh --status` shows every job
  `loaded: yes`, and after the first pass each log has a `START` line.
- **Today.** **Automated** (the installer). Since SP-97 the runners name
  every log, lock and restart label from the config too, so a second
  project's runners keep to their own files (`normie-loop-build.log`,
  `normie-sync.lock`). Never rerun the full installer from a loop session:
  it reloads the lane that session runs in.

## 6. The skills, hooks and rules in the project's repository

- **What.** What a Claude session in the project's repository reads and is
  held to: the four loop skills, the hook that stops edits on `main`, and the
  rules file.
- **Where.** In the project's repository, today as copies of Spirality's:
  - `.claude/skills/loop-build/`, `loop-review/`, `loop-intake/` and
    `loop-spec/` (each a `SKILL.md`).
  - `.claude/settings.json`, which wires the PreToolUse hook
    `scripts/hooks/block_edits_on_main.cjs`.
  - `CLAUDE.md` (the rules for every session, including "How to work with
    Dane" and where the project's tickets live) and
    `docs/LOOP_ENGINEERING.md`.
  - The door and the tools they call: `scripts/clickup.mjs`,
    `scripts/with_doppler.mjs`, `scripts/tracker/`, `scripts/lib/`, `lib/`,
    and the `clickup`, `verify` and `doctor` scripts in `package.json`.
- **Who.** An agent session copies them and adjusts the project's wording.
  What the rules say about the project (what it is, who its users are) is
  Dane's decision.
- **Check.** In a session started in the project's repository, an edit on
  `main` is refused ("Checking branch (no edits on main)"), and
  `npm run clickup -- queue --claimable` answers.
- **Today.** **Manual** (copied by hand). **Missing**: a package the project
  depends on at a pinned version, so a substrate fix reaches it as a pull
  request instead of a re-copy (gap 1).
