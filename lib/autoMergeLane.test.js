'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  doorSource, productScript, productScriptPath, productRoot, productDir,
  skipWithoutDoor, skipWithoutProductScript, skipWithoutProductDir,
} = require('./productScripts.js');

const {
  laneAEligibility,
  governanceReason,
  GOVERNANCE_TEST_STEMS,
  WINDOW_MS,
  STALE_MS,
  windowState,
  parseAutoMergeMarker,
  latestAutoMergeMarker,
  markerLine,
  switchCommand,
  nearMissResume,
  nearMissNotice,
  NEAR_MISS_MEMORY,
  newNearMisses,
  ledgerAfterNearMiss,
  killSwitchState,
  SWITCH_STOP,
  SWITCH_RESUME,
  CAP_PER_HOUR,
  CAP_PER_DAY,
  rateCapState,
  selfDisableState,
  laneGate,
  laneADecision,
  announcementNotice,
  cancellationNotice,
  isLaneNotice,
  quotesMachineText,
  digestDue,
  digestBody,
  digestSince,
  DIGEST_EVERY_MS,
  DIGEST_WINDOW_MS,
  asLedger,
  ledgerAfterMerge,
  ledgerAfterSwitch,
  ledgerAfterDisable,
  ledgerAfterDigest,
  switchSignalsFromLedger,
  mergesSince,
  laneEligibility,
  laneForFile,
} = require('./autoMergeLane');

const { MACHINE_MARKER_LINE, stampMachineComment, stampCommentBody, isCommentPostPath } = require('./machineComment');

/**
 * Task 86bbkw2au — Lane A. Canon: vault doctrine/AUTO-MERGE-LANES.md.
 *
 * THE DANGER IN A FEATURE LIKE THIS IS NOT THAT IT MERGES TOO LITTLE. It is
 * that some path through it merges something nobody agreed to, quietly, at
 * 3am. So the tests that carry the most weight here are the REFUSALS: an
 * unreadable switch, a PR that gained a file during the window, a ticket with
 * no review pass, a stale approval, an announcement that never posted.
 *
 * Every rule below was broken on purpose and watched to fail before the pass
 * was believed. Where that break was subtle, the assertion that caught it is
 * named in a comment.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const OPERATOR = 48012725;
const T0 = 1_756_000_000_000; // a fixed epoch; nothing here reads a real clock

const DOCS_ONLY = ['docs/LOCAL_DEVELOPMENT.md', 'README.md', 'scripts/builder/themeWizardApply.test.js'];

let nextId = 1000;
const comment = (text, { at = T0, user = 7, id } = {}) => ({
  id: String(id ?? nextId++),
  date: String(at),
  comment_text: text,
  user: { id: user },
});

const fromDane = (text, at) => comment(text, { at, user: OPERATOR });
/**
 * A machine comment AS THE API HANDS IT BACK: stamped, and carrying Dane's own
 * user id, because the loops post under his token. `comment(..., { user: 7 })`
 * is not this shape and never was — which is exactly why every test passed
 * while the lane cancelled real merges (task 86bbv8nvy).
 */
const fromMachine = (text, at) => comment(stampMachineComment(text), { at, user: OPERATOR });
const prComment = (n, at) => comment(`PR opened: https://github.com/mentor24-maker/starcaster/pull/${n}`, { at });
const reviewPass = (at) => comment('REVIEW: PASSED (checked out, gates green)', { at });
const reviewFail = (at) => comment('REVIEW: sent back to Queued — the test does not fail when broken', { at });
/**
 * The lane's own notices, AS THE API HANDS THEM BACK — stamped, because
 * `call()` stamps every comment a machine posts at the door.
 *
 * They must be stamped for the same reason `fromMachine` must be: the marker
 * reader now honours a marker only on a comment a machine actually wrote
 * (task 86bbv8nvy round 1), so an unstamped fixture models a notice that
 * cannot exist and would test the wrong lane. Dane quoting `[auto-merge]
 * armed PR #618` is what an UNstamped marker really is, and it must not arm.
 */
const armed = (n, at) => comment(stampMachineComment(
  announcementNotice({ pr: { number: n, url: `https://github.com/x/y/pull/${n}` }, files: DOCS_ONLY, deadlineLabel: '6:00pm EDT', at: 'iso' }).body,
), { at, user: OPERATOR });
const cancelled = (n, at) => comment(stampMachineComment(
  cancellationNotice({ pr: { number: n, url: `https://github.com/x/y/pull/${n}` }, why: 'you commented', at: 'iso' }).body,
), { at, user: OPERATOR });

/** A ticket that is ready in every way except whatever the test is probing. */
function readyTicket({ pr = 42, verdictAt = T0, prAt = T0 - 1000, extra = [] } = {}) {
  return [prComment(pr, prAt), reviewPass(verdictAt), ...extra];
}


// ── Criterion 1: which files may ride ────────────────────────────────────────

test('a PR of nothing but tests and documents is eligible', () => {
  const r = laneAEligibility([
    'docs/VISUAL_REVIEW.md',
    'README.md',
    'components/builder/Thing.test.tsx',
    'lib/builder-client/parse.test.ts',
    'scripts/builder/slugConflict.test.js',
    'scripts/x.test.mjs',
    'docs/SQL/whatever.sql',
  ]);
  assert.equal(r.eligible, true, r.reason);
  assert.equal(r.files.length, 7);
});

test('ONE file outside the set disqualifies the whole PR — no partial credit', () => {
  // The doctrine's phrasing, and the reason is that a mixed PR's risk is the
  // risk of its riskiest file, never the average of them.
  for (const intruder of [
    'components/builder/SettingsPanel.tsx',
    'lib/projectScope.js',
    'routes/index.js',
    'src/css/_builder-react.css',
    'public/js/core.js',
    'package.json',
  ]) {
    const r = laneAEligibility([...DOCS_ONLY, intruder]);
    assert.equal(r.eligible, false, `${intruder} should have disqualified the PR`);
    assert.equal(r.blockedBy, intruder);
    assert.match(r.reason, /not a test, a document or pipeline tooling/);
  }
});

test('criterion 4: the machinery that governs machines is never auto-merged', () => {
  const governance = [
    'CLAUDE.md',
    'components/CLAUDE.md',
    'src/css/CLAUDE.md',
    'docs/DOCTRINE.md',
    'docs/LOOP_ENGINEERING.md',
    '.github/PULL_REQUEST_TEMPLATE.md',
    '.github/workflows/ci.yml',
    // Review round 2 (2026-08-30): the loop's own instruction files are `.md`
    // and were eligible — a PR rewriting the review gate would have merged
    // itself. Agent configuration is governance, whichever folder it is in.
    '.claude/skills/loop-review/SKILL.md',
    '.claude/skills/loop-build/SKILL.md',
    '.claude/skills/loop-spec/SKILL.md',
    '.claude/settings.json',
    'skills/reddit-channel-posting-operator/SKILL.md',
    'scripts/builder/mergeOnComment.test.js',
    'scripts/builder/branchCatchUp.test.js',
    'scripts/builder/wipCap.test.js',
    'scripts/builder/busRelayPlan.test.js',
    'scripts/builder/autoMergeLane.test.js',
    'scripts/builder/reviewGate.test.js',
  ];
  for (const file of governance) {
    assert.equal(laneAEligibility([file]).eligible, false, `${file} must never auto-merge`);
    // And it must still be refused when buried in an otherwise clean PR — the
    // break that mattered here was checking governance only on the first file.
    const mixed = laneAEligibility([...DOCS_ONLY, file]);
    assert.equal(mixed.eligible, false, `${file} must disqualify even alongside clean files`);
    assert.equal(mixed.blockedBy, file);
  }
});

test('every named merge-step test is covered, by construction', () => {
  // A future module joining the merge step must be added to the list, and this
  // is what says so out loud rather than leaving a silent hole.
  for (const stem of GOVERNANCE_TEST_STEMS) {
    assert.ok(governanceReason(`scripts/builder/${stem}.test.js`), `${stem} is listed but not matched`);
  }
  assert.ok(GOVERNANCE_TEST_STEMS.includes('autoMergeLane'),
    'the lane must not be able to auto-merge changes to its own rules');
});

test('an ordinary test file is NOT governance', () => {
  assert.equal(governanceReason('scripts/builder/themeWizardApply.test.js'), null);
  assert.equal(governanceReason('docs/WORK-LOG.md'), null);
});

test('an empty file list is refused, not waved through', () => {
  // The classic vacuous truth: "every file matched" is trivially true of no
  // files. Here it would auto-merge a PR nobody could describe.
  assert.equal(laneAEligibility([]).eligible, false);
  assert.equal(laneAEligibility(null).eligible, false);
  assert.match(laneAEligibility([]).reason, /no changed files/);
});

test('near-misses do not sneak through the test-file pattern', () => {
  for (const f of ['scripts/x.test.js.bak', 'test.js', 'notes.markdown', 'a.test.py', 'x.tests.js']) {
    assert.equal(laneAEligibility([f]).eligible, false, `${f} must not match`);
  }
  // `docs/` must be a PREFIX, not a substring anywhere in the path: a
  // `lib/docs/` folder is library code that happens to be named after
  // documentation.
  assert.equal(laneAEligibility(['lib/docs/thing.ts']).eligible, false);
  // A Markdown file outside docs/ IS eligible, though — `*.md` is its own rule
  // in the allow list, which is what lets a README or a WORK-LOG entry ride.
  assert.equal(laneAEligibility(['docsy/thing.md']).eligible, true);
  assert.equal(laneAEligibility(['components/README.md']).eligible, true);
});

test('gh\'s object shape is accepted as well as bare strings', () => {
  assert.equal(laneAEligibility([{ path: 'docs/a.md' }]).eligible, true);
  assert.equal(laneAEligibility([{ path: 'lib/a.js' }]).eligible, false);
});

// ── The window ───────────────────────────────────────────────────────────────

test('the window is one hour, and it is a named decision', () => {
  assert.equal(WINDOW_MS, HOUR, 'Dane ruled one hour on 2026-08-24');
});

test('window arithmetic runs from the announcement, and refuses a missing one', () => {
  const w = windowState({ announcedAt: T0, now: T0 + 59 * 60 * 1000 });
  assert.equal(w.elapsed, false);
  assert.equal(w.deadlineAt, T0 + HOUR);
  assert.equal(windowState({ announcedAt: T0, now: T0 + HOUR }).elapsed, true);

  // An announcement that never posted has no timestamp, and a window with no
  // start is not a window.
  for (const bad of [null, undefined, 0, NaN, '']) {
    assert.equal(windowState({ announcedAt: bad, now: T0 + DAY }).valid, false);
    assert.equal(windowState({ announcedAt: bad, now: T0 + DAY }).elapsed, false,
      'an unstarted clock must never read as elapsed');
  }
});

test('a failed announcement starts no clock and merges nothing', () => {
  // Acceptance criterion 4, module half: with no armed marker on the ticket
  // there is nothing to merge, however long ago the review passed. (The
  // plumbing half — that a failed post writes no marker at all — is pinned
  // against clickup_direct.mjs at the bottom of this file.)
  const d = laneADecision({
    status: 'Ready to launch',
    comments: readyTicket({ verdictAt: T0 - DAY }),
    operatorId: OPERATOR,
    now: T0 + DAY,
    files: ['lib/nope.js'],
  });
  assert.notEqual(d.act, 'merge');
});

// ── The record on the ticket ─────────────────────────────────────────────────

test('markers round-trip, and the newest one decides', () => {
  assert.deepEqual(parseAutoMergeMarker(markerLine('armed', 7, 'x')), { kind: 'armed', pr: 7, lane: 'A' });
  assert.deepEqual(parseAutoMergeMarker(markerLine('cancelled', 7, 'x')), { kind: 'cancelled', pr: 7, lane: 'A' });
  // Lane B round-trips too, and a marker written before Lane B existed — with
  // no lane letter at all — still parses as the lane it was: A.
  assert.deepEqual(parseAutoMergeMarker(markerLine('armed', 7, 'x', 'B')), { kind: 'armed', pr: 7, lane: 'B' });
  assert.deepEqual(parseAutoMergeMarker('[auto-merge] armed PR #7'), { kind: 'armed', pr: 7, lane: 'A' });
  assert.equal(parseAutoMergeMarker('no marker here'), null);
  // Prose ABOUT a marker is not a marker: it must start the line.
  assert.equal(parseAutoMergeMarker('as I said, [auto-merge] armed PR #7'), null);

  const latest = latestAutoMergeMarker([armed(7, T0), cancelled(7, T0 + 100), armed(7, T0 - 100)]);
  assert.equal(latest.kind, 'cancelled');
  assert.equal(latest.at, T0 + 100);
});

// ── The kill switch (standing condition 1) ───────────────────────────────────

test('stop is matched loosely, resume strictly — the asymmetry is deliberate', () => {
  assert.equal(switchCommand(SWITCH_STOP), 'stop');
  assert.equal(switchCommand('Stop Auto-Merging.'), 'stop');
  assert.equal(switchCommand('stop auto merging'), 'stop', 'nobody types the hyphen twice');
  assert.equal(switchCommand('hey, stop auto-merging until I look at this'), 'stop',
    'a stop buried in a sentence must still stop it');

  assert.equal(switchCommand(SWITCH_RESUME), 'resume');
  assert.equal(switchCommand('resume auto merging'), 'resume');
  assert.equal(switchCommand('I might resume auto-merging tomorrow'), null,
    'a resume must be the whole message — a false resume costs an unwanted merge');
  assert.equal(switchCommand('merge'), null);
  assert.equal(switchCommand(''), null);
});

// ── A near miss says so, instead of matching nothing in silence (86bbuv99r) ──

test('his real 11:11pm message now RESUMES — the wrapper is stripped (86bbvraw4)', () => {
  // The exact string ClickUp stored on 2026-09-03, and again on 2026-09-05.
  // It used to be reported as a near miss and left the lane off; Dane's call
  // on 2026-09-06, after the same class cost him a fourth attempt, was to
  // strip the formatting instead: "we definitely need to do string match or
  // some other method that will strip the invisible style characters so I
  // don't always have to remember to paste just so."
  assert.equal(switchCommand('**`resume auto-merging`**'), 'resume');
});

test('a message with extra WORDS is still a near miss — it does not resume, and it is not silent', () => {
  // The near-miss lane keeps its job. What changed is which failures reach it:
  // formatting he cannot control is now stripped, while a phrase buried in a
  // sentence is a genuine ambiguity and must not merge anything.
  const his = 'resume auto-merging when CI is green';
  assert.equal(switchCommand(his), null, 'a resume must still be the whole message');
  const miss = nearMissResume(his);
  assert.ok(miss, 'and it must no longer be indistinguishable from silence');
  assert.equal(miss.phrase, SWITCH_RESUME);

  const notice = nearMissNotice({ where: 'on the party line', saw: miss.saw });
  assert.match(notice, /did not take/i, 'it has to say plainly that nothing happened');
  // The phrase is handed back PLAIN. The wrapper he copied came from an
  // agent's own card; a notice that repeats it hands him another dud line.
  assert.match(notice, /\n\nresume auto-merging\n/,
    'the phrase must appear on its own line with no bold and no backticks');
  // The echo above quotes HIM, wrapper and all — that is the evidence, and it
  // is indented as a block so it reads as a quotation. What must be clean is
  // the half he is being told to copy from.
  const instruction = notice.slice(notice.indexOf('Type or paste exactly this line'));
  assert.ok(!/[*`_]/.test(instruction.split('(Only "resume"')[0]),
    'the line he is told to copy must carry no markdown at all');
  assert.match(notice, /What came through, exactly as ClickUp stored it/,
    'and he is shown what actually arrived, so the wrapper is visible as the cause');
});

test('a message that DID take gets no notice — resume and stop alike', () => {
  assert.equal(nearMissResume('resume auto-merging'), null);
  assert.equal(nearMissResume('`resume auto-merging`'), null, 'backticks already matched');
  assert.equal(nearMissResume('Resume Auto Merging.'), null, 'so did case, spacing and a full stop');
  assert.equal(nearMissResume('hey, stop auto-merging until I look at this'), null,
    'the stop matcher is untouched, and a stop that took is not a near miss');
});

test('an unrelated message produces NO notice — the noise failure, pinned', () => {
  // If this test ever fails, the fix has become worse than the silence it
  // replaced: the party line is where every alarm lands.
  for (const quiet of [
    'merge',
    'merge 599',
    'looks good, ship it',
    'why has nothing merged since 6:27pm?',
    'resume the pipeline',
    'auto-merging',
    '',
    null,
  ]) {
    assert.equal(nearMissResume(quiet), null, `must stay quiet about ${JSON.stringify(quiet)}`);
  }
});

test('a near miss is answered ONCE, not once per pass', () => {
  const candidates = [{ id: 'msg-1', where: 'on the party line', saw: 'x' }];
  let ledger = asLedger(null);

  const first = newNearMisses({ candidates, ledger });
  assert.equal(first.length, 1, 'the first pass answers it');

  ledger = ledgerAfterNearMiss(ledger, ['msg-1']);
  assert.deepEqual(newNearMisses({ candidates, ledger }), [],
    'every pass after that stays quiet — the message is still in view, and it is not news twice');

  // A SECOND near miss from him is news again, even with identical text.
  const again = newNearMisses({ candidates: [...candidates, { id: 'msg-2', saw: 'x' }], ledger });
  assert.equal(again.length, 1);
  assert.equal(again[0].id, 'msg-2', 'dedup is by message id, never by text');
});

test('a near miss with no id is not answered — it could not be remembered', () => {
  assert.deepEqual(newNearMisses({ candidates: [{ where: 'on the party line' }], ledger: null }), [],
    'answering something we cannot record would repeat forever');
  assert.deepEqual(newNearMisses({ candidates: [{ id: 'a' }, { id: 'a' }], ledger: null }).length, 1,
    'and the same id twice in one pass is one answer');
});

test('the answered-near-miss memory survives a round trip and stays bounded', () => {
  const ids = Array.from({ length: NEAR_MISS_MEMORY + 20 }, (_, i) => `m${i}`);
  let ledger = asLedger(null);
  for (const id of ids) ledger = ledgerAfterNearMiss(ledger, [id]);
  assert.equal(ledger.nearMisses.length, NEAR_MISS_MEMORY, 'the file stays a file');
  assert.equal(ledger.nearMisses[ledger.nearMisses.length - 1], `m${ids.length - 1}`, 'newest kept');

  const reread = asLedger(JSON.parse(JSON.stringify(ledger)));
  assert.deepEqual(reread.nearMisses, ledger.nearMisses, 'and it comes back off disk intact');
  // The whitelist in asLedger is why this key has to be named there at all.
  assert.deepEqual(asLedger({ nearMisses: 'not an array' }).nearMisses, []);
});

test('an UNREADABLE switch means OFF — the fail-safe direction', () => {
  // The most important assertion in this file. "He never said stop" and "I
  // could not find out whether he said stop" look identical from inside the
  // pass, and only one of them is safe to act on.
  const s = killSwitchState({ signals: [], readable: false });
  assert.equal(s.state, 'off');
  assert.match(s.why, /could not be read/);

  // Even with a resume on the record: if the sources cannot be read we do not
  // know it is the newest thing said.
  assert.equal(killSwitchState({
    signals: [{ kind: 'resume', at: T0 }],
    readable: false,
  }).state, 'off');
});

test('the newest signal wins, in both directions', () => {
  assert.equal(killSwitchState({ signals: [] }).state, 'on');
  assert.equal(killSwitchState({ signals: [{ kind: 'stop', at: T0 }] }).state, 'off');
  assert.equal(killSwitchState({
    signals: [{ kind: 'stop', at: T0 }, { kind: 'resume', at: T0 + 1 }],
  }).state, 'on');
  assert.equal(killSwitchState({
    signals: [{ kind: 'resume', at: T0 }, { kind: 'stop', at: T0 + 1 }],
  }).state, 'off');
});

test('a stop is remembered, so it cannot vanish when a ticket closes', () => {
  // A pass only reads OPEN tickets. A stop said on a ticket that later goes
  // Live would disappear from view and the lane would switch itself back on —
  // the one direction a fail-safe must never fail in.
  const l = ledgerAfterSwitch(asLedger(null), { kind: 'stop', at: T0, where: 'on task 1' });
  assert.equal(l.switch.kind, 'stop');
  assert.equal(killSwitchState({ signals: switchSignalsFromLedger(l) }).state, 'off');

  // An older signal never overwrites a newer record.
  const same = ledgerAfterSwitch(l, { kind: 'resume', at: T0 - 1 });
  assert.equal(same.switch.kind, 'stop');

  // A newer resume does, and it clears a self-disable in the same move: one
  // word puts the lane back, rather than two hidden off switches.
  const disabled = ledgerAfterDisable(l, 'something went wrong', T0);
  assert.equal(disabled.disabled.why, 'something went wrong');
  const resumed = ledgerAfterSwitch(disabled, { kind: 'resume', at: T0 + 1 });
  assert.equal(resumed.switch.kind, 'resume');
  assert.equal(resumed.disabled, null, 'resume must clear the self-disable too');
});

// ── The rate cap (standing condition 2) ──────────────────────────────────────

test('the cap holds at 3 an hour and 12 a day', () => {
  assert.equal(CAP_PER_HOUR, 3);
  assert.equal(CAP_PER_DAY, 12);

  const hourly = Array.from({ length: 3 }, (_, i) => ({ at: T0 - i * 60_000 }));
  assert.equal(rateCapState(hourly, T0).allowed, false);
  assert.match(rateCapState(hourly, T0).why, /hourly/);
  assert.equal(rateCapState(hourly.slice(0, 2), T0).allowed, true);

  // Three an hour ago no longer counts against the hour.
  assert.equal(rateCapState(hourly.map((e) => ({ at: e.at - HOUR })), T0).allowed, true);
});

test('the daily cap is a ROLLING window, not a calendar day', () => {
  // "12 per day" that resets at midnight permits 24 in two hours across the
  // boundary — which is precisely the runaway the cap exists to catch.
  const spread = Array.from({ length: 12 }, (_, i) => ({ at: T0 - i * 90 * 60 * 1000 }));
  const cap = rateCapState(spread, T0);
  assert.equal(cap.allowed, false);
  assert.match(cap.why, /daily/);
  assert.equal(rateCapState(spread.map((e) => ({ at: e.at - DAY })), T0).allowed, true);
});

test('a garbled ledger entry cannot inflate or deflate the count', () => {
  assert.equal(rateCapState([{ at: 'nonsense' }, { at: null }, {}], T0).inDay, 0);
});

// ── Self-disable (standing condition 4) ──────────────────────────────────────

test('anything under "could not fully verify" disables the lane', () => {
  const d = selfDisableState({ unchecked: ['could not read PR #9'] });
  assert.equal(d.disabled, true);
  assert.equal(d.fresh, true);
  assert.match(d.why, /could not fully verify/);
  assert.equal(selfDisableState({ unchecked: [] }).disabled, false);
});

test('a red main after an auto-merge disables the lane', () => {
  assert.equal(selfDisableState({ mainBuildRed: true }).disabled, true);
  assert.match(selfDisableState({ mainBuildRed: true }).why, /red/);
});

test('a disable persists until a human clears it', () => {
  const d = selfDisableState({ persisted: { at: T0, why: 'main went red' } });
  assert.equal(d.disabled, true);
  assert.equal(d.fresh, false, 'a remembered disable must not re-announce itself every pass');
  // The reason KEEPS its substance but is no longer replayed verbatim (task
  // 86bbt0mz6). This assertion used to be `equal(d.why, 'main went red')`,
  // which pinned the defect: a stored sentence written by the pass that
  // latched, replayed unchanged by every pass after it, reads as a live
  // finding. On 2026-09-03 that put "this pass could not fully verify 4
  // thing(s)" one line above "0 could not be checked" for 10.8 hours.
  assert.match(d.why, /main went red/, 'the recorded substance must survive');
  assert.match(d.why, /latched off since/, 'and it must say it is a REMEMBERED state, with a date');
});

test('the gate reports WHY, cheapest and most serious reason first', () => {
  const off = killSwitchState({ signals: [{ kind: 'stop', at: T0 }] });
  const dis = selfDisableState({ unchecked: ['x'] });
  const cap = rateCapState(Array.from({ length: 3 }, () => ({ at: T0 })), T0);

  assert.equal(laneGate({ killSwitch: off, selfDisable: dis, rateCap: cap }).kind, 'kill-switch');
  assert.equal(laneGate({ killSwitch: killSwitchState({}), selfDisable: dis, rateCap: cap }).kind, 'self-disabled');
  assert.equal(laneGate({ killSwitch: killSwitchState({}), selfDisable: selfDisableState({}), rateCap: cap }).kind, 'rate-cap');
  assert.equal(laneGate({
    killSwitch: killSwitchState({}),
    selfDisable: selfDisableState({}),
    rateCap: rateCapState([], T0),
  }).allowed, true);
});

// ── The decision ─────────────────────────────────────────────────────────────

test('an eligible, reviewed, unannounced ticket is announced', () => {
  const d = laneADecision({
    status: 'Ready to launch',
    comments: readyTicket(),
    operatorId: OPERATOR,
    now: T0 + 1000,
    files: DOCS_ONLY,
  });
  assert.equal(d.act, 'announce');
  assert.equal(d.pr.number, 42);
});

test('the module asks for the file list rather than guessing without it', () => {
  const d = laneADecision({
    status: 'Ready to launch',
    comments: readyTicket(),
    operatorId: OPERATOR,
    now: T0 + 1000,
  });
  assert.equal(d.act, 'need-files');
  assert.equal(d.pr.number, 42);
});

test('criterion 8: no review PASS, no eligibility — whatever the files', () => {
  const base = { status: 'Ready to launch', operatorId: OPERATOR, now: T0 + 1000, files: DOCS_ONLY };

  // No verdict at all.
  assert.equal(laneADecision({ ...base, comments: [prComment(42, T0)] }).act, 'ignore');
  // A verdict that failed.
  const failed = laneADecision({ ...base, comments: [prComment(42, T0), reviewFail(T0 + 1)] });
  assert.equal(failed.act, 'ignore');
  assert.match(failed.reason, /not a PASS/);
  // A pass superseded by a later failure.
  const superseded = laneADecision({
    ...base,
    comments: [prComment(42, T0), reviewPass(T0 + 1), reviewFail(T0 + 2)],
  });
  assert.equal(superseded.act, 'ignore');
});

test('any status other than Ready to launch is ignored', () => {
  for (const status of ['Queued', 'Building', 'In review', 'Needs your input', 'Live', '', null]) {
    assert.equal(laneADecision({
      status, comments: readyTicket(), operatorId: OPERATOR, now: T0 + 1000, files: DOCS_ONLY,
    }).act, 'ignore', `status ${status} must not be eligible`);
  }
  // Case-insensitively the same status IS eligible — ClickUp lowercases.
  assert.equal(laneADecision({
    status: 'ready to launch', comments: readyTicket(), operatorId: OPERATOR, now: T0 + 1000, files: DOCS_ONLY,
  }).act, 'announce');
});

test('no PR comment means nothing to merge', () => {
  const d = laneADecision({
    status: 'Ready to launch',
    comments: [reviewPass(T0)],
    operatorId: OPERATOR,
    now: T0 + 1000,
    files: DOCS_ONLY,
  });
  assert.equal(d.act, 'ignore');
  assert.match(d.reason, /PR opened/);
});

test('an armed ticket waits out its hour, then merges', () => {
  const comments = readyTicket({ extra: [armed(42, T0 + 10)] });
  const base = { status: 'Ready to launch', comments, operatorId: OPERATOR, files: DOCS_ONLY };

  const early = laneADecision({ ...base, now: T0 + 10 + 59 * 60 * 1000 });
  assert.equal(early.act, 'ignore');
  assert.match(early.reason, /window has \d+ minute/);

  const due = laneADecision({ ...base, now: T0 + 10 + HOUR });
  assert.equal(due.act, 'merge');
  assert.equal(due.pr.number, 42);
  assert.deepEqual(due.eligibility.files, DOCS_ONLY);
});

test('an armed announcement goes STALE after a day, and a stale one cancels rather than merges', () => {
  // Review round 2 (2026-08-30): arm three PRs, say "stop auto-merging", come
  // back a fortnight later and say "resume" — all three were past their
  // deadline and would have merged on windows that closed two weeks ago,
  // with no fresh notice and nothing on his screen.
  assert.equal(STALE_MS, 24 * WINDOW_MS, 'a day is the shelf life, as a named multiple of the window');
  const fresh = windowState({ announcedAt: T0, now: T0 + 2 * HOUR });
  assert.equal(fresh.elapsed, true);
  assert.equal(fresh.stale, false);
  const old = windowState({ announcedAt: T0, now: T0 + STALE_MS });
  assert.equal(old.stale, true);
  assert.equal(windowState({ announcedAt: 0, now: T0 }).stale, false, 'no announcement is not a stale one');

  const comments = readyTicket({ extra: [armed(42, T0 + 10)] });
  const base = { status: 'Ready to launch', comments, operatorId: OPERATOR, files: DOCS_ONLY };
  const d = laneADecision({ ...base, now: T0 + 10 + 14 * DAY });
  assert.equal(d.act, 'cancel', 'a fortnight-old announcement must cancel, never merge');
  assert.equal(d.stale, true);
  assert.match(d.reason, /stale/);
  assert.equal(d.announcementId, comments[2].id);

  // And the cancel is terminal like any other: no re-announcement without a
  // fresh PASS, which is the existing rule doing its job.
  const after = [...comments, cancelled(42, T0 + 10 + 14 * DAY)];
  const again = laneADecision({ ...base, comments: after, now: T0 + 10 + 14 * DAY + 1000 });
  assert.equal(again.act, 'ignore');
  assert.match(again.reason, /no fresh review PASS/);
});

test('ANY comment from Dane during the window cancels it — not a keyword', () => {
  const comments = readyTicket({ extra: [armed(42, T0 + 10), fromDane('hmm', T0 + 20)] });
  const d = laneADecision({
    status: 'Ready to launch', comments, operatorId: OPERATOR, now: T0 + 10 + HOUR, files: DOCS_ONLY,
  });
  assert.equal(d.act, 'cancel');
  assert.match(d.reason, /you commented/);

  // Even a comment that reads like approval. His explicit "merge" goes through
  // the path that was already his; it must not ALSO ride the lane.
  const approving = readyTicket({ extra: [armed(42, T0 + 10), fromDane('merge', T0 + 20)] });
  assert.equal(laneADecision({
    status: 'Ready to launch', comments: approving, operatorId: OPERATOR, now: T0 + 10 + HOUR, files: DOCS_ONLY,
  }).act, 'cancel');
});

test('only HIS comments object, and only ones inside the window', () => {
  // A machine comment during the window is the pipeline talking to itself.
  const machine = readyTicket({ extra: [armed(42, T0 + 10), comment('bot noise', { at: T0 + 20 })] });
  assert.equal(laneADecision({
    status: 'Ready to launch', comments: machine, operatorId: OPERATOR, now: T0 + 10 + HOUR, files: DOCS_ONLY,
  }).act, 'merge');

  // AND THE SAME COMMENT AS IT REALLY ARRIVES — stamped, under Dane's own user
  // id, because the loops post with his token (task 86bbv8nvy). The line above
  // passes on a user id no machine comment actually carries, so it could never
  // have caught this; this one is the assertion that fails without the filter.
  const stamped = readyTicket({
    extra: [armed(42, T0 + 10), fromMachine('[CC-starcaster] Review PASSED — gates green', T0 + 20)],
  });
  assert.equal(laneADecision({
    status: 'Ready to launch', comments: stamped, operatorId: OPERATOR, now: T0 + 10 + HOUR, files: DOCS_ONLY,
  }).act, 'merge', 'a stamped machine comment under his token is the pipeline, not him');

  // His comment from BEFORE the announcement is not an objection to it — the
  // announcement came after and gave him a fresh hour.
  const before = readyTicket({ extra: [fromDane('looks good', T0 + 5), armed(42, T0 + 10)] });
  assert.equal(laneADecision({
    status: 'Ready to launch', comments: before, operatorId: OPERATOR, now: T0 + 10 + HOUR, files: DOCS_ONLY,
  }).act, 'merge');
});

test('the machine filter narrows the objection test and nothing else', () => {
  // Break-test 1 — drop `!isMachineComment(...)` from laneADecision and the
  // stamped-comment assertion above turns into a cancel.
  //
  // Break-test 2 — make the filter swallow everything (`() => true`) and BOTH
  // halves of this test fail: his plain word stops cancelling, and so does the
  // comment nobody can classify. That is the direction that would merge
  // something he objected to, so it gets its own named assertions.
  const base = {
    status: 'Ready to launch', operatorId: OPERATOR, now: T0 + 10 + HOUR, files: DOCS_ONLY,
  };

  // His own word, in the window, unstamped: cancels, exactly as before.
  const his = readyTicket({ extra: [armed(42, T0 + 10), fromDane('hold off on this one', T0 + 20)] });
  const d = laneADecision({ ...base, comments: his });
  assert.equal(d.act, 'cancel', 'his real comment must still cancel');
  assert.match(d.reason, /you commented/);

  // HE QUOTES A MACHINE CARD AND OBJECTS UNDERNEATH IT. This is how he
  // actually objects, and both quoting styles must survive it (round 1 of
  // task 86bbv8nvy — the first cut only covered the tail marker, which was
  // the half that already worked).
  //
  // Break-test 3 — swap `isStampedMachineComment` back to the wide
  // `isMachineComment` and the three head-tag cases below turn into merges:
  // the lane ships over the top of him saying stop.
  const quotedHeads = [
    '[CC-starcaster loop-review] REVIEW: PASSED (checked out, gates green)',
    '[auto-merge] window opened on this PR',
    '[bus-relay] relayed to the bus',
    '[reconciler] moved 86bbv8nvy to Live',
  ];
  for (const card of quotedHeads) {
    const quotingHead = readyTicket({
      extra: [armed(42, T0 + 10), fromDane(`${card}\n\nno, hold this one — I want to look`, T0 + 20)],
    });
    assert.equal(laneADecision({ ...base, comments: quotingHead }).act, 'cancel',
      `his words under a quoted "${card.split(']')[0]}]" card are still his words`);
  }

  // The same act with the TAIL marker pasted first. The stamp lands mid-text
  // rather than last, which is the direction machineComment.js chose on
  // purpose, and it is the safe one here too.
  const quoting = readyTicket({
    extra: [armed(42, T0 + 10), fromDane(`${MACHINE_MARKER_LINE}\n\nwait, why is this merging?`, T0 + 20)],
  });
  assert.equal(laneADecision({ ...base, comments: quoting }).act, 'cancel',
    'his words after a pasted marker are still his words');

  // AND THE HEAD TAG STILL DOES NOT MAKE A REAL MACHINE CARD OBJECT — every
  // card a loop posts carries the tail stamp too (call() writes it at the
  // door), so narrowing to the stamp costs the lane nothing. Sampled over 110
  // real Loop Queue comments: 100 machine-written, 100 via the tail stamp.
  const realCard = readyTicket({
    extra: [armed(42, T0 + 10), fromMachine('[CC-starcaster loop-review] REVIEW: PASSED', T0 + 20)],
  });
  assert.equal(laneADecision({ ...base, comments: realCard }).act, 'merge',
    'a real machine card carries the stamp and is still discounted');

  // An UNCLASSIFIABLE comment under his id still objects. No stamp, no legacy
  // prefix, nothing to recognise — so the lane must assume him and stop.
  const unknown = readyTicket({ extra: [armed(42, T0 + 10), fromDane('?', T0 + 20)] });
  assert.equal(laneADecision({ ...base, comments: unknown }).act, 'cancel',
    'an unrecognised comment is still an objection — the asymmetry is preserved');

  // An unreadable body is the same case: `isMachineComment(undefined)` is
  // false by design, so it counts as his rather than being discounted.
  const unreadable = readyTicket({
    extra: [armed(42, T0 + 10), { id: '9001', date: String(T0 + 20), user: { id: OPERATOR } }],
  });
  assert.equal(laneADecision({ ...base, comments: unreadable }).act, 'cancel',
    'a comment whose text could not be read is not proof a machine wrote it');
});

test('HE QUOTES THE ANNOUNCEMENT ITSELF — his quote must not re-arm the window', () => {
  // The card he is most likely to quote is the one he is replying to. Before
  // this, his quote of `[auto-merge] armed PR #42 ...` registered as a SECOND
  // announcement dated to his own comment: the window silently restarted from
  // his words, his objection was no longer "after the marker", and an hour
  // later the lane merged the PR he had said hold on.
  //
  // Break-test — drop the `isStampedMachineComment` guard from
  // `latestAutoMergeMarker` and both assertions below turn into merges.
  const base = { status: 'Ready to launch', operatorId: OPERATOR, files: DOCS_ONLY };
  const quotesTheNotice = readyTicket({
    extra: [
      armed(42, T0 + 10),
      fromDane(`${markerLine('armed', 42, 'iso')}\n\nno, hold this one — I want to look`, T0 + 20),
    ],
  });

  // Inside the real window: it is an objection, exactly like any other comment.
  const during = laneADecision({ ...base, comments: quotesTheNotice, now: T0 + 10 + HOUR });
  assert.equal(during.act, 'cancel', 'his words under a quoted announcement are an objection');
  assert.match(during.reason, /you commented/);

  // And an hour past HIS comment — the window his quote would have re-armed —
  // it is still cancelled, not merged. This is the assertion that failed.
  assert.equal(
    laneADecision({ ...base, comments: quotesTheNotice, now: T0 + 20 + HOUR + 1 }).act,
    'cancel',
    'his quote of the announcement is not an announcement, so it cannot re-arm',
  );
});

test('HE PASTES THE CARD UNDER HIS WORDS — the other way up, and the one that merged', () => {
  // ROUND 2 OF THIS TICKET, and the reason round 1 was sent back. Round 1
  // closed the ordering where he pastes a card ABOVE his reply: the `[machine]`
  // stamp lands mid-text and the comment reads as his. Pasted UNDERNEATH his
  // words the stamp is the LAST line of HIS comment, so the whole thing read as
  // machine-written — and quoting below your reply is at least as natural as
  // quoting above it. Dane pastes machine text into his comments (2026-09-05,
  // on 86bbuzyra: "I copied that and pasted special as Paste and Match Style").
  //
  // Measured on the real lane before the fix, driving laneADecision with no
  // mocks: "no, hold this one" followed by the announcement card gave
  //     >> inside the window:  ignore | the objection window has 55 minute(s) left
  //     >> an hour past his comment: MERGE | "announced 60 minute(s) ago with no objection"
  // — the lane merged the PR he said hold on, and named nobody objecting as
  // its reason, because his comment had also re-armed the window from his own
  // words.
  //
  // Break-test 1 — delete the `quotesMachineText` call from the objection
  // filter and every assertion below turns into a merge.
  const base = { status: 'Ready to launch', operatorId: OPERATOR, files: DOCS_ONLY };
  const card = armed(42, T0 + 10);
  const pastedUnder = readyTicket({
    extra: [card, fromDane(`no, hold this one — I want to look\n\n${card.comment_text}`, T0 + 20)],
  });

  const during = laneADecision({ ...base, comments: pastedUnder, now: T0 + 10 + HOUR });
  assert.equal(during.act, 'cancel', 'his words ABOVE a pasted card are still his words');

  // The assertion that failed: an hour past HIS comment, past the window his
  // quote would have re-armed.
  assert.equal(
    laneADecision({ ...base, comments: pastedUnder, now: T0 + 20 + HOUR + 1 }).act,
    'cancel',
    'a card pasted under his objection must not merge over the top of him',
  );

  // And the marker still comes from the LANE's announcement, not from his
  // comment — the window never restarted.
  const marker = latestAutoMergeMarker(pastedUnder);
  assert.equal(marker.commentId, String(card.id), 'the window is the lane\'s, dated to the lane\'s own notice');

  // THE MESSAGE SAYS WHICH IT WAS. Naming him for something a script did is
  // the dishonesty this whole ticket was filed about, so a comment that is
  // only his because it carries a pasted card says so.
  assert.match(during.reason, /quotes a machine card/);
  const plain = readyTicket({ extra: [card, fromDane('hold off', T0 + 20)] });
  assert.doesNotMatch(
    laneADecision({ ...base, comments: plain, now: T0 + 10 + HOUR }).reason,
    /quotes a machine card/,
    'a comment he simply typed is not described as a quote',
  );
});

test('he quotes a NON-lane machine card from this ticket, underneath his words', () => {
  // The announcement is not the only card he might paste. Any comment already
  // on the ticket, reproduced whole with words of his around it, was assembled
  // by a person — a loop writes fresh prose, it does not reprint a card that
  // is already there. Measured 2026-09-06 over 1,278 ordered pairs drawn from
  // 189 real machine cards on 60 Loop Queue tickets: ZERO machine card
  // contains another comment whole, so this costs the lane nothing.
  //
  // Break-test 2 — drop the containment half of `quotesMachineText` (keep only
  // the marker half) and this one turns into a merge.
  const verdict = fromMachine(
    '[CC-starcaster loop-review] REVIEW: PASSED — every gate re-run on the branch, break-tested, checked out and driven by hand',
    T0 + 5,
  );
  const comments = readyTicket({
    extra: [
      armed(42, T0 + 10),
      verdict,
      fromDane(`no — hold this one, I want to read it first\n\n${verdict.comment_text}`, T0 + 20),
    ],
  });
  assert.equal(
    laneADecision({ status: 'Ready to launch', operatorId: OPERATOR, files: DOCS_ONLY, comments, now: T0 + 20 + HOUR + 1 }).act,
    'cancel',
    'his words around a card copied off this ticket are still his words',
  );
});

test('HE PASTES WITHOUT THE FORMATTING — the third door, and the one that merged', () => {
  // ROUND 3 OF THIS TICKET. Sign 2 above compares his comment against the
  // cards on the ticket, and it used to compare the RAW TEXT with only its
  // whitespace collapsed — on the premise that "whitespace is what a paste is
  // least likely to preserve exactly". Markdown is. Dane said how he pastes,
  // in his own words, on 86bbuzyra two days before this was found:
  //
  //     "I copied that and pasted special as Paste and Match Style."
  //
  // That drops the formatting. The stored card carries `**` and backticks; his
  // copy does not; containment failed on the marks alone. His comment was
  // still stamped — the `[machine]` line is plain text and survives any paste
  // — so it stayed discounted, and the lane merged the PR he said hold on,
  // reason "announced 90 minute(s) ago with no objection".
  //
  // Measured on the real board: 456 of 679 stamped machine cards (67%) carry
  // emphasis or code marks that a rendered paste drops, so this was the common
  // case, not an edge one.
  //
  // Break-test — put `normalizeForQuoting` back to `replace(/\s+/g, ' ')` and
  // both assertions below turn into merges.
  const base = { status: 'Ready to launch', operatorId: OPERATOR, files: DOCS_ONLY };

  // A card with the markdown these cards really carry.
  const verdict = fromMachine(
    '**REVIEW: PASSED** — every gate re-run on the branch, `npm run typecheck` clean, '
    + '*break-tested* four ways, checked out and driven by hand.\n\n```js\nconst ok = true;\n```',
    T0 + 5,
  );
  // What paste-and-match-style puts in his comment: the words, no marks.
  const asPasted = verdict.comment_text
    .replace(/```[a-z]*\n?/g, '')
    .replace(/\*\*/g, '')
    .replace(/\*/g, '')
    .replace(/`/g, '');
  assert.notEqual(asPasted, verdict.comment_text, 'the fixture must actually differ from the stored card');

  const comments = readyTicket({
    extra: [armed(42, T0 + 10), verdict, fromDane(`no — hold this one, I want to read it first\n\n${asPasted}`, T0 + 20)],
  });

  const during = laneADecision({ ...base, comments, now: T0 + 10 + HOUR });
  assert.equal(during.act, 'cancel', 'a card he pasted WITHOUT its formatting is still a card he pasted');

  // An hour past HIS comment — the assertion that merged.
  assert.equal(
    laneADecision({ ...base, comments, now: T0 + 20 + HOUR + 1 }).act,
    'cancel',
    'a formatting-stripped paste must not merge over the top of him',
  );

  // And the verbatim paste, which already worked, still does — widening the
  // normaliser must not have traded one ordering for the other.
  const verbatim = readyTicket({
    extra: [armed(42, T0 + 10), verdict, fromDane(`no — hold this one\n\n${verdict.comment_text}`, T0 + 20)],
  });
  assert.equal(
    laneADecision({ ...base, comments: verbatim, now: T0 + 20 + HOUR + 1 }).act,
    'cancel',
    'the verbatim paste is unaffected',
  );
});

test('WHAT THIS DOES NOT COVER, pinned so it is found on purpose and not by accident', () => {
  // Said plainly rather than left to be discovered a fourth time — and this
  // comment has BEEN wrong once already, which is the reason to distrust it.
  // Round 2 wrote it claiming the foreign card was the only case left, while
  // the far likelier one — a card off THIS ticket, pasted with its formatting
  // dropped — was sailing through sign 2 on the asterisks alone. Round 3 found
  // that one live. What is pinned here is the remainder AFTER that fix.
  //
  // Neither sign `quotesMachineText` reads can see a card pasted from a
  // DIFFERENT ticket that is not one of this lane's notices: the text is
  // stamped, the lane has never seen it, so containment has nothing to compare
  // against, and nothing in the body says a person put it there.
  //
  // Closing it needs the stamp bound to the body it was written for — a digest
  // in the stamp line — which changes what every card a loop posts looks like
  // and is this ticket's stated non-goal. If a later change DOES close it,
  // this test fails, and that is the point: the note above it has to be
  // rewritten rather than quietly outliving the limit it describes.
  const foreign = stampMachineComment('BUILD: a card posted on some other ticket entirely, pasted in from elsewhere');
  const comments = readyTicket({
    extra: [armed(42, T0 + 10), fromDane(`no, hold this one\n\n${foreign}`, T0 + 20)],
  });
  assert.equal(
    laneADecision({ status: 'Ready to launch', operatorId: OPERATOR, files: DOCS_ONLY, comments, now: T0 + 20 + HOUR + 1 }).act,
    'merge',
    'the known gap: a stamped card from another ticket is still read as a machine\'s',
  );
});

test('isLaneNotice recognises the lane\'s own voice by BOTH ends, not by a marker', () => {
  // A requote carries the marker line and the stamp. What it cannot carry is
  // both ENDS of the notice with nothing of his outside them.
  //
  // Break-test 3 — let `isLaneNotice` return on the closing marker alone
  // (drop the opening check) and the two "pasted" assertions below fail.
  const notice = announcementNotice({
    pr: { number: 42, url: 'https://github.com/x/y/pull/42' }, files: DOCS_ONLY, deadlineLabel: '6:00pm EDT', at: 'iso',
  }).body;
  const cancelNotice = cancellationNotice({
    pr: { number: 42, url: 'https://github.com/x/y/pull/42' }, why: 'you commented', at: 'iso',
  }).body;

  assert.equal(isLaneNotice(stampMachineComment(notice)), 'armed');
  assert.equal(isLaneNotice(stampMachineComment(cancelNotice)), 'cancelled');
  assert.equal(isLaneNotice(notice), 'armed', 'the stamp is optional — the notice is recognised by what the LANE wrote');

  assert.equal(isLaneNotice(`${notice}\n\nno, hold this one`), null, 'his words below it break the close');
  assert.equal(isLaneNotice(`no, hold this one\n\n${notice}`), null, 'his words above it break the opening');
  assert.equal(isLaneNotice(markerLine('armed', 42, 'iso')), null, 'a bare marker line is not a notice');
  assert.equal(isLaneNotice(''), null);
  assert.equal(isLaneNotice(null), null);

  // Two cards spliced together must not pass by borrowing an end from each.
  const other = announcementNotice({
    pr: { number: 99, url: 'https://github.com/x/y/pull/99' }, files: DOCS_ONLY, deadlineLabel: '6:00pm EDT', at: 'iso',
  }).body;
  const spliced = `${other.split('\n')[0]}\n${notice.split('\n').slice(1).join('\n')}`;
  assert.equal(isLaneNotice(spliced), null, 'the opening and the marker must name the same PR');
});

test('an unrecognised CANCELLED marker is still terminal — the skip fails safe both ways', () => {
  // The two kinds fail safe in OPPOSITE directions, and reading them the same
  // way is a regression round 2 caught before it shipped. Skipping an `armed`
  // marker arms nothing, which is safe. Skipping a `cancelled` one makes the
  // ticket read as never announced, so the lane announces AGAIN with no fresh
  // review PASS — the guard that exists so he does not have to say no twice.
  //
  // Break-test 4 — apply the `isLaneNotice` guard to `cancelled` as well as
  // `armed`, and this turns into `announce`.
  const bare = [
    prComment(42, T0 - 1000),
    reviewPass(T0),
    armed(42, T0 + 10),
    comment(markerLine('cancelled', 42, 'iso'), { at: T0 + 30, user: OPERATOR }),
  ];
  const d = laneADecision({
    status: 'Ready to launch', operatorId: OPERATOR, files: DOCS_ONLY, comments: bare, now: T0 + 30 + HOUR + 1,
  });
  assert.equal(d.act, 'ignore', 'a cancellation the lane cannot vouch for still stops it');
  assert.match(d.reason, /you stopped the last auto-merge/);
});

test('THE COUPLING: a real announcement, posted the real way, still arms', () => {
  // The guard above makes the lane's OWN notice depend on the stamp, so if the
  // posting path ever stopped stamping, Lane A would go silently dead — it
  // would announce every pass and never find its own announcement. That is
  // two modules agreeing, which is the kind of thing that drifts.
  //
  // So this asserts the whole chain with no live post: the body the lane
  // builds, sent to the path `postLaneNotice` uses, through the same
  // `stampCommentBody` that `call()` applies at the door.
  const PATH = '/api/v2/task/86bbv8nvy/comment';
  assert.equal(isCommentPostPath(PATH), true, 'the notice path is a comment post, so it gets stamped');

  const notice = announcementNotice({
    pr: { number: 42 }, files: DOCS_ONLY, deadlineLabel: '6:00pm EDT', at: 'iso',
  });
  const sent = stampCommentBody({ comment_text: notice.body });
  const asStored = comment(sent.comment_text, { at: T0 + 10 });

  const read = latestAutoMergeMarker([asStored]);
  assert.ok(read, 'the lane can read back its own posted announcement');
  assert.equal(read.kind, 'armed');
  assert.equal(read.pr, 42);
});

test('an unstamped marker arms nothing at all — it is not the lane talking', () => {
  // The safe direction, stated on purpose: a marker nobody can confirm a
  // machine wrote leaves the ticket un-announced, so nothing merges on it.
  // Re-announcing costs a fresh review PASS, like every other cancel.
  const forged = [
    prComment(42, T0 - 1000),
    reviewPass(T0),
    comment(markerLine('armed', 42, 'iso'), { at: T0 + 10, user: OPERATOR }),
  ];
  const d = laneADecision({
    status: 'Ready to launch', operatorId: OPERATOR, files: DOCS_ONLY, comments: forged, now: T0 + 10 + HOUR + 1,
  });
  assert.notEqual(d.act, 'merge', 'an unstamped marker must never carry a merge');
  assert.equal(d.act, 'announce', 'the ticket reads as never announced, so the lane announces properly');
});

test('cancelling is terminal — no re-announcement without a FRESH review pass', () => {
  const base = { status: 'Ready to launch', operatorId: OPERATOR, now: T0 + DAY, files: DOCS_ONLY };

  const stale = [prComment(42, T0), reviewPass(T0 + 1), cancelled(42, T0 + 100)];
  const d = laneADecision({ ...base, comments: stale });
  assert.equal(d.act, 'ignore');
  assert.match(d.reason, /no fresh review PASS since/);

  // A new review pass after the cancellation re-opens it.
  const fresh = [...stale, reviewPass(T0 + 200)];
  assert.equal(laneADecision({ ...base, comments: fresh }).act, 'announce');
});

test('an announcement for an OLDER PR does not arm the new one', () => {
  // A rebuilt ticket carries the previous round's announcement. The new PR has
  // to earn its own, which is the same rule that makes a cancellation stick.
  const comments = [prComment(99, T0 + 300), reviewPass(T0 + 1), armed(42, T0 + 100)];
  const d = laneADecision({
    status: 'Ready to launch', comments, operatorId: OPERATOR, now: T0 + DAY, files: DOCS_ONLY,
  });
  assert.equal(d.act, 'ignore');
  assert.match(d.reason, /different PR/);

  const reviewed = [...comments, reviewPass(T0 + 400)];
  const next = laneADecision({
    status: 'Ready to launch', comments: reviewed, operatorId: OPERATOR, now: T0 + DAY, files: DOCS_ONLY,
  });
  assert.equal(next.act, 'announce');
  assert.equal(next.pr.number, 99);
});

test('a PR that gains a runtime file DURING the window does not merge', () => {
  // The window is an hour long and a branch can gain a commit inside it. A PR
  // that was tests-only at 8:15 and touches lib/ at 8:47 must not merge at
  // 9:15 on the strength of what it used to be.
  const comments = readyTicket({ extra: [armed(42, T0 + 10)] });
  const d = laneADecision({
    status: 'Ready to launch',
    comments,
    operatorId: OPERATOR,
    now: T0 + 10 + HOUR,
    files: [...DOCS_ONLY, 'lib/projectScope.js'],
  });
  assert.equal(d.act, 'cancel');
  assert.match(d.reason, /no longer eligible for any auto-merge lane/);
  assert.match(d.reason, /lib\/projectScope\.js/);
});

test('eligibility is re-asked at merge time, not trusted from the announcement', () => {
  // The break that this caught: an early version checked files only on the
  // announce path, so the merge path merged whatever the PR had become. This
  // assertion is the one that failed.
  const comments = readyTicket({ extra: [armed(42, T0 + 10)] });
  const d = laneADecision({
    status: 'Ready to launch', comments, operatorId: OPERATOR, now: T0 + 10 + HOUR,
  });
  assert.equal(d.act, 'need-files', 'the merge path must fetch the file list again');
});

// ── What gets said ───────────────────────────────────────────────────────────

test('the announcement names the deadline, the files, and how to stop it', () => {
  const n = announcementNotice({
    pr: { number: 42, url: 'https://github.com/o/r/pull/42' },
    files: DOCS_ONLY,
    deadlineLabel: '9:15pm EDT',
    at: '2026-08-25T20:15:00.000Z',
  });
  assert.match(n.body, /9:15pm EDT/);
  assert.match(n.body, /just comment on this ticket/i);
  for (const f of DOCS_ONLY) assert.ok(n.body.includes(f), `${f} must be listed`);
  // The body carries its own marker, so what a later pass reads and what he
  // was told are the same comment by construction.
  assert.deepEqual(parseAutoMergeMarker(n.body), { kind: 'armed', pr: 42, lane: 'A' });
  assert.deepEqual(parseAutoMergeMarker(n.marker), { kind: 'armed', pr: 42, lane: 'A' });
});

test('a cancellation says nothing merged, and promises no second announcement', () => {
  const n = cancellationNotice({
    pr: { number: 42, url: 'https://github.com/o/r/pull/42' },
    why: 'you commented on this ticket while the window was open',
    at: '2026-08-25T20:20:00.000Z',
  });
  assert.match(n.body, /Nothing was merged/i);
  assert.match(n.body, /still Ready to launch/);
  assert.match(n.body, /fresh review/);
  assert.deepEqual(parseAutoMergeMarker(n.body), { kind: 'cancelled', pr: 42, lane: 'A' });
});

test('every notice pairs its promise with the marker it writes', () => {
  // The pattern mergeOnComment.js arrived at the hard way: written apart, a
  // promise and the record of what was done drift, and on 2026-08-23 eleven
  // tickets were told "your approval still stands" beside a marker that spent
  // it. Built together, a test can assert the pairing.
  const pr = { number: 5, url: 'u' };
  const a = announcementNotice({ pr, files: ['README.md'], deadlineLabel: '1:00pm', at: 'x' });
  const c = cancellationNotice({ pr, why: 'because', at: 'x' });
  assert.equal(parseAutoMergeMarker(a.marker).kind, 'armed');
  assert.equal(parseAutoMergeMarker(c.marker).kind, 'cancelled');
  assert.ok(a.body.includes(a.marker), 'the announcement body must carry its own marker');
  assert.ok(c.body.includes(c.marker), 'the cancellation body must carry its own marker');
});

// ── The digest (standing condition 3) ────────────────────────────────────────

test('the digest posts on a quiet day, and says none', () => {
  // A silent day and a broken job must not look alike — which is the entire
  // reason this branch exists rather than an early return.
  const body = digestBody({ entries: [], sinceLabel: 'the last 24 hours' });
  assert.match(body, /\*\*none\*\*/);
  assert.match(body, /last 24 hours/);
});

test('the digest lists lane, PR and the files that qualified each merge', () => {
  const body = digestBody({
    entries: [{ lane: 'A', pr: 42, task: '86bb1', files: ['docs/a.md'] }],
    sinceLabel: 'the last 24 hours',
  });
  assert.match(body, /Lane A/);
  assert.match(body, /PR #42/);
  assert.match(body, /86bb1/);
  assert.match(body, /docs\/a\.md/);
});

test('the digest is due when it has never run, and once a day after', () => {
  assert.equal(digestDue(0, T0), true);
  assert.equal(digestDue(null, T0), true);
  assert.equal(digestDue(T0, T0 + 60_000), false);
  assert.equal(digestDue(T0, T0 + DIGEST_EVERY_MS), true);
  assert.ok(DIGEST_EVERY_MS < DAY, 'a daily digest must be due slightly under a day, or it drifts a day later each time');
});

// ── The ledger ───────────────────────────────────────────────────────────────

test('the ledger survives junk on disk without throwing', () => {
  for (const junk of [null, undefined, 'nonsense', 42, [], { merges: 'no' }]) {
    const l = asLedger(junk);
    assert.deepEqual(l.merges, []);
    assert.equal(l.disabled, null);
  }
});

test('merges accumulate and old ones are pruned', () => {
  let l = asLedger(null);
  l = ledgerAfterMerge(l, { at: T0, pr: 1 }, T0);
  l = ledgerAfterMerge(l, { at: T0 + 1000, pr: 2 }, T0 + 1000);
  assert.equal(l.merges.length, 2);

  // Three days later the old ones cannot affect a 24-hour cap and only make
  // the file grow forever.
  l = ledgerAfterMerge(l, { at: T0 + 3 * DAY, pr: 3 }, T0 + 3 * DAY);
  assert.deepEqual(l.merges.map((m) => m.pr), [3]);
});

test('mergesSince and the digest window agree', () => {
  const l = ledgerAfterMerge(
    ledgerAfterMerge(asLedger(null), { at: T0 - 2 * HOUR, pr: 1 }, T0),
    { at: T0 - 30 * HOUR, pr: 2 }, T0,
  );
  assert.deepEqual(mergesSince(l, T0 - DAY).map((m) => m.pr), [1]);
});

test('consecutive digests do not overlap — each one starts where the last one stopped', () => {
  // Review round 2 (2026-08-30): digests were 20 hours apart and each covered
  // a fixed 24, so every merge in the four-hour overlap was listed twice.
  const never = asLedger(null);
  assert.equal(digestSince(never, T0), T0 - DIGEST_WINDOW_MS, 'the first digest ever covers a day');
  const posted = ledgerAfterDigest(never, T0 - 20 * HOUR);
  assert.equal(digestSince(posted, T0), T0 - 20 * HOUR, 'a later digest starts at the previous one');

  let l = posted;
  l = ledgerAfterMerge(l, { at: T0 - 22 * HOUR, pr: 1 }, T0); // before the last digest: already reported
  l = ledgerAfterMerge(l, { at: T0 - 3 * HOUR, pr: 2 }, T0);  // since it: report now
  assert.deepEqual(mergesSince(l, digestSince(l, T0)).map((m) => m.pr), [2],
    'a merge reported by the previous digest must not be reported again');
});

test('the digest stamp advances', () => {
  assert.equal(ledgerAfterDigest(asLedger(null), T0).lastDigestAt, T0);
});

// ── The plumbing keeps its side of the bargain ───────────────────────────────

const RELAY = doorSource() || '';

test('the relay merges through the SAME gate, not a second one', (t) => {
  if (skipWithoutDoor(t)) return;
  // Acceptance criterion: "merges exactly as the operator-authorised path
  // does — same gate, same marker, same Live transition". A second merge
  // implementation would be a second set of preconditions to keep in step,
  // and the one that drifted would be the one nobody was watching.
  assert.match(RELAY, /lane: \{ name: decision\.lane \|\| 'A', decision, files: decision\.eligibility\.files \}/,
    'the lane must reach the merge through runMergeStep');
  // COUNT WHAT PERFORMS A MERGE, NOT WHAT SHARES ITS VERB. `gh pr merge
  // --auto` and `gh pr merge --disable-auto` arm and disarm GitHub's own
  // auto-merge and merge nothing themselves (task 86bbup3u1); counting them
  // as merge implementations would either fail this guard forever or, if the
  // number were simply bumped to 3, stop it noticing a genuine second merge.
  const mergeInvocations = RELAY.match(/'pr', 'merge'.*/g) || [];
  const performing = mergeInvocations.filter((line) => !/'--auto'|'--disable-auto'/.test(line));
  assert.equal(performing.length, 1,
    `there must be exactly ONE place that merges a PR, found ${performing.length}`);
  // And the arming calls really are arming: an `--auto` that lost its flag
  // would merge immediately, past every wait this path exists to respect.
  //
  // THREE since task 86bcemvj5, and each is named: arm, disarm on a stale
  // review gate, and disarm on a conflict hand-off. The third exists because a
  // PR armed before main moved under it would otherwise be landed by GitHub the
  // moment its branch is fixed, outside the merge window it just gave back.
  assert.equal(mergeInvocations.length - performing.length, 3,
    'expected exactly three auto-merge control calls (arm, disarm on a stale gate, disarm on a conflict hand-off)');
  const gateCalls = (RELAY.match(/githubGate\(/g) || []).length;
  assert.ok(gateCalls >= 1, 'the lane must not re-implement mergeability');
});

test('the relay starts the clock from the CONFIRMED post, never from local time', (t) => {
  if (skipWithoutDoor(t)) return;
  // The break this caught: an early version computed the deadline from
  // Date.now() at send time and never read the comment back, so a post that
  // silently failed still armed a window.
  assert.match(RELAY, /async function postLaneNotice/);
  assert.match(RELAY, /posted\.at \+ WINDOW_MS/,
    'the binding deadline must be derived from the confirmed post time');
  assert.match(RELAY, /nothing is armed and nothing will merge/,
    'a failed announcement must say so and arm nothing');
});

test('the relay treats an unreadable switch as OFF', (t) => {
  if (skipWithoutDoor(t)) return;
  assert.match(RELAY, /const readable = busSw\.readable && led\.ok;/,
    'both the party line and the ledger must be readable for the switch to be trusted');
  assert.match(RELAY, /readable,\n\s*\}\);/);
});

test('the relay disables the lane on an unverified pass, and says so', (t) => {
  if (skipWithoutDoor(t)) return;
  assert.match(RELAY, /selfDisableState\(\{ unchecked, mainBuildRed: mainRed, persisted: ledger\.disabled \}\)/);
  assert.match(RELAY, /AUTO-MERGE DISABLED ITSELF/);
  // The lane must run AFTER the main loop, or it would be judging a
  // half-finished account of the pass's own reliability.
  assert.ok(RELAY.indexOf('const laneCandidates = []') < RELAY.indexOf('Lane A: announce, wait one hour, merge'));
});

test('the window is never written as a literal at the call site', (t) => {
  if (skipWithoutDoor(t)) return;
  // A tuned number copied into the plumbing is how a decision he made with
  // reasons becomes a mystery number six months later.
  const laneSection = RELAY.slice(RELAY.indexOf('Lane A: announce, wait one hour, merge'));
  assert.equal(/3600000|3_600_000|60 \* 60 \* 1000/.test(laneSection), false,
    'the lane plumbing must use WINDOW_MS, not a literal hour');
});

test('--no-merge turns Lane A off with the rest', (t) => {
  if (skipWithoutDoor(t)) return;
  assert.match(RELAY, /if \(mergingAllowed\) \{\n\s*const now = Date\.now\(\);/,
    'the whole lane must sit behind the existing merge off-switch');
});

test('a paused pipeline turns Lane A off with the rest', (t) => {
  if (skipWithoutDoor(t)) return;
  // Lane A is the one merge path that needs no human word at all, so the
  // pause switch guarding it is load-bearing rather than incidental: while
  // Dane has the deck, nothing may land under him — least of all a merge
  // nobody had to authorise. The lane sits behind `mergingAllowed`, and this
  // pins what that name is actually made of. It was inherited from main by a
  // three-way merge on 2026-08-30 and nothing asserted it until now.
  assert.match(RELAY, /const mergingAllowed = mergeSwitchOn && !pauseState\.paused;/,
    'the merge off-switch must include the pipeline pause, not just --no-merge');
});

test('a lane merge threads its marker under the ANNOUNCEMENT, not an undefined comment', (t) => {
  if (skipWithoutDoor(t)) return;
  // Review round 2 (2026-08-30): laneADecision sets announcementId, never
  // commentId, so the marker POSTed to /comment/undefined/reply, failed, and
  // filed a false "could not write the dedup marker" under the very section
  // the self-disable watches. Every auto-merge would have disabled the lane.
  assert.match(RELAY, /const authorizingComment = lane \? decision\.announcementId : decision\.commentId;/);
  // The bookkeeping moved into `recordMergedTicket` (task 86bbup3u1), because
  // there are now two ways a merge ends — this pass merging, and GitHub's
  // auto-merge landing it between passes — and both owe the identical trail.
  // What this guard is about is unchanged: the marker threads under
  // `authorizingComment`, which is the announcement for a lane.
  assert.match(RELAY, /markMergeHandled\(authorizingComment, task, unchecked, record\.marker\)/,
    'the shared record path must thread the marker under the authorizing comment');
  assert.match(RELAY, /await recordMergedTicket\(mergedRecord, pr\)/,
    'the operator-authorised merge must go through the shared record path');
  assert.match(RELAY, /await recordMergedTicket\(record, pr\)/,
    'the already-merged path must go through the same shared record path');
  assert.match(RELAY, /mergedNotice\(\{\n\s*commentId: authorizingComment,/);
  const laneSection = RELAY.slice(RELAY.indexOf('async function runMergeStep'), RELAY.indexOf('function ledgerPath'));
  assert.equal(/mergedRecord\.marker[\s\S]*decision\.commentId/.test(laneSection.slice(laneSection.indexOf('MERGED PR'))), false,
    'nothing after the merge may reach for decision.commentId, which a lane never has');
});

test('a ledger that could not be read is never written over', (t) => {
  if (skipWithoutDoor(t)) return;
  // Review round 2 (2026-08-30): the end-of-pass write was `if (!dryRun &&
  // led.file) writeLedger(...)`, so a corrupt ledger was replaced with an
  // empty one and a persisted stop vanished on the next pass. The write now
  // goes through saveLedgerIfReadable, which refuses unless the read was clean.
  const laneSection = RELAY.slice(RELAY.indexOf('Lane A: announce, wait one hour, merge'));
  assert.equal(/writeLedger(File)?\(/.test(laneSection), false, 'the lane must not write the ledger directly');
  assert.match(laneSection, /saveLedgerIfReadable\(led, ledger\)/);
  assert.equal(/readFileSync|writeFileSync/.test(RELAY.slice(RELAY.indexOf('function readLedger'), RELAY.indexOf('readBusSwitchSignals'))), false,
    'ledger IO lives in autoMergeLedgerFile.js, where it is tested');
});

test('an unrecognised party-line body is UNREADABLE, not "he never said stop"', (t) => {
  if (skipWithoutDoor(t)) return;
  const fn = RELAY.slice(RELAY.indexOf('async function readBusSwitchSignals'), RELAY.indexOf('function mainBuildIsRed'));
  assert.match(fn, /if \(!messages\) \{\n\s*return \{ readable: false/);
});

test('a truncated file list is refused rather than judged', (t) => {
  if (skipWithoutDoor(t)) return;
  const fn = RELAY.slice(RELAY.indexOf('function prChangedFiles'), RELAY.indexOf('async function postLaneNotice'));
  assert.match(fn, /'files,changedFiles'/);
  assert.match(fn, /json\.changedFiles\) !== files\.length/);
});

test('a dry run announces nothing, cancels nothing and merges nothing', (t) => {
  if (skipWithoutDoor(t)) return;
  const laneSection = RELAY.slice(RELAY.indexOf('Lane A: announce, wait one hour, merge'));
  for (const phrase of [
    'DRY RUN — would announce Lane ${laneName}',
    'DRY RUN — would cancel Lane ${cancelLane}',
    'DRY RUN — would auto-merge PR',
    'DRY RUN — would post to the bus',
  ]) {
    assert.ok(laneSection.includes(phrase), `dry run must cover: ${phrase}`);
  }
});

// ── Lane B: the pipeline's own tooling (task 86bbuzyra) ─────────────────────
//
// Overnight 2026-09-03 nine pull requests merged and Lane A merged none,
// because the pipeline had spent the night building on ITSELF. Dane ruled the
// boundary on 2026-09-04: "A — scripts/, docs/ and test files only", with lib/
// explicitly excluded because server.js requires it directly.

test('a PR that is all pipeline tooling is eligible, and it is Lane B', () => {
  const r = laneEligibility([
    'scripts/builder/loopNote.js',
    'scripts/builder/loopNote.test.js',
    'scripts/weekly_report.mjs',
  ]);
  assert.equal(r.eligible, true, 'scripts/ is what Lane B exists to carry');
  assert.equal(r.lane, 'B');
  assert.match(r.reason, /pipeline's own tooling/);
});

test('tests and docs are still Lane A, not dragged into B', () => {
  // A test file inside scripts/ is one of hundreds. If it read as Lane B the
  // narrower lane would effectively stop existing, and the digest would stop
  // being able to say which risk was actually taken.
  const r = laneEligibility(['scripts/builder/loopNote.test.js', 'docs/WORK-LOG.md']);
  assert.equal(r.eligible, true);
  assert.equal(r.lane, 'A');
});

test('the widest lane any single file needs is the lane the whole PR runs in', () => {
  const r = laneEligibility(['docs/WORK-LOG.md', 'scripts/weekly_report.mjs']);
  assert.equal(r.lane, 'B', 'one tooling file makes the whole PR a Lane B merge');
});

test('every tenant-facing tree is refused, and the refusal names the file', () => {
  // Acceptance criterion 2: a test per excluded directory. These are the trees
  // a client's browser can reach, or that the live server loads.
  const excluded = [
    'lib/projectScope.js',
    'lib/builder-client/builder-template.ts',
    'lib/builder/template.js',
    'lib/authStore.js',
    'components/builder/SettingsPanel.tsx',
    'public/js/core.js',
    'src/css/main.css',
    'routes/index.js',
    'api/[...slug].js',
    'package.json',
    'vercel.json',
  ];
  for (const f of excluded) {
    const r = laneEligibility(['scripts/builder/loopNote.js', f]);
    assert.equal(r.eligible, false, `${f} must not be auto-mergeable`);
    assert.equal(r.blockedBy, f, `the refusal must name ${f}`);
    assert.equal(r.lane, null);
  }
});

test('lib/ is refused even though the doctrine table lists it under Lane B', () => {
  // The doctrine's Lane B row reads "lib/, scripts/, tooling". Dane REMOVED
  // lib/ when he chose the boundary, because server.js requires it directly
  // (lib/config, lib/environmentBanner, lib/publicSiteHosts, lib/devTeamStore)
  // and lib/builder-client bundles into a client's page. This test is here so
  // a future reader who finds the doctrine table and "fixes" the code to match
  // it fails instead.
  for (const f of ['lib/config.js', 'lib/environmentBanner.js', 'lib/publicSiteHosts.js', 'lib/devTeamStore.js']) {
    assert.equal(laneEligibility([f]).eligible, false, `${f} is loaded by server.js`);
  }
});

test('governance still blocks FIRST, and one governance file refuses the whole PR', () => {
  // Acceptance criterion 3. The order matters: a governance file that is also
  // allowed by the lane must be refused for being governance, with that reason.
  const r = laneEligibility(['scripts/builder/loopNote.js', 'scripts/builder/mergeOnComment.js']);
  assert.equal(r.eligible, false);
  assert.equal(r.blockedBy, 'scripts/builder/mergeOnComment.js');
  assert.match(r.reason, /machinery that governs merging/);
});

test('the merge machinery is governance as SOURCE, not only as tests', () => {
  // THE HOLE LANE B WOULD HAVE OPENED. Before this, only `<stem>.test.js` was
  // listed — the sources needed no rule because Lane A refused anything that
  // was not a test or a doc. Lane B makes scripts/ eligible, so the accident
  // that protected them is gone. Doctrine criterion 4: "a machine may never
  // auto-merge a change to the machinery that governs machines ... THE MERGE
  // STEP ITSELF".
  for (const f of [
    'scripts/builder/mergeOnComment.js',
    'scripts/builder/autoMergeLane.js',
    'scripts/builder/autoMergeLedgerFile.js',
    'scripts/builder/passClaim.js',
    'scripts/builder/wipCap.js',
    'scripts/builder/reviewGate.js',
    'scripts/builder/preflight.js',
    'scripts/builder/pipelinePause.js',
    'scripts/clickup_direct.mjs',
    'scripts/review_gate.mjs',
    'scripts/pipeline.mjs',
    'scripts/lib/clickup.cjs',
    'scripts/builder/clickupRetry.js',
  ]) {
    assert.ok(governanceReason(f), `${f} is machinery that governs machines`);
    assert.equal(laneEligibility([f]).eligible, false, `${f} must never auto-merge`);
  }
});

test('the retry policy inside the one ClickUp door is governance too', () => {
  // scripts/lib/clickup.cjs is governance because a change there changes every
  // automated write at once. It delegates when-to-wait-and-retry wholesale to
  // clickupRetry.js, so that file decides the same thing and must be blocked
  // with it — otherwise the door is guarded and its lock is not.
  //
  // This is not hypothetical. check:automerge-reach failed on 2026-09-05, on
  // the first catch-up merge after the shared client landed (#592): the client
  // is reachable from the server (routes/publicSite.js ->
  // lib/bugReportForward.js -> lib/clickupForward.js -> scripts/lib/clickup.cjs
  // -> scripts/builder/clickupRetry.js), which put an auto-mergeable file on a
  // live path. Blocking it as governance is the remedy that check names.
  for (const f of ['scripts/builder/clickupRetry.js', 'scripts/builder/clickupRetry.test.js']) {
    assert.ok(governanceReason(f), `${f} governs every automated ClickUp write`);
    assert.equal(laneEligibility([f]).eligible, false, `${f} must never auto-merge`);
  }
  // And it must refuse the whole PR, not just itself.
  const r = laneEligibility(['scripts/builder/loopNote.js', 'scripts/builder/clickupRetry.js']);
  assert.equal(r.eligible, false);
  assert.equal(r.blockedBy, 'scripts/builder/clickupRetry.js');
});

test('the spend policy inside the one ClickUp door is governance too', () => {
  // The SECOND crossing the reach check caught, one catch-up merge after the
  // first (2026-09-05). scripts/lib/clickup.cjs delegates *whether a call may
  // be made at all* to two files that landed with #592: clickupLedger.cjs
  // holds the machine-local spend budget and the reserve scheduled jobs leave
  // alone, and clickupCaller.cjs decides which kind of caller this process is.
  // Between them they can silence every automated ClickUp write on the machine
  // — the stop switch, the review gate and this lane's own announcements
  // included — so a change there changes every automated write at once, which
  // is the sentence that made the door itself governance.
  //
  // Reached from the server by the same path the retry policy is:
  // routes/publicSite.js -> lib/bugReportForward.js -> lib/clickupForward.js
  // -> scripts/lib/clickup.cjs -> {clickupLedger,clickupCaller}.cjs.
  for (const f of [
    'scripts/lib/clickupLedger.cjs',
    'scripts/lib/clickupCaller.cjs',
    'scripts/builder/clickupLedger.test.js',
    'scripts/builder/clickupCaller.test.js',
  ]) {
    assert.ok(governanceReason(f), `${f} governs every automated ClickUp write`);
    assert.equal(laneEligibility([f]).eligible, false, `${f} must never auto-merge`);
  }
  // And each refuses the whole PR, not just itself.
  for (const f of ['scripts/lib/clickupLedger.cjs', 'scripts/lib/clickupCaller.cjs']) {
    const mixed = laneEligibility(['scripts/builder/loopNote.js', f]);
    assert.equal(mixed.eligible, false);
    assert.equal(mixed.blockedBy, f);
  }
});

test('git hooks and shell runners are governance, though neither is a .js file', () => {
  // Doctrine criterion 4 names GIT HOOKS outright, and they live under
  // scripts/git-hooks/ with no extension at all — so no stem rule would ever
  // have matched them. Every .sh under scripts/ is a runner, an installer or a
  // schedule: what decides WHEN the automation fires, and on which machine.
  for (const f of [
    'scripts/git-hooks/pre-commit',
    'scripts/git-hooks/pre-push',
    'scripts/loop_runner.sh',
    'scripts/run_bus_relay.sh',
    'scripts/install_pipeline_pulse.sh',
    'scripts/provision_node.sh',
  ]) {
    assert.ok(governanceReason(f), `${f} governs when or whether the machines run`);
    assert.equal(laneEligibility([f]).eligible, false);
  }
});

test("the referee's and the gates' own helpers are governance too", () => {
  // REVIEW ROUND 2 ON TASK 86bbuzyra (2026-09-06). GOVERNANCE_STEMS protects
  // three kinds of machinery — the merge step, the referee that decides what a
  // review PASS is, and the gates — but only the merge step had a guard asking
  // what it IMPORTS. So the rot that guard exists to stop was still open for
  // the other two, and this branch is what exposed it: before Lane B,
  // `scripts/` was refused by accident. All five were carriable by Lane B when
  // the send-back was written; the reproduction was:
  //
  //   laneEligibility(['scripts/builder/reviewGateClickup.js'])  -> lane B
  //
  // Each decides something the machinery above then acts on, so a machine that
  // could merge one could change what the referee accepts or what a gate
  // checks, and grade itself afterwards.
  for (const f of [
    'scripts/builder/reviewGateClickup.js', // what the referee reads back from ClickUp
    'scripts/builder/clickupTicketLink.js', // what counts as "this PR names its ticket"
    'scripts/builder/loopTrail.js', // the trail the referee reads
    'scripts/lib/generated_files.cjs', // the gates' definition of a generated file
    'scripts/pin_asset_versions.cjs', // check_asset_versions' targets AND its hash
  ]) {
    assert.ok(governanceReason(f), `${f} governs what the referee or a gate decides`);
    assert.equal(laneEligibility([f]).eligible, false, `${f} must never auto-merge`);
  }
});

test('...and blocking them did NOT narrow Lane B into uselessness', () => {
  // The half that is easy to fake: an allowlist that is subtly too strict
  // refuses everything and looks exactly like the situation this ticket was
  // filed to fix. Ordinary pipeline tooling next door to all five must still
  // be carried.
  for (const f of [
    'scripts/builder/loopNote.js',
    'scripts/builder/operatorCard.js',
    'scripts/builder/buildStart.js',
    'scripts/builder/pullRequestTitle.js',
    'docs/WORK-LOG.md',
  ]) {
    assert.equal(governanceReason(f), null, `${f} is ordinary tooling, not governance`);
  }
  assert.equal(laneEligibility([
    'scripts/builder/loopNote.js',
    'scripts/builder/loopNote.test.js',
    'docs/WORK-LOG.md',
  ]).lane, 'B', 'a pipeline-internal PR must still be Lane B eligible');
});

test('the gates themselves are governance — every scripts/check_* file', (t) => {
  if (skipWithoutProductDir(t, 'gates')) return;
  const names = fs.readdirSync(productDir('gates')).filter((n) => n.startsWith('check_'));
  assert.ok(names.length >= 10, 'expected the check_* family to exist');
  for (const n of names) {
    assert.ok(governanceReason(`scripts/${n}`), `scripts/${n} is a gate and must not auto-merge`);
  }
});

test('Lane B carries only known script extensions, never anything else', () => {
  // `^scripts/` on its own carried scripts/git-hooks/pre-commit, every .sh
  // runner, and would carry a .sql migration the day somebody adds one —
  // which doctrine criterion 1 calls out as NOT reversible by a single revert.
  for (const f of ['scripts/x.test.js.bak', 'scripts/migrate.sql', 'scripts/notes.txt', 'scripts/a.yml']) {
    assert.equal(laneForFile(f), null, `${f} must not be carried by any lane`);
    assert.equal(laneEligibility([f]).eligible, false);
  }
  for (const f of ['scripts/a.js', 'scripts/a.mjs', 'scripts/a.cjs', 'scripts/fixtures/a.json']) {
    assert.equal(laneForFile(f), 'B', `${f} is ordinary pipeline tooling`);
  }
});

test('the empty file list is still refused, and still names no lane', () => {
  // Acceptance criterion 4: the vacuous-truth guard survives the widening.
  assert.equal(laneEligibility([]).eligible, false);
  assert.equal(laneEligibility([]).lane, null);
  assert.match(laneEligibility([]).reason, /no changed files/);
});

test('BREAK TEST — the lane can actually PASS, on a real PR shape', () => {
  // The ticket's own warning: "a widened lane whose allowlist is subtly wrong
  // refuses everything and looks exactly like the current situation, which is
  // the failure being fixed." A lane that only ever refuses is the bug.
  //
  // These are the files of PR #562 (Backfill the missing tags onto the three
  // imported Delray blog posts), which merged on a human's word and which this
  // lane would have carried.
  const r = laneEligibility([
    'scripts/blog_backfill_import_tags.cjs',
    'scripts/builder/blogBackfillImportTags.js',
    'scripts/builder/blogBackfillImportTags.test.js',
  ]);
  assert.equal(r.eligible, true, 'a lane that refuses everything is the bug being fixed');
  assert.equal(r.lane, 'B');
});

test('the announcement says WHICH lane, and what that lane means', () => {
  const b = announcementNotice({
    pr: { number: 9, url: 'https://github.com/o/r/pull/9' },
    files: ['scripts/weekly_report.mjs'],
    deadlineLabel: '9:15pm EDT',
    at: '2026-09-04T20:15:00.000Z',
    lane: 'B',
  });
  assert.match(b.body, /Lane B/);
  assert.match(b.body, /pipeline's own tooling/);
  assert.match(b.body, /no file\nthe live server loads/);
  assert.deepEqual(parseAutoMergeMarker(b.body), { kind: 'armed', pr: 9, lane: 'B' });
  // And Lane A's wording is untouched — he has read it before and it should
  // not change meaning under him.
  const a = announcementNotice({
    pr: { number: 9, url: 'https://github.com/o/r/pull/9' },
    files: ['docs/a.md'],
    deadlineLabel: '9:15pm EDT',
    at: '2026-09-04T20:15:00.000Z',
  });
  assert.match(a.body, /nothing but tests and documentation/);
  assert.match(a.body, /Lane A/);
});

test('auto-merge-status reports Lane B as plainly as Lane A', (t) => {
  if (skipWithoutDoor(t)) return;
  // Acceptance criterion 6.
  const status = RELAY.slice(RELAY.indexOf("console.log(`LANE A:"));
  assert.match(status, /LANE B:/, 'the new lane must appear in auto-merge-status');
  assert.match(status, /carries:/, 'each lane must say what it carries');
  assert.match(status, /check:automerge-reach/, 'the boundary guard must be named');
});

test("Dane's condition 1 shipped: the boundary cannot silently expire", (t) => {
  if (skipWithoutProductScript(t, 'automergeReachCheck')) return;
  // He attached this to choosing the boundary, in these words: "the build
  // should include a check that fails if an auto-mergeable folder becomes
  // reachable from the server. Otherwise this decision silently expires."
  const check = productScriptPath('automergeReachCheck');
  assert.ok(fs.existsSync(check), 'scripts/check_automerge_reach.cjs must exist');
  const pkg = JSON.parse(fs.readFileSync(path.join(productRoot(), 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['check:automerge-reach'], 'node scripts/check_automerge_reach.cjs');
  const ci = fs.readFileSync(path.join(productRoot(), '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /npm run check:automerge-reach/, 'the guard must run in CI, not only by hand');
});

test('this very change could not have auto-merged itself', () => {
  // Criterion 4 is not an abstraction. The files below are what this task
  // touched, and a lane that would wave them through would be a lane that can
  // widen its own permissions.
  const ownFiles = [
    'scripts/builder/autoMergeLane.js',
    'scripts/builder/autoMergeLane.test.js',
    'scripts/builder/autoMergeLedgerFile.js',
    'scripts/builder/autoMergeLedgerFile.test.js',
    'scripts/clickup_direct.mjs',
    'docs/LOOP_ENGINEERING.md',
  ];
  const r = laneAEligibility(ownFiles);
  assert.equal(r.eligible, false, 'Lane A must never be able to ship Lane A');
});

test('LOOP_ENGINEERING documents the lane, the window, the switch and the digest', (t) => {
  if (skipWithoutProductScript(t, 'loopDoc')) return;
  const doc = productScript('loopDoc') || '';
  for (const needle of [
    'Lane A',
    SWITCH_STOP,
    SWITCH_RESUME,
    'AUTO-MERGE-LANES',
    'auto-merge-status',
  ]) {
    assert.ok(doc.includes(needle), `LOOP_ENGINEERING.md must document: ${needle}`);
  }
});

// ── The editor's formatting is not part of what he said (task 86bbt038u) ─────
//
// 2026-09-01: Dane posted `resume auto-merging` on the party line three times
// and the lane stayed latched off for two days. ClickUp's message box turns a
// PASTED phrase into a fenced code block and guesses a language, so what the
// switch actually received was "```cpp\nresume auto-merging\n```". `resume`
// is matched as the WHOLE message — correctly, and that asymmetry with `stop`
// stays — so the backticks made his words unreadable.

test('a fenced resume, with the language tag ClickUp guesses, is still his word', () => {
  assert.equal(switchCommand('```cpp\nresume auto-merging\n```'), 'resume');
});

test('a fenced resume with no language tag reads the same', () => {
  assert.equal(switchCommand('```\nresume auto-merging\n```'), 'resume');
});

test('inline backticks around the phrase read the same', () => {
  assert.equal(switchCommand('`resume auto-merging`'), 'resume');
});

test('stripping the fence does NOT loosen resume into a substring match', () => {
  // The whole point of the asymmetry: a resume that fires when he was only
  // TALKING about resuming costs an unwanted merge.
  assert.equal(switchCommand('I was thinking about resume auto-merging tomorrow'), null);
  assert.equal(switchCommand('```\nremind me to resume auto-merging in the morning\n```'), null);
});

test('a fenced stop still stops', () => {
  assert.equal(switchCommand('```\nstop auto-merging\n```'), 'stop');
});

/*
 * THE LATCH (2026-09-03, task 86bbt0mz6).
 *
 * The lane latched itself off on 2026-08-30 and stayed off for two days; it
 * did it again on 2026-09-03 and stayed off 10.8 hours, found only because
 * Dane asked why nothing had merged since 6:27pm. The latch was RIGHT both
 * times. What made it undiagnosable:
 *
 *   - the stored reason kept only a COUNT, and `unchecked` holds a full
 *     English sentence for every item — all discarded at the moment of
 *     latching;
 *   - the stored sentence says "this pass", so replaying it made a
 *     ten-hour-old finding read as a live verdict, one line above the same
 *     pass reporting "0 could not be checked";
 *   - and after the first announcement, nothing ever said it was still off.
 */
const {
  ledgerAfterLatchNag, persistedLatchWhy, latchNagDue,
  LATCH_ITEM_CAP, LATCH_NAG_EVERY_MS,
} = require('./autoMergeLane.js');

const THREE = ['could not read PR #1', 'could not post to the bus', 'could not stamp the note'];

test('a latch stores the sentences themselves, not just how many there were', () => {
  const l = ledgerAfterDisable(null, 'why', 1000, { items: THREE, trigger: 'unchecked' });
  assert.deepEqual(l.disabled.items, THREE);
  assert.equal(l.disabled.droppedItems, 0);
  assert.equal(l.disabled.trigger, 'unchecked');
});

test('auto-merge-status can read those sentences back off a persisted latch', () => {
  const l = ledgerAfterDisable(null, 'why', 1000, { items: THREE, trigger: 'unchecked' });
  const d = selfDisableState({ persisted: l.disabled });
  assert.deepEqual(d.items, THREE);
  assert.equal(d.disabled, true);
  assert.equal(d.fresh, false);
});

test('the stored list is capped, and says how many it dropped', () => {
  const many = Array.from({ length: LATCH_ITEM_CAP + 7 }, (_, i) => `item ${i}`);
  const l = ledgerAfterDisable(null, 'why', 1000, { items: many, trigger: 'unchecked' });
  assert.equal(l.disabled.items.length, LATCH_ITEM_CAP);
  assert.equal(l.disabled.droppedItems, 7);
});

/*
 * BREAK-TEST: drop the `.replace(/^this pass/...)` and this fails — the
 * replayed sentence claims the CURRENT pass could not verify something, which
 * is what put "could not fully verify 4 thing(s)" and "0 could not be checked"
 * one line apart in the same log for ten hours.
 */
test('a replayed latch is re-tensed and dated, so it cannot read as this pass\'s finding', () => {
  const at = Date.UTC(2026, 8, 3, 16, 41, 10);
  const why = persistedLatchWhy({ at, why: 'this pass could not fully verify 4 thing(s), so it is not in a position to merge on its own word' });
  assert.ok(!why.startsWith('this pass'), 'a stored reason must not be replayed in the present tense');
  assert.match(why, /latched off since/);
  assert.match(why, /2026-09-03/, 'it must say WHEN, or "still broken" and "broke this morning" look alike');
});

/*
 * BREAK-TEST: return `{ due: true }` unconditionally and this fails — the nag
 * would fire on every pass, which is the "all is well x365" failure the bus
 * throttles exist to prevent, in its noisy mirror image.
 */
test('a latch under a day old does not nag', () => {
  const at = 1_000_000_000;
  const d = selfDisableState({ persisted: { at, why: 'w' } });
  assert.equal(latchNagDue({ disabled: d, now: at + 3600_000 }).due, false);
});

test('a latch still in force after a day says so again', () => {
  const at = 1_000_000_000;
  const d = selfDisableState({ persisted: { at, why: 'w' } });
  const out = latchNagDue({ disabled: d, now: at + LATCH_NAG_EVERY_MS + 1 });
  assert.equal(out.due, true);
  assert.match(out.why, /still latched/);
});

test('a FRESH latch never nags — it has just announced itself', () => {
  const d = selfDisableState({ unchecked: ['one'] });
  assert.equal(d.fresh, true);
  assert.equal(latchNagDue({ disabled: d, now: Date.now() }).due, false);
});

test('the nag clock resets only when a nag is recorded, so it is once a day and not once a pass', () => {
  const at = 1_000_000_000;
  const l0 = ledgerAfterDisable(null, 'w', at, { items: ['one'], trigger: 'unchecked' });
  const nagged = ledgerAfterLatchNag(l0, at + LATCH_NAG_EVERY_MS + 1);
  const d = selfDisableState({ persisted: nagged.disabled });
  const soonAfter = latchNagDue({ disabled: d, now: at + LATCH_NAG_EVERY_MS + 2, lastNagAt: nagged.disabled.lastNagAt });
  assert.equal(soonAfter.due, false, 'a nag just posted must not repeat on the next pass');
});

/*
 * Acceptance criterion 3. A red main is a different fact from a verification
 * failure, and reporting it as "0 things could not be verified" would send
 * whoever reads it hunting for an unchecked item that never existed.
 */
test('a latch for a RED MAIN reports that reason and is not dressed as an unchecked item', () => {
  const d = selfDisableState({ mainBuildRed: true });
  assert.equal(d.disabled, true);
  assert.equal(d.trigger, 'main-red');
  assert.deepEqual(d.items, []);
  assert.match(d.why, /red/);
  assert.ok(!/could not fully verify/.test(d.why));
});

test('a latch recorded before this change still reads, and says the sentences are gone', () => {
  const d = selfDisableState({ persisted: { at: 1000, why: 'this pass could not fully verify 4 thing(s)' } });
  assert.deepEqual(d.items, [], 'an old ledger has no items — it must not invent any');
  assert.equal(d.disabled, true);
});

const lane = require('./autoMergeLane.js');

// --- has Lane A ever merged anything? (task 86bbugeda) -----------------------
//
// `auto-merge-status` printed `LANE A: RUNNING` beside `ledger: not created
// yet` on 2026-09-03. Both lines were true and the pair reads as a working
// lane; the lane had never merged a single pull request in its life. "The gate
// is open" and "anything has ever come out of it" are different questions.

test('a lane with no ledger file has NEVER merged, and says so', () => {
  const h = lane.laneAMergeHistory({ ledger: null, fresh: true, readable: true });
  assert.equal(h.verdict, 'never');
  assert.equal(h.count, 0);
  assert.match(h.why, /NEVER merged anything/);
});

test('a lane that has merged reports how many, all-time', () => {
  let ledger = null;
  ledger = lane.ledgerAfterMerge(ledger, { pr: 101, task: 'aaa', at: 1000 }, 1000);
  ledger = lane.ledgerAfterMerge(ledger, { pr: 102, task: 'bbb', at: 2000 }, 2000);
  const h = lane.laneAMergeHistory({ ledger, fresh: false, readable: true });
  assert.equal(h.verdict, 'yes');
  assert.equal(h.count, 2);
  assert.match(h.why, /PR #102/);
});

test('pruning the rate-cap window must NOT walk the all-time count back to zero', () => {
  // THE BUG THIS PINS. `merges` is pruned to two days because it is the rate
  // cap's working set. Deriving "has it ever merged" from it would make a lane
  // that merged plenty last week read as one that has never run — the exact
  // wrong answer, arriving three days after the right one.
  const DAY = 24 * 60 * 60 * 1000;
  const t0 = Date.parse('2026-09-01T00:00:00Z');
  let ledger = lane.ledgerAfterMerge(null, { pr: 7, task: 'aaa', at: t0 }, t0);
  assert.equal(ledger.merges.length, 1);
  assert.equal(ledger.everMerged.count, 1);

  // Five days later a second merge lands. `ledgerAfterMerge` prunes the first
  // one out of the rate-cap window on the way past, so the window holds ONE
  // entry while the lane has merged TWO. Counting the window here would report
  // the wrong number forever, and would report zero on the next quiet week.
  const later = t0 + 5 * DAY;
  ledger = lane.ledgerAfterMerge(ledger, { pr: 8, task: 'bbb', at: later }, later);
  assert.equal(ledger.merges.length, 1, 'the rate-cap window has legitimately pruned the older merge');
  assert.equal(ledger.everMerged.count, 2, 'the all-time count must not be derived from the pruned window');

  // And once the window empties entirely, the lane must still read as one that
  // HAS merged — an empty two-day window does not unsay a merge that happened.
  const muchLater = later + 5 * DAY;
  const emptied = { ...ledger, merges: ledger.merges.filter((m) => muchLater - m.at < 2 * DAY) };
  assert.equal(emptied.merges.length, 0);
  const h = lane.laneAMergeHistory({ ledger: emptied, fresh: false, readable: true });
  assert.equal(h.verdict, 'yes');
  assert.equal(h.count, 2);
});

test('a ledger written before the counter existed answers CANNOT TELL, never "never"', () => {
  // Confidently wrong is the failure mode here: an old ledger with an empty
  // window is not evidence of a lane that has never run, and reporting it as
  // one would send somebody to fix a lane that works.
  const old = { version: 1, merges: [], switch: null, disabled: null, lastDigestAt: 0 };
  const h = lane.laneAMergeHistory({ ledger: old, fresh: false, readable: true });
  assert.equal(h.verdict, 'unknown');
  assert.match(h.why, /not "never"/);
});

test('an old ledger with merges still in its window reports what it can, and says the rest is unrecorded', () => {
  const old = { version: 1, merges: [{ pr: 3, at: 5 }], switch: null, disabled: null, lastDigestAt: 0 };
  const h = lane.laneAMergeHistory({ ledger: old, fresh: false, readable: true });
  assert.equal(h.verdict, 'yes');
  assert.equal(h.count, null, 'the all-time count is genuinely unknown, so it is not invented');
  assert.match(h.why, /predates the all-time counter/);
});

test('an unreadable ledger is CANNOT TELL, not a lane that has never merged', () => {
  const h = lane.laneAMergeHistory({ ledger: null, fresh: false, readable: false });
  assert.equal(h.verdict, 'unknown');
  assert.match(h.why, /could not be read/);
});

test('the all-time counter survives a round trip through asLedger', () => {
  // The normaliser drops anything it does not recognise, so a field it forgets
  // to carry is silently lost on the next write — which is how the count would
  // reset to zero on the first pass after this shipped.
  let ledger = lane.ledgerAfterMerge(null, { pr: 55, task: 'zzz', at: 1000 }, 1000);
  const reloaded = JSON.parse(JSON.stringify(ledger));
  const h = lane.laneAMergeHistory({ ledger: reloaded, fresh: false, readable: true });
  assert.equal(h.count, 1);
  assert.match(h.why, /PR #55/);
});

/*
 * THE WRAPPER IS THE EDITOR TALKING, NOT HIM (2026-09-06, task 86bbvraw4).
 *
 * Dane posted the resume three times over half an hour on 2026-09-06 and the
 * lane stayed latched off. The near-miss detector quoted what ClickUp had
 * actually stored: `**resume auto-merging**` — markdown bold he never typed,
 * carried in on a formatted copy. It took on the fourth try, with Paste and
 * Match Style.
 *
 * This is the SECOND time in six days: stripCodeFormatting was added on
 * 2026-09-01 (86bbt038u) after ClickUp wrapped the same phrase in a code
 * fence and cost two days. Fixing one wrapper at a time is how the same
 * failure keeps coming back, so these cover the class.
 *
 * The literal below is the real stored string. A hand-written approximation is
 * exactly what would have missed it.
 */
test('a resume wrapped in the editor formatting he did not type still resumes', () => {
  const wrapped = [
    ['**resume auto-merging**', 'markdown bold — the real 2026-09-06 string'],
    ['__resume auto-merging__', 'underscore bold'],
    ['*resume auto-merging*', 'italic'],
    ['~~resume auto-merging~~', 'strikethrough'],
    ['`resume auto-merging`', 'inline backticks'],
    ['```cpp\nresume auto-merging\n```', 'fenced block — the 2026-09-01 case'],
    ['​resume auto-merging​', 'zero-width spaces'],
    ['﻿resume auto-merging', 'byte order mark'],
    ['resume auto-merging', 'non-breaking space'],
    ['resume auto‑merging', 'non-breaking hyphen'],
    ['resume auto–merging', 'en dash'],
    ['**Resume Auto-Merging**', 'bold and capitalised'],
  ];
  for (const [text, why] of wrapped) {
    assert.equal(switchCommand(text), 'resume', why);
  }
});

test('stripping the wrapper does NOT loosen the whole-message rule', () => {
  // The strictness is the safety property: a resume that fires when he was
  // only TALKING about resuming costs an unwanted merge.
  assert.equal(switchCommand('I will resume auto-merging later'), null);
  assert.equal(switchCommand('resume auto-merging when CI is green'), null);
  assert.equal(switchCommand('**resume auto-merging** once #618 lands'), null);
});

test('a formatted STOP is still a stop — a stop must never be lost', () => {
  assert.equal(switchCommand('**stop auto-merging**'), 'stop');
  assert.equal(switchCommand('`stop auto-merging`'), 'stop');
  // Stop stays a SUBSTRING match, so it survives being said mid-sentence.
  assert.equal(switchCommand('please **stop auto-merging** for now'), 'stop');
});
