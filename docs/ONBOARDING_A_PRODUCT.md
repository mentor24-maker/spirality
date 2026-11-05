# Onboarding a product onto Spirality: the checklist

Everything a product (Normie, say) needs before its development can run on
Spirality's loops, in one place. Until now the answer was spread across the
project config, the installer, the tracker and Doppler. This page is the
list; planning a real product's setup (SP-89, "Normie is not set up on
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
every item below walked for one real product, with its tickets.

Looking back: how Normie's setup really went, its hold-ups, and a setup
wizard for the next product, [docs/onboarding/SETUP_REVIEW.md](onboarding/SETUP_REVIEW.md).

## The way in: one command

On the Mini, from Spirality's own folder, in a Terminal that is not one of
Spirality's lanes:

```bash
npm run onboard -- --product <slug>
```

It asks Dane only the answers that are his decisions, once (kept in
`~/loop-logs/onboard/<slug>.answers.json`), then runs every item below in
order: the read-only look, the clone (the product's `main` into its
checkout folder, only when that folder does not exist yet), the settings file, the sign-ins (one paste block
for Dane: **real secret values**), the copy into the product's repository as
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

The checklist below stays as what the wizard does, item by item, and how
to check each one by hand.

## The gaps, at a glance

The items below marked **missing**, gathered here so they can become tickets:

1. **No shared package yet.** A product cannot "pin a version" of the
   substrate (`CLAUDE.md`, "What we are building", point 3): there is no
   tagged release and nothing published. Today a product must carry its own
   copy of `scripts/`, `lib/` and `.claude/` (item 6).
2. **Some of the copied code still said "spirality".** Both halves are
   fixed. SP-96 fixed the Doppler half: the npm scripts run `doppler run`
   through `scripts/with_doppler.mjs`, and `npm run doctor` checks, all with
   the `dopplerProject` and `dopplerConfig` the config names (item 3). SP-97
   fixed the runner: `scripts/loop_runner.sh` wrote `~/loop-logs/spirality-...`
   and printed a `com.spirality.<skill>` restart line whatever the config
   said; it now reads `logDir`, `productSlug` and `launchdPrefix` from the
   config, like `scripts/install_loop_runner.sh` and `scripts/run_relay.sh`.
3. **Loop sign-ins were per lane, not per product.** Fixed by SP-95: a
   product that does not run the tracker gets machine sign-ins named for
   itself (`normie loop-build`), so its `create` can no longer re-issue
   Spirality's (item 4).
4. **The tracker project's GitHub repository field could disagree
   unnoticed.** Fixed by SP-99: SP-80 added the field, and the loops still
   read the repository from the project config's `githubRepo`, but
   `npm run doctor` now compares the two (item 4).

## 1. The GitHub repository

- **What.** The product's code, as `owner/name` (Normie:
  `mentor24-maker/normie`). Pull requests go there, and its `main` must never
  change unchecked (`CLAUDE.md`, engineering rule 1).
- **Where.** On GitHub. Inside it, the CI workflow
  `.github/workflows/ci.yml`, which runs `npm ci` then `npm run verify` on
  every pull request and every push to `main`; and a `verify` script in the
  product's `package.json` (Spirality's: syntax check, secret check, tests).
- **Who.** An agent session: copying the workflow, writing `verify`, and
  protecting `main` with `gh api` (the required check is `verify`; force
  pushes and deletions off). Making the repository itself, if it does not
  exist, is Dane's decision.
- **Check.**
  - `gh api repos/<owner>/<name>/branches/main/protection` shows
    `"contexts":["verify"]` and `"allow_force_pushes":{"enabled":false}`.
  - A test pull request shows a `verify` check that runs and goes green.
- **Today.** **Manual.** Spirality's own protection was set by hand; no
  script sets it for a new repository.

## 2. The project config file

- **What.** One JSON file of the product's ids, names, paths and phrases.
  Every substrate module reads it instead of a literal, so the same code
  serves every product.
- **Where.** At the root of the product's repository. The file is always
  named `spirality.project.json`, in every product (it is
  `CONFIG_FILE` in `lib/projectConfig.mjs`; there is no `<product>.project.json`
  name). `lib/projectConfig.mjs` finds it by walking up from the current
  folder and checks every key; `scripts/project_config.mjs` prints one value
  for the shell scripts. A missing required key, an unknown key or a
  malformed value stops the caller with a message naming the key.
- **Who.** An agent session writes it. Two values are Dane's decisions: the
  merge phrases and whether any lane may merge without him
  (`autoMergeLanes`).
- **Check.** From the product's repository:
  `node scripts/project_config.mjs githubRepo` prints the repository, and
  exits non-zero naming the key if anything in the file is wrong.
- **Today.** **Manual** (written by hand; the checking is automated).

The keys. "Required" means the file is refused without it. Spirality's value
is the example.

| Key | Required? | What it means | Spirality |
|---|---|---|---|
| `workspaceId` | required | The ClickUp workspace. Still checked even on the tracker; a product that never used ClickUp still has to fill it with digits. | `"90141423066"` |
| `spaceId` | required | The ClickUp space holding the product's lists. | `"90146476540"` |
| `loopQueueListId` | required | The Loop Queue list the loops drain. On the tracker, this value stands for the tracker project. | `"901418065068"` |
| `operatorUserId` | required | Dane's seat: every hand-off to him assigns it. On the tracker, his actor id. | `"1"` |
| `machineUserId` | required | The machine's seat, never assigned a ticket. On the tracker, `loop-build`'s actor id. | `"2"` |
| `githubRepo` | required | The repository pull requests go to, `owner/name`. | `"mentor24-maker/spirality"` |
| `dopplerProject` | required | The Doppler project holding the product's keys. | `"spirality"` |
| `dopplerConfig` | required | The config inside it the loops use. | `"dev"` |
| `launchdPrefix` | required | The start of every launchd label the installer makes. | `"com.spirality"` |
| `logDir` | required | The folder the runners write logs and locks to. | `"~/loop-logs"` |
| `mergePhrases` | required | What Dane writes on a ticket to mean "merge this" (at least one). | `["merge", "merge it", "ship it", "approve"]` |
| `governancePaths` | required | Files and folders a loop may not change unattended. | `["CLAUDE.md", "docs/LOOP_ENGINEERING.md", ".claude/skills/", ".claude/settings.json", ".github/workflows/"]` |
| `autoMergeLanes` | required | Lanes allowed to merge without Dane; empty means none. | `[]` |
| `operatorName` | required | What the loops call the operator in anything he reads. | `"Dane"` |
| `productSlug` | required | The product's short name: log and lock file names, the machine's sender tag, and the tracker project's slug. | `"spirality"` |
| `legacyMachinePrefixes` | required | Comment prefixes the product's loops used before the `[machine]` stamp. A new product: `[]`. | `[]` |
| `productScripts` | required | Paths to the product's own scripts that substrate wiring tests read (`lib/productScripts.js`). May be `{}`. | `{}` |
| `tracker` | optional | `"clickup"` (the default) or `"api"`, the tracker on the Mini. A new product: `"api"`. | `"api"` |
| `trackerPrefix` | optional | The start of every ticket id (`SP-12`). Capital letters and digits. Normie might use `NO`. | `"SP"` |
| `trackerPort` | optional | The port the tracker service listens on. **Only the product that runs the tracker sets it**; a product that uses Spirality's tracker leaves it out, so the installer installs no second tracker. | `4180` |
| `trackerHost` | optional | Where that service listens; with `trackerPort` only. | `"0.0.0.0"` |
| `trackerDataDir` | optional (required with `trackerPort`) | The folder holding the tracker database and its backups. | `"~/spirality-tracker"` |
| `trackerUrl` | optional (required with `"api"`) | The tracker's address for Dane's browser and the hand-over email. | `"http://mac-mini.local:4180"` |
| `trackerApiUrl` | optional | The address the loops themselves call; on the Mini, its own `127.0.0.1`. Defaults to `trackerUrl`. | `"http://127.0.0.1:4180"` |

Seven of these may be overridden from the environment (Doppler) without
changing the file: `CLICKUP_WORKSPACE_ID`, `CLICKUP_SPACE_ID`,
`CLICKUP_LOOP_QUEUE_LIST`, `CLICKUP_OPERATOR_ID`, `CLICKUP_MACHINE_ID`,
`TRACKER_URL` and `TRACKER_API_URL` (`SCHEMA` in `lib/projectConfig.mjs`).

## 3. The Doppler project and its keys

- **What.** Doppler holds every secret the loops use; the repository holds
  only their names (it is public). Each product has its own Doppler project,
  named in `dopplerProject`, with the config named in `dopplerConfig`.
- **Where.** In Doppler. The list of names a product expects is
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
  | `CLICKUP_API_TOKEN` | the ClickUp token; only needed while a product is still on ClickUp, or to import its ClickUp history (`tracker/import.mjs`) |

  The email keys and `TRACKER_TOKEN_OPERATOR` belong with the product that
  runs the tracker server (they are marked `trackerHome`); a product using
  Spirality's tracker does not need them, and its doctor does not ask for
  them. `CLICKUP_API_TOKEN` is marked `clickup`: doctor asks for it only
  from a product that still talks to ClickUp, its `tracker` `"clickup"` or
  its `loopQueueListId` a real list (Spirality's is, the record kept to
  compare against). A product never on ClickUp (`tracker` `"api"`, ClickUp
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
  that product needs as `present` or `MISSING`, names only, never values.
- **Today.** Making the project and putting values in: **manual**. The
  check: **automated** for any product (SP-96). Every npm script that needs
  keys runs through `scripts/with_doppler.mjs`, which reads `dopplerProject`
  and `dopplerConfig` from the config, so a copy reads its own product's
  keys with no edit.

## 4. The tracker project and its sign-ins

- **What.** The product's queue in the tracker on the Mini
  (`http://mac-mini.local:4180`): a project with its own slug and ticket
  prefix (Normie: `NO-1`, `NO-2`, ...), its GitHub repository, and one
  sign-in per loop lane.
- **Where.** In the tracker's database on the Mini (`trackerDataDir` of the
  product that runs it, Spirality's `~/spirality-tracker`). The project's
  slug is the config's `productSlug`, its prefix `trackerPrefix`. The
  sign-ins are the seats in `TRACKER_SEATS` (`scripts/lib/expectedSecrets.mjs`).
- **How a second product's loops sign in** (decided on SP-95: each product
  its own). Every product's loops share the one tracker, but never an
  actor, because `create` gives a found actor a new token and that stops
  the old one.
  - The product that runs the tracker (its config sets `trackerPort`;
    Spirality) keeps the bare lane names (`loop-build`, `loop-review`,
    `loop-intake`, `relay`, `hand-run`) and holds the operator's own
    sign-in, `TRACKER_TOKEN_OPERATOR`.
  - Any other product (no `trackerPort`; Normie) gets one machine actor per
    lane named for itself and the lane (`normie loop-build`, ...), each
    token kept under the same secret names (`TRACKER_TOKEN_LOOP_BUILD`, ...)
    in **its own** Doppler project. It has no operator seat: its project's
    operator is Dane's existing actor, found by name, and never given a new
    token.
  - `create` and `check` refuse unless `doppler run` is for the config's own
    `dopplerProject`, so one product's run never reads or writes another's
    secrets. And once the tracker holds another product's project,
    `create` gives a new token to an actor under a bare lane name (or to
    the operator) only when this run's Doppler project holds the
    operator's own working sign-in, which only the product that runs the
    tracker has. Otherwise it is a second product whose config wrongly sets
    `trackerPort`, about to take over the first product's sign-ins, and it
    is refused, whether or not that product's project already exists (made
    by `create` or on the page). A guest's own seats, named for it, are
    never refused: a rerun after a lost token just re-keys them.
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
    it into Doppler. For a product that does not run the tracker, with
    `TRACKER_DB` set to the tracker's database (Spirality's
    `~/spirality-tracker/tracker.db`), after Spirality's own. It runs from
    any folder given the product's settings file, `--config <path to
    spirality.project.json>`: the command and its Doppler wrapper both read
    that file, so its sign-ins land in that product's Doppler project, and
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
  - `npm run clickup -- queue` from the product's repository lists its
    tickets (empty at first) with no error.
- **Today.** The project and every product's sign-ins: **automated**
  (`tracker:signins create`), each product with its own (above). The
  repository field: **automated** (`tracker:signins create`, SP-107); its
  agreement with `githubRepo`: **automated** (`npm run doctor`, SP-99). The
  `tracker:signins` npm script runs under the config's own Doppler project
  (SP-96), so in another product's checkout it reads and writes that
  product's secrets, never Spirality's.

## 5. The loop lanes on the Mini

- **What.** The jobs that make the loops run without anyone at the keyboard:
  `loop-build`, `loop-review` and `loop-intake` (each a kept-alive runner
  starting a fresh Claude session every 30 minutes) and the relay (one pass
  every 10 minutes: merges on Dane's word, `MAIN MOVED` notes). Each is a
  launchd job (the Mac's own service manager: it starts a job at login,
  restarts it if it stops, and survives a reboot).
- **Where.** `~/Library/LaunchAgents/<launchdPrefix>.<job>.plist` on the
  Mini, made by `scripts/install_loop_runner.sh` from the product's own main
  checkout. The runners are `scripts/loop_runner.sh` and
  `scripts/run_relay.sh`. Logs are `<logDir>/<productSlug>-<job>.log`. The
  labels and the log folder come from the config, so Normie's jobs
  (`com.normie.loop-build`, say) can sit beside Spirality's.
- **Who.** An agent session on the Mini, from the product's main checkout on
  a clean `main`. Signing Claude in on the Mini (`claude login`), if it is
  not, is Dane's (**a browser login**).
- **Check.** `./scripts/install_loop_runner.sh --status` shows every job
  `loaded: yes`, and after the first pass each log has a `START` line.
- **Today.** **Automated** (the installer). Since SP-97 the runners name
  every log, lock and restart label from the config too, so a second
  product's runners keep to their own files (`normie-loop-build.log`,
  `normie-sync.lock`). Never rerun the full installer from a loop session:
  it reloads the lane that session runs in.

## 6. The skills, hooks and rules in the product's repository

- **What.** What a Claude session in the product's repository reads and is
  held to: the four loop skills, the hook that stops edits on `main`, and the
  rules file.
- **Where.** In the product's repository, today as copies of Spirality's:
  - `.claude/skills/loop-build/`, `loop-review/`, `loop-intake/` and
    `loop-spec/` (each a `SKILL.md`).
  - `.claude/settings.json`, which wires the PreToolUse hook
    `scripts/hooks/block_edits_on_main.cjs`.
  - `CLAUDE.md` (the rules for every session, including "How to work with
    Dane" and where the product's tickets live) and
    `docs/LOOP_ENGINEERING.md`.
  - The door and the tools they call: `scripts/clickup.mjs`,
    `scripts/with_doppler.mjs`, `scripts/tracker/`, `scripts/lib/`, `lib/`,
    and the `clickup`, `verify` and `doctor` scripts in `package.json`.
- **Who.** An agent session copies them and adjusts the product's wording.
  What the rules say about the product (what it is, who its users are) is
  Dane's decision.
- **Check.** In a session started in the product's repository, an edit on
  `main` is refused ("Checking branch (no edits on main)"), and
  `npm run clickup -- queue --claimable` answers.
- **Today.** **Manual** (copied by hand). **Missing**: a package the product
  depends on at a pinned version, so a substrate fix reaches it as a pull
  request instead of a re-copy (gap 1).
