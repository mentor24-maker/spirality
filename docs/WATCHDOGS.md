# StarCaster's watchdogs: which ones Spirality takes

A **watchdog** is a small scheduled check that looks for something gone wrong
and says so on the bus (`docs/TRACKER_MVP.md`, "The bus"), staying quiet
while all is well. StarCaster has about twenty of them, built before
Spirality had a name, so they only ever watch StarCaster. WaveCenter, Normie,
PressPlay and Spirality itself have none: if one of their lanes dies, nothing
says so.

This list is phase 3 of [PLAN.md](PLAN.md) (SP-260). It sorts every one of
StarCaster's watchdogs into one of two kinds:

- **pipeline**: it watches the loop itself (lanes, tickets, merges, runners,
  the machine they run on). These move into Spirality, set from the project
  config, so every project gets them.
- **app**: it watches StarCaster the web application (site imports, the live
  database, AI keys, client sites). These stay in StarCaster and post through
  Spirality's `bus-post`.

The slices that move them build from this table: SP-266 (heartbeat),
SP-267 (stale ready, stale answer), SP-268 (throughput, failed-job report,
checkout currency), then SP-269 has the setup wizard give every project the
lot ([ONBOARDING_A_PROJECT.md, "The pipeline watchdogs"](ONBOARDING_A_PROJECT.md#the-pipeline-watchdogs-sp-269)). A pipeline row with no ticket says why, with Dane's answer ([Seven questions](#seven-questions)).

Where it was read: StarCaster's `main` at commit `e825945`, the schedule's
own wake ([run_bus_relay.sh](https://github.com/mentor24-maker/starcaster/blob/e82594523d1a15ee9df8b08e6c7667f43f915bb3/scripts/run_bus_relay.sh),
every line it runs, in order), then the jobs on their own schedules (pulse,
weekly report) and the review gate. Each file link names that commit.

| Watchdog | How StarCaster runs it | What it watches | StarCaster files | Watches | Goes to |
|---|---|---|---|---|---|
| Checkout currency | `npm run checkout:current -- --check` | Whether the machine could bring its checkout of `main` up to date, naming the files that blocked it when it could not. | [checkout_currency.mjs](https://github.com/mentor24-maker/starcaster/blob/e82594523d1a15ee9df8b08e6c7667f43f915bb3/scripts/checkout_currency.mjs), [checkoutCurrency.js](https://github.com/mentor24-maker/starcaster/blob/e82594523d1a15ee9df8b08e6c7667f43f915bb3/lib/checkoutCurrency.js) | pipeline | Moved (SP-268): `npm run checkout:current`, `lib/checkoutCurrency.js`; the relay runs it after its own pull on every wake. It only reports: Spirality's runners make the pull. |
| Relay interval | `scripts/bus_relay_interval.sh` (a shell line, not `npm run`) | Whether the schedule installed on the machine still wakes the relay as often as the repository says it should. | [bus_relay_interval.sh](https://github.com/mentor24-maker/starcaster/blob/e82594523d1a15ee9df8b08e6c7667f43f915bb3/scripts/bus_relay_interval.sh), [install_bus_relay.sh](https://github.com/mentor24-maker/starcaster/blob/e82594523d1a15ee9df8b08e6c7667f43f915bb3/scripts/install_bus_relay.sh) | pipeline | Not moving, by Dane's choice (Dane, 2026-11-16): the relay reads its wake time from the Settings page on every pass, so the gap this catches (the repository changed, the installed schedule did not) does not arise here. |
| Heartbeat | `npm run heartbeat -- --push-owned`, `-- --check`, `-- --stale-check --check`, and the closing `-- --beat --role bus-relay` | Whether each scheduled job is still running: every job leaves a stamp when it runs, and a job whose stamp goes stale is said on the bus. | [node_heartbeat.mjs](https://github.com/mentor24-maker/starcaster/blob/e82594523d1a15ee9df8b08e6c7667f43f915bb3/scripts/node_heartbeat.mjs), [nodeHeartbeat.js](https://github.com/mentor24-maker/starcaster/blob/e82594523d1a15ee9df8b08e6c7667f43f915bb3/lib/nodeHeartbeat.js) | pipeline | Moved by SP-266: `npm run heartbeat` ([heartbeat.mjs](../scripts/heartbeat.mjs), [heartbeat.js](../lib/heartbeat.js)) reads each lane's last pass from its log, and the relay runs it with `--check` on every wake. The roll call shared between machines stays behind (see node roles). |
| Node roles | Read by every line above (not run on its own) | Which machine may run which job, so two machines never run the same lane and the heartbeat knows whose stamp to read. | [nodeRoles.js](https://github.com/mentor24-maker/starcaster/blob/e82594523d1a15ee9df8b08e6c7667f43f915bb3/lib/nodeRoles.js) | pipeline | Not moving, by Dane's choice (Dane, 2026-11-16), until lanes run on a second machine: every Spirality lane runs on the Mini, so there is nothing to divide; SP-266 leaves it out on purpose. |
| Throughput | `npm run throughput -- --check` | Whether the loop is getting anything done: lanes that run and exit cleanly while the queue does not move. | [loop_throughput.mjs](https://github.com/mentor24-maker/starcaster/blob/e82594523d1a15ee9df8b08e6c7667f43f915bb3/scripts/loop_throughput.mjs), [loopThroughput.js](https://github.com/mentor24-maker/starcaster/blob/e82594523d1a15ee9df8b08e6c7667f43f915bb3/lib/loopThroughput.js) | pipeline | Moved (SP-268): `npm run throughput`, `lib/loopThroughput.js`; the relay runs it on every wake, reading at most once an hour. |
| Stale ready | `npm run stale-ready -- --check` | Tickets stuck in `Ready to launch`: approved but not merged (a red check, a dead merge step). | [stale_ready.mjs](https://github.com/mentor24-maker/starcaster/blob/e82594523d1a15ee9df8b08e6c7667f43f915bb3/scripts/stale_ready.mjs), [staleReady.js](https://github.com/mentor24-maker/starcaster/blob/e82594523d1a15ee9df8b08e6c7667f43f915bb3/lib/staleReady.js) | pipeline | Moved (SP-267): `npm run stale-ready`, `lib/staleReady.js`; the relay runs it on every wake. |
| Stale answer | `npm run stale-answer -- --check` | Tickets in `Needs your input` where Dane has answered and the ticket still has not moved after 30 minutes. | [stale_answer.mjs](https://github.com/mentor24-maker/starcaster/blob/e82594523d1a15ee9df8b08e6c7667f43f915bb3/scripts/stale_answer.mjs), [staleAnswer.js](https://github.com/mentor24-maker/starcaster/blob/e82594523d1a15ee9df8b08e6c7667f43f915bb3/lib/staleAnswer.js) | pipeline | Moved (SP-267): `npm run stale-answer`, `lib/staleAnswer.js`; the relay runs it on every wake. |
| Worker watch | `npm run worker-watch -- --check` | Whether the live site can reach the YouTube download helper on the Mini through its public address. | [worker_watch.mjs](https://github.com/mentor24-maker/starcaster/blob/e82594523d1a15ee9df8b08e6c7667f43f915bb3/scripts/worker_watch.mjs), [workerWatch.js](https://github.com/mentor24-maker/starcaster/blob/e82594523d1a15ee9df8b08e6c7667f43f915bb3/lib/workerWatch.js) | app | Stays in StarCaster (PLAN.md keeps worker-watch there); posts through Spirality's `bus-post`. |
| Site import watch | `npm run site-import-watch -- --check` | Site Import jobs waiting over an hour with nothing picking them up. | [site_import_watch.mjs](https://github.com/mentor24-maker/starcaster/blob/e82594523d1a15ee9df8b08e6c7667f43f915bb3/scripts/site_import_watch.mjs), [siteImportWatch.js](https://github.com/mentor24-maker/starcaster/blob/e82594523d1a15ee9df8b08e6c7667f43f915bb3/lib/siteImportWatch.js) | app | Stays in StarCaster (PLAN.md keeps site import there); posts through `bus-post`. |
| Unapplied SQL | `npm run sql:unapplied -- --check` | Database changes merged into StarCaster's `docs/SQL` that were never run on the live database. | [unapplied_sql_watch.mjs](https://github.com/mentor24-maker/starcaster/blob/e82594523d1a15ee9df8b08e6c7667f43f915bb3/scripts/unapplied_sql_watch.mjs), [unappliedSql.js](https://github.com/mentor24-maker/starcaster/blob/e82594523d1a15ee9df8b08e6c7667f43f915bb3/lib/unappliedSql.js) | app | Stays in StarCaster; posts through `bus-post`. |
| Broken links | `npm run broken-links -- --check` | Links on client sites that point at a page which was deleted, checked once a week. | [broken_links_check.mjs](https://github.com/mentor24-maker/starcaster/blob/e82594523d1a15ee9df8b08e6c7667f43f915bb3/scripts/broken_links_check.mjs), [brokenLinksTicket.js](https://github.com/mentor24-maker/starcaster/blob/e82594523d1a15ee9df8b08e6c7667f43f915bb3/lib/brokenLinksTicket.js), [pageInboundLinks.js](https://github.com/mentor24-maker/starcaster/blob/e82594523d1a15ee9df8b08e6c7667f43f915bb3/lib/pageInboundLinks.js) | app | Stays in StarCaster. It writes one standing ticket, never the bus, by Dane's choice. |
| AI keys | `npm run ai-keys -- --check` | Whether each AI key the website uses still works, and which account it bills, so a key out of credit is named. | [ai_keys_check.mjs](https://github.com/mentor24-maker/starcaster/blob/e82594523d1a15ee9df8b08e6c7667f43f915bb3/scripts/ai_keys_check.mjs), [aiKeys.js](https://github.com/mentor24-maker/starcaster/blob/e82594523d1a15ee9df8b08e6c7667f43f915bb3/lib/aiKeys.js) | app | Stays in StarCaster: the keys are the website's; posts through `bus-post`. |
| Repair | `npm run repair -- --check` | Tickets the loop left stranded (a dead pass's claim, a ticket stuck mid-hand-off, a ticket that disagrees with GitHub), fixing only what the evidence proves and reporting the rest. | [repair.mjs](https://github.com/mentor24-maker/starcaster/blob/e82594523d1a15ee9df8b08e6c7667f43f915bb3/scripts/repair.mjs), [repair.js](https://github.com/mentor24-maker/starcaster/blob/e82594523d1a15ee9df8b08e6c7667f43f915bb3/scripts/builder/repair.js) | pipeline | Not moving, by Dane's choice (Dane, 2026-11-16): `pass-reconcile` already hands back a dead pass's ticket at the start of every build pass, the relay moves a ticket to Live when it merges it, and the GitHub drift step goes to reconcile (SP-354). |
| Reconcile | Run by repair as its drift step; also `npm run reconcile` by hand | Tickets whose status disagrees with GitHub, for example `Ready to launch` while its pull request is already merged. | [reconcile_clickup_github.cjs](https://github.com/mentor24-maker/starcaster/blob/e82594523d1a15ee9df8b08e6c7667f43f915bb3/scripts/reconcile_clickup_github.cjs) | pipeline | SP-354, in part (Dane, 2026-11-16): a read-only check, run by the relay, that names any open ticket whose pull request was merged or closed straight on GitHub and posts it on the bus. It changes no ticket. |
| Machine backup | `npm run backup:node -- --scheduled` | A daily copy of what exists only on this machine's disk (its identity, launch agents, loop logs, sign-ins) into a private GitHub repository. | [backup_node.mjs](https://github.com/mentor24-maker/starcaster/blob/e82594523d1a15ee9df8b08e6c7667f43f915bb3/scripts/backup_node.mjs), [nodeBackup.js](https://github.com/mentor24-maker/starcaster/blob/e82594523d1a15ee9df8b08e6c7667f43f915bb3/lib/nodeBackup.js) | pipeline | SP-355, in part (Dane, 2026-11-16): copy the tracker's nightly backups and the Mini's launch agents to a private place off the Mini. StarCaster's sign-ins and identity files stay where they are. |
| Failed-job report | `npm run report:failure` (called by the pulse and weekly report runners, and three StarCaster app runners, when a job exits non-zero) | Says on the bus that a scheduled job failed, with the end of its log. | [report_job_failure.mjs](https://github.com/mentor24-maker/starcaster/blob/e82594523d1a15ee9df8b08e6c7667f43f915bb3/scripts/report_job_failure.mjs) | pipeline | Moved (SP-268): `npm run report:failure`; every lane runner calls it when a pass exits non-zero. StarCaster's own app jobs (media intake, Reddit watch, Substack notes) keep calling theirs, through `bus-post`. |
| Pipeline pulse | `npm run pulse:publish`, hourly, from its own schedule (`npm run pulse` prints the same reading by hand) | The loop's flow, hour by hour: tickets moving, passes declining, pull requests and tickets that do not name each other; publishes the report and posts what needs someone. | [run_pipeline_pulse.sh](https://github.com/mentor24-maker/starcaster/blob/e82594523d1a15ee9df8b08e6c7667f43f915bb3/scripts/run_pipeline_pulse.sh), [pulse_publish.mjs](https://github.com/mentor24-maker/starcaster/blob/e82594523d1a15ee9df8b08e6c7667f43f915bb3/scripts/pulse_publish.mjs), [pulse.cjs](https://github.com/mentor24-maker/starcaster/blob/e82594523d1a15ee9df8b08e6c7667f43f915bb3/scripts/pulse.cjs), [pulse.js](https://github.com/mentor24-maker/starcaster/blob/e82594523d1a15ee9df8b08e6c7667f43f915bb3/scripts/builder/pulse.js), [pulseDigest.js](https://github.com/mentor24-maker/starcaster/blob/e82594523d1a15ee9df8b08e6c7667f43f915bb3/lib/pulseDigest.js) | pipeline | Not moving, by Dane's choice (Dane, 2026-11-16): throughput (SP-268), `wip-check` and the tracker's Reporting page already cover what it reports. |
| Weekly report | `npm run report:weekly -- --publish`, Mondays at 07:00, from its own schedule | Gathers the week's figures into a page uploaded to Google Drive, leaving room for the written summary. | [run_weekly_report.sh](https://github.com/mentor24-maker/starcaster/blob/e82594523d1a15ee9df8b08e6c7667f43f915bb3/scripts/run_weekly_report.sh), [weekly_report.mjs](https://github.com/mentor24-maker/starcaster/blob/e82594523d1a15ee9df8b08e6c7667f43f915bb3/scripts/weekly_report.mjs), [weeklyReport.js](https://github.com/mentor24-maker/starcaster/blob/e82594523d1a15ee9df8b08e6c7667f43f915bb3/scripts/builder/weeklyReport.js), [weeklyReportDrive.js](https://github.com/mentor24-maker/starcaster/blob/e82594523d1a15ee9df8b08e6c7667f43f915bb3/lib/weeklyReportDrive.js), [weeklyReportHome.js](https://github.com/mentor24-maker/starcaster/blob/e82594523d1a15ee9df8b08e6c7667f43f915bb3/lib/weeklyReportHome.js) | app | Stays in StarCaster (PLAN.md keeps weekly report content there); posts through `bus-post`. Many of its figures are loop figures, which the tracker's Reporting page already counts for every project. |
| Review gate | A GitHub check on every pull request, not a scheduled job | Pull requests about to merge without a review verdict on their ticket or Dane's word; advisory (it annotates and passes) until Dane makes it a required check. | [review-gate.yml](https://github.com/mentor24-maker/starcaster/blob/e82594523d1a15ee9df8b08e6c7667f43f915bb3/.github/workflows/review-gate.yml) | pipeline | Not moving for now, by Dane's choice (Dane, 2026-11-16): merges go only through the relay on Dane's word, and the gate is a workflow file inside each project's own repository, which goes against loop code living only in Spirality (INTEGRATION.md). |

## Running the moved ones by hand

The three SP-268 moved, from the project's checkout. Each prints a reading
and posts nothing unless `--check` is given; a post goes through
`bus-post`, read back, at most once every 6 hours per finding, and its
reminder stamps live in `<logDir>/<projectSlug>-watchdogs/`.

```bash
npm run throughput                       # queue counts, what closed each day, rework PRs; posts nothing
npm run throughput -- --check            # the same, and post to the bus if it is STALLED (an ALARM) or UNKNOWN
npm run checkout:current                 # current / behind, pulled / behind, could not pull: <why and files>
npm run checkout:current -- --check      # the same, and post an ALARM if this machine is left on old code
npm run checkout:current -- --fix        # by hand only: move untracked files main now tracks out of the way
npm run report:failure -- --job loop-build --status 1 --log ~/loop-logs/spirality-loop-build.log --dry-run
```

The relay runs the first two with `--check` on every wake
(`scripts/lib/relay_queue_watchdogs.sh`), after its pull, under a time
limit, and a failure is one line in its log that never changes its verdict.
The checkout check never pulls: the relay and the lane runners already do,
under their shared lock, and restart the tracker when a pull changes its
files (SP-150). Every lane runner calls the third when a pass exits
non-zero (`scripts/lib/lane_failure.sh`): one ALARM naming the lane, its
exit and the end of its log; the lane's next good pass clears the reminder.
A failed post exits 1 and is logged; it never stops the runner or its next
pass.

## The calls for Dane

The sort follows [PLAN.md](PLAN.md) "What stays project-specific", which
keeps site import, worker-watch and the weekly report's content in
StarCaster. Three rows are closer calls than the rest:

- **Weekly report** is sorted app because PLAN.md keeps its content in
  StarCaster, although many of its figures are about the loop.
- **Machine backup** is sorted pipeline because it backs up the Mini, which
  runs every project's lanes, although it watches nothing.
- **AI keys** is sorted app because the keys are the website's, although one
  copy lives on the Mini.

Seven pipeline rows had no ticket: relay interval, node roles, repair,
reconcile, machine backup, pipeline pulse and the review gate.
[Seven questions](#seven-questions) below asked the one thing each was
waiting on, with a recommended answer, and Dane answered all seven on
2026-11-16 (SP-330): reconcile and machine backup move in part (SP-354,
SP-355), and the other five do not move, by his choice.

## Seven questions

One question per ticketless pipeline row, in the table's order. Each can be
answered in a word or a line: **move it** (build it into Spirality for every
project), **move part of it** (and which part), or **do not move it**. Each
recommendation was checked against Spirality's `main` at commit `e03a997`.
SP-330 sent these to Dane, and he answered "all as recommended" on
2026-11-16 at 11:43 AM Mountain time; his answers are in the table's
"Goes to" column and under each question.

1. **Relay interval.** Should Spirality get a check that the relay's installed
   schedule still matches what the repository says?
   **Recommended:** do not move it.
   The schedule installed on the Mini (its launchd job, the Mac's built-in
   scheduler) only wakes the relay once a minute, a fixed figure
   (`RELAY_TICK` in `scripts/lib/loopSchedule.mjs`), and the relay reads its
   real wake time from the Settings page on every pass (`scripts/run_relay.sh`),
   so changing how often it runs never needs the installed schedule to change.

   **Dane, 2026-11-16:** as recommended: not moving.

2. **Node roles.** Should Spirality get StarCaster's list of which machine may
   run which job?
   **Recommended:** do not move it, until lanes run on a second machine.
   Every Spirality lane and the tracker run on the Mini, so there is nothing
   to divide, and SP-266's heartbeat already reads each lane's own log
   without it.

   **Dane, 2026-11-16:** as recommended: not moving until lanes run on a second machine.

3. **Repair.** Should Spirality get StarCaster's scheduled sweep that fixes
   tickets the loop left stranded?
   **Recommended:** do not move it; file a ticket only if a ticket gets
   stranded in a way nothing below catches.
   A dead build pass's ticket is already handed back by `pass-reconcile` at
   the start of every build pass, and the relay already moves a ticket to
   Live when it merges that ticket's pull request (`lib/relayLane.js`), which
   leaves the sweep's last step, written against ClickUp, to question 4.

   **Dane, 2026-11-16:** as recommended: not moving.

4. **Reconcile.** Should Spirality get a check for tickets whose status
   disagrees with GitHub (for example `Ready to launch` while its pull request
   is already merged)?
   **Recommended:** move part of it: a read-only check, run by the relay, that
   names any open ticket whose pull request is already merged or was closed
   without merging, and posts it on the bus.
   The relay moves a ticket only when it is the one merging, or when Dane
   answers a ticket whose pull request is already merged
   (`lib/busRelayPlan.js`), so a pull request merged or closed straight on
   GitHub leaves its ticket behind with nothing to say so, and a report that
   changes nothing is cheap and safe.

   **Dane, 2026-11-16:** as recommended: moving in part, as SP-354.

5. **Machine backup.** Should Spirality get a daily copy, off the Mini, of
   what exists only on its disk?
   **Recommended:** move part of it: copy the tracker's nightly backups and
   the Mini's launch agents to a private place off the machine, and leave
   StarCaster's sign-ins and identity files where they are.
   The tracker already backs up its database every night at 03:15
   (`tracker/backup.mjs`), but only onto the Mini's own disk, so a dead disk
   today loses every project's tickets at once.

   **Dane, 2026-11-16:** as recommended: moving in part, as SP-355.

6. **Pipeline pulse.** Should Spirality get StarCaster's hourly report on how
   the loop is flowing?
   **Recommended:** do not move it.
   Throughput (SP-268) already raises the alarm when the queue stops moving,
   `wip-check` already pairs every open pull request with its ticket, and the
   tracker's Reporting page already counts each project's tickets and passes,
   so the pulse would mostly repeat them.

   **Dane, 2026-11-16:** as recommended: not moving.

7. **Review gate.** Should every project's pull requests carry a GitHub check
   that refuses a merge with no review verdict or word from Dane?
   **Recommended:** do not move it for now.
   Spirality's pull requests merge only through the relay on Dane's word
   (`lib/mergeOnComment.js`), and the gate is a workflow file that would have
   to live inside each project's repository, which goes against loop code
   living only in Spirality ([INTEGRATION.md](INTEGRATION.md)); StarCaster's
   own copy only advises and has never been made required.

   **Dane, 2026-11-16:** as recommended: not moving for now.
