# Moving WaveCenter from ClickUp to the tracker: how it went

WaveCenter (https://github.com/mentor24-maker/wavecenter) is the first
project to move onto the tracker from ClickUp, rather than start fresh as
Normie did ([NORMIE.md](NORMIE.md)). The work was SP-23, "WaveCenter still
runs on ClickUp: move it to the tracker", done on 2026-11-09 by a session
started by hand, with Dane running the wizard in the Mini's Terminal. This
page is for StarCaster's move (SP-25): what the wizard did, where it stopped,
and what was left over.

Every fact below was checked on 2026-11-10 against the tracker, WaveCenter's
repository on GitHub and the Mini.

## What the wizard did

From Spirality's folder on the Mini, `npm run onboard -- --project
wavecenter`, answering that WaveCenter was already on ClickUp (Loop Queue
`901422159126`). The first run took 11:06 to 11:45 AM MT:

1. The answers file and five WaveCenter sign-ins (actors 25 to 29).
2. **A hand fix:** WaveCenter's tracker project had no operator. Dane (actor
   1) was filled in by hand, after a copy of the database was saved
   (`~/spirality-tracker/backups/tracker-before-wavecenter-operator.db`).
3. Stop: WaveCenter's old lanes were unloaded at 11:33 AM MT. From here until
   the setup merged, WaveCenter had no loops at all.
4. Snapshot: `~/spirality-tracker/backups/clickup-archive-wavecenter-2026-11-09.tar.gz`.
5. Import: 161 tickets and 1,514 comments, nothing refused. They are WC-1 to
   WC-161, all Live, as ClickUp's list was. ClickUp's list stays untouched as
   the archive.
6. Switch check: "Safe to switch."
7. Copy: **stopped**, see below.

## Where it stopped, and how it got past

WaveCenter's `package.json` already had its own `clickup` and `doctor`
commands, pointing at the old loop's scripts. The wizard never replaces a
project's own npm commands, and `--allow-replace` did not cover them.

Dane chose to free the two names in WaveCenter first: PR #155 removed them
(merged 11/09 12:49 PM MT). The wizard was then run again; it picked up at
the copy step and opened PR #156 for WC-162, "WaveCenter cannot run
Spirality's loop yet: add its settings, verify check, ticket door, loop
skills and lanes" (73 files, merged 11/09 5:36 PM MT).

SP-172, "StarCaster's setup will stop at the copy step: let --allow-replace
replace a project's own clickup and doctor commands", is Live (Spirality PR
#148), so StarCaster
should not need a first pull request like #155.

## What WaveCenter had that Spirality's loop did not

WaveCenter's old loop had lanes and steps of its own. Each needed Spirality
work before WaveCenter could keep it:

- **The hand-off lane** (`loop-handoff`, which files the tasks members tick
  for the AI agents). Spirality had no tracker sign-in for a project's own
  lane, so on WC-162 Dane chose to go ahead without it (Option A). SP-180
  added project lanes (`projectLanes` in the settings file, Spirality PR
  #139); WC-163,
  "Install the hand-off lane so member-ticked tasks reach the queue again",
  added it to WaveCenter (PR #159).
- **Applying database changes before a merge.** SP-185 added
  `preMergeCommand` (Spirality PR #146); WC-164, "Merged database changes will not reach the live
  database: apply them", uses it (PR #160).
- **The Evolution picture after merges**: WC-165, "Merged changes get no
  Evolution picture: run the capture after merges" (PR #158).

For StarCaster, list its own lanes and merge steps before running the wizard,
and file the Spirality tickets for them first, so nothing is switched off
halfway.

## Where it stands on 2026-11-10

- On the Mini, in WaveCenter's folder, `npm run clickup -- whoami` prints
  `Acting as: wavecenter hand-run` (id 29) and talks to the tracker.
- `com.wavecenter.loop-build`, `loop-review`, `loop-intake` and `relay` are
  loaded. WC-162 to WC-165 were built, reviewed and merged through them.
- The hand-off lane came last. PR #159 merged on 11/09 at 8:40 PM MT, but
  the two steps after it waited until 11/10: its sign-in (`TRACKER_DB=~/spirality-tracker/tracker.db
  npm run tracker:signins -- create --name wavecenter --config
  ~/WebApps/wavecenter/spirality.project.json`, from Spirality's folder,
  actor 30) and `./scripts/install_loop_runner.sh` in WaveCenter's folder.
  Its first pass, 9:30 AM MT, signed in and marked WC-163 to WC-165's tasks
  done. The installer also loaded `ai-rating` and `evolution`.

## For StarCaster (SP-25)

- Run it as a hand-run session on the Mini, never in a lane: the stop step
  unloads the project's own lanes.
- Check the project's tracker record has an operator before starting.
- Expect the project to have no loops from the stop step until the setup
  pull request merges; WaveCenter's gap was six hours.
- After any merge that adds a lane, run the installer again; a merge alone
  does not load it.
- Switching back is in `docs/TRACKER_MVP.md`, "Switching back".
