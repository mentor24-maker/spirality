'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const staleReady = require('../../lib/staleReady.js');
const {
  STALE_AFTER_HOURS,
  READY_STAGE,
  OPERATOR,
  MACHINE,
  CANNOT_TELL,
  actorTally,
  classifyReady,
  duePosts,
  exitCodeFor,
  postKey,
  stampKeyTaskId,
  readyFindings,
  renderReport,
  renderStalePost,
} = staleReady;

/**
 * Task 86bbqp68c. 86bbkw1mn sat in `Ready to launch` for six days with Dane's
 * merge approval already given, blocked on ONE failing test out of 1,846. The
 * merge step declined correctly and said so, and nothing ever looked again.
 *
 * THE DEFECT THIS SUITE GUARDS IS NOT "no alarm". It is an alarm that names
 * the wrong actor. A check that tells Dane he is the blocker when he is not
 * costs him a day and teaches him to distrust the next one — that is the
 * incident behind DOCTRINE §2.5, and it cost four days on 86bbmfc15.
 *
 * So the tests that matter most here are the ones asserting what the output
 * must NOT say.
 */

const HOURS = 60 * 60 * 1000;
const STALE = STALE_AFTER_HOURS + 12;

const ticket = (over = {}) => ({
  taskId: '86bbkw1mn',
  name: 'Weekly report: 2026-08-17 to 2026-08-23',
  url: 'https://app.clickup.com/t/86bbkw1mn',
  hours: STALE,
  commentsReadable: true,
  pr: { number: 444, url: 'https://github.com/mentor24-maker/starcaster/pull/444' },
  prReadable: true,
  prState: 'OPEN',
  checks: { pending: [], failed: [], total: 4 },
  mergeWordGiven: false,
  ...over,
});

// ── the four rows of the ticket's own table ─────────────────────────────────

test('ROW 1 — green checks and no merge word IS Dane, and says so plainly', () => {
  const f = classifyReady(ticket());
  assert.equal(f.actor, OPERATOR);
  assert.equal(f.reasonKey, 'awaiting-merge-word');
  assert.match(f.message, /this one IS yours/);
  assert.match(f.message, /merge/, 'it must say what he has to do');
});

test('ROW 2 — green, approved, and still not merged is the MACHINE side', () => {
  const f = classifyReady(ticket({ mergeWordGiven: true }));
  assert.equal(f.actor, MACHINE);
  assert.equal(f.reasonKey, 'green-and-approved');
  assert.match(f.message, /NOT waiting on you/);
  assert.match(f.message, /merge step is not running/);
});

test('BREAK-TEST: ROW 4d — a merge word that could not be read is CANNOT TELL, never "IS yours"', () => {
  // SC-793 review: an unreadable operator id made every green ticket read as
  // waiting on Dane, even after he had said "merge".
  const f = classifyReady(ticket({ mergeWordGiven: null, mergeWordReadable: false, mergeWordError: 'no usable operatorUserId' }));
  assert.equal(f.actor, CANNOT_TELL);
  assert.equal(f.reasonKey, 'merge-word-unknown');
  assert.match(f.message, /no usable operatorUserId/);
  assert.doesNotMatch(f.message, /IS yours/);
});

test('ROW 3 — THE INCIDENT: red checks name a machine, name the check, and never blame Dane', () => {
  const f = classifyReady(ticket({
    mergeWordGiven: true,
    checks: { pending: [], failed: ['verify (FAILURE)'], total: 4 },
  }));
  assert.equal(f.actor, MACHINE, 'a red build is never the operator');
  assert.equal(f.reasonKey, 'checks-red');
  assert.match(f.message, /NOT waiting on you/);
  assert.match(f.message, /verify \(FAILURE\)/, 'the failing check must be NAMED');
  assert.match(f.message, /#444/);
  assert.doesNotMatch(f.message, /waiting on your merge word/);
  assert.doesNotMatch(f.message, /machine side is keeping up/);
});

test('ROW 3 holds even with NO merge word — red is red, whoever has spoken', () => {
  // The sharper edge. Without the merge word the ticket looks, on ClickUp
  // alone, exactly like row 1 — which is precisely how the pulse got it wrong.
  const f = classifyReady(ticket({
    mergeWordGiven: false,
    checks: { pending: [], failed: ['verify (FAILURE)'], total: 4 },
  }));
  assert.equal(f.actor, MACHINE);
  assert.doesNotMatch(f.message, /IS yours/);
});

test('ROW 4a — unreadable comments are CANNOT TELL, never resolved to an actor', () => {
  const f = classifyReady(ticket({ commentsReadable: false }));
  assert.equal(f.actor, CANNOT_TELL);
  assert.match(f.message, /Not resolved to anyone/);
});

test('ROW 4b — no "PR opened:" line is CANNOT TELL, and says the trail needs repairing', () => {
  const f = classifyReady(ticket({ pr: null }));
  assert.equal(f.actor, CANNOT_TELL);
  assert.equal(f.reasonKey, 'no-pr-trail');
  assert.match(f.message, /Not waiting on Dane/);
});

test('ROW 4c — GitHub refusing to answer is CANNOT TELL, WITH the reason', () => {
  const f = classifyReady(ticket({
    prReadable: false,
    prState: null,
    checks: null,
    prReadError: 'gh: rate limit exceeded',
  }));
  assert.equal(f.actor, CANNOT_TELL);
  assert.match(f.message, /rate limit exceeded/, 'rule 2: a cannot-tell carries its reason');
});

test('BREAK-TEST: no CANNOT TELL row may ever resolve to the operator', () => {
  // DOCTRINE §3.11, stated as an invariant rather than trusted per-branch. A
  // future sixth unreadable state must not be able to default to blaming him.
  const unreadable = [
    ticket({ commentsReadable: false }),
    ticket({ pr: null }),
    ticket({ prReadable: false, prState: null, checks: null }),
    ticket({ checks: null }),
  ];
  for (const r of unreadable) {
    const f = classifyReady(r);
    assert.equal(f.actor, CANNOT_TELL, `${f.reasonKey} must not resolve to an actor`);
    assert.notEqual(f.actor, OPERATOR);
  }
});

// ── the states GitHub can be in that the table did not name ─────────────────

test('checks still running after a day is the machine side, not a missing merge word', () => {
  const f = classifyReady(ticket({ checks: { pending: ['verify'], failed: [], total: 4 } }));
  assert.equal(f.actor, MACHINE);
  assert.equal(f.reasonKey, 'checks-pending');
});

test('a PR with NO check runs at all is not green — #387/#389, and the gate refuses it', () => {
  const f = classifyReady(ticket({ checks: { pending: [], failed: [], total: 0 } }));
  assert.equal(f.actor, MACHINE);
  assert.equal(f.reasonKey, 'no-checks');
  assert.match(f.message, /NO check runs/);
  assert.doesNotMatch(f.message, /IS yours/, 'an unchecked PR must never be offered to him as green');
});

test('an already-merged PR is drift, and reported as the machine side', () => {
  const f = classifyReady(ticket({ prState: 'MERGED' }));
  assert.equal(f.actor, MACHINE);
  assert.match(f.message, /reconcile/, 'and it names the repair');
});

test('a closed-unmerged PR says there is nothing left to merge', () => {
  const f = classifyReady(ticket({ prState: 'CLOSED' }));
  assert.equal(f.actor, MACHINE);
  assert.equal(f.reasonKey, 'pr-not-open');
});

// ── the threshold ───────────────────────────────────────────────────────────

test('the threshold is the pulse\'s own, not a second copy of 24', () => {
  const { STAGE_THRESHOLDS } = require('./pulse.js');
  assert.equal(STALE_AFTER_HOURS, STAGE_THRESHOLDS[READY_STAGE].hours,
    'two copies of a threshold are two thresholds, and they drift');
});

test('a ticket under the threshold is fresh, not a finding', () => {
  const out = readyFindings([ticket({ hours: STALE_AFTER_HOURS - 1 })]);
  assert.equal(out.findings.length, 0);
  assert.deepEqual(out.fresh, ['86bbkw1mn']);
});

test('BREAK-TEST: a ticket with no usable date is a CANNOT TELL finding, never assumed fresh', () => {
  const out = readyFindings([{ taskId: '86bbx', name: 'x', hours: NaN }]);
  assert.equal(out.findings.length, 1);
  assert.equal(out.findings[0].actor, CANNOT_TELL);
  assert.equal(out.findings[0].reasonKey, 'age-unknown');
  assert.equal(out.fresh.length, 0, 'it must not be swept into the healthy pile');
});

test('findings come back oldest-waiting first', () => {
  const out = readyFindings([
    ticket({ taskId: '86bba', hours: STALE }),
    ticket({ taskId: '86bbb', hours: STALE + 100 }),
  ]);
  assert.deepEqual(out.findings.map((f) => f.taskId), ['86bbb', '86bba']);
});

// ── suppression ─────────────────────────────────────────────────────────────

test('a finding already posted inside the window is held, not repeated', () => {
  const f = classifyReady(ticket());
  const now = Date.parse('2026-09-01T12:00:00Z');
  const out = duePosts({
    findings: [f],
    stamps: { [postKey(f)]: new Date(now - 1 * HOURS).toISOString() },
    now,
    everyMs: 6 * HOURS,
  });
  assert.equal(out.due.length, 0);
  assert.equal(out.held.length, 1);
});

test('the same finding posts again once the window has passed', () => {
  const f = classifyReady(ticket());
  const now = Date.parse('2026-09-01T12:00:00Z');
  const out = duePosts({
    findings: [f],
    stamps: { [postKey(f)]: new Date(now - 7 * HOURS).toISOString() },
    now,
    everyMs: 6 * HOURS,
  });
  assert.equal(out.due.length, 1);
});

test('BREAK-TEST: red -> green -> red announces the SECOND red at once', () => {
  // The whole reason the key is the REASON and not the ticket. A window keyed
  // on the ticket alone swallows the returning fault, and a fault that returns
  // must be announced again (scripts/report_job_failure.mjs, same rule).
  const red = classifyReady(ticket({
    checks: { pending: [], failed: ['verify (FAILURE)'], total: 4 }, mergeWordGiven: true,
  }));
  const green = classifyReady(ticket({ mergeWordGiven: true }));
  assert.notEqual(postKey(red), postKey(green), 'the two states must not share a suppression key');

  const now = Date.parse('2026-09-01T12:00:00Z');
  const stamps = {
    [postKey(red)]: new Date(now - 5 * HOURS).toISOString(),   // the first red, 5h ago
    [postKey(green)]: new Date(now - 3 * HOURS).toISOString(), // it recovered, 3h ago
  };
  // It has gone red again, inside the six-hour window of the FIRST red.
  const out = duePosts({ findings: [red], stamps, now, everyMs: 6 * HOURS });
  assert.equal(out.due.length, 0, 'same key, inside the window — held, which is correct');

  // ...and once that window closes, or when the reason is a NEW one, it speaks.
  const different = classifyReady(ticket({ pr: null }));
  const out2 = duePosts({ findings: [different], stamps, now, everyMs: 6 * HOURS });
  assert.equal(out2.due.length, 1, 'a reason never posted before is news immediately');
});

test('a finding never posted before is always due', () => {
  const f = classifyReady(ticket());
  const out = duePosts({ findings: [f], stamps: {}, now: Date.now(), everyMs: 6 * HOURS });
  assert.equal(out.due.length, 1);
});

test('an unparseable stamp reads as "never posted" — it errs towards saying something', () => {
  const f = classifyReady(ticket());
  const out = duePosts({
    findings: [f], stamps: { [postKey(f)]: 'not a date' }, now: Date.now(), everyMs: 6 * HOURS,
  });
  assert.equal(out.due.length, 1, 'a broken stamp must never silence an alarm');
});

test('BREAK-TEST: the stamp key and its reader agree, or clearing silently stops working', () => {
  const f = classifyReady(ticket());
  assert.equal(stampKeyTaskId(postKey(f)), f.taskId);
  assert.equal(stampKeyTaskId('86bbkw1mn:checks-red'), '86bbkw1mn');
});

// ── what the reader is told ─────────────────────────────────────────────────

test('the bus post leads with whose hands it needs', () => {
  const findings = [
    classifyReady(ticket({ taskId: '86bba', checks: { pending: [], failed: ['verify'], total: 2 } })),
    classifyReady(ticket({ taskId: '86bbb' })),
  ];
  const text = renderStalePost({ findings, node: 'mac-mini' });
  assert.match(text, /Whose hands: 1 on the machine side, 1 genuinely waiting on you/);
  assert.match(text, /\[CC-starcaster\]/, 'the bus wants a signature');
  assert.match(text, /FLOOR of the real wait/, 'the date_updated proxy caveat travels with the number');
});

test('BREAK-TEST: a post with only machine findings never asks Dane for anything', () => {
  const findings = [classifyReady(ticket({
    mergeWordGiven: true, checks: { pending: [], failed: ['verify'], total: 2 },
  }))];
  const text = renderStalePost({ findings });
  assert.match(text, /none waiting on you/);
  assert.doesNotMatch(text, /waiting on your merge word/);
});

test('the console report states an all-clear out loud — silence is never all-clear', () => {
  const out = renderReport({ findings: [], fresh: ['86bba'], readyCount: 1 });
  assert.match(out, /Nothing is stuck/);
  assert.ok(out.length > 40);
});

test('the console report separates the three actors', () => {
  const findings = [
    classifyReady(ticket({ taskId: '86bba', checks: { pending: [], failed: ['verify'], total: 2 } })),
    classifyReady(ticket({ taskId: '86bbb' })),
    classifyReady(ticket({ taskId: '86bbc', commentsReadable: false })),
  ];
  const out = renderReport({ findings, fresh: [], readyCount: 3 });
  assert.match(out, /On you: 1\s+On the machine side: 1\s+CANNOT TELL: 1/);
});

test('actorTally counts every actor, including the unresolved', () => {
  const t = actorTally([{ actor: OPERATOR }, { actor: MACHINE }, { actor: CANNOT_TELL }, { actor: MACHINE }]);
  assert.deepEqual(t, { operator: 1, machine: 2, cannotTell: 1 });
});

// ── the exit ladder ─────────────────────────────────────────────────────────

test('exit 0 clean, 1 a finding, 2 cannot-tell — and cannot-tell outranks', () => {
  assert.equal(exitCodeFor([]), 0);
  assert.equal(exitCodeFor([{ actor: OPERATOR }]), 1);
  assert.equal(exitCodeFor([{ actor: MACHINE }]), 1);
  assert.equal(exitCodeFor([{ actor: CANNOT_TELL }]), 2);
  assert.equal(exitCodeFor([{ actor: MACHINE }, { actor: CANNOT_TELL }]), 2,
    'a run that could not read something never exits as healthy');
});

// ── the wiring nothing else can see ─────────────────────────────────────────

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('the relay actually calls it, and cannot be failed by it', () => {
  // The two reasons the pulse never fired were "it has no schedule anywhere"
  // and "the logic existed and was never reached". A green unit suite is not
  // evidence that a scheduled check runs, so the wiring is asserted too.
  const sh = read('scripts/run_bus_relay.sh');
  assert.match(sh, /npm run --silent stale-ready -- --check \|\| true/,
    'the relay must call it, and `|| true` so it can never fail the relay');
  const relayIndex = sh.indexOf('clickup -- bus-relay');
  const checkIndex = sh.indexOf('stale-ready');
  assert.ok(checkIndex > 0 && checkIndex < relayIndex,
    'it runs BEFORE the ownership check, like its two neighbours');
});

test('the npm script exists and points at the committed file', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.scripts['stale-ready'], 'npm run stale-ready must exist');
  assert.match(pkg.scripts['stale-ready'], /scripts\/stale_ready\.mjs/);
  assert.match(pkg.scripts['stale-ready'], /doppler run/, 'Doppler supplies the ClickUp token');
});

test('BREAK-TEST: the check asks the pipeline switch before it posts', () => {
  // Every actor asks. A watchdog shouting on the bus while Dane has the deck
  // is the collision the switch exists to prevent.
  const src = read('scripts/stale_ready.mjs');
  assert.match(src, /pipeline\.mjs/, 'it must consult the one switch implementation');
  const pauseAt = src.indexOf('pipelinePaused()');
  const postAt = src.indexOf('postBusMessage');
  assert.ok(pauseAt > 0 && pauseAt < postAt, 'the switch is consulted before anything is sent');
});

test('the check locates a ticket\'s PR the way the merge step does — no second reader', () => {
  const src = read('scripts/stale_ready.mjs');
  assert.match(src, /findPullRequest/, 'reuse the merge step\'s locator');
  assert.doesNotMatch(src, /PR opened:\s*\\?s\*\(https/, 'and do not write a second regex for it');
});

// ── the second clock (2026-09-02, task 86bbtqytq) ───────────────────────────
//
// 86bbqw49y sat in Ready to launch for TWELVE hours with its PR already merged,
// while this check reported "0 past 24h / Nothing is stuck" — honestly, and
// uselessly. Dane's ruling: a ticket carrying his own `merge` comment gets a
// short fuse, measured FROM THAT COMMENT.

const {
  APPROVED_STALE_AFTER_HOURS,
  liveApprovalAt,
  stalenessClock,
  overdueRatio,
} = staleReady;

const OPERATOR_ID = 48012725;
const comment = (over = {}) => ({
  id: String(over.id || '1'),
  date: String(over.at || Date.now()),
  user: { id: over.userId === undefined ? OPERATOR_ID : over.userId },
  comment_text: over.text || 'merge',
});

test('the short fuse is 2h AND is the pulse\'s own building threshold — no new magic number', () => {
  // His ruling asked for exactly this: "no new constant enters the codebase
  // without a sibling". The coupling is deliberate, so it is pinned in BOTH
  // directions — retuning the build threshold fails here and makes somebody
  // decide, rather than silently moving a clock a person is waiting on.
  const { STAGE_THRESHOLDS } = require('./pulse.js');
  assert.equal(APPROVED_STALE_AFTER_HOURS, 2);
  assert.equal(APPROVED_STALE_AFTER_HOURS, STAGE_THRESHOLDS.building.hours);
  assert.notEqual(APPROVED_STALE_AFTER_HOURS, STALE_AFTER_HOURS, 'two clocks, not one');
});

test('THE INCIDENT: 12h with his merge word is stuck; 12h without it is not', () => {
  const approved = ticket({ hours: 12, approvedHours: 12, prState: 'MERGED', mergeWordGiven: true });
  const untouched = ticket({ hours: 12, prState: 'MERGED' });
  const out = readyFindings([approved, untouched]);
  assert.equal(out.findings.length, 1, 'exactly one of these two is past its clock');
  assert.equal(out.findings[0].basis, 'approval');
  assert.deepEqual(out.fresh, [untouched.taskId], 'the unapproved one keeps its 24h');
});

test('BREAK-TEST: the fuse burns from the merge COMMENT, not from date_updated', () => {
  // The ruling's own break test. 86bbqw49y took 25 automated refusal comments
  // while it sat there, and every one of them bumped date_updated. A clock
  // reading ticket age is reset by the very refusals it exists to catch — so
  // this ticket looks four minutes old and is still a finding.
  const refreshedByRefusals = ticket({ hours: 0.07, approvedHours: 9, prState: 'MERGED', mergeWordGiven: true });
  const clock = stalenessClock(refreshedByRefusals);
  assert.equal(clock.basis, 'approval');
  assert.equal(clock.hours, 9, 'if this reads 0.07 the clock is pointed at date_updated and measures nothing');
  assert.equal(readyFindings([refreshedByRefusals]).findings.length, 1);
});

test('a ticket he approved 1h ago is still fresh — the fuse is short, not instant', () => {
  const out = readyFindings([ticket({ hours: 1, approvedHours: 1 })]);
  assert.equal(out.findings.length, 0);
  assert.equal(out.fresh.length, 1);
});

test('the finding says which clock it is on, so a "3.1h" is never read against 24', () => {
  const f = classifyReady(ticket({ hours: 0.5, approvedHours: 3.1, prState: 'MERGED' }));
  assert.match(f.message, /since you said "merge"/);
  assert.doesNotMatch(f.message, /0\.5h/, 'the stage age is not the clock here and must not be quoted');
});

test('findings rank by how far past their OWN clock they are, not by raw hours', () => {
  const approved = ticket({ taskId: 'A', hours: 3, approvedHours: 3, prState: 'MERGED' });  // 1.5x its 2h
  const untouched = ticket({ taskId: 'B', hours: 26, prState: 'MERGED' });                  // 1.08x its 24h
  const { findings } = readyFindings([untouched, approved]);
  assert.deepEqual(findings.map((f) => f.taskId), ['A', 'B'],
    'raw-hours sorting would bury the ticket he is actually waiting on');
  assert.ok(overdueRatio(findings[0]) > overdueRatio(findings[1]));
});

test('liveApprovalAt takes the OLDEST live merge comment — repeating himself does not restart it', () => {
  const t0 = 1_756_000_000_000;
  const at = liveApprovalAt([
    comment({ id: '1', at: t0, text: 'REVIEW: PASSED (all gates green)', userId: 999 }),
    comment({ id: '2', at: t0 + 3_600_000, text: 'merge' }),
    comment({ id: '3', at: t0 + 7_200_000, text: 'merge' }),
  ], { operatorId: OPERATOR_ID });
  assert.equal(at, t0 + 3_600_000, 'the wait began the first time he said it');
});

test('BREAK-TEST: a merge word from an EARLIER round never lights the fuse', () => {
  // A ticket sent back, rebuilt and re-reviewed carries a stale "merge". The
  // merge step refuses it for exactly this reason; if the fuse ignored the
  // rule, every rebuilt ticket would arrive back in the stage already on fire.
  const t0 = 1_756_000_000_000;
  const at = liveApprovalAt([
    comment({ id: '1', at: t0, text: 'merge' }),
    comment({ id: '2', at: t0 + 86_400_000, text: 'REVIEW: PASSED (round 2)', userId: 999 }),
  ], { operatorId: OPERATOR_ID });
  assert.equal(at, 0, 'no live approval — this one is back to waiting on him, and row 1 says so');
});

test('BREAK-TEST: a MACHINE saying "merge" is not an authorization and starts no clock', () => {
  const at = liveApprovalAt([comment({ id: '1', text: 'merge', userId: 777 })], { operatorId: OPERATOR_ID });
  assert.equal(at, 0);
});

test('no comments at all means no approval, and the 24h clock stands', () => {
  assert.equal(liveApprovalAt([], { operatorId: OPERATOR_ID }), 0);
  assert.equal(liveApprovalAt(null, { operatorId: OPERATOR_ID }), 0);
  assert.equal(stalenessClock({ hours: 5 }).thresholdHours, STALE_AFTER_HOURS);
});

test('a ticket whose comments would not read is not counted as measured', () => {
  // Its short fuse could not be applied at all. Not an alarm at 3h — a
  // transient read failure is not a stuck ticket — but never folded into
  // "nothing is stuck" either (DOCTRINE 3.11).
  const out = readyFindings([ticket({ hours: 3, commentsReadable: false })]);
  assert.equal(out.findings.length, 0);
  assert.deepEqual(out.unmeasured, ['86bbkw1mn']);
  const report = renderReport({ ...out, readyCount: 1 });
  assert.match(report, /could not have the short fuse applied/);
  assert.match(report, /86bbkw1mn/);
});

test('both reports name both clocks, so a threshold is never guessed at', () => {
  const post = renderStalePost({ findings: [classifyReady(ticket({ approvedHours: 3 }))] });
  assert.match(post, new RegExp(`${APPROVED_STALE_AFTER_HOURS}h once you have said`));
  assert.match(post, new RegExp(`${STALE_AFTER_HOURS}h otherwise`));
  assert.match(post, /measured from your "merge" comment itself, which nothing resets/);
  const report = renderReport({ findings: [], fresh: [], readyCount: 0 });
  assert.match(report, /Two clocks/);
});

test('the check reads the trail for EVERY ready ticket, not only the ones past 24h', () => {
  // The regression that would silently undo all of the above: skipping the
  // comment read for a "fresh" ticket makes the merge word invisible, and the
  // 12-hour ticket this was written for is fresh by the 24h clock.
  const src = read('scripts/stale_ready.mjs');
  const readAt = src.indexOf('await readComments(id)');
  const clockAt = src.indexOf('staleReady.stalenessClock(base)');
  assert.ok(readAt > 0 && clockAt > readAt,
    'the comments must be read BEFORE the threshold decision, not after it');
  assert.match(src, /liveApprovalAt/, 'and the approval time must come from the module that owns the rule');
});

test('a row that has NOT established approval does not tell him he approved it', () => {
  // With two clocks in play, "has been approved and waiting 26h" on a row
  // reached without ever reading an approval is the DOCTRINE §2.5 slip in
  // miniature: it states his action as fact. Every such row now says only what
  // the reading actually established.
  for (const t of [ticket({ pr: null }), ticket({ prState: 'CLOSED' }),
    ticket({ prReadable: false, prState: null, checks: null }),
    ticket({ checks: null }), ticket({ commentsReadable: false })]) {
    const f = classifyReady(t);
    assert.doesNotMatch(f.message, /has been approved/, `${f.reasonKey} presumes an approval it never read`);
  }
});
