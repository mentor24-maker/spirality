# Onboarding Normie onto Spirality: the plan

Normie (https://github.com/mentor24-maker/normie) is the first product to
come onto Spirality from scratch. This page walks every item of the
checklist, [docs/ONBOARDING_A_PRODUCT.md](../ONBOARDING_A_PRODUCT.md), for
Normie: where it stands, what is missing, who does it, and the ticket that
does it. Planned in SP-89, "Normie is not set up on Spirality yet: plan its
onboarding as tickets", from Dane's answer on SP-80 ("A, B, and C
https://github.com/mentor24-maker/normie").

Every "Today" line was checked on 2026-11-02 against Normie's repository on
GitHub (its `main` at `a94ee0d`, last changed 2026-08-02), the tracker on the
Mini, Doppler's project list, and the Mini's own checkout at
`~/WebApps/normie` (clean, on `main`, level with GitHub).

Every ticket starts as `Requested` and tagged `normie-onboarding`, so intake
hands each one to Dane and nothing is built before he says "go".

## Where each ticket lives

- **Spirality's project (`SP-`)**: work that changes Spirality itself (the
  sign-in script, the doctor, the runner) or sets up the Mini and the tracker.
  Filed now.
- **Normie's project (`NO-`)**: work that changes Normie's repository. That
  project does not exist yet, so these tickets are listed below by their
  proposed names, marked **to be filed**. SP-98 creates the project and files
  them, then writes their ids here.

## The order

1. SP-95, SP-96, SP-97, SP-99: Spirality's own fixes, so a second product
   can sit beside it without taking over its sign-ins, keys, logs or locks.
   None waits on another.
2. SP-98: the tracker project, the Doppler project and the loop sign-ins
   (waits on SP-95 and SP-96). It files the Normie tickets below.
3. In Normie's repository: CI and `main`'s protection (N1, N2); the settings
   file (N3); the ticket door (N4); the skills, hook and rules (N5).
4. The loop lanes on the Mini (N6), last, because a lane runs the skills
   from N5 and reads the settings from N3.

**One question for Dane before N1 starts.** Nothing drains Normie's queue
until its lanes run (N6), so N1 to N5 cannot be built by Normie's own loops.
The plan assumes each is built by a session Dane starts by hand in
`~/WebApps/normie` (it signs in as `hand-run`), following the loop-build
steps, the way Spirality's seed loop was bootstrapped. The other option is to
file N1 to N5 in Spirality's project and let Spirality's build loop open the
pull requests in Normie's repository (`pr-opened --repo` exists), which mixes
one product's work into another's queue, against `CLAUDE.md`. SP-98's
hand-off card asks him which.

## 1. The GitHub repository

- **Today.** The repository exists and is public. It has a CI workflow,
  `.github/workflows/ci.yml`, on every pull request and every push to `main`,
  but its one job is named `quality`, not `verify`, and it runs the steps one
  by one (typecheck, lint, test, dependency audit, build) instead of
  `npm run verify`. `package.json` has a `verify` script (typecheck, lint,
  test, audit; `verify:full` adds the build), and `scripts/verify.sh` is a
  third version with the build. `main` is **not protected** (GitHub answers
  "Branch not protected"). Vercel also builds a preview of every pull request
  (its own `Vercel` check). The last two runs on `main` passed (2026-08-03);
  the open Dependabot pull requests #59 and #60 **fail CI at the dependency
  audit step** (`npm audit --audit-level=high --omit=dev`), their last runs
  between 2026-08-17 and 2026-09-07.
- **Missing.** A green CI on pull requests; one check named `verify` that
  runs `npm run verify`; `main` protected with that check required and force
  pushes and deletions off.
- **Who.** An agent session (the workflow edit, and the protection with
  `gh api`). Which dependency bumps to take, if one changes how Normie
  behaves, is Dane's decision.
- **Ticket.**
  - N1, **to be filed** in Normie's project: "Every Normie pull request fails
    CI at the dependency audit: clear the high-severity advisories". Waits on
    nothing in Normie.
  - N2, **to be filed** in Normie's project: "Normie's main can change
    without a green check: name its CI check verify and protect main". Waits
    on N1 (a required check that always fails would block every merge).

## 2. The project config file

- **Today.** Normie has no `spirality.project.json`. Its `.claude/` folder
  holds only `settings.json`, which allows `git checkout` and nothing else.
- **Missing.** The file, with Normie's values: `githubRepo`
  `mentor24-maker/normie`; `dopplerProject` `normie`, `dopplerConfig` `dev`;
  `productSlug` `normie`; `launchdPrefix` `com.normie`; `logDir`
  `~/loop-logs`; `tracker` `"api"`; `trackerPrefix` `NO`; `trackerUrl`
  `http://mac-mini.local:4180` and `trackerApiUrl` `http://127.0.0.1:4180`;
  **no** `trackerPort` (Spirality runs the tracker); `operatorUserId` Dane's
  actor id (`1`); `machineUserId` the build loop's actor id that SP-98's
  sign-ins give Normie; `legacyMachinePrefixes` `[]`; `productScripts` `{}`;
  `governancePaths`. Normie never used ClickUp, but `workspaceId`, `spaceId`
  and `loopQueueListId` are still required and must be digits; on the tracker
  the queue is the project named by `productSlug`.
- **Who.** An agent session writes it. Dane's decisions: the merge phrases,
  and whether any lane may merge without him (`autoMergeLanes`, `[]` unless
  he says otherwise).
- **Ticket.** N3, **to be filed** in Normie's project: "No loop knows
  Normie's tracker, Doppler or repository ids: add its
  spirality.project.json". Waits on SP-98 (the actor ids come from it).

## 3. The Doppler project and its keys

- **Today.** Doppler has projects `spirality`, `starcaster`, `wavecenter` and
  `example-project`; **no `normie`**. Normie's own app keys (Supabase,
  Resend, Solana) live in `.env.local` and Vercel (`.env.example` lists the
  names); the Mini's checkout has no `.env.local`. Spirality's `npm run
  doctor` and its npm scripts name Doppler project `spirality` outright, so
  copied into Normie they would read Spirality's keys (checklist gap 2).
- **Missing.** Doppler project `normie`, config `dev`, holding the five loop
  sign-ins (`TRACKER_TOKEN_LOOP_BUILD`, `TRACKER_TOKEN_LOOP_REVIEW`,
  `TRACKER_TOKEN_LOOP_INTAKE`, `TRACKER_TOKEN_RELAY`,
  `TRACKER_TOKEN_HAND_RUN`). Not the operator's sign-in, `RESEND_API_KEY` or
  `TRACKER_NOTIFY_TO` (they go with the product that runs the tracker), and
  not `CLICKUP_API_TOKEN` (Normie was never on ClickUp). Moving Normie's app
  keys into Doppler is **not** needed for the loops and is not planned here.
  And the fix so the tooling reads the Doppler project from the settings
  file.
- **Who.** Making the Doppler project: **Dane, a billing screen / browser
  login** (the Doppler dashboard). The tokens: written by `tracker:signins
  create`, run by Dane on the Mini. The tooling fix: an agent session.
- **Ticket.**
  - SP-96 "A second product's ticket commands and doctor read Spirality's
    Doppler keys: take the Doppler project from the settings file".
  - SP-98 "Normie has no tracker project, Doppler project or loop sign-ins,
    so no loop can take its work: set them up" (the Doppler project itself).

## 4. The tracker project and its sign-ins

- **Today.** The tracker has three projects, Spirality (`SP`), Starcaster
  (`SC`) and WaveCenter (`WC`); **no Normie**, and no ticket tagged
  `normie-onboarding` before this plan. The GitHub repository field (SP-80)
  is empty on all three. Running `tracker:signins create` for Normie today
  would re-issue the tokens of Spirality's own loop seats and stop
  Spirality's loops (checklist gap 3). Nothing compares the tracker's
  repository field with `githubRepo` (gap 4).
- **Missing.** A safe way to sign in a second product's loops; the project
  `normie` with prefix `NO` and repository `mentor24-maker/normie`; its five
  loop sign-ins; and the repository check.
- **Who.** The sign-in fix and the check: an agent session. Running
  `create` on the Mini: Dane. The repository field: **Dane, a browser
  login** (only a person may change a project).
- **Ticket.**
  - SP-95 "Normie's loops would take over Spirality's tracker sign-ins and
    stop Spirality's loops: give each product its own".
  - SP-98 "Normie has no tracker project, Doppler project or loop sign-ins,
    so no loop can take its work: set them up". Waits on SP-95 and SP-96.
  - SP-99 "The tracker's GitHub repository field can disagree with a
    product's settings file and nobody notices: check one against the
    other".

## 5. The loop lanes on the Mini

- **Today.** No Normie jobs. The Mini has Normie's checkout at
  `~/WebApps/normie`, clean, on `main`, level with GitHub, and Node 22, which
  Normie needs (`.nvmrc`). Claude is already signed in on the Mini
  (Spirality's lanes run there), so no `claude login` is expected.
  `scripts/loop_runner.sh` still writes `~/loop-logs/spirality-...` logs and
  locks whatever the settings say (checklist gap 2), so Normie's runners
  would share Spirality's.
- **Missing.** The runner fix; then Normie's four jobs
  (`com.normie.loop-build`, `com.normie.loop-review`,
  `com.normie.loop-intake`, the relay), installed from `~/WebApps/normie` on
  a clean `main`.
- **Who.** An agent session, never one running in one of Spirality's own
  lanes (the installer reloads the lane it runs in).
- **Ticket.**
  - SP-97 "A second product's loop runners would write into Spirality's logs
    and share its locks: name them from the settings file".
  - N6, **to be filed** in Normie's project: "Normie's loops do not run on
    the Mini: install its loop lanes". Waits on N2, N5 and SP-97.

## 6. The skills, hooks and rules in the product's repository

- **Today.** Normie has a `CLAUDE.md` (a project guide: the stack, commands,
  the local Supabase stack), which pulls in `.cursorrules` for its coding
  rules. It has no loop skills (`.claude/skills/` does not exist), no hook
  stopping edits on `main` (its `.claude/settings.json` wires no hooks; it
  has a git `pre-commit` hook in `.githooks/`), no `docs/LOOP_ENGINEERING.md`,
  and no ticket door (`scripts/clickup.mjs`, `scripts/tracker/`,
  `scripts/lib/`, Spirality's `lib/`, the `clickup` and `doctor` npm
  scripts). Normie's own `lib/` folder holds its app code, so Spirality's
  `lib/` cannot be copied over it under the same name. There is no package
  to depend on yet (checklist gap 1).
- **Missing.** The ticket door and its npm scripts; then the four loop
  skills, the main-branch hook, the "How to work with Dane" and "Where the
  work is tracked" sections in `CLAUDE.md`, and `docs/LOOP_ENGINEERING.md`.
- **Who.** An agent session copies them and adjusts the wording. What
  `CLAUDE.md` says Normie is and who its users are is **Dane's decision**;
  its current guide stays.
- **Ticket.**
  - N4, **to be filed** in Normie's project: "A session in Normie's
    repository cannot reach its tickets: copy in the ticket door and its npm
    scripts". Waits on N3 and SP-96.
  - N5, **to be filed** in Normie's project: "A session in Normie's
    repository can edit main and has no loop to follow: copy in the loop
    skills, the main-branch hook and the loop rules". Waits on N4.
  - The shared package (gap 1): **none needed for Normie.** Normie starts on
    copies, as WaveCenter did; the package is the substrate plan's own work
    (`docs/PLAN.md`, phases 1 to 5), and when it exists Normie moves to it
    with StarCaster and WaveCenter.

## The tickets, in one list

| Id | Project | Name | Waits on |
|---|---|---|---|
| SP-95 | Spirality | Normie's loops would take over Spirality's tracker sign-ins and stop Spirality's loops: give each product its own | |
| SP-96 | Spirality | A second product's ticket commands and doctor read Spirality's Doppler keys: take the Doppler project from the settings file | |
| SP-97 | Spirality | A second product's loop runners would write into Spirality's logs and share its locks: name them from the settings file | |
| SP-99 | Spirality | The tracker's GitHub repository field can disagree with a product's settings file and nobody notices: check one against the other | |
| SP-98 | Spirality | Normie has no tracker project, Doppler project or loop sign-ins, so no loop can take its work: set them up | SP-95, SP-96 |
| N1 (to be filed) | Normie | Every Normie pull request fails CI at the dependency audit: clear the high-severity advisories | |
| N2 (to be filed) | Normie | Normie's main can change without a green check: name its CI check verify and protect main | N1 |
| N3 (to be filed) | Normie | No loop knows Normie's tracker, Doppler or repository ids: add its spirality.project.json | SP-98 |
| N4 (to be filed) | Normie | A session in Normie's repository cannot reach its tickets: copy in the ticket door and its npm scripts | N3, SP-96 |
| N5 (to be filed) | Normie | A session in Normie's repository can edit main and has no loop to follow: copy in the loop skills, the main-branch hook and the loop rules | N4 |
| N6 (to be filed) | Normie | Normie's loops do not run on the Mini: install its loop lanes | N2, N5, SP-97 |
