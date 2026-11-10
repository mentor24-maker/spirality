'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readLedgerFile, writeLedgerFile, saveLedgerIfReadable } = require('./autoMergeLedgerFile');
const {
  asLedger, ledgerAfterSwitch, killSwitchState, switchSignalsFromLedger, ledgerAfterCannotTell,
} = require('./autoMergeLane');
const { cannotTellRun } = require('./mergeOnComment');

/**
 * Review round 2 on task 86bbkw2au (2026-08-30): a corrupt ledger was being
 * replaced with an empty one at the end of the pass, which erased a persisted
 * "stop auto-merging" — so the lane halted for one pass and came back ON the
 * next. These tests are the ones that would have caught it.
 */

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'auto-merge-ledger-'));
const T0 = 1_756_000_000_000;

test('a missing ledger is a first run; a corrupt one is a fault', () => {
  const file = path.join(dir(), 'ledger.json');
  const missing = readLedgerFile(file);
  assert.equal(missing.ok, true);
  assert.equal(missing.fresh, true);

  fs.writeFileSync(file, '{"merges": [');
  const corrupt = readLedgerFile(file);
  assert.equal(corrupt.ok, false);
  assert.match(corrupt.why, /could not be read/);
  assert.deepEqual(corrupt.ledger, asLedger(null), 'an unreadable ledger reads as empty — and must therefore never be written back');

  assert.equal(readLedgerFile(null).ok, false, 'no path is a fault too');
});

test('a write is atomic and round-trips', () => {
  const file = path.join(dir(), 'ledger.json');
  const ledger = ledgerAfterSwitch(asLedger(null), { kind: 'stop', at: T0, where: 'on the party line' });
  assert.equal(writeLedgerFile(ledger, file).ok, true);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['ledger.json'], 'no temp file is left behind');
  assert.deepEqual(readLedgerFile(file).ledger, ledger);
  assert.equal(writeLedgerFile(ledger, path.join(file, 'not-a-dir', 'x.json')).ok, false, 'a failed write reports, never throws');
});

test('THE FAIL-SAFE: a corrupt ledger is not overwritten, so a persisted stop survives the pass', () => {
  const file = path.join(dir(), 'ledger.json');
  // Someone said stop. It was written down.
  const stopped = ledgerAfterSwitch(asLedger(null), { kind: 'stop', at: T0, where: 'on ticket 86bbkw2au' });
  assert.equal(writeLedgerFile(stopped, file).ok, true);
  const before = fs.readFileSync(file, 'utf8');

  // A torn write, a stray byte, whatever: the file no longer parses.
  fs.writeFileSync(file, `${before}garbage`);
  const read = readLedgerFile(file);
  assert.equal(read.ok, false);

  // The pass runs on the empty ledger it got back and tries to save it.
  const saved = saveLedgerIfReadable(read, read.ledger);
  assert.equal(saved.ok, false);
  assert.equal(saved.skipped, true);
  assert.match(saved.why, /NOT written/);
  assert.equal(fs.readFileSync(file, 'utf8'), `${before}garbage`, 'the corrupt file is left for a hand to look at, not replaced');

  // And the switch that pass computes from an unreadable ledger is OFF — the
  // pure module's side of the same promise.
  assert.equal(killSwitchState({ signals: switchSignalsFromLedger(read.ledger), readable: read.ok }).state, 'off');
});

test('a clean read saves normally, and a missing path is refused', () => {
  const file = path.join(dir(), 'ledger.json');
  const read = readLedgerFile(file);
  const ledger = ledgerAfterSwitch(asLedger(null), { kind: 'resume', at: T0 });
  assert.equal(saveLedgerIfReadable(read, ledger).ok, true);
  assert.deepEqual(readLedgerFile(file).ledger, ledger);
  assert.equal(saveLedgerIfReadable({ ok: true, file: null }, ledger).ok, false);
});

// ── The CANNOT TELL run survives a round trip (2026-09-04, task 86bbuvd50) ──
//
// THIS IS THE TEST THE WHOLE SECOND HALF OF THE TICKET TURNED ON, and it is
// here rather than in autoMergeLane.test.js because only a real write and a
// real read back can catch what it catches. `asLedger` REBUILDS the ledger
// from a fixed list of keys, so an unnamed key is dropped on every read — the
// counter would reset every pass, the bound would never be reached, and every
// in-memory test would still pass. The first pass on this ticket stopped at
// exactly this trap and wrote it down rather than guessing past it.

test('a stored CANNOT TELL run survives write-then-read — the whitelist test', () => {
  const file = path.join(dir(), 'ledger.json');
  // EVERY FIELD, not just the key. `headSha` is what identifies the block
  // since review round 1, so a field dropped here is a run that can never be
  // recognised as continuing — the counter resets every pass and the alarm
  // never fires, while every in-memory test still passes.
  const run = {
    pr: 604, headSha: '4dd9729b', reason: 'CANNOT TELL — github and git disagree',
    rewordings: 3, firstSeenAt: T0, passes: 5, escalatedAt: null,
  };
  const ledger = ledgerAfterCannotTell(asLedger(null), '86bbuvd50', run);
  assert.equal(writeLedgerFile(ledger, file).ok, true);

  const back = readLedgerFile(file);
  assert.equal(back.ok, true);
  assert.deepEqual(back.ledger.cannotTell['86bbuvd50'], run,
    'the run came back changed or empty — asLedger is a whitelist, so a new key must be named in it');
});

test('an escalated run keeps its escalatedAt across the pass boundary, so it stays quiet', () => {
  // The quiet half of the bound is only real if the stamp PERSISTS. In memory
  // it always does; on disk it does only because the key is whitelisted.
  const file = path.join(dir(), 'ledger.json');
  const escalated = { pr: 7, reason: 'CANNOT TELL — x', firstSeenAt: T0, passes: 9, escalatedAt: T0 + 90 * 60_000 };
  assert.equal(writeLedgerFile(ledgerAfterCannotTell(asLedger(null), 't1', escalated), file).ok, true);
  assert.equal(readLedgerFile(file).ledger.cannotTell.t1.escalatedAt, T0 + 90 * 60_000);
});

test('a cleared run leaves NO residue on disk', () => {
  const file = path.join(dir(), 'ledger.json');
  const stuck = ledgerAfterCannotTell(asLedger(null), 't1', { pr: 7, reason: 'r', firstSeenAt: T0, passes: 3, escalatedAt: null });
  assert.equal(writeLedgerFile(stuck, file).ok, true);
  const cleared = ledgerAfterCannotTell(readLedgerFile(file).ledger, 't1', null);
  assert.equal(writeLedgerFile(cleared, file).ok, true);
  assert.deepEqual(readLedgerFile(file).ledger.cannotTell, {},
    'a resolved wobble must not leave the next block starting half-way to an alarm');
});

test('the runs ride alongside the rate cap and the switch, never over them', () => {
  // One file, several independent records. A write of one must not blank another.
  const file = path.join(dir(), 'ledger.json');
  const stopped = ledgerAfterSwitch(asLedger(null), { kind: 'stop', at: T0, where: 'on the party line' });
  const both = ledgerAfterCannotTell(stopped, 't1', { pr: 7, reason: 'r', firstSeenAt: T0, passes: 1, escalatedAt: null });
  assert.equal(writeLedgerFile(both, file).ok, true);
  const back = readLedgerFile(file).ledger;
  assert.equal(back.switch.kind, 'stop', 'the persisted stop must survive a cannot-tell write');
  assert.equal(back.cannotTell.t1.passes, 1);
});

test('junk in the stored runs is dropped, never thrown on', () => {
  for (const junk of [null, 'a string', 42, ['an array']]) {
    assert.deepEqual(asLedger({ cannotTell: junk }).cannotTell, {}, `cannotTell: ${JSON.stringify(junk)}`);
  }
  assert.deepEqual(asLedger({ cannotTell: { good: { reason: 'r' }, bad: 'not an object', worse: null } }).cannotTell,
    { good: { pr: null, headSha: null, reason: 'r', rewordings: undefined, firstSeenAt: undefined, passes: undefined, escalatedAt: null } },
    'one bad entry must not take the good ones with it');
});

/**
 * THE END-TO-END PROOF, and the one thing neither half could show alone.
 *
 * The decision function is pure and its tests build `prev` in memory; the
 * round-trip tests above write a record and read it back. Only both together
 * answer the question the ticket actually asked — does the relay say this
 * ONCE across real pass boundaries? — because the quiet depends entirely on an
 * `escalatedAt` surviving a file it is read out of ten minutes later.
 *
 * This drives the same loop the relay runs: read the ledger, decide, write it
 * back, repeat, on a real file, at the relay's real ten-minute cadence.
 */
function drivePasses({ file, taskId, pr, headSha = 'aa11bb22', verdicts, startAt, everyMs = 10 * 60_000 }) {
  const posts = [];
  verdicts.forEach((v, i) => {
    const now = startAt + i * everyMs;
    const read = readLedgerFile(file);
    // WHAT THE RELAY DOES, line for line: read the stored run, hand it the
    // reading and the identity, write back whatever comes out. The "is this
    // the same block" question lives in cannotTellRun, not here — it used to
    // be duplicated in this driver AND in the relay, which is two places to
    // fix and one of them would have been missed.
    const run = cannotTellRun({
      prev: read.ledger.cannotTell[taskId] || null,
      verdict: v === null ? '' : v,
      isCannotTell: v !== null,
      identity: { pr, headSha },
      now,
    });
    if (run.escalate) posts.push({ pass: i + 1, atMs: now, reason: run.reason });
    assert.equal(saveLedgerIfReadable(read, ledgerAfterCannotTell(read.ledger, taskId, run.next)).ok, true);
  });
  return posts;
}

const STUCK = 'CANNOT TELL — GitHub reports this branch as CONFLICTING, but git merges it cleanly';

test('ACROSS REAL PASSES: an unchanging cannot-tell escalates exactly once, then goes quiet', () => {
  const file = path.join(dir(), 'ledger.json');
  // Twenty passes, ten minutes apart: three hours and ten minutes of the same
  // answer. That is the shape of the 2026-09-04 blocks, which ran 2h07m to
  // 2h39m before an agent session unstuck them.
  const posts = drivePasses({ file, taskId: 't1', pr: 604, verdicts: Array(20).fill(STUCK), startAt: T0 });

  assert.equal(posts.length, 1, `escalated ${posts.length} times — the bound must speak once, not once per pass`);
  // Ten-minute passes, so the first pass at or past 90 minutes is the tenth.
  assert.equal(posts[0].pass, 10);
  assert.equal(posts[0].atMs - T0, 90 * 60_000, 'and not a pass earlier — 90 minutes is the measured threshold');
  assert.match(posts[0].reason, /1h 30m/);
  assert.match(posts[0].reason, /10 pass\(es\)/);
  // Passes 11 through 20 — the ticket asked specifically for a sixth, seventh
  // and eighth silent pass; this is ten of them.
  assert.equal(readLedgerFile(file).ledger.cannotTell.t1.passes, 20, 'it keeps counting while silent');
});

test('ACROSS REAL PASSES: a NEW COMMIT resets the clock and may escalate on its own merits', () => {
  const file = path.join(dir(), 'ledger.json');
  // Stuck for two hours on one commit (escalates once), then somebody pushes
  // and it is stuck again on the new one. That second wall is genuinely new
  // and gets its own 90 minutes and its own message.
  const first = drivePasses({ file, taskId: 't1', pr: 604, headSha: 'aaaa1111', verdicts: Array(12).fill(STUCK), startAt: T0 });
  const second = drivePasses({
    file, taskId: 't1', pr: 604, headSha: 'bbbb2222',
    verdicts: Array(12).fill('CANNOT TELL — a required check has never reported'),
    startAt: T0 + 120 * 60_000,
  });
  assert.equal(first.length, 1, 'the first wall spoke once');
  assert.equal(first[0].pass, 10);
  assert.equal(second.length, 1, 'a new commit deserves its own message');
  assert.equal(second[0].pass, 10, 'the second run started its own 90-minute clock at the push');
  assert.match(second[0].reason, /a required check has never reported/);
});

test('ACROSS REAL PASSES: THE SEND-BACK — an alternating wording is ONE block, and it speaks', () => {
  const file = path.join(dir(), 'ledger.json');
  // The defect review round 1 found, driven over a real file: GitHub gives two
  // wordings for one fact, interleaved. Under the prose grain the clock reset
  // on nearly every pass and the alarm was never reachable at all — on this
  // sequence it posted NOTHING across three hours.
  const COMPUTING = 'CANNOT TELL yet — GitHub is still computing whether the branch merges cleanly';
  const verdicts = [STUCK, COMPUTING, STUCK, STUCK, COMPUTING, STUCK, COMPUTING, COMPUTING,
    STUCK, COMPUTING, STUCK, STUCK, COMPUTING, STUCK, STUCK, COMPUTING, STUCK, STUCK];
  const posts = drivePasses({ file, taskId: 't1', pr: 604, verdicts, startAt: T0 });

  assert.equal(posts.length, 1, `escalated ${posts.length} times on an alternating verdict — it must speak exactly once`);
  assert.equal(posts[0].pass, 10, 'at ninety minutes, the same as an unchanging one');
  assert.match(posts[0].reason, /reworded itself \d+ time/, 'and it must say GitHub kept changing its answer');
  assert.match(posts[0].reason, /still computing/, 'quoting the NEWEST wording, not the first');
  const run = readLedgerFile(file).ledger.cannotTell.t1;
  assert.equal(run.passes, 18, 'the count ran through every reword');
  assert.equal(run.firstSeenAt, T0, 'and the clock never restarted');
});

test('ACROSS REAL PASSES: a verdict that CLEARS leaves no residue — the next block starts from zero', () => {
  const file = path.join(dir(), 'ledger.json');
  const posts = drivePasses({
    file,
    taskId: 't1',
    pr: 604,
    // Stuck 80 minutes (never escalates), clears, then stuck again with the
    // SAME wording. If the first run leaked, the second would alarm at once.
    verdicts: [...Array(8).fill(STUCK), null, ...Array(8).fill(STUCK)],
    startAt: T0,
  });
  assert.deepEqual(posts, [], 'neither run reached 90 minutes, so nothing may be said');
  const run = readLedgerFile(file).ledger.cannotTell.t1;
  assert.equal(run.passes, 8, 'the second run counted from one, not from nine');
});

test('ACROSS REAL PASSES: a new PR on the same ticket is a new block, not a continuing one', () => {
  const file = path.join(dir(), 'ledger.json');
  // Two hours stuck on #604 — escalated. The PR is closed and reopened as
  // #605, same wording. That branch has been stuck for one pass, not twelve.
  drivePasses({ file, taskId: 't1', pr: 604, verdicts: Array(12).fill(STUCK), startAt: T0 });
  const before = readLedgerFile(file).ledger.cannotTell.t1;
  assert.ok(before.escalatedAt, 'the first block did escalate');

  const posts = drivePasses({ file, taskId: 't1', pr: 605, headSha: 'cccc3333', verdicts: Array(3).fill(STUCK), startAt: T0 + 200 * 60_000 });
  assert.deepEqual(posts, [], 'thirty minutes on a fresh PR is not an alarm');
  const after = readLedgerFile(file).ledger.cannotTell.t1;
  assert.equal(after.pr, 605);
  assert.equal(after.passes, 3, 'the count restarted with the pull request');
  assert.equal(after.escalatedAt, null, 'and the old escalation did not silence the new block');
});
