'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { doorSource, skipWithoutDoor, productScript, skipWithoutProductScript } = require('./productScripts.js');

const {
  isMergeCommand,
  isReviewPassed,
  isReviewVerdict,
  findPullRequest,
  mergeDecision,
  checkState,
  githubGate,
  MERGE_STATE_STATUSES,
  unmetProtectionRule,
} = require('./mergeOnComment.js');

const OPERATOR = 48012725;
const AGENT = 99999999;

/**
 * How often the relay actually wakes, read from the one file that decides it.
 * `INTERVAL_SECONDS` in scripts/install_bus_relay.sh generates the launchd
 * plist, so it is the source of truth; copying the number into this test would
 * just create a second place for it to be wrong.
 */
function relayIntervalSeconds() {
  // The installer is a PRODUCT script, not a substrate module (task 86bcgmnpy,
  // slice 1): read it through the configured path, so the test that needs it
  // skips where there is no bus relay instead of failing on its absence.
  const src = productScript('busRelayInstaller');
  if (src === null) return null;
  const m = src.match(/^INTERVAL_SECONDS=(\d+)/m);
  assert.ok(m, 'install_bus_relay.sh must declare INTERVAL_SECONDS');
  return Number(m[1]);
}

/** Comment factory: t is a relative timestamp so ordering is readable. */
let nextId = 1;
function c(t, userId, text) {
  return { id: String(nextId++), date: String(1000 + t), user: { id: userId }, comment_text: text };
}

const PR_URL = 'https://github.com/mentor24-maker/starcaster/pull/362';
const prOpened = (t) => c(t, AGENT, `PR opened: ${PR_URL}\n\nBuilt in worktree .claude/worktrees/x.`);
const reviewPassed = (t) => c(t, AGENT, 'REVIEW PASSED (loop-review, 2026-08-22) — promoted to Ready to launch.');

// ---------------------------------------------------------------- phrases

test('the four sanctioned merge phrases fire, in any casing or padding', () => {
  for (const phrase of ['merge', 'merge it', 'ship it', 'approve']) {
    assert.equal(isMergeCommand(phrase), true, phrase);
    assert.equal(isMergeCommand(phrase.toUpperCase()), true, phrase);
    assert.equal(isMergeCommand(`  ${phrase}\n`), true, phrase);
    assert.equal(isMergeCommand(`${phrase}!`), true, phrase);
  }
});

test('EXACT PHRASE, NEVER SUBSTRING — the sentence that must not merge anything', () => {
  assert.equal(isMergeCommand('do not merge this yet'), false);
  assert.equal(isMergeCommand('merge after the other one lands'), false);
  assert.equal(isMergeCommand("I'll approve the design later"), false);
  assert.equal(isMergeCommand('can you ship it once CI is green?'), false);
  assert.equal(isMergeCommand('hold off — do NOT ship it'), false);
});

test('empty and junk comments are not commands', () => {
  assert.equal(isMergeCommand(''), false);
  assert.equal(isMergeCommand(null), false);
  assert.equal(isMergeCommand('   '), false);
  assert.equal(isMergeCommand('👍'), false);
});

// ---------------------------------------------------------- review verdict

test('both spellings loop-review actually uses count as a pass', () => {
  assert.equal(isReviewPassed('REVIEW PASSED (loop-review, 2026-08-22)'), true);
  assert.equal(isReviewPassed('REVIEW: PASSED (loop-review, 2026-08-21 night) — promoted.'), true);
});

test('a failing verdict is a verdict but not a pass', () => {
  const failed = 'REVIEW: sent back to Queued (loop-review, 2026-08-22) — CI is RED.';
  assert.equal(isReviewVerdict(failed), true);
  assert.equal(isReviewPassed(failed), false);
});

test('prose that merely says the words is not a verdict line', () => {
  assert.equal(isReviewPassed('this is not a REVIEW PASSED situation'), false);
});

// ------------------------------------------------------------------- PR url

test('only a "PR opened:" line is trusted as the PR to merge', () => {
  const comments = [
    c(1, AGENT, 'Releasing back to Queued: depends on PR #341 https://github.com/mentor24-maker/starcaster/pull/341 which has not merged.'),
    prOpened(2),
  ];
  assert.equal(findPullRequest(comments).number, 362);
});

test('a cited PR with no "PR opened:" line yields nothing — refuse, never guess', () => {
  const comments = [c(1, AGENT, 'see https://github.com/mentor24-maker/starcaster/pull/341 for context')];
  assert.equal(findPullRequest(comments), null);
});

test('the newest "PR opened:" wins when a ticket was rebuilt', () => {
  const comments = [prOpened(1), c(5, AGENT, 'PR opened: https://github.com/mentor24-maker/starcaster/pull/400')];
  assert.equal(findPullRequest(comments).number, 400);
});

// -------------------------------------------------------------- decisions

test('the happy path: operator says merge on a passed, PR-carrying ticket', () => {
  const d = mergeDecision({
    status: 'ready to launch',
    operatorId: OPERATOR,
    comments: [prOpened(1), reviewPassed(2), c(3, OPERATOR, 'merge')],
  });
  assert.equal(d.act, 'merge');
  assert.equal(d.pr.number, 362);
  assert.equal(d.pr.owner, 'mentor24-maker');
});

test('DELIBERATE: an agent-authored "merge" is ignored — only the operator id authorizes', () => {
  const d = mergeDecision({
    status: 'ready to launch',
    operatorId: OPERATOR,
    comments: [prOpened(1), reviewPassed(2), c(3, AGENT, 'merge')],
  });
  assert.equal(d.act, 'ignore');
});

test('DELIBERATE: identity is by id, not by name — an agent named "Dane" still cannot merge', () => {
  const impostor = { id: '77', date: '1003', user: { id: AGENT, username: 'Dane' }, comment_text: 'merge' };
  const d = mergeDecision({
    status: 'ready to launch',
    operatorId: OPERATOR,
    comments: [prOpened(1), reviewPassed(2), impostor],
  });
  assert.equal(d.act, 'ignore');
});

test('DELIBERATE: the operator saying "merge" on a Queued ticket does nothing', () => {
  for (const status of ['Queued', 'Building', 'In review', 'Needs your input', 'Live']) {
    const d = mergeDecision({
      status,
      operatorId: OPERATOR,
      comments: [prOpened(1), reviewPassed(2), c(3, OPERATOR, 'merge')],
    });
    assert.equal(d.act, 'ignore', status);
  }
});

test('DELIBERATE: no REVIEW PASSED comment → refused, with a reason worth reading', () => {
  const d = mergeDecision({
    status: 'ready to launch',
    operatorId: OPERATOR,
    comments: [prOpened(1), c(3, OPERATOR, 'merge')],
  });
  assert.equal(d.act, 'refuse');
  assert.match(d.reason, /no review verdict/);
});

test('DELIBERATE: the latest verdict is a FAIL → refused even though an older pass exists', () => {
  const d = mergeDecision({
    status: 'ready to launch',
    operatorId: OPERATOR,
    comments: [
      prOpened(1),
      reviewPassed(2),
      c(3, AGENT, 'REVIEW: sent back to Queued — a blocking finding.'),
      c(4, OPERATOR, 'merge'),
    ],
  });
  assert.equal(d.act, 'refuse');
  assert.match(d.reason, /not a PASS/);
});

test('DELIBERATE: a stale "merge" from an earlier round cannot release the new PR', () => {
  const d = mergeDecision({
    status: 'ready to launch',
    operatorId: OPERATOR,
    comments: [prOpened(1), c(2, OPERATOR, 'merge'), c(8, AGENT, 'PR opened: https://github.com/mentor24-maker/starcaster/pull/400'), reviewPassed(9)],
  });
  assert.equal(d.act, 'refuse');
  assert.match(d.reason, /predates/);
});

test('DELIBERATE: no "PR opened:" comment → refused, nothing guessed', () => {
  const d = mergeDecision({
    status: 'ready to launch',
    operatorId: OPERATOR,
    comments: [reviewPassed(2), c(3, OPERATOR, 'merge')],
  });
  assert.equal(d.act, 'refuse');
  assert.match(d.reason, /PR opened/);
});

test('a comment already handled never fires twice', () => {
  const cmd = c(3, OPERATOR, 'merge');
  const comments = [prOpened(1), reviewPassed(2), cmd];
  assert.equal(mergeDecision({ status: 'ready to launch', operatorId: OPERATOR, comments }).act, 'merge');
  const second = mergeDecision({
    status: 'ready to launch', operatorId: OPERATOR, comments, handled: new Set([cmd.id]),
  });
  assert.equal(second.act, 'ignore');
});

test('a ticket with no operator comments at all is silent, not refused', () => {
  const d = mergeDecision({ status: 'ready to launch', operatorId: OPERATOR, comments: [prOpened(1), reviewPassed(2)] });
  assert.equal(d.act, 'ignore');
});

test('an operator comment that is a question, not a command, is ignored', () => {
  const d = mergeDecision({
    status: 'ready to launch',
    operatorId: OPERATOR,
    comments: [prOpened(1), reviewPassed(2), c(3, OPERATOR, 'does this touch the live site?')],
  });
  assert.equal(d.act, 'ignore');
});

// ------------------------------------------------------------ github gate

const green = [
  { __typename: 'CheckRun', name: 'verify', status: 'COMPLETED', conclusion: 'SUCCESS' },
  { __typename: 'StatusContext', context: 'Vercel', state: 'SUCCESS' },
];

test('open + green + clean merges', () => {
  const g = githubGate({ state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: green });
  assert.equal(g.action, 'merge');
});

test('DELIBERATE: conflicts stop the script dead — never update-branch, never resolve', () => {
  const g = githubGate({ state: 'OPEN', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', statusCheckRollup: green });
  assert.equal(g.action, 'conflict');
});

test('behind main asks for update-branch, not a merge', () => {
  const g = githubGate({ state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND', statusCheckRollup: green });
  assert.equal(g.action, 'update-branch');
});

test('a StatusContext failure is a red PR — the shape a CheckRun-only reader would miss', () => {
  const rollup = [
    { __typename: 'CheckRun', name: 'verify', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'StatusContext', context: 'Vercel', state: 'FAILURE' },
  ];
  const g = githubGate({ state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: rollup });
  assert.equal(g.action, 'refuse');
  assert.match(g.reason, /Vercel/);
});

test('a check still running means wait quietly, not refuse', () => {
  const rollup = [{ __typename: 'CheckRun', name: 'verify', status: 'IN_PROGRESS' }];
  const g = githubGate({ state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', statusCheckRollup: rollup });
  assert.equal(g.action, 'wait');
});

test('a PR with no checks at all is refused — unverified is not green', () => {
  const g = githubGate({ state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: [] });
  assert.equal(g.action, 'refuse');
  assert.match(g.reason, /no checks/);
});

test('closed, merged and draft PRs are all refused', () => {
  assert.equal(githubGate({ state: 'MERGED' }).action, 'refuse');
  assert.equal(githubGate({ state: 'CLOSED' }).action, 'refuse');
  const draft = githubGate({ state: 'OPEN', isDraft: true, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: green });
  assert.equal(draft.action, 'refuse');
  assert.match(draft.reason, /draft/);
});

test('UNKNOWN mergeability waits — GitHub has not finished computing it', () => {
  const g = githubGate({ state: 'OPEN', mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN', statusCheckRollup: green });
  assert.equal(g.action, 'wait');
});

// ------------------------------ one sentence per merge state (86bbrg9v0)
//
// PR #487, 2026-09-01: Dane's "merge" was refused with "GitHub reports the
// merge is blocked (a required review or check is missing)" while every check
// was green and the branch actually had a merge conflict. Both halves of that
// "why" were false, and it read as answered. These fixtures hold one row per
// mergeStateStatus so no value can collapse into another's sentence again.

/** The wrong sentence, in the form no fixture below may ever produce. */
const REVIEW_MISSING = /required review or check is missing/i;

/** A phrase that claims a review is the problem, however it is worded. */
const CLAIMS_A_REVIEW = /review/i;

const gateOn = (over) => githubGate({
  state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: green, ...over,
});

test('every mergeStateStatus GitHub can return has a sentence of its own', () => {
  const seen = new Map();
  for (const status of MERGE_STATE_STATUSES) {
    const g = gateOn({ mergeStateStatus: status });
    assert.ok(g && g.action, `${status} produced no verdict at all`);
    assert.ok(g.reason && g.reason.length > 10, `${status} produced no reason worth reading`);
    // The two that MAY merge share one sentence on purpose — "go" is the
    // same answer either way. Every value that holds the work up has to say
    // something of its own, because that is the sentence Dane reads.
    if (g.action === 'merge') continue;
    const clash = seen.get(g.reason);
    assert.equal(clash, undefined,
      `${status} and ${clash} share one sentence — that is the collapse this test exists to stop`);
    seen.set(g.reason, status);
  }
  // Only CLEAN and HAS_HOOKS may merge; every other value has an owner.
  const merges = MERGE_STATE_STATUSES.filter((s) => gateOn({ mergeStateStatus: s }).action === 'merge');
  assert.deepEqual(merges, ['CLEAN', 'HAS_HOOKS']);
});

test('DELIBERATE: no merge state invents a missing review', () => {
  for (const status of MERGE_STATE_STATUSES) {
    const g = gateOn({ mergeStateStatus: status });
    assert.doesNotMatch(g.reason, REVIEW_MISSING, `${status} named a missing review it never read`);
  }
});

test('BEHIND says whose job it is — the machine catches it up', () => {
  const g = gateOn({ mergeStateStatus: 'BEHIND' });
  assert.equal(g.action, 'update-branch');
  assert.match(g.reason, /behind main/);
});

test('UNSTABLE with a green rollup is a disagreement, not a merge', () => {
  const g = gateOn({ mergeStateStatus: 'UNSTABLE' });
  assert.equal(g.action, 'refuse');
  assert.match(g.reason, /CANNOT TELL/);
  assert.doesNotMatch(g.reason, CLAIMS_A_REVIEW);
});

test('UNSTABLE names the failing check whenever the rollup can see it', () => {
  const rollup = [
    { __typename: 'CheckRun', name: 'verify', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'CheckRun', name: 'Vercel', status: 'COMPLETED', conclusion: 'FAILURE' },
  ];
  const g = gateOn({ mergeStateStatus: 'UNSTABLE', statusCheckRollup: rollup });
  assert.equal(g.action, 'refuse');
  assert.match(g.reason, /Vercel/);
});

test('BLOCKED names the branch-protection rule when GitHub named it', () => {
  const needsReview = gateOn({ mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' });
  assert.equal(needsReview.action, 'refuse');
  assert.match(needsReview.reason, /required review has not been given/);

  const changes = gateOn({ mergeStateStatus: 'BLOCKED', reviewDecision: 'CHANGES_REQUESTED' });
  assert.equal(changes.action, 'refuse');
  assert.match(changes.reason, /requested changes/);
});

test('THE BUG: BLOCKED with green checks and no named rule says CANNOT TELL', () => {
  const g = gateOn({ mergeStateStatus: 'BLOCKED' });
  assert.equal(g.action, 'refuse');
  assert.match(g.reason, /CANNOT TELL/);
  assert.doesNotMatch(g.reason, REVIEW_MISSING);
  // And it must say the thing that would have saved the hour: a conflict
  // GitHub has not recomputed looks exactly like this.
  assert.match(g.reason, /conflict/i);
});

test('an APPROVED PR that is still BLOCKED does not blame the review', () => {
  const g = gateOn({ mergeStateStatus: 'BLOCKED', reviewDecision: 'APPROVED' });
  assert.equal(g.action, 'refuse');
  assert.match(g.reason, /CANNOT TELL/);
});

test('a merge state this gate does not know is refused, never merged', () => {
  const g = gateOn({ mergeStateStatus: 'SOMETHING_NEW' });
  assert.equal(g.action, 'refuse');
  assert.match(g.reason, /CANNOT TELL/);
  assert.match(g.reason, /SOMETHING_NEW/);
});

test('UNKNOWN says CANNOT TELL out loud and waits — it is never resolved by guessing', () => {
  const g = gateOn({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' });
  assert.equal(g.action, 'wait');
  assert.match(g.reason, /CANNOT TELL/);
  assert.doesNotMatch(g.reason, REVIEW_MISSING);
});

test('THE #487 SHAPE: UNKNOWN on the first read, DIRTY on the next', () => {
  // What GitHub was reporting when the gate looked: still computing.
  const first = githubGate({
    state: 'OPEN', mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN',
    statusCheckRollup: green,
  });
  assert.equal(first.action, 'wait', 'a PR GitHub has not finished computing is asked again, not refused');
  assert.doesNotMatch(first.reason, REVIEW_MISSING);

  // What `gh pr view` showed a moment later, and what was actually true.
  const second = githubGate({
    state: 'OPEN', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY',
    statusCheckRollup: green,
  });
  assert.equal(second.action, 'conflict');
  assert.match(second.reason, /conflict/i);
  assert.doesNotMatch(second.reason, REVIEW_MISSING);

  // And the shape in between — GitHub having settled on BLOCKED before it
  // recomputed the conflict, which is how #487 reached the wrong sentence.
  const between = githubGate({
    state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED',
    statusCheckRollup: green,
  });
  assert.doesNotMatch(between.reason, REVIEW_MISSING,
    'every check was green — this is the sentence that sent Dane looking for a review that was never missing');
});

test('unmetProtectionRule names only what GitHub named', () => {
  assert.equal(unmetProtectionRule({ reviewDecision: 'REVIEW_REQUIRED' }), 'a required review has not been given');
  assert.equal(unmetProtectionRule({ reviewDecision: 'CHANGES_REQUESTED' }), 'a reviewer requested changes');
  assert.equal(unmetProtectionRule({ reviewDecision: 'APPROVED' }), null);
  assert.equal(unmetProtectionRule({}), null, 'an absent field is "could not tell", not "no rule"');
  assert.equal(unmetProtectionRule(null), null);
});

test('the merge read asks GitHub for reviewDecision, or the rule can never be named', (t) => {
  if (skipWithoutDoor(t)) return;
  const fs = require('node:fs');
  const path = require('node:path');
  const src = doorSource() || '';
  const m = src.match(/const fields = '([^']*mergeStateStatus[^']*)'/);
  assert.ok(m, 'clickup_direct.mjs must build the PR field list in one place');
  assert.ok(m[1].split(',').includes('reviewDecision'),
    'reviewDecision is what lets a BLOCKED merge name its rule instead of guessing');
});

test('checkState reads both rollup shapes and both failure spellings', () => {
  const s = checkState([
    { __typename: 'CheckRun', name: 'a', status: 'COMPLETED', conclusion: 'FAILURE' },
    { __typename: 'CheckRun', name: 'b', status: 'COMPLETED', conclusion: 'SKIPPED' },
    { __typename: 'CheckRun', name: 'c', status: 'QUEUED' },
    { __typename: 'StatusContext', context: 'd', state: 'PENDING' },
    { __typename: 'StatusContext', context: 'e', state: 'ERROR' },
  ]);
  assert.deepEqual(s.pending, ['c', 'd']);
  assert.equal(s.failed.length, 2);
});

// ------------------------------------------- re-planning a refusal (86bbjt18r)

const {
  MERGE_MARKER,
  parseMergeMarker,
  latestMergeMarker,
  countMergeRefusals,
} = require('./mergeOnComment.js');

/** A marker reply, in the exact shape markMergeHandled writes. */
function marker(t, what) {
  return { id: `m${nextId++}`, date: String(1000 + t), comment_text: `${MERGE_MARKER} ${what} — 2026-08-22T0${t}:00:00.000Z` };
}

test('a marker that is not ours parses as nothing', () => {
  assert.equal(parseMergeMarker('[bus-relay] sent to channel 2kydhxeu-474 at ...'), null);
  assert.equal(parseMergeMarker(''), null);
  assert.equal(parseMergeMarker('merge'), null);
});

test('a refusal marker keeps its reason, em-dash and all', () => {
  const why = 'no "PR opened:" comment on this ticket — nothing to merge';
  const parsed = parseMergeMarker(`${MERGE_MARKER} refused: ${why} — 2026-08-22T04:00:00.000Z`);
  assert.equal(parsed.kind, 'refused');
  assert.equal(parsed.reason, why);
  assert.equal(parsed.at, '2026-08-22T04:00:00.000Z');
});

test('a MERGE is terminal, and stays terminal', () => {
  assert.equal(parseMergeMarker(`${MERGE_MARKER} merged PR #372 at 2026-08-22T04:00:00.000Z — 2026-08-22T04:00:01.000Z`).kind, 'terminal');
});

test('markers written before this change still parse (nothing needs migrating)', () => {
  // The live format has not changed — only its reading. Both of these are
  // verbatim from the 2026-08-22 run.
  assert.equal(parseMergeMarker(`${MERGE_MARKER} refused: the most recent review verdict is not a PASS — 2026-08-22T03:12:44.101Z`).kind, 'refused');
  assert.equal(parseMergeMarker(`${MERGE_MARKER} merged PR #345 at 2026-08-22T03:20:00.000Z — 2026-08-22T03:20:02.222Z`).kind, 'terminal');
});

test('the NEWEST marker decides — a refusal after a refusal replaces it', () => {
  const replies = [marker(1, 'refused: reason A'), marker(3, 'refused: reason B'), marker(2, 'refused: reason C')];
  assert.equal(latestMergeMarker(replies).reason, 'reason B');
  assert.equal(latestMergeMarker([]), null);
});

test('THE BUG: a refusal is re-planned once its reason is fixed, with no second "merge"', () => {
  // 2026-08-22, verbatim: refused for "no PR opened:", the comment added by
  // hand minutes later, and three later passes never looked again.
  const cmd = c(3, OPERATOR, 'merge');
  const before = [reviewPassed(2), cmd];
  const first = mergeDecision({ status: 'ready to launch', operatorId: OPERATOR, comments: before });
  assert.equal(first.act, 'refuse');
  assert.match(first.reason, /no "PR opened:"/);

  // The pass that refused wrote a marker recording that reason. Rebuild the
  // refusal map the way bus-relay does — by PARSING that marker back off the
  // reply thread — so this test exercises the reader, not just the rule.
  // Under the old rule the comment was struck off forever. Now the missing PR
  // comment arrives and the very next pass merges it — Dane says nothing.
  const replies = [marker(3, `refused: ${first.reason}`)];
  const parsed = latestMergeMarker(replies);
  assert.equal(parsed.kind, 'refused');
  const refused = new Map([[first.commentId, parsed.reason]]);
  const after = [...before, prOpened(4)];
  const second = mergeDecision({ status: 'ready to launch', operatorId: OPERATOR, comments: after, refused });
  assert.equal(second.act, 'merge');
  assert.equal(second.pr.number, 362);
});

test('re-planning is silent while the reason still holds — no duplicate refusals', () => {
  const cmd = c(3, OPERATOR, 'merge');
  const comments = [reviewPassed(2), cmd];
  const first = mergeDecision({ status: 'ready to launch', operatorId: OPERATOR, comments });
  const refused = new Map([[first.commentId, first.reason]]);
  const again = mergeDecision({ status: 'ready to launch', operatorId: OPERATOR, comments, refused });
  assert.equal(again.act, 'ignore');
  assert.match(again.reason, /already refused for the same reason/);
});

test('a DIFFERENT refusal reason is news, and is said out loud', () => {
  const cmd = c(3, OPERATOR, 'merge');
  const comments = [reviewPassed(2), cmd];
  const refused = new Map([[String(cmd.id), 'some older reason that no longer applies']]);
  const out = mergeDecision({ status: 'ready to launch', operatorId: OPERATOR, comments, refused });
  assert.equal(out.act, 'refuse');
  assert.match(out.reason, /no "PR opened:"/);
});

test('a TERMINAL marker is still spent forever — a merged PR is never re-merged', () => {
  const cmd = c(3, OPERATOR, 'merge');
  const comments = [reviewPassed(1), prOpened(2), cmd];
  const out = mergeDecision({
    status: 'ready to launch', operatorId: OPERATOR, comments,
    handled: new Set([String(cmd.id)]),
    refused: new Map(),
  });
  assert.equal(out.act, 'ignore');
});

// ---------- the comment must not promise what the marker does not do (86bbk0g4u)

const {
  markerKind,
  mayPromiseApproval,
  refusalNotice,
  conflictHandOffNotice,
  mergedNotice,
  APPROVAL_CARRIES_OVER,
} = require('./mergeOnComment.js');

const SOME_PR = { number: 380, url: PR_URL };

/**
 * THE INVARIANT, asserted over every notice the merge path can post.
 *
 * A 'refused' marker is re-decided on later passes, so its body MAY promise
 * the approval carries over. A 'terminal' marker is spent forever, so its
 * body MUST NOT — that promise is exactly the lie the conflict hand-off told
 * eleven tickets on 2026-08-23. Building body and marker in one function is
 * what makes this checkable at all; before, they lived in different files.
 *
 * SHARPENED 2026-08-30 (task 86bbq0fh8). A re-decidable marker turned out not
 * to be enough. "It goes through on its own" is only true if somebody is going
 * to deal with the reason, and on a conflict nobody was: the hand-off asked
 * the bus for an agent session, nothing reads the bus, and PR #434 sat three
 * days under a comment saying it was progressing. So the promise now needs
 * BOTH a re-decidable marker and a named actor, and `actor: 'nobody'` is the
 * case that must stay silent about merging and say it is stalled instead.
 */
const FILED = { id: '86bbzzzzz', url: 'https://app.clickup.com/t/86bbzzzzz' };

function assertPromiseMatchesMarker(notice, label) {
  const kind = markerKind(notice.marker);
  const promises = notice.body.includes(APPROVAL_CARRIES_OVER);
  assert.ok(notice.actor, `${label}: every notice must name who acts next`);
  const mayPromise = mayPromiseApproval({ marker: notice.marker, actor: notice.actor });
  assert.equal(promises, mayPromise,
    `${label}: marker ${kind}, actor "${notice.actor}" — the body ${promises ? 'promises' : 'does not promise'} the approval carries over and should ${mayPromise ? '' : 'not '}`);
  if (kind === 'terminal') {
    assert.equal(promises, false, `${label}: terminal marker (${notice.marker}) must not promise the approval carries over`);
  }
  if (notice.actor === 'nobody') {
    assert.equal(promises, false, `${label}: no actor exists, so it must not promise a merge`);
  }
}

test('EVERY notice the merge path posts says truthfully whether the approval survives', () => {
  // Walks the WHOLE refusal table (task 86bbtqpxd), not one sample. A refusal
  // now carries a class, and the promise it is allowed to make follows from
  // that class — so the invariant has to hold for every reason there is,
  // including the terminal ones that never used to exist here.
  const { REFUSAL_CODES } = require('./refusalClass.js');
  for (const code of Object.values(REFUSAL_CODES)) {
    assertPromiseMatchesMarker(
      refusalNotice({ commentId: '77', why: `some reason (${code})`, plainEnglish: 'x', refusalCode: code }),
      `refusal: ${code}`,
    );
  }
  assertPromiseMatchesMarker(
    conflictHandOffNotice({ commentId: '77', pr: SOME_PR, localVerdict: null }),
    'hand-off, unchecked locally',
  );
  assertPromiseMatchesMarker(
    conflictHandOffNotice({ commentId: '77', pr: SOME_PR, localVerdict: { realConflict: true, reason: 'both touched routes/index.js' }, filed: FILED }),
    'hand-off, real overlap, ticket filed',
  );
  assertPromiseMatchesMarker(
    conflictHandOffNotice({ commentId: '77', pr: SOME_PR, localVerdict: { realConflict: true, reason: 'both touched routes/index.js' }, filed: null }),
    'hand-off, real overlap, NOTHING filed',
  );
  assertPromiseMatchesMarker(
    mergedNotice({ commentId: '77', pr: SOME_PR, mergedAt: '2026-08-23T10:00:00.000Z' }),
    'merged',
  );
});

// ---------- a hand-off names its actor, or says there isn't one (86bbq0fh8)

test('THE BUG: a real conflict with nothing filed must not say it will merge', () => {
  // PR #434, 2026-08-26 to 2026-08-29. The comment said the approval stood and
  // it would merge once the branch was caught up; "once the branch is caught
  // up" had no owner, the bus post asking for an agent session went into a
  // room nothing reads, and three days passed. Dane found it himself.
  const { body, actor } = conflictHandOffNotice({
    commentId: '77', pr: SOME_PR, filed: null,
    localVerdict: { kind: 'real-conflict', reason: 'both touched routes/index.js' },
  });
  assert.equal(actor, 'nobody');
  assert.ok(!body.includes(APPROVAL_CARRIES_OVER), 'must not promise the approval carries over with no actor');
  assert.doesNotMatch(body, /will merge|goes through on its own|on a later run/i,
    'must not describe a merge that nothing is going to perform');
  assert.match(body, /Nothing is currently working on it/i, 'must say plainly that it is stalled');
  assert.match(body, /agent session/i, 'must name what kind of actor it needs');
});

test('a filed conflict ticket IS the named actor, and the body says which one', () => {
  const { body, actor } = conflictHandOffNotice({
    commentId: '77', pr: SOME_PR, filed: FILED,
    localVerdict: { kind: 'real-conflict', reason: 'both touched routes/index.js' },
  });
  assert.equal(actor, 'loop-queue');
  assert.match(body, new RegExp(FILED.id), 'the ticket that will do the work must be named by id');
  assert.match(body, new RegExp(FILED.url.replace(/[/.]/g, '\\$&')), 'and linked');
  assert.match(body, /build loop drains every pass/i, 'and the reader must be told that actor is already running');
  assert.ok(body.includes(APPROVAL_CARRIES_OVER), 'with a real actor the approval genuinely does carry over');
});

test('no hand-off leans on the passive voice to imply an actor it cannot name', () => {
  // vault doctrine/TERMINOLOGY.md, 2026-08-29: a hand-off names which of the
  // two it needs — a person or an agent session — and passive voice implying
  // an unnamed one is itself the defect.
  const stalled = conflictHandOffNotice({
    commentId: '77', pr: SOME_PR, filed: null,
    localVerdict: { kind: 'real-conflict', reason: 'overlap' },
  }).body;
  for (const weasel of [/it will be (?:merged|caught up|resolved)/i, /once the branch is caught up/i]) {
    assert.doesNotMatch(stalled, weasel, `passive promise with no actor behind it: ${weasel}`);
  }
});

test('a stale GitHub answer still retries, filed or not — a PROVEN no-overlap needs nobody', () => {
  // This used to be written against `localVerdict: null`, on the belief that
  // "no verdict" meant "the check found nothing". Review round 2 of task
  // 86bbq80j5 separated those: the retry promise belongs to a verdict that
  // actually came back clean, which is now stated rather than inferred from an
  // absence. The old shape sent "nobody needs to claim it" to the bus for a
  // failed fetch and for a repo the machine has no checkout of.
  for (const filed of [null, FILED]) {
    const n = conflictHandOffNotice({
      commentId: '77', pr: SOME_PR, filed,
      localVerdict: { kind: 'no-overlap', reason: 'the catch-up merged cleanly but could not be pushed' },
    });
    assert.equal(n.actor, 'later-pass');
    assert.ok(n.body.includes(APPROVAL_CARRIES_OVER));
    assert.match(n.body, /merged on the next run/i);
  }
});

test('NO VERDICT is not a finding — a dry run may not stand the room down', () => {
  // The other half of the same separation. Null now means one thing only: a
  // dry run, which never attempts the catch-up. It gets an actor, which is
  // what makes the dry run report an unfiled hand-off as stalled instead of
  // calling it self-healing (review round 2, item 5).
  const n = conflictHandOffNotice({ commentId: '77', pr: SOME_PR, localVerdict: null, filed: null });
  assert.equal(n.actor, 'nobody');
  assert.doesNotMatch(n.body, /merged on the next run/i, 'it has no finding to promise on');
  assert.match(n.body, /no local check was attempted/i, 'and it says so');
});

test('the two hand-off kinds say two different things', () => {
  // 'needs-rebuild' was a third kind while committed HTML carried ?v= asset
  // pins; retired 2026-08-24 with the pins themselves (task 86bbkh288).
  const of = (localVerdict) => conflictHandOffNotice({ commentId: '77', pr: SOME_PR, localVerdict }).body;
  const real = of({ kind: 'real-conflict', reason: 'both touched routes/index.js' });
  const couldNotCheck = of({ kind: 'could-not-check', reason: 'the local merge could not run' });
  const noOverlap = of({ kind: 'no-overlap', reason: 'the catch-up merged cleanly but could not be pushed' });
  assert.notEqual(real, couldNotCheck);
  assert.notEqual(couldNotCheck, noOverlap, 'THREE kinds, and the middle two are not one kind');
  assert.match(real, /both changed the same lines/);
  assert.match(real, /never resolve one blind/);
  assert.match(couldNotCheck, /could not check whether that is true/);
  assert.match(noOverlap, /with no overlap at all/);
});

test('an old-style realConflict verdict still reads correctly', () => {
  // Belt and braces: the boolean shape predates `kind`, and a caller that has
  // not been updated must not silently fall through to "unknown".
  const body = conflictHandOffNotice({
    commentId: '77', pr: SOME_PR, localVerdict: { realConflict: true, reason: 'overlap' },
  }).body;
  assert.match(body, /both changed the same lines/,
    'the pre-`kind` boolean shape must still read as a real overlap');
});

test('THE BUG: the hand-off told him his merge still stood, then threw it away', () => {
  // Verbatim from the 2026-08-23 record: the comment said "then your merge
  // still stands and this goes through", and the marker beside it parsed as
  // terminal, so no later pass ever looked again.
  //
  // The verdict here is the stale-GitHub one that day actually was. It used to
  // be written as `null` and rely on null reading as self-healing; review
  // round 2 made that state itself instead of being inferred from an absence.
  const notice = conflictHandOffNotice({
    commentId: '77', pr: SOME_PR,
    localVerdict: { kind: 'no-overlap', reason: 'main merged into the branch with no conflict' },
  });
  assert.equal(markerKind(notice.marker), 'refused');
  // The opening line says what happened, in the operator's own requested
  // shape (2026-08-24). It used to open "Needs a hand", which read as a
  // request for him to do something in a lane where the only thing he owes
  // is the merge word he had already given.
  assert.match(notice.body, /was not able to merge on the last attempt/i);
  assert.ok(notice.body.includes(APPROVAL_CARRIES_OVER));
});

test('the hand-off never asks the operator for a person, or for anything at all', () => {
  // He reads this comment in Ready to launch, which is HIS lane: the only
  // thing owed there is his merge word, and he has already given it. Wording
  // that reads as a request sends him looking for an action that does not
  // exist — he said so on 2026-08-24, about this exact comment.
  for (const localVerdict of [
    null,
    { realConflict: true, reason: 'both touched routes/index.js' },
    { realConflict: false, reason: 'the catch-up could not be pushed' },
  ]) {
    const { body } = conflictHandOffNotice({ commentId: '77', pr: SOME_PR, localVerdict });
    assert.doesNotMatch(body, /needs a person|needs a hand/i, `asks for a person: ${body}`);
  }
});

test('only a REAL overlap is denied the "next run" promise', () => {
  // The whole family of bugs behind this ticket is the machine promising an
  // outcome it cannot deliver. A real overlap will hit the same wall next
  // pass, so it must not say the next run merges it; anything else retries
  // usefully and must say so, or he is left wondering whether to act.
  // With a ticket filed there IS an actor, so the "later run" promise is
  // honest; without one the body must not promise a merge at all, which the
  // stalled-hand-off tests above cover.
  const real = conflictHandOffNotice({
    commentId: '77', pr: SOME_PR, filed: FILED,
    localVerdict: { realConflict: true, reason: 'both touched routes/index.js' },
  }).body;
  assert.doesNotMatch(real, /on the next run/i);
  assert.match(real, /on a later run/i);
  assert.match(real, /both changed the same lines/i);

  // Only a PROVEN no-overlap earns the next-run promise (review round 2). The
  // loop here used to include `null` and the legacy `realConflict: false`,
  // neither of which is evidence that anything was checked — and a promise
  // made on no evidence is the family of bug this whole ticket is about.
  const { body } = conflictHandOffNotice({
    commentId: '77', pr: SOME_PR,
    localVerdict: { kind: 'no-overlap', reason: 'the catch-up merged cleanly but could not be pushed' },
  });
  assert.match(body, /merged on the next run/i, `no retry promise: ${body}`);

  for (const localVerdict of [null, { realConflict: false, reason: 'the catch-up could not be pushed' }]) {
    const n = conflictHandOffNotice({ commentId: '77', pr: SOME_PR, localVerdict, filed: FILED });
    assert.doesNotMatch(n.body, /merged on the next run/i,
      `a check that never ran may not promise the next run merges it: ${n.body}`);
  }
});

test('the hand-off marker and the reason the plumbing compares are the SAME string', () => {
  // The quieting in clickup_direct.mjs compares the reason a previous pass
  // recorded against the one it just derived. If those two ever differ by a
  // character, a permanently-conflicting ticket gets an identical comment
  // on every pass instead of going silent.
  const notice = conflictHandOffNotice({ commentId: '77', pr: SOME_PR, localVerdict: null });
  const derived = notice.marker.replace(/^refused:\s*/, '');
  const readBack = parseMergeMarker(`${MERGE_MARKER} ${notice.marker} — 2026-08-23T10:00:00.000Z`);
  assert.equal(readBack.kind, 'refused');
  assert.equal(readBack.reason, derived);
});

test('MIGRATION: the eleven already-stuck hand-offs read back as re-decidable', () => {
  // Written before this change, so no "refused:" prefix. They must now heal
  // themselves on the next pass rather than needing a command run by hand.
  const legacy = parseMergeMarker(`${MERGE_MARKER} conflict hand-off on PR #380 — 2026-08-23T04:00:00.000Z`);
  assert.equal(legacy.kind, 'refused');
  assert.equal(legacy.legacy, true);
  assert.equal(legacy.reason, 'conflict hand-off on PR #380');

  // ...and the reason it yields is byte-identical to what a NEW hand-off
  // records, so a ticket that is still genuinely conflicted stays quiet
  // instead of being re-announced once per pass.
  const fresh = conflictHandOffNotice({ commentId: '77', pr: SOME_PR, localVerdict: null });
  assert.equal(fresh.marker.replace(/^refused:\s*/, ''), legacy.reason);
});

test('MIGRATION does not reach a merged marker — that stays spent forever', () => {
  for (const spent of [
    'merged PR #380 at 2026-08-22T04:00:00.000Z',
    'conflict hand-off on PR #380 and then some',
    'handed off',
  ]) {
    assert.equal(parseMergeMarker(`${MERGE_MARKER} ${spent} — 2026-08-23T04:00:00.000Z`).kind, 'terminal', spent);
  }
});

test('AC2: a conflict cleared since the hand-off merges on the next pass, unprompted', () => {
  const cmd = c(3, OPERATOR, 'merge');
  const comments = [reviewPassed(1), prOpened(2), cmd];

  // Pass 1 reached 'merge' on the ClickUp side and then hit a conflict at the
  // GitHub gate. Rebuild what bus-relay records: the hand-off marker, parsed
  // back off the reply thread exactly as the live pass does.
  const first = mergeDecision({ status: 'ready to launch', operatorId: OPERATOR, comments });
  assert.equal(first.act, 'merge');
  assert.equal(
    githubGate({ state: 'OPEN', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }).action,
    'conflict',
  );
  const notice = conflictHandOffNotice({ commentId: first.commentId, pr: SOME_PR, localVerdict: null });
  const parsed = latestMergeMarker([marker(4, notice.marker)]);
  const refused = new Map([[first.commentId, parsed.reason]]);

  // Someone merges main into the branch and pushes. Next pass: the SAME
  // authorization is still live — under the old terminal marker it was in
  // `handled` and this decision was never reached at all.
  const second = mergeDecision({ status: 'ready to launch', operatorId: OPERATOR, comments, refused });
  assert.equal(second.act, 'merge');
  assert.equal(second.pr.number, 362);
  assert.equal(second.priorRefusal, 'conflict hand-off on PR #380');
  assert.equal(
    githubGate({
      state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
      statusCheckRollup: [{ name: 'verify', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    }).action,
    'merge',
  );
});

test('a still-conflicted ticket stays quiet: the reason it derives is the one it recorded', () => {
  const cmd = c(3, OPERATOR, 'merge');
  const comments = [reviewPassed(1), prOpened(2), cmd];
  const notice = conflictHandOffNotice({ commentId: String(cmd.id), pr: SOME_PR, localVerdict: null });
  const refused = new Map([[String(cmd.id), notice.marker.replace(/^refused:\s*/, '')]]);
  const again = mergeDecision({ status: 'ready to launch', operatorId: OPERATOR, comments, refused });
  // mergeDecision cannot know about the conflict — it lives at the GitHub
  // gate — so it correctly still says 'merge' and hands the plumbing the
  // reason to compare against.
  assert.equal(again.act, 'merge');
  assert.equal(again.priorRefusal, notice.marker.replace(/^refused:\s*/, ''));
});

// ── Merging in one pass (task 86bbk2fb5) ────────────────────────────────────

/**
 * Merging one PR is ~3 minutes of work — catch up, run CI (verify median 85s),
 * merge — and we were achieving 1.25 merges an hour. The cost was the shape:
 * pass N caught the branch up and left, CI finished 85 seconds later, pass N+1
 * merged an hour after that.
 *
 * The rule that makes waiting safe is that running out of budget produces a
 * WAIT — precisely what the pass returned before — and never a merge. These
 * tests exist mostly to defend that asymmetry.
 */

const {
  IN_PASS_WAIT_MS,
  IN_PASS_POLL_MS,
  MAX_IN_PASS_WAITS,
  mergeObserveBudget,
  mergeObservationSpendsSlot,
  mayWaitInPass,
  afterCatchUpDecision,
} = require('./mergeOnComment.js');

test('a green PR after the catch-up merges in this pass', () => {
  const out = afterCatchUpDecision({ gate: { action: 'merge', reason: '1 check green' }, elapsedMs: 20_000 });
  assert.equal(out.action, 'merge');
});

test('red during the wait refuses, with the gate\'s own words', () => {
  // No new wording: the existing refusal path handles it, unchanged.
  const out = afterCatchUpDecision({ gate: { action: 'refuse', reason: 'checks are red: verify' }, elapsedMs: 20_000 });
  assert.equal(out.action, 'refuse');
  assert.equal(out.reason, 'checks are red: verify');
});

test('a conflict discovered during the wait goes to the conflict path', () => {
  const out = afterCatchUpDecision({ gate: { action: 'conflict', reason: 'the branch conflicts' }, elapsedMs: 1000 });
  assert.equal(out.action, 'conflict');
});

test('still running inside the budget means ask again', () => {
  const out = afterCatchUpDecision({ gate: { action: 'wait', reason: 'checks still running: verify' }, elapsedMs: 30_000 });
  assert.equal(out.action, 'poll-again');
});

test('a branch that goes behind during the wait ends the wait — polling cannot catch it up', () => {
  // BREAK-TEST: delete the update-branch arm of afterCatchUpDecision and this
  // fails — `assert.equal(out.action, 'update-branch')` reports 'poll-again',
  // which polls out the full budget and then answers "CI was still running"
  // about a branch whose CI was fine and had merely fallen behind main
  // (found in review, 2026-08-30, task 86bbmk7pv).
  const out = afterCatchUpDecision({ gate: { action: 'update-branch', reason: 'the branch is behind main' }, elapsedMs: 1000 });
  assert.equal(out.action, 'update-branch');
  assert.equal(out.reason, 'the branch is behind main');
});

test('OUT OF BUDGET IS A WAIT, never a merge', () => {
  // The whole safety of this feature. A slow CI run must not become either a
  // failure or an unchecked merge — it must become exactly the outcome the
  // pass produced before this existed.
  for (const gate of [
    { action: 'wait', reason: 'checks still running: verify' },
    { action: 'wait', reason: 'GitHub is still computing whether the branch merges cleanly' },
    { action: 'unknown-future-action' },
    {},
  ]) {
    const out = afterCatchUpDecision({ gate, elapsedMs: IN_PASS_WAIT_MS + 1 });
    assert.equal(out.action, 'wait', `${JSON.stringify(gate)} must time out to wait`);
    assert.notEqual(out.action, 'merge');
  }
});

test('the timeout says how long it waited, so the log is readable', () => {
  const out = afterCatchUpDecision({ gate: { action: 'wait' }, elapsedMs: 999_999, budgetMs: 180_000 });
  assert.match(out.reason, /180s/);
  assert.match(out.reason, /next pass/);
});

test('the per-pass cap is enforced, and the extras fall through', () => {
  assert.equal(mayWaitInPass(0), true);
  assert.equal(mayWaitInPass(MAX_IN_PASS_WAITS - 1), true);
  assert.equal(mayWaitInPass(MAX_IN_PASS_WAITS), false, 'the cap must actually stop it');
  assert.equal(mayWaitInPass(MAX_IN_PASS_WAITS + 5), false);
  assert.equal(mayWaitInPass(0, 0), false, 'a cap of zero disables in-pass waiting entirely');
});

test('the budget is a named constant, roughly 2x the observed median', () => {
  // 85s median for `verify`. A literal here is how a tuned number becomes a
  // mystery number six months later.
  assert.equal(typeof IN_PASS_WAIT_MS, 'number');
  // This range is about the MEDIAN, not about the schedule. The tighter of the
  // two constraints is the next test: cap x budget must stay under the relay's
  // interval, which at cap 3 and a 600s interval means a budget under 200s.
  assert.ok(IN_PASS_WAIT_MS >= 120_000 && IN_PASS_WAIT_MS <= 300_000,
    `budget should be ~2x the 85s median, got ${IN_PASS_WAIT_MS}ms`);
  assert.ok(IN_PASS_POLL_MS > 0 && IN_PASS_POLL_MS < IN_PASS_WAIT_MS);
});

test('the merge observation draws from the SAME budget, and never a second one', () => {
  // ROUND 2 of task 86bbv35cq. The merge-observation wait shipped taking a
  // 15-minute default, blocking, uncapped per ticket, and charged to nothing.
  // Against a 600s wake that is one PR swallowing the relay's own next firing
  // — the precise mistake the comment on the next test records having already
  // been made once, arriving on a new path.
  //
  // It is not a second budget. It is an in-pass wait: same slots, same
  // ceiling, so the worst case below covers it by construction rather than
  // being a sum of two numbers nobody maintains.
  const fresh = mergeObserveBudget({ used: 0, cap: MAX_IN_PASS_WAITS });
  assert.equal(fresh.charged, true);
  assert.equal(fresh.timeoutMs, IN_PASS_WAIT_MS, 'one wait, the same ceiling as every other');

  const last = mergeObserveBudget({ used: MAX_IN_PASS_WAITS - 1, cap: MAX_IN_PASS_WAITS });
  assert.equal(last.charged, true);

  // A SPENT BUDGET STILL LOOKS ONCE. timeoutMs 0 takes one read and no sleep,
  // which is the whole of the queue-less path — so a pass that has done its
  // waiting still observes every ordinary merge correctly, and merely does not
  // linger on one GitHub is holding. Refusing to read at all would reinvent
  // the false success this ticket started from.
  const spent = mergeObserveBudget({ used: MAX_IN_PASS_WAITS, cap: MAX_IN_PASS_WAITS });
  assert.equal(spent.charged, false, 'it does not charge a slot it has not got');
  assert.equal(spent.timeoutMs, 0, 'and it does not sleep');

  // No budget object at all (a caller that forgot to thread it through) is the
  // spent case, never the unbounded one.
  assert.equal(mergeObserveBudget({ used: Infinity, cap: 0 }).timeoutMs, 0);
  assert.equal(mergeObserveBudget().timeoutMs, IN_PASS_WAIT_MS, 'defaults are the ordinary case');

  // The ceiling can never exceed one in-pass wait, whatever it is handed.
  for (const used of [0, 1, 2, 3, 99]) {
    assert.ok(mergeObserveBudget({ used }).timeoutMs <= IN_PASS_WAIT_MS,
      'no path may return a wait longer than one slot');
  }
});

test('ROUND 3: a wait that never happened costs nothing', () => {
  // The round-2 fix charged the slot BEFORE the observation, on being WILLING
  // to wait. But today's queue-less merge answers on the first read having
  // slept 0ms — so every ordinary merge spent one of three slots for a wait it
  // never took. Measured: three ordinary merges in a pass left used = 3/3, and
  // `mayWaitInPass` then refused the fourth ticket its real review-gate or CI
  // wait and deferred it a whole ten-minute interval. That is criterion 5 —
  // "identically with NO queue enabled" — broken on the live path, by the
  // accounting rather than by the wait.
  assert.equal(mergeObservationSpendsSlot({ charged: true, sleptMs: 0 }), false,
    'the queue-less path: willing to wait, never waited, pays nothing');
  assert.equal(mergeObservationSpendsSlot({ charged: true, sleptMs: 1 }), true,
    'a wait that really blocked spends its slot');
  assert.equal(mergeObservationSpendsSlot({ charged: true, sleptMs: IN_PASS_WAIT_MS }), true);

  // `charged` still gates it: a pass with no slots left is handed timeoutMs 0,
  // takes one read and no sleep, and may not somehow spend a fourth.
  assert.equal(mergeObservationSpendsSlot({ charged: false, sleptMs: 0 }), false);
  assert.equal(mergeObservationSpendsSlot({ charged: false, sleptMs: 90_000 }), false,
    'an unbudgeted wait cannot spend a slot it was never given');

  // Missing arguments are the free answer, never the expensive one.
  assert.equal(mergeObservationSpendsSlot(), false);
  assert.equal(mergeObservationSpendsSlot({}), false);

  // THE MEASUREMENT THAT NAMED THE DEFECT, as arithmetic: three ordinary
  // merges in one pass, and the fourth ticket still gets its real wait.
  let used = 0;
  for (let merge = 0; merge < 3; merge += 1) {
    const budget = mergeObserveBudget({ used, cap: MAX_IN_PASS_WAITS });
    // A queue-less merge: one read, no sleep.
    if (mergeObservationSpendsSlot({ charged: budget.charged, sleptMs: 0 })) used += 1;
  }
  assert.equal(used, 0, 'three ordinary merges spend nothing');
  assert.equal(mayWaitInPass(used, MAX_IN_PASS_WAITS), true,
    'so the next ticket that needs a REAL wait still gets one');

  // And three merges GitHub really held do spend the pass, as they should.
  let held = 0;
  for (let merge = 0; merge < 3; merge += 1) {
    const budget = mergeObserveBudget({ used: held, cap: MAX_IN_PASS_WAITS });
    if (mergeObservationSpendsSlot({ charged: budget.charged, sleptMs: budget.timeoutMs })) held += 1;
  }
  assert.equal(held, MAX_IN_PASS_WAITS, 'real waits are still counted');
  assert.equal(mayWaitInPass(held, MAX_IN_PASS_WAITS), false, 'and still stop the pass overrunning');
});

test('worst case is bounded — a pass cannot outlast its own interval', (t) => {
  if (skipWithoutProductScript(t, 'busRelayInstaller')) return;
  // launchd runs one instance per Label and COALESCES the firings it misses
  // while a pass is still running, so a long pass can never stack. What it can
  // do is swallow the firing it overran: approvals that arrived meanwhile then
  // wait on work already in flight instead of being picked up next time round.
  //
  // So the bound is the relay's own interval — read from the source of truth
  // rather than written down a second time here. A literal would be a number
  // that stops agreeing with the schedule the moment either one moves, which
  // is exactly what happened to the 15-minute bound this replaces: it was
  // picked when the relay ran hourly, and it survived the change to 10 minutes
  // still permitting a pass 1.5x longer than the whole interval.
  const intervalMs = relayIntervalSeconds() * 1000;
  const worstMs = MAX_IN_PASS_WAITS * IN_PASS_WAIT_MS;
  assert.ok(worstMs < intervalMs,
    `a pass could hold open for ${Math.round(worstMs / 60_000)} minutes, which is not ` +
    `shorter than the ${Math.round(intervalMs / 60_000)}-minute relay interval — it would ` +
    `swallow its own next firing and delay approvals that arrive while it runs`);

  // AND EVERY WAIT IS INSIDE THAT SUM (round 2 of task 86bbv35cq). Multiplying
  // the two named constants is only a bound while nothing waits OUTSIDE them,
  // and that is exactly how the merge observation got past this test the first
  // time: it was a third wait the arithmetic never saw. So walk the budget
  // down slot by slot, spending a merge observation at each step, and prove
  // the total is still the same worst case rather than more than it.
  let spent = 0;
  for (let used = 0; used < MAX_IN_PASS_WAITS + 2; used += 1) {
    spent += mergeObserveBudget({ used, cap: MAX_IN_PASS_WAITS }).timeoutMs;
  }
  assert.equal(spent, worstMs,
    'merge observations must fit INSIDE the worst case, not be added to it');
  assert.ok(spent < intervalMs, 'so a pass that spends every slot on merges still fits its wake');

  // AND THE ACCOUNTING RUNS THE SAME WALK (round 3). The ceiling above bounds
  // how long each observation MAY block; this bounds what a pass actually
  // blocks for once the slot is charged on evidence. Walk it as the relay
  // does — draw a budget, wait for as long as it allows, charge only what
  // really slept — and the total must still be the one worst case.
  let realUsed = 0;
  let realMs = 0;
  for (let ticket = 0; ticket < MAX_IN_PASS_WAITS + 3; ticket += 1) {
    const budget = mergeObserveBudget({ used: realUsed, cap: MAX_IN_PASS_WAITS });
    const sleptMs = budget.timeoutMs; // the worst case: GitHub held it the whole way
    realMs += sleptMs;
    if (mergeObservationSpendsSlot({ charged: budget.charged, sleptMs })) realUsed += 1;
  }
  assert.equal(realMs, worstMs, 'charging on evidence must not let a pass wait longer than the bound');
  assert.ok(realMs < intervalMs, 'so it still fits inside the relay\'s own wake');
});

test('the relay waits after BOTH catch-up paths, and merges the same way', (t) => {
  if (skipWithoutDoor(t)) return;
  const src = doorSource() || '';

  // Both the GitHub update-branch path and the local false-conflict catch-up
  // must wait — fixing only one leaves half the backlog waiting a full extra
  // interval for no reason.
  //
  // Counting the NAME is not enough: a first version of this assertion counted
  // `waitForChecksInPass(` and a break that left the identifier in place while
  // never calling it passed cleanly. The AWAITED calls are the thing.
  //
  // TWO since 2026-09-03 (task 86bbup3u1), and the one that LEFT is the point.
  // The GitHub catch-up path no longer waits at all: waiting was the treadmill
  // — 180s against a ~6 minute CI run, on a branch main invalidates every 20
  // minutes. It now falls through to the arming path, which hands the PR to
  // GitHub and returns, so the merge no longer depends on a pass being awake
  // at the right moment.
  //
  // THREE since 2026-09-04 (task 86bbuvcwc). The GitHub-says-conflict /
  // git-says-clean disagreement now performs the local catch-up instead of
  // only reporting it, and a path that pushes must wait on the CI that push
  // restarts — for the same reason the other two do.
  //
  // What this guard is about is unchanged — no path that pushes may leave a
  // PR for a whole relay interval for no reason.
  const awaited = (src.match(/await waitForChecksInPass\(/g) || []).length;
  assert.equal(awaited, 3,
    `expected exactly 3 awaited calls — the local false-conflict catch-up, the GitHub/git disagreement catch-up, and the stale review-gate re-run — found ${awaited}`);

  // And the path that stopped waiting must ARM instead, not simply give up.
  // BREAK-TEST: delete the fall-through assignment and this fails.
  assert.match(src, /gate = \{ action: 'wait', cannotTell: false, reason: 'the branch was caught up with main and its checks are re-running' \}/,
    'the GitHub catch-up must fall through to the arming path, not return');
  assert.match(src, /'--auto', '--squash', '--delete-branch'/,
    'the arming path must actually arm GitHub auto-merge');

  // MEASURED, NOT ASSUMED (PR #583): arming does NOT catch a branch up.
  // `allow_update_branch` adds the "Update branch" button; it does not make
  // GitHub push to an armed PR. An armed PR left BEHIND sits forever, which is
  // a worse livelock than the one this replaced. So the catch-up stays ours.
  assert.equal(/if \(prJson\.autoMergeRequest\) \{\n\s*console\.error\(`  MERGE WAITING on \$\{label\}: behind main/.test(src), false,
    'a behind-main PR must be caught up even when auto-merge is already armed');
  assert.match(src, /re-ran the stale review gate/,
    'the stale review-gate re-run must say so on the console, like every other path here');

  // It must NOT decide mergeability itself. The `gateOf` hook added for the
  // stale-gate re-run narrows when to KEEP WAITING; it can never widen "may
  // merge", because its default is githubGate and the one caller that
  // overrides it composes with githubGate rather than replacing it — through
  // the pure, tested duringRerunWait, whose only pass-through is a FRESH
  // answer (an 'absent' mid-swap rollup keeps waiting; reviewGate.test.js
  // pins that arm by behaviour).
  assert.match(src, /gateOf = githubGate/,
    'the in-pass wait must default to the same gate');
  assert.match(src, /gate: gateOf\(json\)/,
    'the in-pass wait must re-ask the gate it was given, not re-implement it');
  assert.match(src, /reviewGate\.duringRerunWait\(\{\n\s*staleness: reviewGate\.reviewGateStaleness\(\{ rollup: json\.statusCheckRollup, comments \}\),\n\s*gate: githubGate\(json\),/,
    'the stale-gate hook must route through the tested duringRerunWait, composed with githubGate for the actual merge decision');
});

// ── The operator card must not be read as the verdict (task 86bbrem48) ────
// 2026-09-01: four approved tickets sat in `Ready to launch` overnight while
// the queue stood still behind a full WIP cap. The merge step refused each
// one with "the most recent review verdict is not a PASS" — a false
// statement. loop-review's own operator card contains a prose line beginning
// "Review re-ran everything independently on the merged code: ...", the card
// is NEWER than the verdict, and the old pattern (/^\s*REVIEW\b.*$/im)
// matched any line starting with the word "Review". The review pass was
// poisoning its own verdict, permanently: the card can never stop being
// newer than the verdict it accompanies.

// Verbatim shape from 86bbr1u9v, which is the ticket that jammed.
const operatorCard = (t) => c(t, AGENT, [
  'NEEDED FROM DANE: Merge approval on PR #489',
  '',
  'Review re-ran everything independently on the merged code: typecheck clean,',
  '1976 + 1388 tests passing, conventions, syntax, clean build.',
].join('\n'));

test('an operator card posted AFTER the verdict does not become the verdict', () => {
  const d = mergeDecision({
    status: 'ready to launch',
    operatorId: OPERATOR,
    comments: [prOpened(1), reviewPassed(2), operatorCard(3), c(4, OPERATOR, 'merge')],
  });
  assert.equal(d.act, 'merge', 'the newest PASS still governs — the card is prose, not a verdict');
  assert.equal(d.pr.number, 362);
});

test('a prose line beginning "Review" is not a verdict at all', () => {
  assert.equal(isReviewVerdict('Review re-ran everything independently on the merged code'), false);
  assert.equal(isReviewVerdict('Reviewed the branch and it looks fine'), false);
  // Still a verdict, both spellings, both outcomes — the fix narrows the
  // pattern, it does not move it.
  assert.equal(isReviewVerdict('REVIEW: PASSED — verified on the merged code'), true);
  assert.equal(isReviewVerdict('REVIEW PASSED (loop-review, 2026-08-22)'), true);
  assert.equal(isReviewVerdict('REVIEW: sent back to Queued — a blocking finding.'), true);
});

test('DELIBERATE: the fix made the gate STRICTER, never more willing to merge', () => {
  // The one property that must survive: a genuine send-back that is newer
  // than a pass still refuses, even with an operator card in the mix. A fix
  // to a merge gate that loosens it is worse than the bug it repairs.
  const d = mergeDecision({
    status: 'ready to launch',
    operatorId: OPERATOR,
    comments: [
      prOpened(1),
      reviewPassed(2),
      operatorCard(3),
      c(4, AGENT, 'REVIEW: sent back to Queued — a blocking finding.'),
      c(5, OPERATOR, 'merge'),
    ],
  });
  assert.equal(d.act, 'refuse');
  assert.match(d.reason, /not a PASS/);
});

test('a ticket carrying ONLY a card and no verdict still refuses', () => {
  // The card must not stand in for a verdict in either direction: it cannot
  // block a pass, and it cannot substitute for one.
  const d = mergeDecision({
    status: 'ready to launch',
    operatorId: OPERATOR,
    comments: [prOpened(1), operatorCard(2), c(3, OPERATOR, 'merge')],
  });
  assert.equal(d.act, 'refuse');
  assert.match(d.reason, /no review verdict/);
});

// ── A pasted merge word is still the merge word (task 86bbt038u) ─────────────
//
// The same ClickUp behaviour that swallowed Dane's `resume auto-merging` on
// 2026-09-01 applies here: his `merge` worked only because he typed it by
// hand. Pasting it would have produced a fenced block and been ignored, with
// the ticket sitting in Ready to launch looking like he had never answered.

test('a fenced merge word is a merge command', () => {
  assert.equal(isMergeCommand('```\nmerge\n```'), true);
  assert.equal(isMergeCommand('```cpp\nmerge\n```'), true);
});

test('inline backticks around a merge phrase still count', () => {
  assert.equal(isMergeCommand('`merge it`'), true);
  assert.equal(isMergeCommand('`ship it`'), true);
});

test('stripping the fence does NOT turn the closed set into a substring match', () => {
  assert.equal(isMergeCommand('do not merge this yet'), false);
  assert.equal(isMergeCommand('```\ndo not merge this yet\n```'), false);
  assert.equal(isMergeCommand("I'll approve the design later"), false);
});

// ── GitHub auto-merge (task 86bbup3u1) ───────────────────────────────────────
//
// The incident: on 2026-09-03 Dane said "merge" at 15:43 and the PR was still
// open an hour later. `main` requires branches be up to date, CI takes ~6
// minutes, main absorbed a merge every ~20, and the relay waits 180s. Every
// pass caught the branch up, timed out, and deferred to a pass that started
// from behind again. Nothing refused; every pass was healthy.

const {
  autoMergeDecision,
  autoMergeArmedTooLong,
  mergedElsewhereNotice,
  AUTO_MERGE_STALE_MS,
} = require('./mergeOnComment.js');

test('checks still running hands the PR to GitHub instead of deferring', () => {
  const d = autoMergeDecision({ gate: { action: 'wait', reason: 'checks still running: verify' }, reviewGateState: 'fresh' });
  assert.equal(d.action, 'arm');
});

test('behind main arms too — GitHub does the catch-up itself', () => {
  const d = autoMergeDecision({ gate: { action: 'update-branch' }, reviewGateState: 'fresh' });
  assert.equal(d.action, 'arm');
});

test('an already-armed PR is not armed a second time', () => {
  const d = autoMergeDecision({
    gate: { action: 'wait' },
    autoMergeRequest: { enabledAt: new Date().toISOString() },
    reviewGateState: 'fresh',
  });
  assert.equal(d.action, 'already-armed');
});

// THE REFUSAL PATHS ARE UNTOUCHED (criterion 4). Arming happens on exactly
// two non-terminal answers; every terminal one keeps going through the
// relay's own gate, which is stricter than GitHub's.
test('a terminal gate answer never arms auto-merge', () => {
  for (const action of ['refuse', 'conflict', 'merge']) {
    const d = autoMergeDecision({ gate: { action }, reviewGateState: 'fresh' });
    assert.equal(d.action, 'none', `${action} must not arm`);
  }
});

test('an already-merged PR never arms', () => {
  const d = autoMergeDecision({ gate: { action: 'wait' }, reviewGateState: 'fresh', alreadyMerged: true });
  assert.equal(d.action, 'none');
});

// THE GUARD THAT MATTERS. Branch protection on main requires `verify` and
// nothing else, so GitHub's auto-merge cannot see this repo's review gate.
// Arming a PR whose review gate is stale would delegate the merge to a weaker
// gate than the one being replaced.
test('a stale review gate is never handed to GitHub', () => {
  const d = autoMergeDecision({ gate: { action: 'wait' }, reviewGateState: 'stale' });
  assert.equal(d.action, 'none');
});

test('a PR armed before its review gate went stale is DISARMED', () => {
  const d = autoMergeDecision({
    gate: { action: 'wait' },
    autoMergeRequest: { enabledAt: new Date().toISOString() },
    reviewGateState: 'stale',
  });
  assert.equal(d.action, 'disarm');
});

test('a pending review gate does not arm either', () => {
  assert.equal(autoMergeDecision({ gate: { action: 'wait' }, reviewGateState: 'pending' }).action, 'none');
});

test('absent review gate is allowed through, as the merge path already allows it', () => {
  assert.equal(autoMergeDecision({ gate: { action: 'wait' }, reviewGateState: 'absent' }).action, 'arm');
});

// AN ARMED MERGE THAT NEVER FIRES IS THE NEW SILENCE. Once the pass hands the
// PR to GitHub it stops looking, so something has to notice a hand-off that
// never landed.
test('a freshly armed PR is not reported as stalled', () => {
  const now = Date.now();
  const r = autoMergeArmedTooLong({ autoMergeRequest: { enabledAt: new Date(now - 60_000).toISOString() }, now });
  assert.equal(r.state, 'ok');
});

test('a PR armed longer than the threshold is reported stalled', () => {
  const now = Date.now();
  const r = autoMergeArmedTooLong({
    autoMergeRequest: { enabledAt: new Date(now - AUTO_MERGE_STALE_MS - 60_000).toISOString() },
    now,
  });
  assert.equal(r.state, 'stale');
  assert.match(r.reason, /armed on this PR for/);
});

// CANNOT TELL IS NOT OK. Reading an unknown as healthy is how the silence
// this guards against gets rebuilt one level up (DOCTRINE 3.11).
test('an armed PR with no readable arming time is CANNOT TELL, not healthy', () => {
  assert.equal(autoMergeArmedTooLong({ autoMergeRequest: {} }).state, 'cannot-tell');
  assert.equal(autoMergeArmedTooLong({ autoMergeRequest: { enabledAt: 'banana' } }).state, 'cannot-tell');
});

test('a PR that is not armed is not stalled', () => {
  assert.equal(autoMergeArmedTooLong({ autoMergeRequest: null }).state, 'not-armed');
});

// The notice a merged-elsewhere PR gets. Its marker must be TERMINAL, or the
// next pass re-decides a merge that already happened.
test('the merged-elsewhere notice is terminal and names how it merged', () => {
  const armed = mergedElsewhereNotice({
    commentId: '123', pr: { number: 571, url: 'https://example.com/571' }, mergedAt: '2026-09-03T22:55:28Z', armed: true,
  });
  assert.match(armed.marker, /^merged PR #571 at /);
  assert.equal(markerKind(armed.marker), 'terminal');
  assert.match(armed.body, /auto-merge/i);

  const byHand = mergedElsewhereNotice({
    commentId: '123', pr: { number: 571, url: 'https://example.com/571' }, mergedAt: '2026-09-03T22:55:28Z', armed: false,
  });
  assert.match(byHand.body, /outside this relay/i);
  assert.equal(markerKind(byHand.marker), 'terminal');
});

/*
 * ONE ASYNCHRONOUS READING IS NOT A SETTLED FACT (2026-09-03, task 86bbupfgn).
 *
 * PR #567 read CONFLICTING/DIRTY from two different GitHub endpoints five
 * minutes apart. `git merge-tree --write-tree` said clean, and the real merge
 * brought 16 commits across with zero conflicts. The gate handed the ticket to
 * an agent session — none was watching — so a green, approved PR stopped dead
 * for 17 minutes behind a sentence that was simply false.
 *
 * The cause of GitHub's answer is still unknown and none of this guesses at
 * it. The ticket's leading suspect — a stale computation against the older
 * base GitHub reported (base_sha 0c6f096b while main was at 9b0056e2) — was
 * MEASURED on the real objects and does NOT hold: merge-tree is clean against
 * both commits. So the rule here is only "do not assert what a second source
 * contradicts", which needs no theory of the cause.
 */
const DIRTY_PR = {
  state: 'OPEN',
  isDraft: false,
  mergeable: 'CONFLICTING',
  mergeStateStatus: 'DIRTY',
  statusCheckRollup: [{ name: 'verify', conclusion: 'SUCCESS' }],
};

test('GitHub says DIRTY and git merges cleanly: no conflict is asserted', () => {
  const g = githubGate(DIRTY_PR, { gitCrossCheck: { known: true, conflicts: false, base: 'origin/main', head: '7e990d13' } });
  assert.notEqual(g.action, 'conflict');
  assert.ok(!/the branch conflicts with newer work on main/.test(g.reason),
    'the false sentence from 2026-09-03 must not be reachable when git disagrees');
});

test('...and the disagreement names what each source said', () => {
  const g = githubGate(DIRTY_PR, { gitCrossCheck: { known: true, conflicts: false, base: 'origin/main', head: '7e990d13' } });
  assert.equal(g.disagreement, true);
  assert.match(g.reason, /GitHub reports/, 'it must say what GitHub said');
  assert.match(g.reason, /git merges/, 'and what git said');
  assert.match(g.reason, /origin\/main/);
  assert.match(g.reason, /7e990d13/);
});

/*
 * ...AND THEN IT DOES SOMETHING ABOUT IT (2026-09-04, task 86bbuvcwc).
 *
 * Declining to claim a conflict was right and is untouched above. What was
 * missing is that this disagreement has a KNOWN remedy, so answering `wait`
 * promised a change that was never coming. Measured on PR #585: every check
 * green, `git merge-tree --write-tree` exit 0, GitHub `CONFLICTING`, and the
 * relay printing "auto-merge is armed, GitHub lands it" five times over fifty
 * minutes — while GitHub's own auto-merge refuses to land a PR it has
 * flagged. Dane had said "merge". Nothing was going to happen.
 *
 * The one confirmed cause is `docs/WORK-LOG.md merge=union`: git honours that
 * driver and so does a merge GitHub PERFORMS, but the mergeability GitHub
 * PRECOMPUTES does not. Merging main in and pushing flipped GitHub to
 * MERGEABLE within seconds and the armed merge landed it.
 */
test('the disagreement asks for the catch-up, it does not merely report it', () => {
  const g = githubGate(DIRTY_PR, { gitCrossCheck: { known: true, conflicts: false, base: 'origin/main', head: '7e990d13' } });
  assert.equal(g.action, 'catch-up-locally',
    'a disagreement with a known remedy must ask for the remedy, not for another look');
  assert.ok(!/CANNOT TELL/.test(g.reason),
    'it is no longer a could-not-tell: the relay knows exactly what to do about it');
  assert.match(g.reason, /merges .*into the branch and pushes/,
    'and the reason must say what is about to be done to the branch');
});

test('BREAK-TEST both readings: only GitHub-conflicting AND git-clean asks for a catch-up', () => {
  // The pair of injected readings is the whole decision. Flip either one and
  // the answer must change — a fix that only ever caught up would push merge
  // commits onto branches that genuinely conflict.
  const bothConflict = githubGate(DIRTY_PR, { gitCrossCheck: { known: true, conflicts: true, base: 'origin/main', head: 'abc12345' } });
  assert.equal(bothConflict.action, 'conflict',
    'GitHub CONFLICTING + git CONFLICTING is a real conflict and must still refuse');
  assert.match(bothConflict.reason, /GitHub and git agree/);

  const cannotAsk = githubGate(DIRTY_PR, { gitCrossCheck: { known: false, why: 'could not fetch the branch' } });
  assert.equal(cannotAsk.action, 'conflict',
    'a cross-check that could not be taken is not permission to push to the branch');

  // DIRTY_PR's rollup is shaped for the conflict branch, which returns before
  // the checks are ever read; a PR that gets PAST that branch needs a real
  // completed check or it reads as still-running.
  const githubHappy = githubGate({
    ...DIRTY_PR,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    statusCheckRollup: [{ name: 'verify', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  }, { gitCrossCheck: { known: true, conflicts: false, base: 'origin/main', head: '7e990d13' } });
  assert.equal(githubHappy.action, 'merge',
    'a PR GitHub is happy with must never be pushed to on the strength of a cross-check');
});

test('a branch needing the local catch-up is TERMINAL to an in-pass wait, never polled out', () => {
  // Same reasoning as `update-branch`: no amount of polling makes a branch
  // catch itself up, so waiting out the budget on it can only end in a
  // wrong-reason answer — "CI was still running" about a branch whose CI was
  // fine.
  const gate = githubGate(DIRTY_PR, { gitCrossCheck: { known: true, conflicts: false, base: 'origin/main', head: '7e990d13' } });
  const next = afterCatchUpDecision({ gate, elapsedMs: 0, budgetMs: 999_999 });
  assert.equal(next.action, 'catch-up-locally', 'it must go straight back to the caller that owns the remedy');
  assert.equal(next.disagreement, true, 'and keep saying which finding it came from');
  assert.ok(next.reason, 'and say why');
});

test('the relay performs the catch-up on the disagreement, and says so on the ticket', (t) => {
  if (skipWithoutDoor(t)) return;
  const src = doorSource() || '';

  const from = src.indexOf("if (gate.action === 'catch-up-locally') {");
  assert.ok(from > -1, 'the relay must handle the action the gate now returns');
  const block = src.slice(from, src.indexOf("if (gate.action === 'update-branch') {", from));

  assert.match(block, /branchCatchUp\.catchUpBranchLocally\(/,
    'it must actually perform the catch-up, not only report the disagreement');
  assert.match(block, /comment_text:/,
    'a branch caught up automatically is not a silent write — it is announced on the ticket');
  assert.match(block, /CODES\.REAL_CONFLICT/,
    'and a catch-up that finds a REAL conflict must still hand off');
  assert.match(block, /if \(dryRun\)/,
    'a dry run must never push anything');
  assert.ok(!/--force/.test(block), 'it never force-pushes');
});

test('a GENUINE conflict still hands off, and is still never resolved by the script', () => {
  const g = githubGate(DIRTY_PR, { gitCrossCheck: { known: true, conflicts: true, base: 'origin/main', head: 'abc12345' } });
  assert.equal(g.action, 'conflict');
  assert.match(g.reason, /GitHub and git agree/);
});

/*
 * The cross-check failing is CANNOT TELL, and CANNOT TELL is not permission to
 * merge. The hand-off still happens — an unconfirmed conflict is not something
 * to merge either — but the sentence stops asserting a cause it never read.
 */
test('no cross-check available: it still hands off, but claims only what it read', () => {
  const g = githubGate(DIRTY_PR);
  assert.equal(g.action, 'conflict', 'an unverified conflict is still not a merge');
  assert.equal(g.needsGitCrossCheck, true, 'and the caller is told a second opinion is worth taking');
  assert.match(g.reason, /GitHub reports this branch as CONFLICTING/);
  assert.ok(!/^the branch conflicts with newer work on main$/.test(g.reason));
});

test('a cross-check that FAILED is reported as failed, not as clean', () => {
  const g = githubGate(DIRTY_PR, { gitCrossCheck: { known: false, why: 'could not fetch the branch' } });
  assert.equal(g.action, 'conflict');
  assert.match(g.reason, /could not be consulted \(could not fetch the branch\)/);
});

test('DIRTY without CONFLICTING is treated the same way — it is the same computation', () => {
  const pr = { ...DIRTY_PR, mergeable: 'MERGEABLE', mergeStateStatus: 'DIRTY' };
  const g = githubGate(pr, { gitCrossCheck: { known: true, conflicts: false, base: 'origin/main', head: 'aa11bb22' } });
  assert.equal(g.action, 'catch-up-locally');
  assert.match(g.reason, /DIRTY/);
});

// Imported as a namespace rather than destructured: these tests assert on the
// module's own exported constant as well as its function, and reading the
// source file back is part of pinning the measurement.
const mergeOnComment = require('./mergeOnComment.js');
const fs = require('node:fs');
const path = require('node:path');

// ── The CANNOT TELL bound (2026-09-04, task 86bbuvd50) ───────────────────────
//
// THE BUG. A CANNOT TELL is a correct verdict, and the relay repeated it every
// ten minutes forever while saying "the next pass asks again". On 2026-09-04
// three pull requests each sat that way for over two hours — #596, #592 and
// #563 — and each needed an agent session to catch the branch up. A permanent
// block was indistinguishable from a momentary one, and one of them latched the
// whole auto-merge lane off.
//
// The threshold is MEASURED; the table and the empty 54m..2h07m gap it came
// from are on CANNOT_TELL_STALE_MS.

const CT = { isCannotTell: true, verdict: 'GITHUB AND GIT DISAGREE — CANNOT TELL' };
const T0 = 1_700_000_000_000;
const MIN = 60_000;

test('a fresh cannot-tell starts a run and does NOT escalate', () => {
  const out = mergeOnComment.cannotTellRun({ prev: null, ...CT, now: T0 });
  assert.equal(out.state, 'new');
  assert.equal(out.escalate, false, 'the first sighting is an ordinary wait, not an alarm');
  assert.equal(out.next.passes, 1);
  assert.equal(out.next.firstSeenAt, T0);
  assert.equal(out.next.escalatedAt, null);
});

test('an ordinary wobble under the threshold never escalates', () => {
  // The direction that matters most: a bound that fires early turns every
  // ordinary wait into an alarm and teaches everyone to ignore it. The longest
  // run that EVER cleared on its own was 54 minutes, so 54 must stay silent.
  let prev = null;
  for (const mins of [0, 10, 20, 30, 40, 54]) {
    const out = mergeOnComment.cannotTellRun({ prev, ...CT, now: T0 + mins * MIN });
    assert.equal(out.escalate, false, `escalated at ${mins}m — the measured self-clearing ceiling is 54m`);
    prev = out.next;
  }
});

test('past the threshold it escalates exactly once, then goes quiet', () => {
  // The ticket's own acceptance criterion: "a sixth, seventh and eighth
  // identical pass produce no further post".
  let prev = mergeOnComment.cannotTellRun({ prev: null, ...CT, now: T0 }).next;
  const at = mergeOnComment.cannotTellRun({ prev, ...CT, now: T0 + 95 * MIN });
  assert.equal(at.state, 'escalate');
  assert.equal(at.escalate, true);
  assert.match(at.reason, /1h 35m/, 'it must say how long, in the operator\'s units');
  assert.match(at.reason, /GITHUB AND GIT DISAGREE/, 'and quote the verdict verbatim');
  assert.match(at.reason, /nothing was merged, refused or cancelled/i,
    'it must say it changed no merge decision — the ticket\'s non-goal, stated where a reader sees it');
  assert.ok(at.next.escalatedAt, 'the escalation must be recorded, or it repeats forever');

  let prev2 = at.next;
  for (const mins of [105, 115, 125, 200, 600]) {
    const later = mergeOnComment.cannotTellRun({ prev: prev2, ...CT, now: T0 + mins * MIN });
    assert.equal(later.escalate, false, `posted again at ${mins}m — one escalation, then silence`);
    assert.equal(later.state, 'quiet');
    prev2 = later.next;
  }
});

// ── What counts as "the same verdict" (review round 1) ─────────────────────
//
// THE SECOND BUG, and it hid inside the fix for the first. The rule shipped
// comparing the reason PROSE, which is right in spirit and wrong in grain:
// GitHub rewords a cannot-tell mid-block, so the clock restarted every time it
// did and ninety minutes was never reached. Replayed over the relay's own log
// the bound escalated on ONE of the three blocks that actually needed hands.
// A block is one pull request stuck on one commit; the wording is GitHub's
// polling state, not a new fact.

const SAME = { pr: 606, headSha: 'a6f52c23' };
const COMPUTING = 'CANNOT TELL yet — GitHub is still computing whether the branch merges cleanly';

test('THE SEND-BACK: a REWORDED verdict on the same commit is the SAME block', () => {
  // 86bbpz1hu alternated between these two wordings eight times in thirteen
  // passes. Its longest unbroken streak of one wording was about thirty
  // minutes, so under the prose grain the clock never got a third of the way.
  let prev = null;
  const wordings = [CT.verdict, COMPUTING, CT.verdict, CT.verdict, COMPUTING, CT.verdict, COMPUTING];
  wordings.forEach((verdict, i) => {
    const out = mergeOnComment.cannotTellRun({
      prev, verdict, isCannotTell: true, identity: SAME, now: T0 + i * 10 * MIN,
    });
    if (i) assert.notEqual(out.state, 'new', `pass ${i + 1} restarted the run on a reword — that IS the defect`);
    assert.equal(out.next.firstSeenAt, T0, 'the clock must keep running through a reword');
    assert.equal(out.next.passes, i + 1);
    prev = out.next;
  });
  assert.equal(prev.reason, COMPUTING, 'and the NEWEST wording is what gets quoted, not the first');
  assert.equal(prev.rewordings, 5, 'while the rewordings are counted, because that IS the diagnosis');
});

test('a NEW HEAD COMMIT is a new block: the clock restarts and may escalate on its own merits', () => {
  // Criterion 4, read at the grain that survives production. A push is a
  // genuinely new wall — GitHub has a new commit to make its mind up about,
  // and "stuck for two hours" is no longer true of it.
  const first = mergeOnComment.cannotTellRun({ prev: null, ...CT, identity: SAME, now: T0 });
  const pushed = mergeOnComment.cannotTellRun({
    prev: first.next, ...CT, identity: { pr: 606, headSha: 'ff00ff00' }, now: T0 + 200 * MIN,
  });
  assert.equal(pushed.state, 'new', 'a different commit is a different fact');
  assert.equal(pushed.escalate, false);
  assert.equal(pushed.next.firstSeenAt, T0 + 200 * MIN, 'the clock restarts from the push');
  assert.equal(pushed.next.passes, 1);

  const later = mergeOnComment.cannotTellRun({
    prev: pushed.next, ...CT, identity: { pr: 606, headSha: 'ff00ff00' }, now: T0 + 300 * MIN,
  });
  assert.equal(later.escalate, true, 'the new run escalates on its own merits');
});

test('a DIFFERENT PULL REQUEST on the same ticket is a new block', () => {
  // A ticket whose PR was closed and reopened under a new number has been
  // stuck for one pass, not two hours.
  const first = mergeOnComment.cannotTellRun({ prev: null, ...CT, identity: SAME, now: T0 });
  const reopened = mergeOnComment.cannotTellRun({
    prev: { ...first.next, escalatedAt: T0 + 90 * MIN },
    ...CT, identity: { pr: 607, headSha: 'a6f52c23' }, now: T0 + 200 * MIN,
  });
  assert.equal(reopened.state, 'new');
  assert.equal(reopened.next.escalatedAt, null, 'the old escalation must not silence the new block');
});

test('AN UNKNOWN COMMIT NEVER ENDS A RUN — a read that failed is not a new wall', () => {
  // The ticket's own "a rate-limited read". A pass that could not reach GitHub
  // has no SHA to compare; treating that as a new block would restart the
  // clock every time GitHub throttled us, which is this bug wearing a hat.
  const first = mergeOnComment.cannotTellRun({ prev: null, ...CT, identity: SAME, now: T0 });
  const blind = mergeOnComment.cannotTellRun({
    prev: first.next, isCannotTell: true, verdict: 'could not read the PR',
    identity: { pr: 606, headSha: null }, now: T0 + 10 * MIN,
  });
  assert.equal(blind.state, 'holding', 'an unreadable pass continues the run it cannot see past');
  assert.equal(blind.next.headSha, 'a6f52c23', 'and carries the identity forward rather than erasing it');

  const back = mergeOnComment.cannotTellRun({
    prev: blind.next, ...CT, identity: SAME, now: T0 + 95 * MIN,
  });
  assert.equal(back.escalate, true, 'so the run still reaches the threshold on the far side of the outage');
});

test('an OLD RECORD written before the commit was stored keeps counting', () => {
  // The upgrade case: a run persisted by the previous version has no headSha.
  // Failing toward silence here would mute every run in flight when this ships.
  const out = mergeOnComment.cannotTellRun({
    prev: { pr: 606, reason: CT.verdict, firstSeenAt: T0, passes: 8, escalatedAt: null },
    ...CT, identity: SAME, now: T0 + 95 * MIN,
  });
  assert.equal(out.escalate, true, 'a record with no stored commit must continue, not restart');
  assert.equal(out.next.headSha, 'a6f52c23', 'and it adopts the commit it can now see');
});

test('a verdict that clears leaves NO residue', () => {
  const escalated = mergeOnComment.cannotTellRun({
    prev: { reason: CT.verdict, firstSeenAt: T0, passes: 9, escalatedAt: T0 + 95 * MIN },
    ...CT, now: T0 + 120 * MIN,
  });
  assert.equal(escalated.state, 'quiet');

  const cleared = mergeOnComment.cannotTellRun({
    prev: escalated.next, isCannotTell: false, verdict: '', now: T0 + 130 * MIN,
  });
  assert.equal(cleared.state, 'clear');
  assert.equal(cleared.next, null, 'a resolved block must not leave the next one half-way to an alarm');
  assert.equal(cleared.escalate, false);

  const fresh = mergeOnComment.cannotTellRun({ prev: cleared.next, ...CT, now: T0 + 140 * MIN });
  assert.equal(fresh.escalate, false, 'the next block starts from zero');
  assert.equal(fresh.next.passes, 1);
});

test('an unreadable stored timestamp restarts the clock rather than disabling the alarm', () => {
  // Reading a missing timestamp as "just started, forever" makes the alarm
  // unreachable — this ticket's own bug one level up, and the exact defect
  // task 86bbu60ax found in the claim reader the same day.
  for (const bad of [undefined, null, 'not-a-date', NaN]) {
    const out = mergeOnComment.cannotTellRun({
      prev: { reason: CT.verdict, firstSeenAt: bad, passes: 4, escalatedAt: null },
      ...CT, now: T0,
    });
    assert.equal(out.state, 'new', `firstSeenAt ${String(bad)} must restart, not stall`);
    assert.equal(out.next.firstSeenAt, T0);
    assert.equal(out.next.escalatedAt, null, 'and must stay reachable on a later pass');
  }
});

/**
 * THE REPLAY. The test the send-back asked for, and the only one that could
 * have caught the prose grain.
 *
 * These are the real pass sequences out of `~/Library/Logs/bus-relay-launchd.log`
 * on the Mini — minutes from the block's first reading, and which of the two
 * wordings GitHub gave on that pass. `null` is a reading that was NOT a
 * cannot-tell, which is what ENDS a block. Nothing here is invented or
 * rounded: every synthetic fixture in this file repeats one string verbatim,
 * and the real log never does, which is exactly why the defect survived eight
 * break-tests.
 *
 * The three long blocks each needed an agent session to unstick. The short one
 * cleared itself in 53 minutes and must stay silent — it is the closest any
 * self-clearing run has ever come to the 90-minute threshold, so it is the
 * real-data guard on the noisy direction.
 */
/**
 * THE FIXTURE IS DERIVED FROM `githubGate`, NEVER TYPED OUT (review round 2 of
 * task 86bbuvd50). The first version of this replay pasted the wordings out of
 * the relay log, and PR #597 had already changed one of them in the code —
 * so the test proved the decision function correct about a population
 * production no longer produces, while the real thing said nothing for two and
 * a half hours. Asking the gate means a future rewording moves the fixture
 * with it, and a change in CLASSIFICATION fails this test instead of hiding.
 *
 * The two readings are the two GitHub actually gives inside a stuck block:
 * CONFLICTING while git merges it cleanly (84 of the 106 classifiable lines in
 * the measured log) and mergeability still being computed (the other 22).
 * `SETTLED` is an ordinary CI wait — a reading that WAS taken — which is what
 * ends a block.
 */
const gateVerdict = (pr, opts) => githubGate(pr, opts);
const DISAGREEING = gateVerdict(
  { state: 'OPEN', isDraft: false, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', statusCheckRollup: [] },
  { gitCrossCheck: { known: true, conflicts: false, base: 'origin/main', head: '4dd9729b' } },
);
const STILL_COMPUTING = gateVerdict(
  { state: 'OPEN', isDraft: false, mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN', statusCheckRollup: [] },
);
const SETTLED = gateVerdict(
  { state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED',
    statusCheckRollup: [{ name: 'verify', status: 'IN_PROGRESS' }] },
);

test('the two verdicts the replay is built from are the ones the log actually holds', () => {
  // If either of these stops being what production emits, the replay below is
  // measuring something else and this says so first.
  assert.equal(DISAGREEING.action, 'catch-up-locally');
  assert.match(DISAGREEING.reason, /GitHub reports this branch as CONFLICTING, but git merges/);
  assert.equal(mergeOnComment.verdictCannotTell(DISAGREEING), true,
    'the dominant verdict must classify as a cannot-tell — it is 84 of the 106 measured lines');
  assert.equal(STILL_COMPUTING.action, 'wait');
  assert.equal(mergeOnComment.verdictCannotTell(STILL_COMPUTING), true);
  assert.equal(SETTLED.action, 'wait');
  assert.equal(mergeOnComment.verdictCannotTell(SETTLED), false,
    'a routine CI wait is a reading, and counting it would widen the measured population');
  // THE DEFECT ITSELF, pinned. PR #597 deleted the `CANNOT TELL — ` prefix
  // from the dominant verdict, which silently unhooked the prose-matching
  // classifier this replaced. The classification must NOT depend on it.
  assert.ok(!/CANNOT TELL/.test(DISAGREEING.reason),
    'the dominant verdict no longer carries the marker — that is the whole defect, and it must stay pinned here');
});
const REAL_BLOCKS = [
  // The ONE block the prose grain did catch, and this row says why: its first
  // twelve passes are the same wording, so the old clock survived to 90m. The
  // other two reworded before then, which is the whole defect in one column.
  { ticket: '86bbugcpa', pr: 592, sha: '65debd98', needed: 'an agent session', escalations: 1, rewordedBySpeaking: false,
    passes: [[0, null], [22, 1], [33, 1], [43, 1], [54, 1], [64, 1], [75, 1], [86, 1], [96, 1], [106, 1],
      [117, 1], [128, 1], [138, 2], [149, 2], [160, 2], [170, 1], [181, 1]] },
  { ticket: '86bbuvcwc', pr: 597, sha: '4dd9729b', needed: 'an agent session', escalations: 1, rewordedBySpeaking: true,
    passes: [[0, null], [21, 1], [32, 1], [42, 1], [53, 1], [64, 1], [74, 1], [85, 1], [95, 1], [106, 2],
      [117, 2], [127, 2], [138, 1], [148, 1], [159, 2], [169, 1], [180, 1], [190, null]] },
  { ticket: '86bbpz1hu', pr: 563, sha: 'a6f52c23', needed: 'an agent session', escalations: 1, rewordedBySpeaking: true,
    passes: [[0, null], [21, 1], [32, 1], [43, 1], [53, 2], [64, 1], [75, 2], [85, 2], [96, 1], [106, 1],
      [117, 2], [127, 1], [138, 1], [148, 2], [159, null]] },
  { ticket: '86bbtqpxd', pr: 596, sha: '0b5545f9', needed: 'nothing — it cleared itself', escalations: 0,
    passes: [[0, null], [11, 1], [22, 1], [33, 2], [43, 1], [54, 1], [64, 2]] },
];

test('REPLAYED OVER THE REAL RELAY LOG: every block that needed hands escalates exactly once', () => {
  for (const block of REAL_BLOCKS) {
    let prev = null;
    const posts = [];
    for (const [mins, wording] of block.passes) {
      const gate = wording === null ? SETTLED : (wording === 1 ? DISAGREEING : STILL_COMPUTING);
      const verdict = gate.reason;
      const run = mergeOnComment.cannotTellRun({
        prev,
        verdict,
        isCannotTell: mergeOnComment.verdictCannotTell(gate),
        // Production reads the commit out of `gh pr view --json headRefOid`,
        // so it is known on EVERY pass — including the "still computing" ones,
        // whose prose does not mention it.
        identity: { pr: block.pr, headSha: block.sha },
        now: T0 + mins * MIN,
      });
      if (run.escalate) posts.push({ mins, reason: run.reason, quoted: verdict });
      prev = run.next;
    }
    assert.equal(posts.length, block.escalations,
      `${block.ticket} (needed ${block.needed}) escalated ${posts.length} time(s), expected ${block.escalations}`);
    if (block.escalations) {
      assert.ok(posts[0].mins >= 90, `${block.ticket} escalated at ${posts[0].mins}m — before the threshold`);
      assert.ok(posts[0].mins <= 130, `${block.ticket} took ${posts[0].mins}m to speak — far past the threshold`);
      // VERBATIM, and the string comes from the GATE rather than from this
      // file — so the message must quote whatever wording production emits
      // today, not the one the log happened to hold in September.
      assert.ok(posts[0].reason.includes(posts[0].quoted),
        `${block.ticket}: the message must quote the verdict it is stuck on, verbatim`);
      // The message must not CLAIM a verbatim repeat where the log shows a
      // reworded one — a reader opening that log would catch it out.
      if (block.rewordedBySpeaking) {
        assert.match(posts[0].reason, /reworded itself \d+ time/,
          `${block.ticket} reworded before the bound spoke; the message must say so`);
      } else {
        assert.match(posts[0].reason, /answered the same way/,
          `${block.ticket} really did repeat itself verbatim; the message must not invent a reword`);
      }
    }
  }
});

test('the threshold sits in the measured gap, and the measurement is written down', () => {
  // The number is load-bearing and was picked from real data. If someone
  // changes it, they must move it deliberately and re-measure.
  assert.equal(mergeOnComment.CANNOT_TELL_STALE_MS, 90 * 60 * 1000);
  const src = fs.readFileSync(path.join(__dirname, 'mergeOnComment.js'), 'utf8');
  assert.match(src, /86bbugcpa\s+16 lines/, 'the measured table must stay beside the constant');
  assert.match(src, /Nothing sits between 54 minutes and 2h07m/,
    'the gap that chose the threshold is the justification and must not be deleted');
  assert.match(src, /DO NOT UNIFY THIS WITH/,
    'the coincidence with the stranded clock must stay flagged, or someone will tidy them into one');
});

test('the bound never changes a merge decision — the ticket\'s non-goals', () => {
  // It must not claim a conflict, refuse a merge, or cancel auto-merge. The
  // function returns a report and a stored counter, and nothing else.
  const out = mergeOnComment.cannotTellRun({
    prev: { reason: CT.verdict, firstSeenAt: T0, passes: 9, escalatedAt: null },
    ...CT, now: T0 + 200 * MIN,
  });
  assert.equal(out.escalate, true);
  for (const key of ['action', 'refuse', 'conflict', 'cancel', 'merge']) {
    assert.ok(!(key in out), `cannotTellRun returned "${key}" — it must not influence the merge decision`);
  }
});

// ── The wiring half of task 86bbuvd50 ──────────────────────────────────────
//
// The decision function above shipped in PR #604 and the relay did not call
// it, so the loop was still unbounded in production. These are the tests that
// stop that shipping inert a second time.

test('verdictCannotTell asks the VERDICT, never its prose', () => {
  assert.equal(mergeOnComment.verdictCannotTell({ action: 'wait', cannotTell: true, reason: 'anything at all' }), true);
  assert.equal(mergeOnComment.verdictCannotTell({ action: 'wait', cannotTell: false, reason: 'anything at all' }), false);
  // THE ROUND-2 DEFECT, stated as an assertion. A verdict whose sentence
  // shouts CANNOT TELL but whose classification says otherwise is classified
  // by the field — and, the direction that actually bit, a verdict that
  // classifies as a cannot-tell while its sentence never says so is counted.
  assert.equal(mergeOnComment.verdictCannotTell(
    { action: 'refuse', cannotTell: false, reason: 'CANNOT TELL — a sentence that lies about itself' }), false);
  assert.equal(mergeOnComment.verdictCannotTell(
    { action: 'catch-up-locally', cannotTell: true, reason: 'GitHub reports this branch as CONFLICTING, but git merges it cleanly' }), true);
  // An UNDECLARED field is not a cannot-tell, which is silent by
  // construction — `Boolean(undefined)` is `false`. That is exactly why the
  // source assertion below exists rather than a runtime throw: a relay pass
  // must not crash over a missing field, so the gate is held at the source.
  for (const nothing of [null, undefined, {}, { action: 'wait' }, 0, '']) {
    assert.equal(mergeOnComment.verdictCannotTell(nothing), false, `${JSON.stringify(nothing)} declares nothing`);
  }
});

test('EVERY githubGate return declares cannotTell — the assertion that would have caught #597', () => {
  // The classification lives where the verdict is MADE. A new branch of the
  // gate that forgets the field would not be a syntax error and no
  // behavioural test would catch it (`Boolean(undefined)` is false, so it
  // would simply never be counted) — which is precisely how PR #597 unhooked
  // 84 of the 106 measured lines by rewording a sentence.
  const src = fs.readFileSync(path.join(__dirname, 'mergeOnComment.js'), 'utf8');
  const start = src.indexOf('function githubGate(');
  assert.ok(start > 0, 'githubGate must be findable in the source');
  const end = src.indexOf('\n}\n', src.indexOf('unreadableMergeState', start));
  assert.ok(end > start, 'the end of githubGate must be findable');
  const body = src.slice(start, end);

  // Every `return {` in the function, with the object literal that follows it.
  const returns = [];
  let i = body.indexOf('return {');
  while (i !== -1) {
    let depth = 0;
    let j = body.indexOf('{', i);
    const from = j;
    for (; j < body.length; j += 1) {
      if (body[j] === '{') depth += 1;
      else if (body[j] === '}') { depth -= 1; if (depth === 0) break; }
    }
    returns.push(body.slice(from, j + 1));
    i = body.indexOf('return {', j);
  }
  assert.ok(returns.length >= 17,
    `only ${returns.length} returns found in githubGate — the scan is not seeing the function`);
  for (const literal of returns) {
    assert.match(literal, /\bcannotTell: (true|false)\b/,
      'a githubGate return that leaves the cannot-tell question unanswered:\n  '
      + `${literal.replace(/\s+/g, ' ').slice(0, 160)}`);
  }
});

test('the gate classifies the real population, and nothing wider', () => {
  const open = { state: 'OPEN', isDraft: false, statusCheckRollup: [{ name: 'verify', status: 'COMPLETED', conclusion: 'SUCCESS' }] };
  const cannotTells = [
    // The two the threshold was measured on.
    [githubGate({ ...open, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' },
      { gitCrossCheck: { known: true, conflicts: false, base: 'origin/main', head: 'aa11' } }), 'GitHub and git disagree'],
    [githubGate({ ...open, mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }), 'mergeability still computing'],
    // Terminal refusals that could not name what they saw. They never reach
    // the bound — a refusal is not a wait that repeats — but the field says
    // what was read, not what happens next.
    [githubGate({ ...open, mergeable: 'MERGEABLE', mergeStateStatus: 'UNSTABLE' }), 'UNSTABLE with every check green'],
    [githubGate({ ...open, mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED' }), 'BLOCKED with no rule named'],
    [githubGate({ ...open, mergeable: 'MERGEABLE', mergeStateStatus: 'WHAT_IS_THIS' }), 'a merge state the gate cannot read'],
  ];
  for (const [gate, what] of cannotTells) {
    assert.equal(mergeOnComment.verdictCannotTell(gate), true, `${what} must classify as a cannot-tell`);
  }

  // AND NOTHING WIDER. A threshold measured on one population and applied to
  // a larger one is the calibration error the ticket named in the loud
  // direction: an alarm on every routine six-minute CI wait teaches everyone
  // to ignore it, which is the silent failure wearing a louder coat.
  const readings = [
    [githubGate({ ...open, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }), 'a mergeable PR'],
    [githubGate({ ...open, mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND' }), 'behind main'],
    [githubGate({ ...open, mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' }), 'a named protection rule'],
    [githubGate({ ...open, statusCheckRollup: [{ name: 'verify', status: 'IN_PROGRESS' }], mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED' }), 'checks still running'],
    [githubGate({ ...open, statusCheckRollup: [{ name: 'verify', status: 'COMPLETED', conclusion: 'FAILURE' }], mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED' }), 'checks red'],
    [githubGate({ ...open, statusCheckRollup: [], mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }), 'no checks at all'],
    [githubGate({ ...open, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' },
      { gitCrossCheck: { known: true, conflicts: true, base: 'origin/main', head: 'aa11' } }), 'a conflict both sources agree on'],
    [githubGate({ state: 'MERGED' }), 'already merged'],
    [githubGate({ state: 'CLOSED' }), 'closed'],
    [githubGate({ state: 'OPEN', isDraft: true }), 'a draft'],
    [githubGate({ ...open, mergeable: 'MERGEABLE', mergeStateStatus: 'DRAFT' }), 'GitHub still says draft'],
  ];
  for (const [gate, what] of readings) {
    assert.equal(mergeOnComment.verdictCannotTell(gate), false, `${what} IS a reading and must not be counted`);
  }
});

test('a verdict carried through afterCatchUpDecision keeps its classification', () => {
  // A FIELD DROPPED ON A REASSIGNMENT is how the 86bbtqpxd refusal-code
  // defect worked — silently, with every test still passing. The same shape
  // applies here, and on this path it would take the bound straight back to
  // never firing.
  const disagreeing = githubGate(
    { state: 'OPEN', isDraft: false, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', statusCheckRollup: [] },
    { gitCrossCheck: { known: true, conflicts: false, base: 'origin/main', head: 'aa11' } },
  );
  const carried = mergeOnComment.afterCatchUpDecision({ gate: disagreeing, elapsedMs: 0, budgetMs: 1000 });
  assert.equal(carried.action, 'catch-up-locally');
  assert.equal(mergeOnComment.verdictCannotTell(carried), true,
    'the disagreement must survive the in-pass wait, or every catch-up path stops counting');

  // Running out of budget does not turn an unreadable PR into a readable one.
  const timedOut = mergeOnComment.afterCatchUpDecision({
    gate: githubGate({ state: 'OPEN', isDraft: false, mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN', statusCheckRollup: [] }),
    elapsedMs: 999_999,
    budgetMs: 1000,
  });
  assert.equal(timedOut.action, 'wait');
  assert.equal(mergeOnComment.verdictCannotTell(timedOut), true);

  // ...and an ordinary CI wait that times out is still an ordinary wait.
  const ordinary = mergeOnComment.afterCatchUpDecision({
    gate: githubGate({ state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED',
      statusCheckRollup: [{ name: 'verify', status: 'IN_PROGRESS' }] }),
    elapsedMs: 999_999,
    budgetMs: 1000,
  });
  assert.equal(mergeOnComment.verdictCannotTell(ordinary), false);
});

test('the escalation says the four things the ticket asked for', () => {
  const decision = mergeOnComment.cannotTellRun({
    prev: { reason: 'CANNOT TELL — github and git disagree', firstSeenAt: 1_700_000_000_000, passes: 8, escalatedAt: null },
    verdict: 'CANNOT TELL — github and git disagree',
    isCannotTell: true,
    now: 1_700_000_000_000 + 127 * 60_000,
  });
  assert.equal(decision.escalate, true);
  const { body, bus } = mergeOnComment.cannotTellEscalation({
    label: '"A stuck ticket" (86bbuvd50)',
    taskUrl: 'https://app.clickup.com/t/86bbuvd50',
    pr: 604,
    prUrl: 'https://github.com/mentor24-maker/starcaster/pull/604',
    decision,
    node: 'mac-mini',
    at: '9:14pm',
  });
  for (const text of [body, bus]) {
    assert.match(text, /2h 7m/, 'the elapsed time');
    assert.match(text, /9 pass\(es\)/, 'the count');
    assert.match(text, /"CANNOT TELL — github and git disagree"/, 'the verdict VERBATIM, not a summary');
    assert.match(text, /mac-mini/, 'the machine');
    assert.match(text, /bus-relay merge step/, 'the actor');
  }
  assert.match(body, /PR #604/);
  assert.ok(bus.includes('https://github.com/mentor24-maker/starcaster/pull/604'), 'the bus line links the PR');
  assert.ok(bus.includes('https://app.clickup.com/t/86bbuvd50'), 'and the ticket');
});

test('the escalation states what it did NOT do, both surfaces', () => {
  // Every non-goal is something a reader will otherwise assume happened. An
  // automated note that lets the reader infer a merge decision it never made
  // is the 86bbqw49y defect.
  const decision = {
    reason: 'This pull request has answered the same way for 1h 40m across 6 pass(es) and has not moved: "x". '
      + 'Nothing was merged, refused or cancelled by this message.',
    heldMs: 100 * 60_000,
  };
  const { body } = mergeOnComment.cannotTellEscalation({ label: 'L', decision, node: 'mac-mini' });
  assert.match(body, /Nothing was merged, refused or cancelled/);
  assert.match(body, /Auto-merge is exactly as it was/);
  assert.doesNotMatch(body, /Nothing was merged, refused or cancelled[\s\S]*Nothing was merged, refused or cancelled/,
    'said once, not twice — the sentence is the decision function\'s and must not be duplicated around it');
});

test('an escalation with nothing to name still names the machine gap out loud', (t) => {
  if (skipWithoutDoor(t)) return;
  const { body, bus } = mergeOnComment.cannotTellEscalation({
    label: 'L', decision: { reason: 'stuck', heldMs: 1 },
  });
  assert.match(body, /on an unnamed machine/, 'an unknown machine is stated, never silently omitted');
  assert.match(bus, /on an unnamed machine/);
  assert.match(body, /this pull request/, 'and a missing PR number reads as prose, not "PR #undefined"');
});

// ── Source assertions: this must not ship inert ────────────────────────────

const RELAY_SRC = doorSource() || '';

test('the relay actually CALLS the bound — the whole defect of the first slice', (t) => {
  if (skipWithoutDoor(t)) return;
  assert.match(RELAY_SRC, /mergeOnComment\.cannotTellRun\(/,
    'the decision function shipped once already with no caller; a bound nothing calls is the bug it fixes');
  assert.match(RELAY_SRC, /cannotTellEscalation\(/, 'and the escalation must be built');
  assert.match(RELAY_SRC, /ledgerAfterCannotTell\(/, 'and the run must be persisted, or it resets every pass');
});

test('EVERY waiting verdict the merge step returns answers the cannot-tell question', (t) => {
  if (skipWithoutDoor(t)) return;
  // A new waiting path that forgets the field is not a syntax error and no
  // behavioural test would catch it: `Boolean(undefined)` is false, so the
  // path would simply never be counted, silently, forever. That is this
  // ticket's own bug reappearing through a route it did not cover.
  const waits = RELAY_SRC.split('\n').filter((l) => l.includes("outcome: 'waiting'"));
  assert.ok(waits.length >= 9, `expected the merge step's waiting returns, found ${waits.length}`);
  for (const line of waits) {
    assert.ok(/cannotTell:/.test(line), `a waiting return with no cannotTell verdict:\n  ${line.trim()}`);
    assert.ok(/pr:/.test(line), `a waiting return that does not name its PR:\n  ${line.trim()}`);
    // AND THE COMMIT IT IS STUCK ON (review round 1). A waiting path that
    // forgets this is not a syntax error either: an undefined SHA reads as
    // "unknown", which continues whatever run is stored, so the bound would
    // silently key on the wrong thing instead of failing.
    assert.ok(/headSha:/.test(line), `a waiting return that does not name its head commit:\n  ${line.trim()}`);
    // AND IT MAY NOT CLASSIFY BY PROSE (review round 2). The whole defect was
    // a substring match on a sentence the code had stopped saying. The only
    // three forms allowed here are the verdict's own field, a literal the
    // author had to type deliberately, and `true` from a path that KNOWS no
    // reading was taken.
    assert.ok(/cannotTell: (mergeOnComment\.verdictCannotTell\(|true\b|false\b)/.test(line),
      `a waiting return that classifies by something other than the verdict:\n  ${line.trim()}`);
  }
  assert.ok(!/readsAsCannotTell/.test(RELAY_SRC),
    'the prose-matching classifier must not come back — it is what made the bound silent in production');
});

test('a waiting return after a PUSH reads the FRESH head commit, not the stale one', (t) => {
  if (skipWithoutDoor(t)) return;
  // Review round 2, finding 3. `prJson` was read BEFORE the catch-up push, so
  // its commit is one behind the branch that now exists — and the next pass
  // would see a "different" block and restart the ninety-minute clock, once
  // per catch-up. With PR #597 performing catch-ups routinely, that alone
  // would keep the bound out of reach.
  //
  // BREAK-TEST: put `prJson.headRefOid` back on either post-push wait and
  // this fails.
  const pushed = RELAY_SRC.split('\n').filter((l) => l.includes("outcome: 'waiting'") && /reason: (after|next)\.reason/.test(l));
  assert.equal(pushed.length, 3,
    `expected the three waits that follow a fresh read, found ${pushed.length}`);
  for (const line of pushed) {
    assert.ok(/headSha: headShaOf\(after, prJson\)/.test(line),
      `a wait after a fresh read that stores the STALE commit:\n  ${line.trim()}`);
  }
  // And the helper must actually prefer the fresh read, not merely exist.
  const from = RELAY_SRC.indexOf('function headShaOf(');
  assert.ok(from > 0, 'headShaOf must exist');
  const body = RELAY_SRC.slice(from, RELAY_SRC.indexOf('\n}', from));
  assert.match(body, /fresh && fresh\.prJson && fresh\.prJson\.headRefOid/,
    'it must read the commit off the FRESH read first');
  assert.match(body, /\|\| null/, 'and answer null rather than guessing when neither read has it');
});

test('the relay asks GitHub for the head commit at all', (t) => {
  if (skipWithoutDoor(t)) return;
  // The identity is only as good as the field it is read from. `headRefOid`
  // missing from the --json list makes every reading's SHA undefined, which
  // fails SILENTLY into "unknown" and takes the fix back to the prose grain.
  // MATCHED ON THE FIELD LIST, not on the file. The first version of this
  // assertion looked for `headRefOid` anywhere in the source and passed
  // happily with the field deleted from the --json request, because seven
  // `prJson.headRefOid` reads still mentioned it — an assertion that could
  // not fail, found by break-testing it.
  const fieldList = (RELAY_SRC.match(/const fields = '([^']+)'/) || [])[1] || '';
  assert.ok(fieldList.split(',').includes('headRefOid'),
    `gh pr view is not asked for headRefOid, so every reading's commit is undefined: ${fieldList}`);
  assert.match(RELAY_SRC, /identity: \{ pr: reading\.pr, headSha: reading\.headSha \}/,
    'and hand it to the bound as the block identity');
});

test('LANE A IS BOUNDED TOO — its readings reach the same clock', (t) => {
  if (skipWithoutDoor(t)) return;
  // Review round 1's second finding: `mergeReadings` was fed only from the
  // watch loop, so a PR stuck this way on the auto-merge lane was unbounded.
  // The bound runs twice on purpose — above the lane gate so it stays audible
  // while the lane is halted, and again after the lane so the lane's own
  // readings are counted.
  assert.match(RELAY_SRC, /laneReadings\.push\(/, "Lane A's merge step must record its reading");
  assert.match(RELAY_SRC, /await boundCannotTell\(laneReadings\)/, 'and that reading must reach the bound');
  assert.match(RELAY_SRC, /await boundCannotTell\(mergeReadings\)/, 'while the watch loop stays bounded above the gate');
  const src = RELAY_SRC;
  assert.ok(src.indexOf('await boundCannotTell(mergeReadings)') < src.indexOf('const killSwitch = killSwitchState'),
    'the first call must stay ABOVE the lane gate, or the bound goes deaf exactly when auto-merge is latched off');
});

test('a no-reading outcome is never counted as a verdict that cleared', (t) => {
  if (skipWithoutDoor(t)) return;
  // 'none' means this ticket carried no merge authorization to act on, which
  // says nothing about whether a block is still there. Reading it as "cleared"
  // wiped the run every pass for exactly the tickets Lane A handles — they
  // reach the watch loop with no merge word, which is WHY they are candidates.
  const pushes = RELAY_SRC.split('\n').filter((l) => /outcome !== 'threw'/.test(l));
  assert.ok(pushes.length >= 2, `expected both reading sites to guard on outcome, found ${pushes.length}`);
  for (const line of pushes) {
    assert.ok(/outcome !== 'none'/.test(line), `a reading site that counts 'none' as a reading:\n  ${line.trim()}`);
  }
});

test('a rehearsal does not stamp the escalation clock', (t) => {
  if (skipWithoutDoor(t)) return;
  // `throughput --dry-run` had exactly this defect: a rehearsal muted the real
  // alarm. Here it would spend the one escalation a run is allowed on a
  // message nobody was sent.
  const block = RELAY_SRC.slice(RELAY_SRC.indexOf('The bound on CANNOT TELL'));
  const upToLoopEnd = block.slice(0, block.indexOf('MERGE STUCK escalated on'));
  assert.match(upToLoopEnd, /if \(dryRun\) \{[\s\S]*?would escalate a stuck merge[\s\S]*?continue;/,
    'the dry-run branch must return before any write or any stamp');
});

/*
 * THE DEDUP THE MACHINE STAMP BROKE (2026-09-06, task 86bbvr0j5).
 *
 * `call()` appends the `[machine]` line to every comment it posts, the merge
 * step's own dedup marker included. That line ends "Dane's token — not his
 * word", so the ` — <timestamp>` split below it took the stamp's em-dash: the
 * timestamp was never recovered and the reason came back with the stamp glued
 * on, matching nothing. The dedup stopped working the day the stamp shipped
 * (2026-09-01) and nobody noticed until PR #628 posted the same conflict
 * hand-off seven times in two hours.
 *
 * The fixture is the REAL stored text, copied from comment 90140253038828's
 * reply thread — a hand-written approximation is exactly how this was missed.
 */
const STAMP = "\n\n[machine] posted by a loop under Dane's token — not his word";
const REAL_MARKER = '[merge-on-comment] refused: conflict hand-off on PR #628 — 2026-09-06T17:56:12.369Z' + STAMP;

test('a stamped refusal marker still yields its bare reason', () => {
  const p = parseMergeMarker(REAL_MARKER);
  assert.equal(p.kind, 'refused');
  // Byte-identical to what the next pass compares against, or it goes quiet
  // never and posts forever.
  assert.equal(p.reason, 'conflict hand-off on PR #628');
});

test('a stamped refusal marker still yields its timestamp, so the age clock can run', () => {
  assert.equal(parseMergeMarker(REAL_MARKER).at, '2026-09-06T17:56:12.369Z');
});

test('a stamped MERGED marker is still terminal, so no authorization is re-spent', () => {
  // The direction that must never regress: a spent merge stays spent.
  const merged = '[merge-on-comment] merged PR #628 at 2026-09-06T18:09:15.000Z' + STAMP;
  assert.equal(parseMergeMarker(merged).kind, 'terminal');
});

test('an unstamped marker is unchanged, so markers written before the stamp still read', () => {
  const old = '[merge-on-comment] refused: conflict hand-off on PR #500 — 2026-08-30T11:00:00.000Z';
  const p = parseMergeMarker(old);
  assert.equal(p.reason, 'conflict hand-off on PR #500');
  assert.equal(p.at, '2026-08-30T11:00:00.000Z');
});

test('attempts are counted from the markers already on the thread', () => {
  const replies = [
    { comment_text: REAL_MARKER },
    { comment_text: REAL_MARKER },
    { comment_text: REAL_MARKER },
  ];
  assert.equal(countMergeRefusals(replies, 'conflict hand-off on PR #628'), 3);
});

test('only the markers giving THIS reason count toward the alarm', () => {
  // A PR refused twice for red checks and once for a conflict has not tried
  // the conflict three times, and an alarm saying so sends somebody looking
  // for a problem that is not there.
  const other = '[merge-on-comment] refused: checks are red on PR #628 — 2026-09-06T16:00:00.000Z' + STAMP;
  const replies = [{ comment_text: other }, { comment_text: other }, { comment_text: REAL_MARKER }];
  assert.equal(countMergeRefusals(replies, 'conflict hand-off on PR #628'), 1);
});
