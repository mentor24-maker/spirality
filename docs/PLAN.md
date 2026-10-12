# The substrate plan

Filed as WaveCenter ticket 86bcgm97x on 2026-10-11 and decided by Dane the same day: the substrate is Alphire Spirality, in this repository. The text below is the ticket's analysis and plan, kept here so the repository carries its own reason for existing.

## Goal
Dane asked (2026-10-11): review the StarCaster and WaveCenter pipelines, confirm they are consistent, and plan a properly abstracted multi-project substrate. This ticket carries the analysis and the plan, and asks for the decisions that unlock it. It is not itself build work; the build tickets are filed after Dane answers.

## The finding in one paragraph
The two pipelines are the same design and are NOT a substrate. WaveCenter's loop is a hand-trimmed copy of StarCaster's (its ClickUp door says so in its header; four of its library modules are copies of StarCaster's builder modules). The ClickUp contract is identical: the same seven statuses with the same owners, the same operator id (48012725), the same `[machine]` stamp, the same `@@ASKED/@@CONTEXT/@@NEEDED` card, the same `PR opened:` and `REVIEW: PASSED` markers, the same command names and guards, the same launchd runner shape, the same three skills. What differs is everything StarCaster learned after the copy was taken, and the copy is already paying for that: on 2026-10-11 three WaveCenter tickets sat for hours after Dane wrote "merge", and two answers (A, D) sat unread. StarCaster fixed exactly that on 2026-08-21 (mergeOnComment.js, "three Ready-to-launch tickets sat for hours after Dane commented merge"). The lesson existed; the copy did not carry it.

## Sizes
- StarCaster loop machinery: about 50,000 lines of code, 42,000 lines of tests, 9,100 lines of docs. Door 6,390 lines, 35 commands. Five launchd lanes (build, review, bus-relay every 10 min, pipeline-pulse, weekly-report). Watchdogs: heartbeat, throughput, stale-ready, stale-answer, repair/reconcile, report-failure, node roles.
- WaveCenter: about 1,700 lines, 3 percent of that. Door 634 lines, 20 commands. Two lanes. No watchdogs: if a runner dies, nothing says so.

## Where they are consistent (good)
- Statuses, owners, who may set Dane's two statuses, the PASS gate on Ready to launch.
- Comment conventions and the operator card, including the 50-100 word context rule and the blockquote ban.
- `waiting` as the only honest way to say "waiting on Dane".
- Runner: one skill per lane, lock per lane, log per lane, time limit, fresh headless session per pass, refuse to run from a worktree.

## Where they have drifted (the gaps, most costly first)
1. Merge and hand-back. StarCaster: bus-relay reads Dane's "merge"/"merge it"/"ship it"/"approve", merges with the check green, files a conflict ticket when it cannot, and moves an answered Needs your input ticket back to Queued. WaveCenter: nothing reads comments (ticket 86bcgkznw, filed today).
2. Health. StarCaster has heartbeat, throughput, stale-ready, stale-answer, report-failure. WaveCenter has none. A dead WaveCenter lane is invisible.
3. Budget and pacing. StarCaster's door keeps a ClickUp request reserve for interactive sessions, yields when scheduled traffic would starve them, and paces the build lane to queue depth with a WIP cap and a pause switch. WaveCenter's door only reports the limit.
4. The definition of done. WaveCenter has ONE name, `npm run verify`, run by CI, build and review alike. StarCaster has no single verify script: the gate is a list in ci.yml plus a hand-kept subset in loop-build's SKILL.md. WaveCenter's is the better idea and should flow back.
5. Branch protection. WaveCenter: required `verify` check, enforced for admins, checked today by API. StarCaster: a documented manual step, plus an advisory review-gate check that is not yet enforcing.
6. Hooks. WaveCenter: one (no edits on main). StarCaster: seven Claude hooks (including Stop hooks that refuse to end a session without a proper hand-off) and git hooks.
7. Configuration. StarCaster re-declares the Loop Queue list id in 14 code files and the operator id in 6, hard-codes the Doppler project in about 15 npm scripts, the repo name in 3 files, the launchd prefix, the node identity file and the known-repos table. WaveCenter declares its ids once, with env overrides. Neither has a "project" object.
8. Docs. StarCaster's doc says the token belongs to a second account (Pulse); its code says the loops post under Dane's token, which is why the `[machine]` stamp exists. The doc is out of date. WaveCenter's doc links to StarCaster's for the incident history, so the lessons live in one repo and the rules in two.

## What a substrate is, here
One shared package that owns everything in the list above that is NOT about a particular product, parameterised by one project config object: workspace, space, Loop Queue list, operator id, machine user id, GitHub repo, Doppler project and config, launchd label prefix, log folder, merge phrases, governance paths, lane allow-lists. Each product repo keeps only: its `verify` contents, its deploy and database specifics, its CLAUDE.md and doctrine, and a short "gates" section in each skill. StarCaster already has the seed of this in two places: `builder/taskRepo.js` (the `repo:<name>` tag that routes a ticket to another checkout) and `lib/nodeRoles.js` (which machine runs which lane). StarCaster's code is also already well shaped for extraction: every script is a thin I/O shell over small pure modules with tests, so the work is moving files behind existing tests, not rewriting.

## The plan, in phases (each phase is a few tickets; each ticket one PR)
0. The contract, written once. A `LOOP_CONTRACT.md` in the substrate repo: statuses, owners, markers, card format, operator id rule, merge phrases, the `waiting` verdicts. Both product docs link to it instead of restating it. Fix the two-account text. (1 ticket)
1. The pure decision modules, with their tests, moved into the package and imported back by StarCaster (no behaviour change, proven by its 42,000 test lines) and then by WaveCenter: loopStatuses, loopTrail, machineComment, operatorCard, waitingOnOperator, costlyAsk, sendBackRounds, mergeOnComment, refusalClass, conflictWork, branchCatchUp, busRelayPlan, autoMergeLane, wipCap, loopInterval, passClaim, passTimeout. The project config object is born here. (about 4 tickets: package skeleton and config; StarCaster imports; WaveCenter imports; delete the copies)
2. The door. One `clickup` CLI in the package with StarCaster's command set including `bus-relay` (relay, merge-on-comment, hand-back, conflict tickets); each repo's `npm run clickup` becomes a one-line wrapper. WaveCenter's merge lane (86bcgkznw) is then "install the package's relay lane", not a third implementation. (about 3 tickets)
3. Runners and health. `loop_runner.sh`, the installer (label prefix and log folder from config), heartbeat, stale-ready, stale-answer, throughput, report-failure, checkout-currency, in the package; WaveCenter gets all of them by installing. (about 3 tickets)
4. Skills and hooks. The three SKILL.md files become package templates with a per-repo gates section; the hook set is shared. StarCaster adopts `npm run verify` as its one gate name. (about 3 tickets)
5. Upgrades as PRs. A product pins a substrate version; a bump is a PR with CI, so rule 1 (nothing reaches main unchecked) covers substrate changes too, and a bad release can never reach both products at once.

## What stays product-specific, on purpose
StarCaster: asset pinning, Vercel bundle and UI doctrine checks, `check:shots`, site import, worker-watch, weekly report content, DOCTRINE.md. WaveCenter: core boundary check, secrets scan, browser-secrets check, Supabase RLS check, DATA_MODEL and EXTENSION_MODEL. Each product's CLAUDE.md.

## Risks and how the plan handles them
- Size: 50,000 lines. Move module by module behind the existing tests; never rewrite. Phase 1 is the cheapest and highest-value step because those modules are already pure.
- A shared bug reaches both products: pinned versions, one PR per product to upgrade, CI on each.
- Infrastructure separation (CLAUDE.md, StarCaster's 2026-08-17 outage): the substrate is code only; it holds no keys, no database, no deploy. Each product keeps its own Doppler, Supabase and Vercel.
- Ordering with 86bcgkznw: building it as a WaveCenter copy now means a third mergeOnComment to keep in step. Recommendation: Phase 1 first (one or two days of loop time), then 86bcgkznw on top of it.

## Non-goals
- No change to the ClickUp statuses or lists; they are already identical.
- No monorepo; the products stay separate repos with separate infrastructure.

## Affected files / artifacts
- New repository for the substrate (name is Dane's; suggestion: deo-loop), its own Loop Queue list, and a third pair of lanes on the Mac Mini.
- StarCaster: scripts/clickup_direct.mjs, scripts/builder/*, scripts/lib/clickup*.cjs, scripts/loop_runner.sh, scripts/install_loop_runner.sh, scripts/run_bus_relay.sh, .claude/skills/*, .claude/settings.json, docs/LOOP_ENGINEERING.md.
- WaveCenter: scripts/clickup.mjs, scripts/lib/*, scripts/loop_runner.sh, scripts/install_loop_runner.sh, .claude/skills/*, docs/LOOP_ENGINEERING.md.

## Acceptance criteria
- [ ] Dane has answered the three questions on the card.
- [ ] The Phase 0 and Phase 1 tickets are filed in the agreed queue in loop-spec shape before any building.

## How to test
- Open this ticket's card: three questions, each answerable with a letter.

## Risk
low for this ticket (a plan). The build phases carry their own risk lines.
