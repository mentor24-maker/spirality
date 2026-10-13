'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const {
  prOpenedComment,
  verdictComment,
  prTrailLanded,
  prBodyCarriesTicket,
  readyToLaunchGate,
  isReadyToLaunch,
} = require('./loopTrail.js');
const { findPullRequest, isReviewPassed } = require('./mergeOnComment.js');
const { doorSource, skipWithoutDoor } = require('./productScripts.js');

const TASK = '86bbjt18r';
const TASK_URL = `https://app.clickup.com/t/${TASK}`;
const PR_URL = 'https://github.com/mentor24-maker/starcaster/pull/386';

let nextId = 1;
function c(t, text) {
  return { id: String(nextId++), date: String(1000 + t), comment_text: text };
}

// ------------------------------------------------- the PR trail (gap 2 + 3)

test('what pr-opened writes is what the merge step reads — one shape, both ends', () => {
  const posted = c(1, prOpenedComment(PR_URL, 'Built in worktree merge-on-comment-gaps.'));
  const found = findPullRequest([posted]);
  assert.equal(found.number, 386);
  assert.equal(found.owner, 'mentor24-maker');
  assert.equal(found.repo, 'starcaster');
});

test('a trail with no "PR opened:" line at all is not a trail', () => {
  const out = prTrailLanded([c(1, `See ${PR_URL} for the change.`)], 386);
  assert.equal(out.ok, false);
  assert.match(out.why, /no "PR opened: <url>" line/);
});

test('THE 2026-08-22 GAP: the number is checked, not merely "some PR line exists"', () => {
  // A ticket rebuilt onto a second PR whose new comment silently failed would
  // otherwise verify green against the OLD one, and the loop would hand off a
  // ticket pointing at a dead PR.
  const out = prTrailLanded([c(1, prOpenedComment(PR_URL))], 400);
  assert.equal(out.ok, false);
  assert.match(out.why, /#386, not #400/);
});

test('the newest line wins, so a rebuild verifies against its own PR', () => {
  const comments = [
    c(1, prOpenedComment(PR_URL)),
    c(9, prOpenedComment('https://github.com/mentor24-maker/starcaster/pull/400')),
  ];
  assert.equal(prTrailLanded(comments, 400).ok, true);
  assert.equal(prTrailLanded(comments, 386).ok, false);
});

test('the link runs the other way too: the PR body must name its ticket', () => {
  assert.equal(prBodyCarriesTicket(`Closes ${TASK_URL}\n\nSummary.`, TASK, TASK_URL), true);
  // ClickUp's own "copy link" button includes the workspace id.
  assert.equal(
    prBodyCarriesTicket(`Closes https://app.clickup.com/t/90141423066/${TASK}`, TASK, TASK_URL),
    true,
  );
  // Ids are quoted in mixed case in the wild.
  assert.equal(prBodyCarriesTicket(`Closes ${TASK_URL.toUpperCase()}`, TASK, TASK_URL), true);
});

test('a bare task id is NOT a link — this command and the review gate agree now', () => {
  // Until 2026-08-26 (task 86bbmmv7t, finding 2) a bare id passed here and was
  // then refused by the review gate, which has always wanted the URL — so
  // `pr-opened` called a PR traceable and the gate told the same reader, of the
  // same body, that it carried no ticket link. The two read one matcher now.
  //
  // BREAK-TEST: point prBodyCarriesTicket back at a substring search for the
  // id and this fails, along with the agreement test in reviewGate.test.js.
  assert.equal(prBodyCarriesTicket(`ClickUp: ${TASK}`, TASK, TASK_URL), false);
  assert.equal(prBodyCarriesTicket(`ClickUp: ${TASK.toUpperCase()}`, TASK, TASK_URL), false);
});

test('BREAK IT: a PR body with a plain summary and no ticket is refused', () => {
  // Two of the four stranded PRs on 2026-08-22 looked exactly like this, and
  // ticket and PR could then only be paired by reading titles.
  assert.equal(prBodyCarriesTicket('Adds the thing. Vercel preview attached.', TASK, TASK_URL), false);
  assert.equal(prBodyCarriesTicket('', TASK, TASK_URL), false);
  assert.equal(prBodyCarriesTicket(null, TASK, TASK_URL), false);
});

test('a link to a DIFFERENT ticket is not a link to this one', () => {
  assert.equal(prBodyCarriesTicket('ClickUp: https://app.clickup.com/t/86bbjd5nn', TASK, TASK_URL), false);
});

// ------------------------------------------ the Ready-to-launch gate (gap 3)

test('what verdict --pass writes is what the gate accepts', () => {
  const text = verdictComment(true, 'loop-review, 2026-08-22 — gates green, walked the steps.');
  assert.equal(isReviewPassed(text), true);
  assert.equal(readyToLaunchGate([c(1, text)]).ok, true);
});

test('BREAK IT ON PURPOSE 1: a ticket with no verdict at all cannot reach Ready to launch', () => {
  // 86bbgcxyz on 2026-08-22: promoted to the operator's safe-to-merge signal
  // with nothing on the ticket that had ever reviewed it.
  const out = readyToLaunchGate([c(1, 'PR opened: ' + PR_URL), c(2, 'Built and pushed.')]);
  assert.equal(out.ok, false);
  assert.match(out.why, /no review verdict/);
});

test('BREAK IT ON PURPOSE 2: a send-back as the newest verdict cannot reach Ready to launch', () => {
  // 86bbggwet on 2026-08-22: an older pass existed, the LAST word was not one.
  const out = readyToLaunchGate([
    c(1, verdictComment(true, 'first round')),
    c(5, verdictComment(false, 'the propagation test is red')),
  ]);
  assert.equal(out.ok, false);
  assert.match(out.why, /not a PASS/);
});

test('a later re-review does release it — the NEWEST verdict is the one that counts', () => {
  const out = readyToLaunchGate([
    c(1, verdictComment(true, 'first round')),
    c(5, verdictComment(false, 'the propagation test is red')),
    c(9, verdictComment(true, 'fixed and re-run')),
  ]);
  assert.equal(out.ok, true);
});

test('comment order off the wire is not assumed — the gate sorts by date itself', () => {
  const out = readyToLaunchGate([
    c(9, verdictComment(true, 'fixed and re-run')),
    c(5, verdictComment(false, 'the propagation test is red')),
  ]);
  assert.equal(out.ok, true);
});

test('a send-back verdict does not accidentally read as a pass', () => {
  assert.equal(isReviewPassed(verdictComment(false, 'CI is red')), false);
});

test('a send-back verdict names Rework, and the OLD wording still counts as one', () => {
  // Task 86bbr1u9v. Two halves, and the second matters more than the first:
  // `sendBackRounds` counts these comments to decide when a fourth round goes
  // to Dane instead of round-tripping again. If renaming the status had
  // orphaned the history, every ticket sent back before 2026-08-31 would have
  // silently reset to round 1 — the escalation quietly switched off.
  const fresh = verdictComment(false, 'the panel is staggered');
  assert.match(fresh, /sent back to Rework/);
  assert.doesNotMatch(fresh, /sent back to Queued/);

  const { isReviewVerdict } = require('./mergeOnComment.js');
  const legacy = 'REVIEW: sent back to Queued — one surviving mutant proves a coverage hole.';
  for (const text of [fresh, legacy]) {
    assert.equal(isReviewVerdict(text), true, `must read as a verdict: ${text}`);
    assert.equal(isReviewPassed(text), false, `must not read as a pass: ${text}`);
  }
  // And a PASS is untouched by any of it.
  assert.equal(isReviewPassed(verdictComment(true, 'gates green')), true);
});

test('only "Ready to launch" is gated — no other status is touched', () => {
  assert.equal(isReadyToLaunch('Ready to launch'), true);
  assert.equal(isReadyToLaunch('  ready TO launch '), true);
  for (const s of ['Queued', 'Building', 'In review', 'Needs your input', 'Live', '', null]) {
    assert.equal(isReadyToLaunch(s), false, String(s));
  }
});

// --------------------------------------------------------------- the wiring
//
// A gate that is never called is worse than no gate: it reads as protection
// in review and does nothing at runtime (DOCTRINE — a check that could
// silently not run). These read the script itself, because both doors into
// "Ready to launch" are command blocks that no unit test can reach.

const SCRIPT = doorSource() || '';

test('BOTH doors into Ready to launch consult the gate', (t) => {
  if (skipWithoutDoor(t)) return;
  const calls = SCRIPT.match(/await readyToLaunchRefused\(task, status\)/g) || [];
  assert.equal(calls.length, 2, 'expected the gate on both `status` and `ask`');
  assert.match(SCRIPT, /if \(await readyToLaunchRefused\(task, status\)\) process\.exit\(2\)/);
  assert.match(SCRIPT, /if \(!noMove && await readyToLaunchRefused\(task, status\)\) process\.exit\(2\)/);
});

test('the gate runs BEFORE anything is written, on both doors', (t) => {
  if (skipWithoutDoor(t)) return;
  // In `ask` it must precede the card post; in `status` it must precede the
  // task read that leads to the write. A refusal has to leave the ticket
  // exactly where it was.
  const askAt = SCRIPT.indexOf('if (!noMove && await readyToLaunchRefused');
  // The card posts in ClickUp's structured shape since task 86bbq5ruz (the
  // banner is bold and red, and colour only exists there).
  const cardAt = SCRIPT.indexOf("call('POST', `/api/v2/task/${task}/comment`, { comment: commentBody })");
  assert.ok(askAt > 0 && cardAt > askAt, 'the ask gate must run before the card is posted');

  const statusAt = SCRIPT.indexOf('if (await readyToLaunchRefused(task, status)) process.exit(2)');
  const writeAt = SCRIPT.indexOf("call('PUT', `/api/v2/task/${task}`, body)");
  assert.ok(statusAt > 0 && writeAt > statusAt, 'the status gate must run before the status write');
});

test('the merge marker has exactly one definition, shared by writer and reader', (t) => {
  if (skipWithoutDoor(t)) return;
  const declared = SCRIPT.match(/const MERGE_MARKER = /g) || [];
  assert.equal(declared.length, 0, 'clickup_direct.mjs must import MERGE_MARKER, not re-declare it');
  // Matched against the destructuring BLOCK rather than one literal line: the
  // import grew to several lines when the notice builders joined it, and a
  // regex pinned to the old one-line shape failed on a change that was purely
  // formatting. What must stay true is that the name comes FROM mergeOnComment.
  const imported = /\}\s*=\s*mergeOnComment;/.exec(SCRIPT);
  assert.ok(imported, 'clickup_direct.mjs must destructure from mergeOnComment');
  const block = SCRIPT.slice(SCRIPT.lastIndexOf('const {', imported.index), imported.index);
  for (const name of ['MERGE_MARKER', 'latestMergeMarker']) {
    assert.ok(block.includes(name), `${name} must be imported from mergeOnComment`);
  }
});

test('every comment the merge path posts is built beside its marker, not inline', (t) => {
  if (skipWithoutDoor(t)) return;
  // Task 86bbk0g4u: the hand-off body and the marker it was written with made
  // opposite promises for a month because they lived in two different files.
  // The bodies now come from mergeOnComment, where a test can compare them.
  for (const builder of ['refusalNotice', 'conflictHandOffNotice', 'mergedNotice']) {
    assert.ok(SCRIPT.includes(builder), `${builder} must be used by the merge step`);
  }
  assert.ok(
    !/Your approval is still standing/.test(SCRIPT),
    'the approval promise must not be typed inline in clickup_direct.mjs — it belongs with the marker',
  );
});
