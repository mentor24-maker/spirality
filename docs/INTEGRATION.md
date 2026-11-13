# How Spirality and a project meet

Spirality is the development pipeline: the tracker, the loops that build,
review and merge, the bus, and the watchdogs. A **project** is an application
the pipeline builds: StarCaster, WaveCenter, Normie, PressPlay, and Spirality
itself. This document says where one ends and the other begins.

## The decision

Dane decided this on SP-261, "Spirality and its projects meet in nine
unwritten places: write down the four integration points, and move the loop
code out of the projects" (2026-11-12):

> My impression from reading the list of places they touch today is that is
> was mostly Spirality functionality being written into Starcaster codebase,
> which again, was just because that's where we started from. So to the
> extent that's the case, I think the solution is placing it strictly in
> Spirality's code base and abstracting it to work with all projects.

The pipeline was first built inside StarCaster's repository, on ClickUp,
before it had a name. Most of what still connects the two is pipeline code
living in the wrong repository. So the rule is:

**Pipeline code lives only in Spirality and works for every project. A
project provides four things, listed below, and nothing else. Spirality reads
nothing about a project except through those four, and a project never calls
the tracker, the bus or the loop's own code.**

This replaces two earlier answers: "projects pin a version of a shared
package" (`docs/PLAN.md`, phase 5) and "a project gets the loop as a wizard
copy" (Dane, 2026-11-08: *"a wizard copy now is fine for now"*). Both
put loop code inside the project. The wizard copy stays in use until the
moves below are done.

## What a project provides

### 1. A manifest

`spirality.project.json` at the root of the project's repository: who the
project is. Its GitHub repository, Doppler project and config, tracker
prefix, merge phrases, protected files (`governancePaths`), auto-merge
lanes, and the application checks below.

- **Spirality owns the format.** It is written down once, with a version
  number, in [PROJECT_MANIFEST.md](PROJECT_MANIFEST.md) (SP-262). A
  manifest with a missing field, an unknown field or the wrong version is
  refused, with the field named, before any lane runs.
- **Nothing about the machine goes in it.** Which machine runs the tracker,
  and its address, are Spirality's to know, not the project's.

### 2. A gate

`npm run verify` in the project's repository. Exit 0 means the project's own
checks pass; anything else means they do not. Spirality runs it before a pull
request opens, in review, and before the setup wizard stops anything, and
never looks inside it. What it runs (typecheck, tests, doctrine checks) is
the project's business.

### 3. Application checks (optional)

Checks that watch the **application**, not the pipeline. StarCaster's
are the site import watch, unapplied database changes, AI keys, broken links
and its workers. Each is listed in the manifest with a name, the command to
run and how often. Each command:

- exits 0 when all is well, and non-zero when something needs attention,
  printing one line saying what;
- posts nothing and calls nothing of Spirality's.

**Spirality runs them** on its own schedule and posts what they find to that
project's bus, as an alarm (texted to Dane) or a plain post, by the same
rules as every other bus post. The check's code stays in the project because
only the project knows what "healthy" means for it.

### 4. Its rules for agents

The project's `CLAUDE.md` and its doctrine (`docs/DOCTRINE.md` and the
like): what the application is, who its users are, how its pages must look.
Spirality's lanes read and follow them. What they say is Dane's decision for
each project.

## What Spirality owns

Everything else, written once and working for every project from the
manifest:

- **The tracker** and the door into it (`npm run clickup`), including the
  tracker sign-ins each project's lanes use.
- **The lanes**: intake, build, review and the relay (merge on Dane's word,
  hand-back, conflict tickets), and the launchd jobs that run them, one set
  per project. They run from Spirality's own folder and work in a git
  worktree of the project's repository.
- **The skills and hooks** a lane's Claude session works under. Spirality
  supplies them to each session instead of copying them into the project's
  `.claude/` folder.
- **Auto-merge** (Lanes A and B), turned on per project by the manifest.
- **The bus**: one per project, the Team chat ticket, alarms texted to Dane,
  the "New on the Bus" count, and Dane's switch words
  (`docs/TRACKER_MVP.md`, "The bus").
- **The pipeline watchdogs**: heartbeat, throughput, stale ready, stale
  answer, repair and reconcile, report failure, the pulse and the weekly
  report's counting. They run for every project, not only StarCaster
  (SP-260).
- **Pacing and pauses**, scoped to one project: a usage limit or a pause in
  one project's lanes never stands down another's.
- **The setup wizard**, which reads the manifest, makes the tracker project,
  its sign-ins and its bus, checks the gate, and installs the lanes.

## Where Spirality and StarCaster touch today

Checked on the Mini on 2026-11-12, the day StarCaster moved to the tracker
(SP-25), and where each ends up:

| # | Today | Whose it is | Ends up |
|---|---|---|---|
| 1 | `spirality.project.json` in StarCaster's repository | The boundary | Stays, as the manifest, once its format is published and checked. |
| 2 | A copy of Spirality's door, runner and libraries in StarCaster's `loop/` folder, with no record of which Spirality version it came from | Spirality's | Leaves StarCaster. The lanes run from Spirality's folder. |
| 3 | StarCaster's `scripts/lib/clickup.cjs` posts alarms to the tracker itself, with the machine name `mac-mini` written into StarCaster's code (PR #1004, SC-791) | Spirality's | Deleted. Spirality posts what application checks find. |
| 4 | The bus, Team chat (SCBUS-1) | Spirality's | Spirality's alone. Only Spirality and Dane write to it. |
| 5 | StarCaster's gate: the list of checks the wizard saved as its check command | The boundary | Stays, under the one name `npm run verify`. |
| 6 | launchd jobs named `com.starcaster.*`, logs in `~/loop-logs`, and StarCaster's old usage-limit stand-down file there (`loops.standdown`, read only by StarCaster's code) | Spirality's | Installed and owned by Spirality, one set per project, with pauses scoped to one project. |
| 7 | GitHub: pull requests, branch protection, merge phrases | The boundary | Stays. The project's repository is where Spirality works. |
| 8 | StarCaster's tracker sign-ins (actors 31 to 35); StarCaster's own app keys in its Doppler project | Sign-ins: Spirality's. App keys: StarCaster's | Unchanged. |
| 9 | `scripts/run_bus_relay.sh` runs pipeline watchdogs and application checks side by side | Mixed | Pipeline watchdogs move to Spirality. Application checks stay in StarCaster as commands listed in its manifest. |

The loop skills and hooks the wizard copied into StarCaster's `.claude/`
folder are Spirality's too, and leave with item 2.

## How a change reaches the projects: staged rollout

Once the loop code lives only in Spirality, one Spirality change could reach
every project at once. The original plan stopped that by letting each project
pin a package version. Dane chose to keep the safeguard another way (SP-261,
2026-11-12, answer "A"):

- **Spirality runs its own lanes on a new release first.** Spirality is the
  first project to meet every change.
- **Each project runs a release Spirality names for it.** A project moves to
  the new release after a quiet period on Spirality's own lanes, or on Dane's
  word.
- **A bad release is rolled back for one project** by naming its previous
  release again, without touching the others.

## The moves

Each is its own ticket in Spirality's queue, and each removal from a project
is a ticket in that project's own queue, filed once Spirality's side is Live:

1. Publish the manifest's format, with a version, and refuse a manifest that
   does not match it.
2. Run a project's lanes, door, skills and hooks from Spirality's folder,
   with pacing and pauses scoped to one project.
   Slice 1 done (SP-263): every lane file in the log folder is named for its
   project, checked by `scripts/lib/laneFiles.test.mjs`, and the pause switch
   is looked for only in the project's own tracker project.
3. Let a project list application checks in its manifest for Spirality to run
   and post to its bus.
4. Move the pipeline watchdogs into Spirality for every project (SP-260,
   filed 2026-11-12, which also sorts StarCaster's watchdogs into pipeline
   watchdogs and application checks).
5. Name a Spirality release for each project, Spirality's own lanes first.
6. In each project's queue: remove the copied loop (`loop/`, the copied
   `.claude/` skills and hooks) and, in StarCaster, the tracker posting in
   `scripts/lib/clickup.cjs` and the watchdogs in `run_bus_relay.sh`.

## Bringing a new application in

When the moves are done, a new application joins the pipeline by:

1. writing its `spirality.project.json`;
2. making `npm run verify` its gate;
3. listing any application checks;
4. running the setup wizard.

Nothing is copied into its repository.
