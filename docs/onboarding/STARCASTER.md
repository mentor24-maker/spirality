# StarCaster's jobs that touch ClickUp, and the plan for each

StarCaster (https://github.com/mentor24-maker/starcaster) is the next
project to move from ClickUp to the tracker (SP-25, "StarCaster still runs on
ClickUp: move it to the tracker"). WaveCenter's move
([WAVECENTER.md](WAVECENTER.md)) showed that the setup wizard's stop step
only unloads the lanes the project's installer names (`loop-build`,
`loop-review`). Everything else StarCaster runs keeps running. This page
lists every one of those jobs that reads or writes ClickUp, so none of them
is switched off halfway. The work was SP-200, done on 2026-11-10 by the
build lane, reading StarCaster's checkout on the Mini (`main` at `0eaf4b37`).
Nothing in StarCaster was changed.

## How it was checked

- `launchctl list | grep starcaster` on the Mini: 13 jobs. Each job's
  `ProgramArguments` was read from its plist in `~/Library/LaunchAgents`.
- For each script a job runs, every local file it imports, followed all the
  way down, was searched for ClickUp's API address, the ClickUp token, a
  ClickUp list id or a `npm run clickup` call. `git grep` over the whole
  repository found the rest (the production app and the workflow).

Six jobs never touch ClickUp: `browser-door`, `colima`, `openclaw`,
`site-import-worker`, `studio-worker` and `tailscaled`. Two are the loop
lanes the wizard replaces: `loop-build` and `loop-review`. The rest are
below.

## Three ways StarCaster reaches ClickUp, and what the switch does to each

The setup copy puts Spirality's ticket door under `loop/` and points
StarCaster's `npm run clickup` at it. It does not remove StarCaster's own
`scripts/clickup_direct.mjs` or `scripts/lib/clickup.cjs`. So:

1. **`npm run clickup -- <command>`** (the weekly report, the merge relay)
   reaches Spirality's door after the switch. A command the door does not
   have (`chat`, `stage-counts`, `bus-relay`) **fails**.
2. **`scripts/lib/clickup.cjs`** (almost every watchdog) reads ClickUp's API
   itself and writes by running `scripts/clickup_direct.mjs` directly. It
   **keeps working, against ClickUp**: the Loop Queue readers watch a list
   nothing writes to any more and report on nothing, and their posts go to
   ClickUp's Team chat ticket, where nobody looks once StarCaster is on the
   tracker. Nothing errors, which is the dangerous part.
3. **The production app on Vercel and the `review-gate` workflow on GitHub**
   read the ClickUp token from their own settings. They keep working against
   ClickUp until they are changed.

**The bus.** Nearly every job below posts to "the bus", StarCaster's alarm
channel: ClickUp's chat channel, which the free plan refuses, so each post
lands on a standing "Team chat" ticket in the Loop Queue instead
(`lib/busFallback.js`). The tracker's bus is already built (SP-24,
[TRACKER_MVP.md, "The bus"](../TRACKER_MVP.md#the-bus-starcasters-alarms)):
`npm run clickup -- bus-post` writes one comment on the bus project's Team
chat ticket. What is missing is a bus project for StarCaster and
`busProject` in its config: the wizard does not set one up (SP-204).

## The list

"Change in StarCaster" means StarCaster's own pull request at the switch
(SP-25), in StarCaster's queue, not here. No plan is "retire": every job
keeps doing its work, on the tracker.

### `com.starcaster.bus-relay` (every 10 minutes, `scripts/run_bus_relay.sh`)

It runs 14 steps, then the relay. One row per step.

| Step | What it reads and writes on ClickUp | Plan |
|---|---|---|
| `checkout:current` (`scripts/checkout_currency.mjs`) | Posts to the bus when the Mini's checkout cannot catch up with `main`. | Change in StarCaster: post with `bus-post`. Needs SP-204. |
| `heartbeat --push-owned`, `--check`, `--stale-check --check` (`scripts/node_heartbeat.mjs`) | Reads and rewrites the "roll call", a ticket in the Loop Queue whose description holds every job's last run; posts to the bus when a job goes quiet. StarCaster's own `loop_runner.sh` writes `loop-build` and `loop-review` beats into it. | Change in StarCaster: keep the roll call as a ticket in the bus project (read with SP-205's read, write with `describe`), post with `bus-post`, and stop expecting `loop-build` and `loop-review` beats: Spirality's runner does not write them, and its lanes are watched by `install_loop_runner.sh --status` and `pass-reconcile`. Needs SP-204, SP-205. |
| `throughput --check` (`scripts/loop_throughput.mjs`) | Reads every Loop Queue ticket (closed too) to see whether the queue is getting shorter; posts to the bus. | Change in StarCaster: read with SP-205's read, post with `bus-post`. Needs SP-204, SP-205. |
| `stale-ready --check` (`scripts/stale_ready.mjs`) | Reads Loop Queue tickets in Ready to launch and their comments (verdicts, Dane's merge word); posts to the bus. | Change in StarCaster: read with SP-205's read and its comments, post with `bus-post`. Needs SP-204, SP-205. |
| `stale-answer --check` (`scripts/stale_answer.mjs`) | Reads Loop Queue tickets and their comments for an answer from Dane that nothing acted on; posts to the bus. | The same as stale-ready. Needs SP-204, SP-205. |
| `worker-watch --check` (`scripts/worker_watch.mjs`) | Posts to the bus when production cannot reach the YouTube download helper. | Change in StarCaster: post with `bus-post`. Needs SP-204. |
| `site-import-watch --check` (`scripts/site_import_watch.mjs`) | Posts to the bus when a Site Import waits with nothing to run it. | Change in StarCaster: post with `bus-post`. Needs SP-204. |
| `sql:unapplied --check` (`scripts/unapplied_sql_watch.mjs`) | Reads production's tables (not ClickUp), then reads the Loop Queue for a ticket already filed and files one when there is none; posts to the bus. | Change in StarCaster: look for the ticket with SP-205's read, file it with `npm run clickup -- task`, post with `bus-post`. Needs SP-204, SP-205. |
| `broken-links --check` (`scripts/broken_links_check.mjs`) | The same shape: reads the Loop Queue for a filed ticket, files one through `lib/clickupForward.js`. | The same as sql:unapplied. Needs SP-205. |
| `ai-keys --check` (`scripts/ai_keys_check.mjs`) | Posts to the bus when an AI key is out of credit or invalid. | Change in StarCaster: post with `bus-post`. Needs SP-204. |
| `repair --check`, `backup:node` | Nothing on ClickUp. | No change. |
| `npm run clickup -- bus-relay` (the relay, in `scripts/clickup_direct.mjs`) | Watches the Loop Queue and the Agent Response list: merges on Dane's word (and auto-merge Lanes A and B), hands tickets back out of Needs your input, copies Dane's comments to the bus, and posts "merged", "refused" and "held" notices. A command Spirality's door does not have, so it fails after the switch. | Becomes Spirality's `relay` lane, which the wizard installs (`com.starcaster.relay`): it already merges on Dane's word and does the hand-back. Lanes A and B: SP-199, SP-202, SP-203. The merge notices on the bus: SP-207. Copying Dane's comments to the bus is replaced by `bus-read --operator` (TRACKER_MVP.md, "The bus"). Change in StarCaster: take the `bus-relay` line out of `run_bus_relay.sh`. |
| `report:failure` when the relay fails (`scripts/report_job_failure.mjs`) | Posts to the bus. | See `report:failure` below. |

**Steps around a merge.** StarCaster's relay runs nothing around a merge
that Spirality's relay lacks, apart from Lanes A and B and the bus notices
above: there is no database step (StarCaster's database changes are watched
by `sql:unapplied`, not applied at merge), and `main` deploys itself on
Vercel. Its "merge window" (one merge at a time) is not needed by Spirality's
relay, which merges one ticket after another in a single pass. So StarCaster
needs no `preMergeCommand`.

### `com.starcaster.pipeline-pulse` (hourly, `scripts/run_pipeline_pulse.sh`)

| Step | What it reads and writes on ClickUp | Plan |
|---|---|---|
| `pulse:publish` (`scripts/pulse_publish.mjs`) | Reads every Loop Queue ticket (closed too), keeps its full report as a ticket in the Loop Queue (creates it the first time), and posts what is due to the bus. | Change in StarCaster: read with SP-205's read, keep the report ticket in the bus project (`task`, `describe`), post with `bus-post`. Needs SP-204, SP-205. |
| `report:failure` when it fails | Posts to the bus. | See `report:failure` below. |

### `com.starcaster.weekly-report` (Mondays 7 AM, `scripts/run_weekly_report.sh`)

| Step | What it reads and writes on ClickUp | Plan |
|---|---|---|
| `report:weekly` (`scripts/weekly_report.mjs`) | Through `npm run clickup --`: `stage-counts` over the Loop Queue for the week, `task` to file the report, `chat` to post it to the bus. After the switch, `stage-counts` and `chat` fail. | Spirality-side: `stage-counts` in the door (SP-206). Change in StarCaster: `bus-post` for `chat`, and `task --list <busProject>` for the report (Spirality's `task` takes the same `--name`, `--body-file` and `--list`). Needs SP-204, SP-206. |
| `report:failure` when it fails | Posts to the bus. | See `report:failure` below. |

### `report:failure` (`scripts/report_job_failure.mjs`)

Called by `bus-relay`, `pipeline-pulse` and `weekly-report` when they fail.
It posts one message to the bus. Plan: change in StarCaster, post with
`bus-post`. Needs SP-204.

### The `review-gate` workflow (`.github/workflows/review-gate.yml`)

Runs `scripts/review_gate.mjs` on every pull request, on GitHub's machines,
with the ClickUp token from the repository's settings: reads the ticket's
review verdict from ClickUp. Advisory: only `verify` is required on `main`.

Plan: change in StarCaster, read the verdict from the tracker at its public
address (`trackerPublicUrl`, already on the internet behind sign-in), with
SP-205's read. It needs a tracker sign-in whose token goes into StarCaster's
GitHub settings: putting that secret in is Dane's (a real secret value).
Until then the gate reads a ClickUp list that no longer changes and, being
advisory, blocks nothing.

### Also found: the production app on Vercel

Not a scheduled job, but it writes to ClickUp, and the switch does not touch
it:

- **Bug reports** (`lib/bugReportForward.js` through `lib/clickupForward.js`):
  every bug report from the app becomes a ClickUp ticket in the Loop Queue,
  in Needs your input.
- **The AI spending alarm** (`lib/aiSpendAlarm.js`, hourly on Vercel's
  scheduler) and **the Mini's AI brake** (`lib/miniAiLimit.js`) post to the
  bus through `lib/clickupForward.js`.
- **The YouTube outreach worker** (`workers/youtube-outreach/health.js`, part
  of `com.starcaster.youtube-outreach-worker`) posts to the bus through
  `scripts/lib/clickup.cjs`.

Plan: change in StarCaster. Bug reports file a tracker ticket and the alarms
post to the tracker's bus, at `trackerPublicUrl`, with their own tracker
sign-in; the Mini's worker uses `bus-post`. The token goes into Vercel's
settings, which is Dane's (a real secret value). Needs SP-204.

## The Spirality tickets this filed

Each is on SP-25's `Waits on:` line, with SP-199, SP-202 and SP-203 for the
auto-merge lanes:

- SP-204, "Make the setup wizard give a project its bus".
- SP-205, "Add a JSON ticket read to the door for scheduled checks".
- SP-206, "Add a stage-counts command to the door for the weekly report".
- SP-207, "Make the relay post its merge notices to the project's bus".

## For SP-25

StarCaster's own pull request at the switch carries every "change in
StarCaster" row above. Until it merges, those jobs still talk to ClickUp:
switch them in that one pull request, not one at a time, and check each row
off against this page.
