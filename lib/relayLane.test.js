'use strict';

/**
 * relayLane tests, and the three acceptance scenarios of task 86bchpkxz run
 * through the SAME decision chain the `relay` command uses (mergeDecision,
 * then githubGate), with fixtures standing in for ClickUp and GitHub:
 *
 *   1. "merge it" from the operator on a Ready to launch ticket with a green,
 *      mergeable PR → merge.
 *   2. A merge phrase on a ticket whose PR is red, conflicting or unreviewed
 *      → no merge, and the reason names the gate.
 *   3. A comment that is not exactly a merge phrase ("merge PR #4") → nothing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PR_VIEW_FIELDS, markerBookkeeping, recordBookkeeping, emptyBooks, mergeDestination, relayLine,
} = require('./relayLane.js');
const { mergeDecision, githubGate, MERGE_MARKER } = require('./mergeOnComment.js');
const { stampMachineComment } = require('./machineComment.js');

const OPERATOR = 48012725;
const AGENT = 99999999;

let nextId = 1;
function c(t, userId, text) {
  return { id: String(nextId++), date: String(1000 + t), user: { id: userId }, comment_text: text };
}
const PR_URL = 'https://github.com/mentor24-maker/spirality/pull/4';
const prOpened = (t) => c(t, AGENT, `PR opened: ${PR_URL}`);
const reviewPassed = (t) => c(t, AGENT, 'REVIEW: PASSED — verified independently.');
const reviewFailed = (t) => c(t, AGENT, 'REVIEW: sent back to Rework — the test steps do not pass.');

const green = [{ __typename: 'CheckRun', name: 'verify', status: 'COMPLETED', conclusion: 'SUCCESS' }];
const red = [{ __typename: 'CheckRun', name: 'verify', status: 'COMPLETED', conclusion: 'FAILURE' }];
const greenPr = { state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: green };

function decide(comments, status = 'Ready to launch', books = emptyBooks()) {
  return mergeDecision({ status, comments, operatorId: OPERATOR, ...books });
}

// --------------------------------------------------- acceptance scenarios

test('ACCEPTANCE 1: "merge it" on a green, mergeable PR merges in one pass', () => {
  const d = decide([prOpened(1), reviewPassed(2), c(3, OPERATOR, 'merge it')]);
  assert.equal(d.act, 'merge');
  assert.equal(d.pr.number, 4);
  assert.equal(githubGate(greenPr).action, 'merge');
});

test('ACCEPTANCE 2a: a merge phrase on a RED PR is refused, and the reason names the checks', () => {
  const d = decide([prOpened(1), reviewPassed(2), c(3, OPERATOR, 'merge')]);
  assert.equal(d.act, 'merge');
  const g = githubGate({ ...greenPr, statusCheckRollup: red });
  assert.equal(g.action, 'refuse');
  assert.match(g.reason, /checks are red: verify/);
  assert.ok(g.refusalCode, 'a refusal carries the code the notice is classified by');
});

test('ACCEPTANCE 2b: a merge phrase on a CONFLICTING PR is not merged, and the reason says conflict', () => {
  const d = decide([prOpened(1), reviewPassed(2), c(3, OPERATOR, 'ship it')]);
  assert.equal(d.act, 'merge');
  const g = githubGate({ ...greenPr, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' });
  assert.equal(g.action, 'conflict');
  assert.match(g.reason, /CONFLICTING/);
});

test('ACCEPTANCE 2c: a merge phrase on an UNREVIEWED ticket is refused before GitHub is asked', () => {
  const noVerdict = decide([prOpened(1), c(3, OPERATOR, 'approve')]);
  assert.equal(noVerdict.act, 'refuse');
  assert.match(noVerdict.reason, /no review verdict/);

  const sentBack = decide([prOpened(1), reviewFailed(2), c(3, OPERATOR, 'approve')]);
  assert.equal(sentBack.act, 'refuse');
  assert.match(sentBack.reason, /not a PASS/);

  const stale = decide([prOpened(1), c(2, OPERATOR, 'merge'), reviewPassed(3)]);
  assert.equal(stale.act, 'refuse');
  assert.match(stale.reason, /predates/);
});

test('ACCEPTANCE 2d: a merge phrase on a ticket that is not Ready to launch does nothing', () => {
  const d = decide([prOpened(1), reviewPassed(2), c(3, OPERATOR, 'merge')], 'In review');
  assert.equal(d.act, 'ignore');
});

test('ACCEPTANCE 3: "merge PR #4" is not a merge phrase — nothing happens, nothing is posted', () => {
  for (const words of ['merge PR #4', 'merge #4', 'please merge', 'merge it when green', 'Merge PR #4.']) {
    const d = decide([prOpened(1), reviewPassed(2), c(3, OPERATOR, words)]);
    assert.equal(d.act, 'ignore', words);
    assert.match(d.reason, /no unhandled merge command/, words);
  }
});

test('a machine-posted "merge" never authorizes: the stamp makes it more than the phrase', () => {
  const d = decide([prOpened(1), reviewPassed(2), c(3, OPERATOR, stampMachineComment('merge'))]);
  assert.equal(d.act, 'ignore');
});

// ------------------------------------------------------ marker bookkeeping

const reply = (t, text) => ({ id: String(nextId++), date: String(1000 + t), comment_text: stampMachineComment(text) });

test('no replies: nothing handled, nothing refused', () => {
  assert.deepEqual(markerBookkeeping([]), { marker: null, handled: false, refused: null, refusedAt: '', refusedCount: 0 });
  assert.deepEqual(markerBookkeeping(undefined).handled, false);
});

test('a merged marker spends the authorization forever', () => {
  const k = markerBookkeeping([reply(1, `${MERGE_MARKER} merged PR #4 at 2026-10-13T20:00:00.000Z — 2026-10-13T20:00:00.000Z`)]);
  assert.equal(k.handled, true);
  assert.equal(k.refused, null);
});

test('a refused marker is re-decided: the reason, its time and its count come back', () => {
  const k = markerBookkeeping([
    reply(1, `${MERGE_MARKER} refused: checks are red: verify (FAILURE) — 2026-10-13T20:00:00.000Z`),
    reply(2, `${MERGE_MARKER} refused: checks are red: verify (FAILURE) — 2026-10-13T20:10:00.000Z`),
  ]);
  assert.equal(k.handled, false);
  assert.equal(k.refused, 'checks are red: verify (FAILURE)');
  assert.equal(k.refusedAt, '2026-10-13T20:10:00.000Z');
  assert.equal(k.refusedCount, 2);
});

test('the NEWEST marker decides: a refusal after a merge is not read back as merged', () => {
  const k = markerBookkeeping([
    reply(2, `${MERGE_MARKER} refused: checks are red: verify (FAILURE) — 2026-10-13T20:10:00.000Z`),
    reply(1, `${MERGE_MARKER} merged PR #4 at x — 2026-10-13T20:00:00.000Z`),
  ]);
  assert.equal(k.handled, false);
  assert.equal(k.refused, 'checks are red: verify (FAILURE)');
});

test('a prior refusal for the SAME reason quiets the decision; a different reason does not', () => {
  const comments = [prOpened(1), reviewFailed(2), c(3, OPERATOR, 'merge')];
  const auth = comments[2];
  const books = recordBookkeeping(emptyBooks(), auth.id, markerBookkeeping([
    reply(4, `${MERGE_MARKER} refused: the most recent review verdict is not a PASS — 2026-10-13T20:00:00.000Z`),
  ]));
  const quiet = decide(comments, 'Ready to launch', books);
  assert.equal(quiet.act, 'ignore');
  assert.match(quiet.reason, /already refused for the same reason/);

  const other = recordBookkeeping(emptyBooks(), auth.id, markerBookkeeping([
    reply(4, `${MERGE_MARKER} refused: checks are red: verify (FAILURE) — 2026-10-13T20:00:00.000Z`),
  ]));
  const loud = decide(comments, 'Ready to launch', other);
  assert.equal(loud.act, 'refuse');
  assert.equal(loud.priorRefusal, 'checks are red: verify (FAILURE)');
});

test('a spent authorization is skipped, so a merged PR is never re-decided', () => {
  const comments = [prOpened(1), reviewPassed(2), c(3, OPERATOR, 'merge')];
  const books = recordBookkeeping(emptyBooks(), comments[2].id, markerBookkeeping([
    reply(4, `${MERGE_MARKER} merged PR #4 at x — 2026-10-13T20:00:00.000Z`),
  ]));
  assert.equal(decide(comments, 'Ready to launch', books).act, 'ignore');
});

// -------------------------------------------------------- merge destination

test('no "Next slice:" line: the ticket closes as Live', () => {
  assert.equal(mergeDestination('## Goal\n\nShip the thing.\n').status, 'Live');
  assert.equal(mergeDestination('').status, 'Live');
  assert.equal(mergeDestination(null).status, 'Live');
});

test('a "Next slice:" line with content sends the ticket back to Queued for the next build pass', () => {
  const d = mergeDestination('## Slices\n\nSlice 1 is this PR.\n\nNext slice: the Needs your input hand-back, once busRelayPlan arrives.\n');
  assert.equal(d.status, 'Queued');
  assert.match(d.why, /Next slice: the Needs your input hand-back/);
});

test('the line is read whole-line and case-insensitively, with list and bold markers allowed', () => {
  assert.equal(mergeDestination('- **Next slice:** slice 3').status, 'Queued');
  assert.equal(mergeDestination('NEXT SLICE: slice 3').status, 'Queued');
});

test('"Next slice: none" (or done) means no next slice — Live', () => {
  for (const rest of ['none', 'None.', 'done', 'n/a', '']) {
    assert.equal(mergeDestination(`Next slice: ${rest}`).status, 'Live', rest);
  }
});

test('prose about slices is NOT a declaration: only the line moves a ticket', () => {
  const prose = 'The ticket returns to `Queued` after each slice merges, until slice 3 is in.';
  assert.equal(mergeDestination(prose).status, 'Live');
});

// ---------------------------------------------------------------- odds

test('PR_VIEW_FIELDS covers every field githubGate reads', () => {
  for (const f of ['state', 'isDraft', 'mergeable', 'mergeStateStatus', 'reviewDecision', 'statusCheckRollup']) {
    assert.ok(PR_VIEW_FIELDS.includes(f), f);
  }
});

test('relayLine is one tab-separated line a log reader can grep', () => {
  const line = relayLine({ task: { id: 'abc', name: 'Fix it' }, status: 'Ready to launch', outcome: 'would-merge', detail: 'PR #4' });
  assert.equal(line, 'abc\tReady to launch\twould-merge\tPR #4 "Fix it"');
  assert.equal(line.split('\n').length, 1);
});
