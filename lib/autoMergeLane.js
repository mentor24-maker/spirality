'use strict';

/**
 * autoMergeLane — Lane A: "tests and documentation merge themselves after a
 * one-hour window."
 *
 * WHY THIS EXISTS (2026-08-25, task 86bbkw2au). Merge-on-comment removed the
 * HANDS from the merge step: Dane says "merge" and the machine performs it,
 * after checking review passed, checks are green, and nothing conflicts. What
 * remained was the WORD — and at scale that word is the ceiling. Ninety-four
 * merges in the week of 17-24 August is ninety-four decisions; at three hundred
 * it is not a decision any more, it is a rubber stamp, and a rubber stamp is
 * worse than a policy because it looks like oversight while providing none.
 *
 * So auto-merge goes exactly where his answer was never in doubt. Lane A is
 * 12% of the volume and approximately 0% of the risk — every changed file is a
 * test or a document, nothing runtime moves. That ratio is the REASON to start
 * here: what the first weeks measure is not whether documentation can be
 * merged safely, it is whether the MACHINERY is trustworthy — does the kill
 * switch work, does the digest get read, does the rate cap hold, does it
 * disable itself on trouble. Those questions are worth answering while the
 * blast radius is zero.
 *
 * Canon: vault `doctrine/AUTO-MERGE-LANES.md` (ratified 2026-08-24), including
 * Dane's three rulings — Lane A ships, it gets a one-hour objection window
 * ("to start", so a starting position rather than a permanent property), and
 * Lane C is never automated. Lane B was not ruled on and is not shipped;
 * nothing here knows what a Lane B is.
 *
 * EVERYTHING IN THIS FILE IS PURE. Path eligibility, window arithmetic, the
 * rate cap, the kill switch and the self-disable are decisions, and a decision
 * that can only be exercised against a live ClickUp and a live GitHub is a
 * decision nobody will break-test. The plumbing that carries these out lives
 * in scripts/clickup_direct.mjs (`bus-relay`), the same pass that already
 * relays his comments and performs his authorized merges.
 *
 * NOTHING HERE LOOSENS AN EXISTING PRECONDITION. Lane A replaces the
 * operator's comment and NOTHING else: a review PASS, an open PR, green
 * checks and a clean merge are all still required, and they are still checked
 * by mergeOnComment.githubGate on the way through. This module only ever
 * decides whether the machine may supply the word he would have said.
 */

const { machineSenderTag } = require('./substrateConfig.js');

const {
  normalizeCommand,
  isReviewVerdict,
  isReviewPassed,
  findPullRequest,
} = require('./mergeOnComment');
const { isStampedMachineComment, MACHINE_MARKER } = require('./machineComment');

// ── Criterion 1: which files may ride in this lane ───────────────────────────

/**
 * The allow list, and it is an ALLOW list on purpose: one file outside it
 * disqualifies the whole PR. There is no partial credit and no "mostly tests"
 * — the doctrine's phrasing, and the reason is that a mixed PR's risk is the
 * risk of its riskiest file, not the average.
 */
const LANE_A_ALLOWED = [
  { label: 'a test file', re: /(^|\/)[^/]+\.test\.(js|ts|tsx|mjs)$/ },
  { label: 'a file under docs/', re: /^docs\// },
  { label: 'a Markdown document', re: /\.md$/ },
];

/**
 * Lane B — the pipeline's own tooling (2026-09-04, task 86bbuzyra).
 *
 * WHY IT EXISTS. Overnight 2026-09-03 nine pull requests merged and Lane A
 * merged none of them, because the pipeline had spent the night building on
 * ITSELF — `scripts/`, not tests and not documents. Seven hours of a ten-hour
 * night had no merge at all, and the gaps lined up exactly with when Dane was
 * asleep. `wipCap.js` already states the identity: throughput is
 * min(build, review, merge), and merge is the slowest. Overnight it was zero.
 *
 * WHY ONLY `scripts/`. The doctrine's Lane B row reads "internal runtime with
 * real coverage — `lib/`, `scripts/`, tooling", and the ticket proposed exactly
 * that. `lib/` was then measured and REMOVED, by Dane, on the record:
 *
 *   `server.js` requires it directly (`lib/config`, `lib/environmentBanner`,
 *   `lib/publicSiteHosts`, `lib/devTeamStore`), it holds the stores and
 *   `projectScope.js` that serve tenant sites, and `lib/builder-client/**`
 *   bundles into `public/builder-bundle.js` and into `lib/builder/template.js`
 *   — the code that renders a client's published pages. A bad merge there
 *   reaches a client's site with no human in the path.
 *
 * So the line is `scripts/`, which no served route reaches. That boundary is
 * not self-enforcing — `lib/loopThroughput.js` already imports
 * `scripts/builder/wipCap.js`, so the trees are not cleanly separated — which
 * is why Dane attached a condition to picking it: a check that fails if an
 * auto-mergeable folder becomes reachable from the server, so the decision
 * cannot silently expire. That is `npm run check:automerge-reach`.
 *
 * Dane's ruling, 2026-09-04, in full: "A — scripts/, docs/ and test files
 * only." Everything guarding Lane A guards this identically: a review PASS,
 * the announce-and-wait window, cancel-by-commenting, the caps, the kill
 * switch, the self-disable latch, and `governanceReason()` below.
 */
const LANE_B_ALLOWED = [
  // The extension list is not decoration. `^scripts/` on its own carried
  // `scripts/git-hooks/pre-commit` (extensionless) and every `.sh` runner, and
  // it would carry a `.sql` migration the day somebody adds one — which
  // doctrine criterion 1 calls out by name as NOT reversible by a single
  // revert. Measured against the tree on 2026-09-04: 413 files, all of them
  // .js/.mjs/.cjs/.sh/.json/.txt plus four extensionless git hooks.
  { label: 'a script under scripts/', re: /^scripts\/(?:[^/]+\/)*[^/]+\.(?:js|mjs|cjs|ts|json)$/ },
];

/**
 * Criterion 4, self-amendment: a machine may never auto-merge a change to the
 * machinery that governs machines. Not because such changes are usually bad —
 * most in August were excellent — but because a system that can widen its own
 * permissions has no ceiling, and the failure is undetectable from inside.
 *
 * Matched on the WHOLE repo-relative path, except CLAUDE.md which is matched
 * on its basename: this repo carries several (components/, src/css/, routes/,
 * public/js/, lib/builder-client/) and every one of them is an instruction to
 * agents, not prose.
 */
const GOVERNANCE_PATHS = [
  'docs/DOCTRINE.md',
  'docs/LOOP_ENGINEERING.md',
];

/** Any file with this basename is governance, wherever it sits. */
const GOVERNANCE_BASENAMES = ['CLAUDE.md'];

/**
 * The machinery that governs machines, blocked whether the change is to the
 * SOURCE or to its test.
 *
 * ORIGINALLY THIS LIST WAS TESTS ONLY, and that was correct while Lane A
 * existed on its own: a test that governs merging IS governance even though it
 * is a test file and would otherwise sail through the allow list. The sources
 * needed no rule, because `mergeOnComment.js` is neither a test nor a document
 * and Lane A refused it without being asked to.
 *
 * LANE B REMOVES THAT ACCIDENT (2026-09-04, task 86bbuzyra). `scripts/` is now
 * eligible, and the merge step lives in `scripts/`. Dane was told, in the card
 * that asked him to choose the boundary, that "everything already guarding
 * Lane A stays … governanceReason() still blocks agent config outright" — which
 * reads as a promise that the merge step is still protected. It was not, and
 * without this change the very first thing the widened lane would have done is
 * auto-merge PR #593, which edits `scripts/builder/mergeOnComment.js`.
 *
 * Ratified doctrine, criterion 4, names it exactly: "A machine may never
 * auto-merge a change to the machinery that governs machines … CI workflows,
 * git hooks, check_conventions, nodeRoles, .gitattributes, THE MERGE STEP
 * ITSELF, or this document." A system that can widen its own permissions has no
 * ceiling, and the failure is undetectable from inside.
 *
 * Being STRICTER is the safe direction, and stays the safe direction: the cost
 * of a wrong entry here is that one more PR needs Dane's word, which is the
 * status quo. The cost of a missing one is a lane that can rewrite its own
 * rules unobserved.
 */
const GOVERNANCE_STEMS = [
  // The merge step and the rules of the lanes themselves.
  'mergeOnComment',
  'autoMergeLane',
  'autoMergeLedgerFile',
  'branchCatchUp',
  'waitForChecks',
  'shipPrTrail',
  // Who may claim a ticket, and whether a pass may run at all.
  'passClaim',
  'preflight',
  'wipCap',
  'loopRunnerGuard',
  'mainGuard',
  'pipelinePause',
  'pipelinePauseStore',
  'loopStatuses',
  'taskRepo',
  // The matcher a gate's verdict is computed from. `check_vercel_bundle` is
  // already governance by the `scripts/check_` prefix, and it decides whether
  // `workers/` can reach the Vercel bundle entirely by asking this module
  // whether a path is excluded — so a lane that could carry this file without
  // Dane could weaken that gate to a permanent pass while the gate itself
  // stayed untouched and green.
  'vercelIgnore',
  // The referee: what counts as a review PASS, and what a send-back is.
  'reviewGate',
  'review_gate',
  'sendBackRounds',
  // The relay that drives every one of the above, and the repair pass that
  // can move a ticket between statuses on its own.
  'busRelayPlan',
  'clickup_direct',
  'pipeline',
  'repair',
  // The retry/backoff policy INSIDE that one door. `scripts/lib/clickup.cjs`
  // is already governance because "a change there changes every automated
  // write at once" — and it delegates the whole when-to-wait-and-retry
  // decision to this file, so the same sentence is true of it. Found by
  // `check:automerge-reach` on 2026-09-05, the first catch-up merge after the
  // shared client landed (#592): the client is reached from the server via
  // routes/publicSite.js -> lib/bugReportForward.js -> lib/clickupForward.js,
  // which put an auto-mergeable file on a live path. This is exactly the
  // silent expiry Dane's condition asked the check to catch, and it caught it.
  'clickupRetry',
  // The spend policy inside that same door, found by the same check on the
  // NEXT catch-up merge (2026-09-05). `scripts/lib/clickup.cjs` delegates
  // *whether a call may be made at all* to these two: `clickupLedger` holds
  // the machine-local budget and the reserve scheduled jobs leave alone, and
  // `clickupCaller` decides which kind of caller this process is. Between
  // them they can silence every automated ClickUp write on the machine — the
  // stop switch, the review gate and this lane's own announcements included —
  // and they are reached from the server by the same path the retry policy is
  // (routes/publicSite.js -> lib/bugReportForward.js -> lib/clickupForward.js
  // -> scripts/lib/clickup.cjs). Two catch-ups, two crossings: the boundary
  // moves whenever somebody refactors behind that door, which is precisely
  // what Dane's condition predicted and why the check runs on every PR.
  'clickupLedger',
  'clickupCaller',
  // THE MERGE STEP, BROKEN INTO PIECES WHILE THIS BRANCH WAITED (2026-09-06,
  // the fourth catch-up merge). Every one of these arrived on `main` between
  // 2026-09-04 and 2026-09-06 as code lifted OUT of the merge step into its
  // own module, and each one landed auto-mergeable: measured on this branch
  // immediately after the catch-up, `laneEligibility` carried all six via
  // lane B. Nothing had gone wrong — the list is by hand, and a file that did
  // not exist when the list was written cannot be on it.
  //
  // That is the failure mode itself, not an oversight to tut at: the boundary
  // expires every time somebody refactors behind it, exactly as the clickup
  // entries above expired twice in one day. `mergeMachineryGovernance.test.js`
  // is the guard that now fails the build instead of letting the next one
  // through, and these are the files it was measured against.
  'mergeCompletion', // "did this PR actually merge?" — every merging caller asks it
  'mergeWindowLease', // who may be in the catch-up window, i.e. who merges next
  'mergeWindowLeaseFile', // that lease's store; a fail-safe is only as good as its disk
  'shipAlreadyLive', // ship's "is this already merged?" — the decision before a merge
  'shipThread', // `npm run ship` IS a merge step
  'ship_thread', // ...and this is the runner that performs it
  'conflictWork', // what counts as a conflict, which is what stops a merge
  'machineComment', // whether a "merge" comment is Dane's or a machine's own (#618)
  'refusalClass', // whether a failed merge may be retried
  // The guard that enforces this whole paragraph. It flagged ITSELF on its
  // first run — its control fixtures contain real `gh pr merge` calls — and
  // that is the right answer for the right reason: a file that decides what
  // may auto-merge is the machinery that governs merging, so a machine must
  // not auto-merge a change to it. Same rule that already covers
  // `autoMergeLane` itself.
  'mergeMachineryGovernance',
  // The repair pass that moves tickets between statuses on its own. `repair`
  // and `pipeline` are already stems for this reason; on 2026-09-05 the sweep
  // was lifted out of `pipeline.mjs` into its own file precisely so it could
  // be tested, and the stem did not follow it.
  'pipelineSweep',
  'strandedLocalWork', // decides whether a stranded ticket's work still exists
  // WHICH MACHINE MAY RUN WHAT, and whether its jobs came back after a reboot.
  // Doctrine criterion 4 names `nodeRoles` outright, alongside the merge step.
  // `lib/nodeRoles.js` is refused today only because `lib/` is outside the
  // lane — the same protection-by-accident this branch exists to remove — and
  // `scripts/verify_node_roles.mjs` landed inside the lane on 2026-09-05. A
  // machine that can auto-merge these can widen its own roles, or excuse its
  // own dead schedules, and grade itself afterwards.
  'nodeRoles',
  'verify_node_roles',
  'nodeRebootTest',
  // THE REFEREE'S AND THE GATES' OWN HELPERS (2026-09-06, review round 2 on
  // task 86bbuzyra). The paragraphs above protect three kinds of machinery —
  // the merge step, the referee that decides what a review PASS is, and the
  // gates the work is judged by — but only the MERGE STEP had a guard asking
  // what it imports. These five are what the widened guard found when the
  // other two kinds were finally asked the same question. Every one of them
  // was carriable by Lane B, and each decides something the machinery above
  // then acts on:
  'reviewGateClickup', // what the referee reads back from ClickUp, i.e. whether a ticket has a passing verdict
  'clickupTicketLink', // what counts as "this PR names its ticket" — widen the matcher and the gate accepts a PR with no trail
  'loopTrail', // the trail the referee reads to decide a PR was opened by a loop at all
  'generated_files', // check_conventions' and check_syntax' definition of which files are generated
  'pin_asset_versions', // check_asset_versions' target list AND its hash function — the gate's whole subject
];

/**
 * Kept as the old name because a test iterates it, and because the ORIGINAL
 * reading — "a test that governs merging is governance" — is still true and is
 * still the more surprising half of the rule.
 */
const GOVERNANCE_TEST_STEMS = GOVERNANCE_STEMS;

/**
 * Whole paths that govern, and whose stems are too generic to match on.
 *
 * `scripts/lib/clickup.cjs` is the one door every machine write to ClickUp now
 * goes through, including the budget it counts against; a change there changes
 * every automated write at once.
 */
const GOVERNANCE_FILES = [
  'scripts/lib/clickup.cjs',
  'server.js',
];

/**
 * Prefix rules for whole families of gate.
 *
 * `scripts/check_*` ARE the gates — `check_conventions` is named in the
 * doctrine by hand, and every sibling is the same kind of thing. `install_*`
 * writes the launchd schedules that decide when any of this runs at all.
 */
const GOVERNANCE_FILE_PREFIXES = [
  'scripts/check_',
  'scripts/install_',
  // Doctrine criterion 4 names GIT HOOKS outright. They live here with no
  // extension at all, so nothing else in this file would have matched them.
  'scripts/git-hooks/',
];

/**
 * Every shell script under `scripts/` is a runner, an installer or a schedule
 * — `loop_runner.sh`, `run_bus_relay.sh`, `install_pipeline_pulse.sh`,
 * `provision_node.sh`. All ten of them decide WHEN the automation fires or on
 * what machine, which is the machinery that governs machines however short the
 * file is. Blocked as a class rather than by name so a new one is blocked the
 * day it lands, not the day somebody remembers to list it.
 */
const GOVERNANCE_SHELL_RE = /^scripts\/(?:[^/]+\/)*[^/]+\.sh$/;

/**
 * `.github/` is CI machinery, and it contains Markdown (issue and PR
 * templates) that the allow list would otherwise wave through. A workflow file
 * is already ineligible because it is not `.md` — the templates are the hole.
 *
 * `.claude/` and `skills/` (2026-08-30, review round 2) are the same class and
 * were missed: `.claude/skills/loop-review/SKILL.md` IS the review gate's
 * instructions, every one of them is `.md`, and a PR rewriting how the review
 * loop gates work read as "documentation" and would have merged itself an hour
 * after announcing. Agent configuration is not prose, whichever folder it is in.
 */
const GOVERNANCE_PREFIXES = ['.github/', '.claude/', 'skills/'];

function basenameOf(p) {
  const s = String(p || '');
  const cut = s.lastIndexOf('/');
  return cut === -1 ? s : s.slice(cut + 1);
}

/**
 * Is this one path governance? Returns the reason string when it is, null when
 * it is not — so the caller can name the file AND why, rather than saying
 * "ineligible" and leaving the reader to guess.
 */
function governanceReason(file) {
  const path = String(file || '').trim();
  if (!path) return null;
  const base = basenameOf(path);

  if (GOVERNANCE_BASENAMES.includes(base)) {
    return `${path} is an instruction file for agents — a machine does not auto-merge its own instructions`;
  }
  if (GOVERNANCE_PATHS.includes(path)) {
    return `${path} is doctrine — a machine does not auto-merge the rules it is judged by`;
  }
  if (path.startsWith('.github/')) {
    return `${path} is CI machinery — a machine does not auto-merge what runs its own checks`;
  }
  if (GOVERNANCE_PREFIXES.some((p) => path.startsWith(p))) {
    return `${path} is agent configuration — a machine does not auto-merge the instructions it runs on`;
  }
  if (GOVERNANCE_FILES.includes(path)) {
    return `${path} is machinery every automated write runs through — a machine does not auto-merge it`;
  }
  if (GOVERNANCE_FILE_PREFIXES.some((p) => path.startsWith(p))) {
    return `${path} is one of the gates the pipeline is judged by — a machine does not auto-merge its own checks`;
  }
  if (GOVERNANCE_SHELL_RE.test(path)) {
    return `${path} is a runner or a schedule — a machine does not auto-merge what decides when it runs`;
  }

  // The stem, whether this is the source or the test that covers it. Both
  // halves matter and they fail differently: editing the source changes what
  // the machine DOES, editing the test changes what would have caught it.
  const t = /(^|\/)([^/]+)\.test\.(js|ts|tsx|mjs)$/.exec(path);
  if (t && GOVERNANCE_STEMS.includes(t[2])) {
    return `${path} tests the merge step itself — a test that governs merging is governance`;
  }
  const src = /(^|\/)([^/]+)\.(js|mjs|cjs|ts)$/.exec(path);
  if (src && GOVERNANCE_STEMS.includes(src[2])) {
    return `${path} IS the machinery that governs merging and claiming — a machine does not auto-merge the rules it runs on`;
  }
  return null;
}

/** Does this path match Lane A's allow list (tests and documents)? */
function allowedReason(file) {
  const path = String(file || '').trim();
  const hit = LANE_A_ALLOWED.find((rule) => rule.re.test(path));
  return hit ? hit.label : null;
}

/** Does this path match Lane B's allow list (the pipeline's own tooling)? */
function laneBAllowedReason(file) {
  const path = String(file || '').trim();
  const hit = LANE_B_ALLOWED.find((rule) => rule.re.test(path));
  return hit ? hit.label : null;
}

/**
 * Which lane does ONE file need? 'A' for a test or a document, 'B' for
 * pipeline tooling, null for a file no lane may carry.
 *
 * Lane A is checked first so a test file inside `scripts/` — of which there are
 * hundreds — still reads as Lane A rather than dragging a whole PR into the
 * wider lane. The lane a PR runs in is the widest lane any of its files needs.
 */
function laneForFile(file) {
  if (allowedReason(file)) return 'A';
  if (laneBAllowedReason(file)) return 'B';
  return null;
}

/**
 * Is every changed file eligible for Lane A?
 *
 * @param {string[]} files repo-relative paths, as `gh pr view --json files`
 *   reports them (which is what `git diff --name-only origin/main...HEAD`
 *   would give).
 * @returns {{eligible: boolean, reason: string, files: string[], blockedBy?: string}}
 */
function laneEligibility(files) {
  const list = (Array.isArray(files) ? files : [])
    .map((f) => String(f && f.path ? f.path : f || '').trim())
    .filter(Boolean);

  // A PR that changed nothing is not a safe PR, it is an anomaly. Reading an
  // empty list as "every file matched" is the classic vacuous-truth bug, and
  // here it would auto-merge a PR nobody could describe.
  if (!list.length) {
    return { eligible: false, lane: null, reason: 'the PR reports no changed files — nothing to judge', files: [] };
  }

  for (const file of list) {
    const gov = governanceReason(file);
    if (gov) return { eligible: false, reason: gov, files: list, blockedBy: file };
  }
  let lane = 'A';
  for (const file of list) {
    const need = laneForFile(file);
    if (!need) {
      return {
        eligible: false,
        lane: null,
        reason: `${file} is not a test, a document or pipeline tooling, so no auto-merge lane may carry it`,
        files: list,
        blockedBy: file,
      };
    }
    // The widest lane any single file needs is the lane the whole PR runs in —
    // the same "no partial credit" reading the allow list has always had.
    if (need === 'B') lane = 'B';
  }
  return {
    eligible: true,
    lane,
    reason: lane === 'A'
      ? `all ${list.length} changed file(s) are tests or documentation`
      : `all ${list.length} changed file(s) are the pipeline's own tooling, tests or documentation`,
    files: list,
  };
}

/**
 * The old name, kept because it reads correctly at every call site that only
 * cares whether a PR may auto-merge at all. It is the SAME function: the lane
 * it picks is on the result.
 */
const laneAEligibility = laneEligibility;

// ── The window ───────────────────────────────────────────────────────────────

/**
 * One hour, Dane's ruling of 2026-08-24 — stricter than the draft, which
 * proposed merging immediately on a review PASS. Named rather than written as
 * a literal at the call site, because it is a decision he made with reasons
 * and shortening it is another decision he makes with the log in front of him.
 */
const WINDOW_MS = 60 * 60 * 1000;

/**
 * An announcement has a shelf life (2026-08-30, review round 2). Without one,
 * three PRs armed before a "stop auto-merging" would all be past their
 * deadline when he said "resume" a fortnight later, and would merge on the
 * next pass on windows that closed two weeks ago, with no fresh notice and
 * nothing on his screen. A day is generous: a pass runs every half hour, so an
 * armed ticket that is a day old was not waited out, it was forgotten.
 */
const STALE_MS = 24 * WINDOW_MS;

/**
 * How far into the window are we?
 *
 * `announcedAt` is ALWAYS the timestamp ClickUp put on the announcement
 * comment, read back from ClickUp — never local time at the moment of sending.
 * An announcement that failed to post is not a window, and a clock started
 * from the send would run even when the comment never arrived, merging
 * something nobody was ever told about.
 */
function windowState({ announcedAt, now, windowMs = WINDOW_MS, staleMs = STALE_MS } = {}) {
  const started = Number(announcedAt);
  const at = Number(now);
  if (!Number.isFinite(started) || started <= 0) {
    return { valid: false, elapsed: false, stale: false, elapsedMs: 0, remainingMs: windowMs, deadlineAt: null };
  }
  const deadlineAt = started + windowMs;
  const elapsedMs = at - started;
  return {
    valid: true,
    deadlineAt,
    elapsedMs,
    remainingMs: Math.max(0, deadlineAt - at),
    elapsed: at >= deadlineAt,
    // Past the deadline AND past its shelf life: the window closed long ago
    // and nobody was watching when it did.
    stale: elapsedMs >= staleMs,
  };
}

// ── The record on the ticket ─────────────────────────────────────────────────

/**
 * The announcement and its cancellation are ORDINARY TICKET COMMENTS carrying
 * a marker line, not a state file. That is deliberate: the ticket is the one
 * surface Dane and every pass can both see, the announcement has to be visible
 * to him anyway (an unannounced window is not a window), and a machine that
 * remembers its intentions somewhere he cannot look is how "it merged and I
 * never saw it coming" happens.
 *
 * It also means the clock is ClickUp's own comment timestamp, which is exactly
 * the confirmed-post time the doctrine requires.
 */
const AUTO_MERGE_MARKER = '[auto-merge]';

const AUTO_MERGE_MARKER_RE = /^\s*\[auto-merge\]\s+(armed|cancelled)\s+PR #(\d+)(?:\s+lane ([AB]))?\b/im;

/**
 * The marker line a notice carries, built where the notice is built.
 *
 * The lane letter is OPTIONAL in the regex above on purpose: markers written
 * before Lane B existed say "lane A" and must keep parsing, and a marker whose
 * lane cannot be read is still a marker — losing the lane letter would be a
 * cosmetic gap, losing the armed/cancelled state would strand a live window.
 */
function markerLine(kind, prNumber, at, lane = 'A') {
  return `${AUTO_MERGE_MARKER} ${kind} PR #${prNumber} lane ${lane} — ${at}`;
}

function parseAutoMergeMarker(text) {
  const m = AUTO_MERGE_MARKER_RE.exec(String(text || ''));
  if (!m) return null;
  return { kind: m[1].toLowerCase(), pr: Number(m[2]), lane: m[3] || 'A' };
}

// ── Recognising the lane's OWN voice ─────────────────────────────────────────

/**
 * The first line of each notice, named here rather than typed at the builder,
 * because the recogniser below matches on it. A notice and the test that
 * recognises it are the same pairing `announcementNotice` already keeps with
 * its marker: written apart they drift, and the drift is silent.
 */
const announcementOpening = (prNumber, deadlineLabel) =>
  `**Merging PR #${prNumber} at ${deadlineLabel} unless you say otherwise.**`;
const ANNOUNCEMENT_OPENING_RE = /^\*\*Merging PR #(\d+) at .+ unless you say otherwise\.\*\*$/;
const CANCELLATION_OPENING = '**Auto-merge stopped. Nothing was merged.**';

/**
 * Is this comment NOTHING BUT one of this lane's own notices?
 *
 * WHY A MARKER LINE IS NOT ENOUGH (2026-09-06, task 86bbv8nvy round 2). The
 * announcement is the card Dane is most likely to paste, because it is the one
 * he is replying to — and a verbatim requote carries every line of it,
 * including the `[auto-merge] armed PR #618` marker and the `[machine]` stamp.
 * Asking either of those alone read HIS objection as a fresh announcement,
 * dated to his own words: the window silently restarted from the moment he
 * said stop, and an hour later the lane merged the PR he had said hold on,
 * giving "announced 60 minute(s) ago with no objection" as its reason.
 *
 * So a notice is recognised by its two ENDS, which a quote cannot both keep:
 * the body must OPEN with the notice's own first line and CLOSE with the
 * matching marker line (ignoring the machine stamp `call()` appends after it).
 * Text of his above the card breaks the opening; text of his below it breaks
 * the close. Only the lane writes both, and only in this order.
 *
 * WHY THE ENDS RATHER THAN THE STAMP. Measured 2026-09-06 over 209 real Loop
 * Queue comments: 189 are machine-written, and NOT ONE of them announces
 * itself at the top — they all open with ordinary prose ("PR opened:",
 * "REVIEW: sent back...", "BUILD (round 3):"). A general "machine-marked at
 * both ends" rule would therefore have called every card on the board Dane's
 * word. These two notices are different because this module BUILDS them, so
 * their first line is a fixed string it can check against.
 *
 * @returns {'armed'|'cancelled'|null} which notice, or null if it is not one.
 */
function isLaneNotice(text) {
  const lines = String(text == null ? '' : text)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return null;
  // Drop the machine stamp: `call()` appends it after the marker, so the
  // marker is the last line the notice itself wrote.
  const body = lines[lines.length - 1].startsWith(MACHINE_MARKER) ? lines.slice(0, -1) : lines;
  if (body.length < 2) return null;
  const closing = parseAutoMergeMarker(body[body.length - 1]);
  if (!closing) return null;
  const opens = closing.kind === 'armed'
    ? ANNOUNCEMENT_OPENING_RE.test(body[0])
    : body[0] === CANCELLATION_OPENING;
  if (!opens) return null;
  // The opening names the PR too, and it must be the SAME PR the marker names
  // — otherwise two cards spliced together would pass.
  if (closing.kind === 'armed' && Number(ANNOUNCEMENT_OPENING_RE.exec(body[0])[1]) !== closing.pr) return null;
  return closing.kind;
}

/**
 * Did a person assemble this comment out of a machine card and words of their
 * own?
 *
 * The objection filter's problem, stated exactly: the `[machine]` stamp is the
 * LAST line of every card a loop posts, so a card pasted UNDER Dane's own
 * words lands the stamp at the end of HIS comment, and the whole thing reads
 * as machine-written. Round 1 closed the other ordering (a card pasted ABOVE
 * his words puts the stamp mid-text); this closes the one round 2 found.
 *
 * Two signs, either of which means a person did the assembling:
 *
 *   1. It carries one of THIS LANE's marker lines but is not one of this
 *      lane's notices. Only the lane writes those markers, and only inside a
 *      notice — so a marker in anything else was pasted there. This is the
 *      exact case measured on the real lane, and it needs no history.
 *
 *   2. It contains another comment from this ticket whole, and is longer than
 *      it. A loop writes fresh prose; it does not reproduce a card that is
 *      already on the ticket. Compared on WORDS ALONE, not on the raw text —
 *      see `normalizeForQuoting`, and read that note before trusting this one:
 *      the whole sign turned on a formatting difference until 2026-09-06.
 *      Its false-positive cost is measured in `normalizeForQuoting`'s note —
 *      8 cards on the real board, unchanged by the widening, all one legacy
 *      shape, all in the cancelling direction.
 *
 * WHAT IT DOES NOT COVER, said plainly rather than left to be found again —
 * and note that the first version of this paragraph got the answer wrong. It
 * named a foreign-ticket card as the ONLY residue, while the much likelier
 * case, a card off this very ticket pasted with its formatting dropped, was
 * sailing through sign 2 on the asterisks alone.
 *
 * What is left after that is genuinely the foreign card: he pastes a stamped
 * card from a DIFFERENT ticket that is not a lane notice. The lane has never
 * seen it, so containment has nothing to match against, and nothing in the
 * body says a person put it there. Closing that needs the stamp itself bound
 * to the body it was written for (a digest in the stamp line), which changes
 * what every card a loop posts looks like and is this ticket's stated
 * non-goal.
 *
 * THAT LIMIT IS A GUESS ABOUT WHAT NOBODY DOES, which is what the last two
 * rounds of this ticket were as well. It is pinned by a test that FAILS if a
 * later change closes it, so the claim cannot quietly outlive the code.
 */
function quotesMachineText(c, comments) {
  const text = String((c && c.comment_text) || '');
  if (!text.trim()) return false;
  if (parseAutoMergeMarker(text) && !isLaneNotice(text)) return true;
  const mine = normalizeForQuoting(text);
  return (comments || []).some((other) => {
    if (!other || String(other.id) === String(c.id)) return false;
    const theirs = normalizeForQuoting(other.comment_text);
    // Short comments are excluded: "merge" appears inside half the cards on
    // the board, and a one-word containment says nothing about who typed it.
    if (theirs.length < QUOTED_RUN_MIN) return false;
    return mine.length > theirs.length && mine.includes(theirs);
  });
}

/**
 * Long enough that containment means a paste rather than a coincidence.
 * Counted on the normalised form below, which is shorter than the raw text.
 */
const QUOTED_RUN_MIN = 60;

/**
 * Reduce a comment to its WORDS, so the containment test survives the paste.
 *
 * WHY NOT WHITESPACE ALONE (2026-09-06, task 86bbv8nvy round 3). The first cut
 * collapsed whitespace only, on the stated premise that "whitespace is what a
 * paste is least likely to preserve exactly". Markdown is. Dane described his
 * own method in his own words two days earlier, on 86bbuzyra:
 *
 *     "I copied that and pasted special as Paste and Match Style."
 *
 * Paste-and-match-style drops the formatting. The stored card reads
 * `**REVIEW: PASSED** — every gate re-run`; what lands in his comment reads
 * `REVIEW: PASSED — every gate re-run`. Containment failed on the asterisks
 * alone, so his comment stayed discounted and his objection with it — and the
 * lane merged the PR he said hold on, giving "announced 90 minute(s) ago with
 * no objection" as its reason. This ticket's own failure, arriving through a
 * third door.
 *
 * SO IT COMPARES THE WORDS AND NOTHING ELSE. Every mark a renderer eats —
 * emphasis, code ticks, fences and their language tag, bullets, heading
 * hashes, quote bars, and all punctuation — is gone from BOTH sides before the
 * test. That is deliberately more than the emphasis marks alone: it makes the
 * question "what exactly does his editor preserve?" stop mattering, and that
 * question is unanswerable from here. The marks are DELETED rather than
 * spaced, so `` `continue` ``+`s` reads as "continues", the way it renders.
 *
 * MEASURED BOTH WAYS, 2026-09-06, over 679 stamped machine cards on 134 real
 * Loop Queue tickets — because widening containment can only ADD matches, and
 * the earlier count was taken with the narrow form:
 *
 *   - It closes the bug: with a rendered copy of each of those 679 cards
 *     pasted under an objection, all 679 are now read as his. The narrow form
 *     caught 216. (456 of the 679, 67%, carry emphasis or code marks at all.)
 *   - It costs nothing NEW. Driving the real `quotesMachineText` over all 679
 *     against every comment on their own tickets: 8 are read as assembled by
 *     a person, and the SAME 8, from the same pairs, under the old narrow
 *     form. Widening added none. (Measured with the real function rather than
 *     machine-card pairs, because the filter compares against every comment on
 *     the ticket, and the pairwise count misses exactly this.)
 *
 * THOSE 8 ARE PRE-EXISTING AND ALL ONE SHAPE, recorded here so the next reader
 * does not re-find them: a card that mentions a PR url swallows the older
 * bare `PR opened: <url>` comment naming the same PR, which is just over the
 * length floor. They predate the stamp, so nothing marks them as machine
 * text. Left alone deliberately — fixing it means moving `QUOTED_RUN_MIN` or
 * special-casing that line, both of which are their own change with their own
 * risk, and this one is in the forgiving direction.
 *
 * And the direction is the forgiving one either way: a false positive here
 * reads a machine card as his and CANCELS, which costs a re-announcement. A
 * false negative merges over the top of him.
 */
function normalizeForQuoting(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    // A fence takes its language tag with it — ```js renders as nothing, but
    // left alone it is the word "js" on the stored side and absent on his.
    .replace(/```[a-z0-9+#.-]*/g, ' ')
    .replace(/[*_~`]+/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function commentDate(c) {
  const n = Number(c && c.date);
  return Number.isFinite(n) ? n : 0;
}

function byDateNewestFirst(comments) {
  return (comments || []).slice().sort((a, b) => commentDate(b) - commentDate(a));
}

/**
 * The NEWEST auto-merge marker on the ticket decides where it stands. A ticket
 * announced, cancelled and announced again carries three, and only the last
 * one describes the present.
 */
function latestAutoMergeMarker(comments) {
  for (const c of byDateNewestFirst(comments)) {
    const parsed = parseAutoMergeMarker(c.comment_text);
    if (!parsed) continue;

    // A MARKER ONLY COUNTS ON A COMMENT THIS LANE ACTUALLY WROTE
    // (2026-09-06, task 86bbv8nvy). The announcement is the card Dane is most
    // likely to paste — it is the one he is replying to — and a verbatim
    // requote carries its `[auto-merge] armed PR #618` line. Read as a second
    // announcement dated to HIS comment, the window silently restarted from
    // the moment he said stop, and an hour later the lane merged the PR he had
    // said hold on. Round 1 asked only for the `[machine]` stamp, which a
    // requote also carries; `isLaneNotice` asks for the notice's two ENDS,
    // which his words displace whichever way up he pastes it.
    //
    // THE TWO KINDS SKIP IN OPPOSITE DIRECTIONS, because their fail-safe
    // directions are opposite (round 2 of this ticket).
    //
    //   `armed`     — an unrecognised one arms NOTHING. Nothing merges on a
    //                 window the lane cannot vouch for, and re-announcing
    //                 costs a fresh review PASS like every other cancel.
    //
    //   `cancelled` — an unrecognised one is STILL TERMINAL. Cancelling is
    //                 what makes `laneADecision` refuse to announce again
    //                 without a fresh PASS, so skipping one would read as
    //                 "never announced" and put the notice back in front of
    //                 him — the guard that exists so he does not have to say
    //                 no twice. Trusting a cancellation too readily costs a
    //                 merge that does not happen; distrusting one costs a
    //                 merge that does.
    if (parsed.kind === 'armed' && isLaneNotice(c.comment_text) !== 'armed') continue;
    return { ...parsed, at: commentDate(c), commentId: String(c.id) };
  }
  return null;
}

/** The newest review verdict comment, whatever it says. */
function latestVerdict(comments) {
  const c = byDateNewestFirst(comments).find((x) => isReviewVerdict(x.comment_text));
  return c ? { at: commentDate(c), passed: isReviewPassed(c.comment_text) } : null;
}

// ── The kill switch ──────────────────────────────────────────────────────────

const SWITCH_STOP = 'stop auto-merging';
const SWITCH_RESUME = 'resume auto-merging';

/**
 * Read one of Dane's messages as a switch command.
 *
 * THE TWO HALVES ARE MATCHED DIFFERENTLY, ON PURPOSE. "stop" is found as a
 * SUBSTRING anywhere in his message; "resume" must be the whole message. The
 * asymmetry follows the cost: a stop that fires when he only mentioned it
 * costs a delay and one word to undo, while a resume that fires when he was
 * only talking about resuming costs an unwanted merge of something nobody
 * agreed to. When the two errors are that lopsided, the matcher should be too.
 *
 * Hyphen optional either way — nobody types punctuation the same way twice.
 */
function switchCommand(text) {
  const norm = normalizeCommand(text).replace(/auto[\s-]?merging/g, 'auto-merging');
  if (norm === SWITCH_RESUME) return 'resume';
  if (norm.includes(SWITCH_STOP)) return 'stop';
  return null;
}

/**
 * The other half of a strict matcher: a message that ALMOST said resume.
 *
 * The strictness above is right and this does not touch it (task 86bbuv99r's
 * first non-goal). What it fixes is that a near-miss and silence are the same
 * event from where Dane sits. On 2026-09-03 at 11:11pm he posted the resume
 * phrase wrapped in bold and backticks, believed the lane was back, and found
 * out 35 minutes later only because he asked. It happened again on 2026-09-05
 * at 8:58pm, on the same phrase, in the same wrapper, while an urgent ticket
 * was parked waiting for exactly that resume — twice is the pattern, and both
 * times the lane's answer to a message it did not understand was nothing at
 * all.
 *
 * "Nearly" is defined narrowly and on purpose: the normalised message CONTAINS
 * the resume phrase but is not equal to it. Anything that DID match is not a
 * near miss (it took effect, so there is nothing to say), and anything that
 * never mentions the phrase is not one either — that second half is the noise
 * failure this could turn into, and it is pinned by its own test.
 *
 * Note what this deliberately cannot do: it cannot resume the lane. It says
 * what to type. Acting on a guess about what he meant is the unwanted merge
 * the whole-message rule exists to prevent.
 *
 * @returns {null|{phrase: string, saw: string}}
 */
function nearMissResume(text) {
  // Anything the matcher understood is not a near miss — resume OR stop.
  // Asking the real matcher, rather than re-deriving its rules here, is what
  // keeps the two from drifting apart: a future change to what counts as a
  // match silences this automatically, in the right direction.
  if (switchCommand(text)) return null;
  const norm = normalizeCommand(text).replace(/auto[\s-]?merging/g, 'auto-merging');
  if (!norm.includes(SWITCH_RESUME)) return null;
  return { phrase: SWITCH_RESUME, saw: String(text || '').trim().slice(0, 200) };
}

/**
 * What the party line is told about a near miss.
 *
 * THE PHRASE IS PLAIN TEXT, WITH NOTHING AROUND IT, and that is the whole
 * point of the message rather than a formatting preference. The wrapper he
 * copied on 2026-09-03 came from an agent's own card, which had rendered the
 * command in bold and backticks; a notice that repeats the mistake it is
 * reporting hands him another line that will not take. Both offenders are
 * markdown, so the phrase gets its own line and no decoration at all.
 */
function nearMissNotice({ where = 'on the party line', saw = '' } = {}) {
  const quoted = saw ? `\n\nWhat came through, exactly as ClickUp stored it:\n\n    ${saw}\n` : '\n';
  return `${machineSenderTag('bus-relay')} THAT DID NOT TAKE — a message ${where} looks like it meant to resume auto-merging, and it did not match. Nothing has changed; the lane is in whatever state it was already in.${quoted}
The resume phrase has to be the WHOLE message, as plain text. Bold, backticks or an extra word around it and it is swallowed. Type or paste exactly this line, on its own, with no formatting:

resume auto-merging

(Only "resume" is strict. "stop auto-merging" is matched anywhere in a sentence, so a stop is never lost this way.)`;
}

/**
 * The switch's state, from every source that can carry it.
 *
 * @param {object}   opts
 * @param {Array}    opts.signals  [{ kind:'stop'|'resume', at:<ms>, where:<string> }]
 *                                 from the bus, from Loop Queue ticket comments,
 *                                 and from the ledger (a stop seen on an earlier
 *                                 pass — see why below).
 * @param {boolean}  opts.readable false if ANY source could not be read.
 *
 * FAIL-SAFE IS THE WHOLE POINT (standing condition 1). If the switch cannot be
 * read, auto-merge is OFF — not "assume fine". "He never said stop" and "I
 * could not find out whether he said stop" look identical from in here, and
 * only one of them is safe to act on.
 */
function killSwitchState({ signals, readable = true } = {}) {
  if (!readable) {
    return {
      state: 'off',
      why: 'the kill switch could not be read this pass, and an unreadable switch means OFF',
      at: null,
      where: null,
    };
  }
  const sorted = (signals || [])
    .filter((s) => s && (s.kind === 'stop' || s.kind === 'resume'))
    .slice()
    .sort((a, b) => Number(b.at || 0) - Number(a.at || 0));
  const newest = sorted[0];
  if (!newest) return { state: 'on', why: 'no stop has been issued', at: null, where: null };
  if (newest.kind === 'stop') {
    return {
      state: 'off',
      why: `auto-merge was stopped${newest.where ? ` (${newest.where})` : ''}`,
      at: Number(newest.at) || null,
      where: newest.where || null,
    };
  }
  return {
    state: 'on',
    why: `auto-merge was resumed${newest.where ? ` (${newest.where})` : ''}`,
    at: Number(newest.at) || null,
    where: newest.where || null,
  };
}

// ── The rate cap ─────────────────────────────────────────────────────────────

/**
 * Standing condition 2. A burst is the signature of a loop misbehaving, so the
 * cap turns a runaway into a pause rather than into ninety merges.
 */
const CAP_PER_HOUR = 3;
const CAP_PER_DAY = 12;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * @param {Array}  entries  the ledger's merge records, [{ at:<ms>, ... }]
 * @param {number} now
 * Rolling windows, not calendar buckets: "12 per day" that resets at midnight
 * permits 24 in two hours across the boundary.
 */
function rateCapState(entries, now, { perHour = CAP_PER_HOUR, perDay = CAP_PER_DAY } = {}) {
  const at = Number(now);
  const list = (entries || []).map((e) => Number(e && e.at)).filter((n) => Number.isFinite(n));
  const inHour = list.filter((t) => at - t < HOUR_MS && t <= at).length;
  const inDay = list.filter((t) => at - t < DAY_MS && t <= at).length;
  if (inHour >= perHour) {
    return { allowed: false, inHour, inDay, why: `the hourly auto-merge cap is spent (${inHour}/${perHour} in the last hour)` };
  }
  if (inDay >= perDay) {
    return { allowed: false, inHour, inDay, why: `the daily auto-merge cap is spent (${inDay}/${perDay} in the last 24 hours)` };
  }
  return { allowed: true, inHour, inDay, why: `${inHour}/${perHour} this hour, ${inDay}/${perDay} today` };
}

// ── Self-disable ─────────────────────────────────────────────────────────────

/**
 * Standing condition 4. Two triggers, both meaning "this pass is not in a
 * position to be trusted with an irreversible action":
 *
 *   - the pass reported anything under "could not fully verify". That section
 *     is the relay's honest account of what it could not check (DOCTRINE 3.11),
 *     and a pass that could not check something is not a pass that should be
 *     merging on its own word.
 *   - `main`'s build went red after the last auto-merge. Whether or not the
 *     auto-merge caused it, merging more on top of a red main is how one bad
 *     change becomes five.
 *
 * A human re-enables it, with the same word that resumes the kill switch.
 */
function selfDisableState({ unchecked = [], mainBuildRed = false, persisted = null } = {}) {
  if (persisted && persisted.at) {
    return {
      disabled: true,
      // A latch read back from the ledger is NOT this pass's finding, and the
      // stored sentence says "this pass" (task 86bbt0mz6). Replayed verbatim
      // it reads as a live verdict: on 2026-09-03 the relay printed "this pass
      // could not fully verify 4 thing(s)" on every pass for 10.8 hours while
      // the same passes reported "0 could not be checked" one line later. Two
      // different passes' facts, ten hours apart, printed as one.
      why: persistedLatchWhy(persisted),
      at: Number(persisted.at) || null,
      fresh: false,
      // The sentences themselves, so "why is the lane off?" is answerable
      // later. Before this they were discarded at the moment of latching and
      // only the COUNT survived — which is what made an August outage
      // undiagnosable two days after the fact.
      items: Array.isArray(persisted.items) ? persisted.items : [],
      droppedItems: Number(persisted.droppedItems) || 0,
      trigger: persisted.trigger || 'unchecked',
    };
  }
  if (Array.isArray(unchecked) && unchecked.length) {
    return {
      disabled: true,
      fresh: true,
      at: null,
      why: `this pass could not fully verify ${unchecked.length} thing(s), so it is not in a position to merge on its own word`,
      items: unchecked.slice(),
      droppedItems: 0,
      trigger: 'unchecked',
    };
  }
  if (mainBuildRed) {
    return {
      disabled: true,
      fresh: true,
      at: null,
      why: 'the build on main is red after the last auto-merge',
      // Deliberately empty, and a trigger of its own: a red main is not an
      // unchecked item, and dressing it as one would send whoever reads this
      // looking for a verification failure that never happened.
      items: [],
      droppedItems: 0,
      trigger: 'main-red',
    };
  }
  return { disabled: false, why: '', at: null, fresh: false, items: [], droppedItems: 0, trigger: '' };
}

/**
 * Everything that can stop the lane, in one answer, cheapest and most
 * important first. Returned rather than thrown so the caller can SAY why —
 * silent automation and an unnoticed outage look the same (condition 3).
 */
/** How many stored sentences a latch keeps. A pathological pass could put
 *  hundreds on `unchecked`; the ledger is a diagnostic, not a log. */
const LATCH_ITEM_CAP = 20;

/** One relatch-free day. A latch still in force after this says so again —
 *  the same reasoning the pipeline pause uses for nagging hourly: a latch
 *  nobody remembers looks exactly like a lane with nothing to do. */
const LATCH_NAG_EVERY_MS = DAY_MS;

/**
 * The stored reason, re-tensed. The recorded sentence was written by the pass
 * that latched and says "this pass"; every later reader is a different pass.
 * Saying WHEN is the whole difference between "something is wrong right now"
 * and "something went wrong at 10:41 this morning and nothing has cleared it".
 */
function persistedLatchWhy(persisted) {
  const stored = String((persisted && persisted.why) || 'auto-merge disabled itself earlier');
  const at = Number(persisted && persisted.at) || 0;
  const when = at ? new Date(at).toISOString() : 'an earlier pass';
  const retensed = stored.replace(/^this pass could not fully verify/, 'a pass could not fully verify');
  return `auto-merge has been latched off since ${when} — ${retensed}. It stays off until a human says "resume auto-merging".`;
}

/**
 * Is it time to say again that the lane is still latched?
 *
 * The FIRST engagement already announces itself (the caller posts on
 * `fresh`). The gap this closes is the silence afterwards: a persisted latch
 * printed its halt only to a launchd log nobody reads, so a lane that had
 * switched itself off looked exactly like a quiet night — two days in August,
 * 10.8 hours on 2026-09-03.
 */
function latchNagDue({ disabled, now, lastNagAt = 0, everyMs = LATCH_NAG_EVERY_MS } = {}) {
  if (!disabled || !disabled.disabled || disabled.fresh) return { due: false, why: 'not a persisted latch' };
  const since = Number(lastNagAt) || Number(disabled.at) || 0;
  if (!since) return { due: false, why: 'no clock to measure from' };
  const age = Number(now) - since;
  if (age < everyMs) return { due: false, why: `last said ${Math.round(age / 3600000)}h ago` };
  return { due: true, why: `still latched, and nothing has been said for ${Math.round(age / 3600000)}h` };
}

function laneGate({ killSwitch, selfDisable, rateCap } = {}) {
  if (killSwitch && killSwitch.state === 'off') return { allowed: false, why: killSwitch.why, kind: 'kill-switch' };
  if (selfDisable && selfDisable.disabled) return { allowed: false, why: selfDisable.why, kind: 'self-disabled' };
  if (rateCap && !rateCap.allowed) return { allowed: false, why: rateCap.why, kind: 'rate-cap' };
  return { allowed: true, why: rateCap ? rateCap.why : 'no reason not to', kind: 'open' };
}

// ── The decision ─────────────────────────────────────────────────────────────

/**
 * What should this pass do with one Ready-to-launch ticket?
 *
 *   'ignore'     — nothing to do, and usually nothing to say
 *   'need-files' — it is a candidate; the caller must fetch the PR's changed
 *                  files and ask again. Kept out of this module because it is
 *                  a network call, and the point of this file is that every
 *                  rule can be break-tested without one.
 *   'announce'   — eligible and unannounced: post the notice, start the clock
 *   'cancel'     — an announcement is live and must not proceed
 *   'merge'      — the hour has passed with no objection
 *
 * NOTE ON `files`: eligibility is checked at BOTH announce time and merge
 * time, against a fresh read. A branch can gain a commit during the window,
 * and a PR that was tests-only at 8:15 and touches `lib/` at 8:47 must not
 * merge at 9:15 on the strength of what it used to be.
 */
function laneADecision({
  status,
  comments,
  operatorId,
  now,
  files = null,
  windowMs = WINDOW_MS,
  staleMs = STALE_MS,
} = {}) {
  const all = byDateNewestFirst(comments);

  if (String(status || '').toLowerCase() !== 'ready to launch') {
    return { act: 'ignore', reason: `status is "${status}", not Ready to launch` };
  }

  // Criterion 8, and the precondition Lane A is least allowed to weaken: a
  // ticket with no review PASS is never eligible, whatever its files. Lane A
  // supplies the operator's word, not the reviewer's.
  const verdict = latestVerdict(all);
  if (!verdict) return { act: 'ignore', reason: 'no review verdict on this ticket — loop-review has not passed it' };
  if (!verdict.passed) return { act: 'ignore', reason: 'the most recent review verdict is not a PASS' };

  const pr = findPullRequest(all);
  if (!pr) return { act: 'ignore', reason: 'no "PR opened:" comment on this ticket — nothing to merge' };

  const marker = latestAutoMergeMarker(all);
  const armed = marker && marker.kind === 'armed' && marker.pr === pr.number;

  if (armed) {
    const win = windowState({ announcedAt: marker.at, now, windowMs, staleMs });

    // A stale announcement is cancelled, never merged: the hour it promised
    // him ended long ago, and a merge now would land on nobody's watch. It
    // takes a fresh review PASS to announce again, like any other cancel.
    if (win.stale) {
      return {
        act: 'cancel',
        pr,
        announcementId: marker.commentId,
        announcedAt: marker.at,
        reason: `the announcement is ${Math.round(win.elapsedMs / HOUR_MS)} hours old — its window closed long ago, so it is stale rather than due`,
        stale: true,
        lane: marker.lane,
      };
    }

    // THE OBJECTION. Any comment from him during the window cancels it — any
    // comment, not a keyword. If he is talking about it, the machine stops.
    // A "false" objection costs him one word; a missed objection costs an
    // unwanted merge, so the asymmetry runs this way on purpose.
    //
    // BUT A MACHINE COMMENT IS NOT HIM (2026-09-04, task 86bbv8nvy). The loops
    // post under Dane's token, so EVERY card a script writes comes back from
    // the API stamped with his user id — including this lane's own
    // announcement and the stuck-merge escalation. Asking the user id alone
    // read the pipeline talking to itself as him objecting, and cancelled a
    // merge he had authorized with the words "you commented on this ticket",
    // which he had not.
    //
    // THE STRICT READER, NOT THE WIDE ONE (round 1 of this ticket). Only the
    // tail stamp counts here — `isStampedMachineComment`, the last-line-only
    // half of scripts/builder/machineComment.js. The wide `isMachineComment`
    // ALSO honours a head-anchored tag (`[CC-starcaster loop-review]`,
    // `[auto-merge]`, `[bus-relay]`, `[reconciler]`), which other callers do
    // need — and which is exactly what Dane types when he quotes a card and
    // objects underneath it. Measured: "[auto-merge] armed PR #618 lane A\nno,
    // hold this one" classified as a machine's words. Over 110 real Loop Queue
    // comments, every one of the 100 machine-written ones carried the tail
    // stamp and none needed the head tag, so this costs the lane nothing.
    //
    // AND THE OTHER WAY UP (round 2 of this ticket). The stamp is the LAST
    // line of every card a loop posts, so a card pasted UNDERNEATH his words
    // leaves the stamp at the end of HIS comment and the whole thing reads as
    // machine-written. Measured on the real lane: "no, hold this one" followed
    // by the announcement card merged the PR an hour later, reason "announced
    // 60 minute(s) ago with no objection". `quotesMachineText` is what closes
    // it — see its own note for the two signs it reads and, just as
    // importantly, the one paste it still cannot see.
    //
    // WHICH WAY THIS CALL SITE FAILS, because it is NOT the direction the head
    // of machineComment.js describes. There, mistaking his word for a
    // machine's leaves an escalation unreleased: loud, and the ticket stays
    // with him. Here it MERGES — silently, an hour later, over the top of him.
    // Same misreading, opposite blast radius, which is why this site asks for
    // more than the stamp and the escalation site does not.
    //
    // THE ASYMMETRY IS UNCHANGED, and this is the whole safety argument: only
    // a comment POSITIVELY recognised as machine-written is discounted.
    // Anything unclassifiable — an unstamped comment, an unreadable body, a
    // head tag he could have typed, a stamped body carrying text a person
    // assembled, a format nobody has seen — is still his, and still cancels.
    const objection = all.find(
      (c) => Number(c.user && c.user.id) === Number(operatorId)
        && commentDate(c) > marker.at
        && !(isStampedMachineComment(c.comment_text) && !quotesMachineText(c, all)),
    );
    if (objection) {
      return {
        act: 'cancel',
        pr,
        announcementId: marker.commentId,
        announcedAt: marker.at,
        // SAY WHICH IT WAS. Naming him for something a script did is the
        // dishonesty this whole ticket was filed about, so a comment that is
        // only HIS because it carries a pasted card says so — he can see at a
        // glance whether the lane read him right.
        reason: isStampedMachineComment(objection.comment_text)
          ? 'you commented on this ticket while the window was open — your comment quotes a machine card, so the lane read the words around it as yours'
          : 'you commented on this ticket while the window was open',
        objectionId: String(objection.id),
        lane: marker.lane,
      };
    }

    if (files === null) return { act: 'need-files', pr, announcementId: marker.commentId, announcedAt: marker.at, reason: 'need the PR\'s changed files to re-check eligibility' };

    const still = laneAEligibility(files);
    if (!still.eligible) {
      return {
        act: 'cancel',
        pr,
        announcementId: marker.commentId,
        announcedAt: marker.at,
        reason: `the PR changed during the window and is no longer eligible for any auto-merge lane — ${still.reason}`,
        eligibility: still,
        lane: marker.lane,
      };
    }

    if (!win.elapsed) {
      return {
        act: 'ignore',
        pr,
        announcedAt: marker.at,
        deadlineAt: win.deadlineAt,
        remainingMs: win.remainingMs,
        reason: `the objection window has ${Math.max(1, Math.round(win.remainingMs / 60000))} minute(s) left to run`,
      };
    }

    return {
      act: 'merge',
      pr,
      announcementId: marker.commentId,
      announcedAt: marker.at,
      eligibility: still,
      // The lane the PR qualifies for NOW, not the lane it was armed under. A
      // branch that gained a `scripts/` commit during the window is a Lane B
      // merge even though the announcement said A, and the record must say
      // what actually happened rather than what was predicted.
      lane: still.lane,
      reason: `announced ${Math.round(win.elapsedMs / 60000)} minute(s) ago with no objection`,
    };
  }

  // Not armed for this PR. To announce (or re-announce) the newest review
  // verdict must be NEWER than the newest auto-merge marker of any kind.
  //
  // That single rule carries two requirements at once. Cancelling is terminal
  // for that announcement — it never re-announces without a fresh review PASS,
  // so he does not have to keep saying no to the same thing. And an `armed`
  // marker naming a DIFFERENT PR is stale in exactly the same way: the ticket
  // was rebuilt, and the new PR has to earn its own announcement.
  if (marker && verdict.at <= marker.at) {
    const what = marker.kind === 'cancelled'
      ? 'you stopped the last auto-merge on this ticket'
      : 'the last announcement was for a different PR';
    return { act: 'ignore', pr, reason: `${what}, and there has been no fresh review PASS since` };
  }

  if (files === null) return { act: 'need-files', pr, reason: 'need the PR\'s changed files to judge eligibility' };

  const eligibility = laneAEligibility(files);
  if (!eligibility.eligible) {
    return { act: 'ignore', pr, eligibility, lane: eligibility.lane, reason: eligibility.reason };
  }

  return { act: 'announce', pr, eligibility, lane: eligibility.lane, reason: eligibility.reason };
}

// ── What gets said ───────────────────────────────────────────────────────────

/**
 * Every notice is built HERE, returning the body and its marker as one object
 * — the pattern mergeOnComment.js arrived at the hard way, after a conflict
 * hand-off spent eleven tickets' authorizations while its comment promised the
 * opposite. Written apart, a promise and the record of what was actually done
 * drift; written together, a test can assert the pairing.
 */

/**
 * The announcement. `deadlineLabel` is formatted by the caller in Dane's local
 * clock with the zone read from his machine (OPERATIONS SOP 13) — this module
 * never touches a locale.
 *
 * A note on that time: it is computed from local time at the moment of
 * sending, while the BINDING deadline is the confirmed post time plus an hour.
 * The confirmed time is never earlier than the send, so the real deadline is
 * never earlier than the announced one. He can be merged on late; he can never
 * be merged on early, which is the direction that matters.
 */
function announcementNotice({ pr, files, deadlineLabel, at, lane = 'A' }) {
  const list = files.map((f) => `- \`${f}\``).join('\n');
  const what = lane === 'B'
    ? "This change touches nothing but the pipeline's own tooling under `scripts/` — no file"
      + '\nthe live server loads, and nothing a client\'s browser can reach. A review pass has'
      + '\nalready passed it, and its checks are green — so rather than wait for you to say'
      + '\n"merge", this is announcing itself and giving you an hour to stop it.'
    : 'This change touches nothing but tests and documentation, a review pass has already'
      + '\npassed it, and its checks are green — so rather than wait for you to say "merge",'
      + '\nthis is announcing itself and giving you an hour to stop it.';
  return {
    marker: markerLine('armed', pr.number, at, lane),
    body: [
      announcementOpening(pr.number, deadlineLabel),
      '',
      what,
      '',
      `**To stop it, just comment on this ticket.** Anything at all — a word, a question,`,
      '"hold on". If you are talking about it, nothing merges, and it will not announce',
      'itself again until a fresh review pass has looked at it.',
      '',
      `The ${files.length} changed file(s), which are what made it eligible:`,
      '',
      list,
      '',
      `${pr.url}`,
      '',
      `(Automatic — Lane ${lane}, vault doctrine AUTO-MERGE-LANES. The one-hour clock starts when this comment posted. — bus-relay auto-merge)`,
      '',
      markerLine('armed', pr.number, at, lane),
    ].join('\n'),
  };
}

/** He objected, or the PR stopped being eligible. Terminal for this announcement. */
function cancellationNotice({ pr, why, at, lane = 'A' }) {
  return {
    marker: markerLine('cancelled', pr.number, at, lane),
    body: [
      CANCELLATION_OPENING,
      '',
      `Why: ${why}.`,
      '',
      `PR #${pr.number} is still open and this ticket is still Ready to launch, waiting on your`,
      'word exactly as it was before. It will not announce itself again unless a fresh review',
      'pass looks at it — so if you do want it in, say "merge" and it goes straight through.',
      '',
      `${pr.url}`,
      '',
      `(Automatic — Lane ${lane}. — bus-relay auto-merge)`,
      '',
      markerLine('cancelled', pr.number, at, lane),
    ].join('\n'),
  };
}

// ── The digest ───────────────────────────────────────────────────────────────

/**
 * Standing condition 3: announced, never silent. One post a day listing every
 * auto-merge with its lane and the files that qualified it — and saying "none"
 * on a quiet day, because a silent day and a broken job must not look alike.
 */
const DIGEST_EVERY_MS = 20 * HOUR_MS;

/** The span a digest covers when it has never run before. */
const DIGEST_WINDOW_MS = DAY_MS;

/**
 * Where this digest starts counting from. Consecutive digests are 20 hours
 * apart and used to each cover a fixed 24 — so every merge in the four-hour
 * overlap was reported twice (2026-08-30, review round 2). A digest now covers
 * everything since the LAST digest, and only the first ever one covers a day.
 */
function digestSince(ledger, now, windowMs = DIGEST_WINDOW_MS) {
  const last = Number(asLedger(ledger).lastDigestAt);
  return last > 0 ? last : Number(now) - windowMs;
}

/** Due if it has never run, or if the interval has passed. */
function digestDue(lastDigestAt, now, everyMs = DIGEST_EVERY_MS) {
  const last = Number(lastDigestAt);
  if (!Number.isFinite(last) || last <= 0) return true;
  return Number(now) - last >= everyMs;
}

function digestBody({ entries = [], sinceLabel = 'the last day', clockLabel } = {}) {
  const head = `${machineSenderTag('bus-relay')} Auto-merge digest`;
  const when = clockLabel ? ` (${clockLabel})` : '';
  if (!entries.length) {
    return `${head}${when} — **none**. No pull request was auto-merged in ${sinceLabel}. (A quiet day and a broken job must not look alike, so this posts either way.)`;
  }
  const lines = entries.map((e) => {
    const files = (e.files || []).map((f) => `\`${f}\``).join(', ');
    return `- **Lane ${e.lane || 'A'}** · PR #${e.pr} · ${e.task ? `task ${e.task}` : 'task unknown'}\n  qualified by: ${files || '(files not recorded)'}`;
  });
  return `${head}${when} — ${entries.length} auto-merged in ${sinceLabel}:\n\n${lines.join('\n')}`;
}

// ── The ledger ───────────────────────────────────────────────────────────────

/**
 * The small amount of state that genuinely cannot live on a ticket: how many
 * auto-merges have happened recently (the rate cap), whether the lane has
 * disabled itself, and when the digest last posted.
 *
 * Pure transformations here, file IO in the caller — so the shape is testable
 * and the only untested part is `readFileSync`. Only one machine relays
 * (lib/nodeRoles.js), so one machine's file is the whole record.
 */
function emptyLedger() {
  return { version: 1, merges: [], switch: null, disabled: null, lastDigestAt: 0, everMerged: null, cannotTell: {}, nearMisses: [] };
}

/** Normalize whatever came off disk into a ledger, without throwing. */
function asLedger(raw) {
  const base = emptyLedger();
  if (!raw || typeof raw !== 'object') return base;
  return {
    version: 1,
    merges: Array.isArray(raw.merges) ? raw.merges.filter((m) => m && Number.isFinite(Number(m.at))) : [],
    switch: raw.switch && raw.switch.kind ? raw.switch : null,
    disabled: raw.disabled && raw.disabled.at ? raw.disabled : null,
    lastDigestAt: Number(raw.lastDigestAt) || 0,
    // The all-time tally. `merges` above is PRUNED to two days because it is
    // the rate cap's working set, so it can never answer "has this lane ever
    // merged anything" — which is the question `auto-merge-status` was
    // answering with silence while printing LANE A: RUNNING (task 86bbugeda).
    everMerged: raw.everMerged && Number.isFinite(Number(raw.everMerged.count))
      ? {
        count: Number(raw.everMerged.count),
        lastAt: Number(raw.everMerged.lastAt) || 0,
        lastPr: raw.everMerged.lastPr == null ? null : raw.everMerged.lastPr,
      }
      : null,
    // The per-ticket CANNOT TELL runs the merge step's bound is counted in
    // (2026-09-04, task 86bbuvd50). SEE THE WARNING ON asCannotTellRuns: this
    // whitelist is why the key has to be named here at all.
    cannotTell: asCannotTellRuns(raw.cannotTell),
    // Which near misses have already been answered. Ids only — the message
    // itself is on the party line and does not need a second copy here.
    nearMisses: asNearMisses(raw.nearMisses),
  };
}

/**
 * Normalize the stored CANNOT TELL runs: `{ [ticketId]: { pr, headSha, reason,
 * rewordings, firstSeenAt, passes, escalatedAt } }`.
 *
 * THE WHITELIST IS PER FIELD, NOT ONLY PER KEY, and review round 1 of task
 * 86bbuvd50 is why that sentence is here: `headSha` is what identifies the
 * block now, so a field dropped in this object is a run that can never be
 * recognised as continuing — the counter resets every pass, the alarm never
 * fires, and every in-memory test still passes. Exactly the trap one floor
 * down. The round-trip test in autoMergeLedgerFile.test.js checks the whole
 * record, field by field, for this reason.
 *
 * WHY THIS FUNCTION IS THE WHOLE POINT OF THE TICKET'S SECOND HALF.
 * `asLedger` above does not merge what came off disk — it REBUILDS the ledger
 * from a fixed list of keys, so a key nobody named here is silently dropped on
 * every single read. The counter would therefore reset every pass, the bound
 * would never be reached, and every test would still pass, because every test
 * would be handing the decision function a `prev` it built in memory. The
 * round-trip test in autoMergeLedgerFile.test.js is the one that would have
 * caught it, which is why it exists.
 *
 * Values are passed through rather than coerced. `cannotTellRun` already
 * refuses a timestamp that is not a positive finite number — coercing here
 * would turn a null into a 0, and 0 is finite, which is precisely the corrupt
 * record that made the first draft escalate instantly.
 */
function asCannotTellRuns(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [taskId, run] of Object.entries(raw)) {
    if (!taskId || !run || typeof run !== 'object' || Array.isArray(run)) continue;
    out[taskId] = {
      pr: run.pr == null ? null : run.pr,
      headSha: run.headSha == null ? null : run.headSha,
      reason: String(run.reason || ''),
      rewordings: run.rewordings,
      firstSeenAt: run.firstSeenAt,
      passes: run.passes,
      escalatedAt: run.escalatedAt == null ? null : run.escalatedAt,
    };
  }
  return out;
}

/** How many answered near misses the ledger remembers. Enough that a message
 *  cannot come back around after a quiet week; small enough that the file
 *  stays a file. */
const NEAR_MISS_MEMORY = 50;

/** Normalize the answered-near-miss list off disk, without throwing. */
function asNearMisses(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((x) => String(x)).filter(Boolean).slice(-NEAR_MISS_MEMORY);
}

/**
 * Which of this pass's near misses have not been answered yet.
 *
 * A pass re-reads the same party-line messages every ten minutes, so without
 * this the notice would fire on every pass for as long as the message stayed
 * in view — the "chatty notice" failure named in the ticket's own risk line,
 * which is the one way this fix could be worse than the silence it replaces.
 * Dedup is by the message's own id, never by its text: he can legitimately
 * make the same near miss twice, and the second one needs answering too.
 */
function newNearMisses({ candidates = [], ledger = null } = {}) {
  const seen = new Set(asLedger(ledger).nearMisses);
  const out = [];
  const takenThisPass = new Set();
  for (const c of candidates) {
    const id = c && c.id == null ? '' : String(c.id);
    // No id means no way to remember it was answered, so answering it would
    // repeat forever. Silence is the lesser failure of those two.
    if (!id || seen.has(id) || takenThisPass.has(id)) continue;
    takenThisPass.add(id);
    out.push(c);
  }
  return out;
}

/** Remember that these near misses have been answered. */
function ledgerAfterNearMiss(ledger, ids = []) {
  const l = asLedger(ledger);
  const add = (Array.isArray(ids) ? ids : [ids]).map((x) => String(x)).filter(Boolean);
  if (!add.length) return l;
  const merged = [...l.nearMisses.filter((x) => !add.includes(x)), ...add];
  return { ...l, nearMisses: merged.slice(-NEAR_MISS_MEMORY) };
}

/**
 * Store this pass's CANNOT TELL run for one ticket, or DELETE it when the
 * verdict cleared (`next` is null).
 *
 * Deleting rather than storing an empty record is criterion 5 — "a verdict
 * that clears leaves no residue" — and it is also what keeps the map small
 * without a pruner: an entry only survives while a ticket is actively stuck.
 * The one leak left is a ticket that vanishes from the watch mid-block (it
 * changed status, or its PR closed), which strands one ~150-byte record. That
 * is deliberately NOT pruned by age: a time-based sweep would delete the
 * `escalatedAt` of a still-stuck ticket and let the alarm fire again, which is
 * the "escalate exactly once" rule failing in the noisy direction.
 */
function ledgerAfterCannotTell(ledger, taskId, next) {
  const l = asLedger(ledger);
  if (!taskId) return l;
  const runs = { ...l.cannotTell };
  if (!next) delete runs[taskId];
  else {
    runs[taskId] = {
      pr: next.pr == null ? null : next.pr,
      headSha: next.headSha == null ? null : next.headSha,
      reason: String(next.reason || ''),
      rewordings: next.rewordings,
      firstSeenAt: next.firstSeenAt,
      passes: next.passes,
      escalatedAt: next.escalatedAt == null ? null : next.escalatedAt,
    };
  }
  return { ...l, cannotTell: runs };
}

/**
 * Records older than two days cannot affect a 24-hour cap and are only there
 * to make the file grow forever.
 */
function pruneMerges(merges, now, keepMs = 2 * DAY_MS) {
  return (merges || []).filter((m) => Number(now) - Number(m.at) < keepMs);
}

function ledgerAfterMerge(ledger, entry, now) {
  const l = asLedger(ledger);
  const prior = l.everMerged || { count: 0, lastAt: 0, lastPr: null };
  return {
    ...l,
    merges: pruneMerges([...l.merges, entry], now),
    // Monotonic, and deliberately not derived from `merges` — pruning must
    // never be able to walk this backwards to zero and turn a working lane
    // into one that reads as having never run.
    everMerged: {
      count: prior.count + 1,
      lastAt: Number(entry && entry.at) || Number(now) || prior.lastAt,
      lastPr: entry && entry.pr != null ? entry.pr : prior.lastPr,
    },
  };
}

/**
 * Has Lane A ever actually merged anything?
 *
 * THREE ANSWERS, NEVER TWO. On 2026-09-03 `auto-merge-status` printed
 * `LANE A: RUNNING` beside `ledger: not created yet`, which reads as a healthy
 * lane and describes one that has never merged a single pull request in its
 * life. "Running" is about the gate being open; this is about whether anything
 * has ever come out of it, and the two were never distinguished.
 *
 *   'never'   — confirmed: there is no ledger file at all, so nothing has run.
 *   'yes'     — confirmed, with a count and when.
 *   'unknown' — a ledger written before this counter existed. It may have
 *               merged plenty; we cannot say, and saying "never" would be a
 *               confident wrong answer about the lane's whole history.
 *
 * `fresh` is the ledger FILE's own answer to "did I exist before this read"
 * (autoMergeLedgerFile.js), which is the only evidence that separates "never"
 * from "unknown".
 */
function laneAMergeHistory({ ledger, fresh = false, readable = true } = {}) {
  if (!readable) {
    return { verdict: 'unknown', count: null, why: 'the auto-merge ledger could not be read, so whether this lane has ever merged is unknown' };
  }
  if (fresh) {
    return { verdict: 'never', count: 0, why: 'has NEVER merged anything — no ledger file exists, so no auto-merge has ever happened' };
  }
  const l = asLedger(ledger);
  if (l.everMerged) {
    if (l.everMerged.count <= 0) {
      return { verdict: 'never', count: 0, why: 'has NEVER merged anything — the ledger exists but its all-time count is zero' };
    }
    const pr = l.everMerged.lastPr == null ? '' : ` (most recently PR #${l.everMerged.lastPr})`;
    return {
      verdict: 'yes',
      count: l.everMerged.count,
      lastAt: l.everMerged.lastAt,
      why: `has merged ${l.everMerged.count} pull request${l.everMerged.count === 1 ? '' : 's'} all told${pr}`,
    };
  }
  if (l.merges.length > 0) {
    return {
      verdict: 'yes',
      count: null,
      why: `has merged at least ${l.merges.length} in the last two days; this ledger predates the all-time counter, so the full history is not recorded`,
    };
  }
  return {
    verdict: 'unknown',
    count: null,
    why: 'nothing merged in the last two days, and this ledger predates the all-time counter — whether it has EVER merged is unknown, not "never"',
  };
}

/**
 * Remember a stop.
 *
 * WHY IT IS PERSISTED. The switch can be set on any Loop Queue ticket, and a
 * pass only reads the OPEN ones. A "stop auto-merging" said on a ticket that
 * later goes Live would vanish from view and the lane would quietly switch
 * itself back on — the one direction a fail-safe must never fail in. Writing
 * it down makes the stop sticky, so only a `resume` NEWER than it can clear it.
 */
function ledgerAfterSwitch(ledger, signal) {
  const l = asLedger(ledger);
  if (!signal || (signal.kind !== 'stop' && signal.kind !== 'resume')) return l;
  const current = l.switch;
  if (current && Number(current.at) >= Number(signal.at)) return l;
  // Resuming clears a self-disable too: one word puts the lane back, rather
  // than a person having to find out there were two separate off switches.
  return { ...l, switch: signal, disabled: signal.kind === 'resume' ? null : l.disabled };
}

function ledgerAfterDisable(ledger, why, at, { items = [], trigger = 'unchecked' } = {}) {
  const l = asLedger(ledger);
  if (l.disabled && l.disabled.at) return l;
  const all = Array.isArray(items) ? items.map((x) => String(x)) : [];
  const kept = all.slice(0, LATCH_ITEM_CAP);
  return {
    ...l,
    disabled: {
      at: Number(at),
      why: String(why || 'auto-merge disabled itself'),
      // The sentences, not just how many there were. Capped, and the cap says
      // what it swallowed rather than pretending the list was complete.
      items: kept,
      droppedItems: all.length - kept.length,
      trigger,
    },
  };
}

function ledgerAfterLatchNag(ledger, at) {
  const l = asLedger(ledger);
  if (!l.disabled) return l;
  return { ...l, disabled: { ...l.disabled, lastNagAt: Number(at) } };
}

function ledgerAfterDigest(ledger, at) {
  return { ...asLedger(ledger), lastDigestAt: Number(at) };
}

/** The ledger's own switch record, in the shape killSwitchState wants. */
function switchSignalsFromLedger(ledger) {
  const l = asLedger(ledger);
  return l.switch ? [{ ...l.switch, where: l.switch.where || 'recorded on an earlier pass' }] : [];
}

/** Merges inside the digest window, newest first. */
function mergesSince(ledger, since) {
  return asLedger(ledger).merges
    .filter((m) => Number(m.at) >= Number(since))
    .sort((a, b) => Number(b.at) - Number(a.at));
}

module.exports = {
  // eligibility
  LANE_A_ALLOWED,
  LANE_B_ALLOWED,
  GOVERNANCE_PATHS,
  GOVERNANCE_BASENAMES,
  GOVERNANCE_STEMS,
  GOVERNANCE_TEST_STEMS,
  GOVERNANCE_PREFIXES,
  GOVERNANCE_FILES,
  GOVERNANCE_FILE_PREFIXES,
  GOVERNANCE_SHELL_RE,
  governanceReason,
  allowedReason,
  laneBAllowedReason,
  laneForFile,
  laneEligibility,
  laneAEligibility,
  // window
  WINDOW_MS,
  STALE_MS,
  windowState,
  // ticket record
  AUTO_MERGE_MARKER,
  markerLine,
  parseAutoMergeMarker,
  latestAutoMergeMarker,
  latestVerdict,
  // switch
  SWITCH_STOP,
  SWITCH_RESUME,
  switchCommand,
  nearMissResume,
  nearMissNotice,
  NEAR_MISS_MEMORY,
  newNearMisses,
  ledgerAfterNearMiss,
  killSwitchState,
  // cap
  CAP_PER_HOUR,
  CAP_PER_DAY,
  rateCapState,
  // self-disable
  selfDisableState,
  laneGate,
  // decision
  laneADecision,
  // notices
  announcementNotice,
  cancellationNotice,
  isLaneNotice,
  quotesMachineText,
  // digest
  DIGEST_EVERY_MS,
  DIGEST_WINDOW_MS,
  digestSince,
  digestDue,
  digestBody,
  // ledger
  emptyLedger,
  asLedger,
  asCannotTellRuns,
  ledgerAfterCannotTell,
  pruneMerges,
  ledgerAfterMerge,
  ledgerAfterSwitch,
  ledgerAfterDisable,
  ledgerAfterLatchNag,
  persistedLatchWhy,
  latchNagDue,
  LATCH_ITEM_CAP,
  LATCH_NAG_EVERY_MS,
  ledgerAfterDigest,
  switchSignalsFromLedger,
  laneAMergeHistory,
  mergesSince,
};
