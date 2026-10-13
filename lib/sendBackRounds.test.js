'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ESCALATE_AT_ROUND, LOOP_NOTE_MAX,
  isSendBack, reasonOf, sendBacks, priorSendBackCount,
  nextRound, currentRound, wouldEscalate, roundSummaryLines, truncateReason,
} = require('./sendBackRounds.js');
const { verdictComment } = require('./loopTrail.js');
const { loopNote } = require('./loopNote.js');

/** A ClickUp comment as the API hands it back. */
let seq = 0;
const comment = (text, date) => ({ id: String(++seq), date: String(date), comment_text: text });
/** A send-back written the way the loop actually writes one. */
const sentBack = (reason, date) => comment(verdictComment(false, reason), date);
const passed = (note, date) => comment(verdictComment(true, note), date);

test('a send-back is a review verdict that is not a pass — the two shapes the loop writes', () => {
  assert.equal(isSendBack('REVIEW: sent back to Queued — the docs contradict it'), true);
  assert.equal(isSendBack('REVIEW: PASSED — ran every gate'), false);
  assert.equal(isSendBack('I sent back the other one yesterday'), false, 'prose about a send-back is not a verdict');
  assert.equal(isSendBack(''), false);
});

test('a first send-back is round 1 — never round 0, and never a marker on a ticket with no history', () => {
  assert.equal(nextRound([]), 1);
  assert.equal(priorSendBackCount([]), 0);
  assert.equal(nextRound([passed('all green', 1000)]), 1, 'a pass is not a round');
});

test('a ticket with two prior send-backs stamps round 3', () => {
  const history = [
    sentBack('the tenancy columns are missing', 1000),
    passed('came back green', 1500),
    sentBack('the safety property is inverted', 2000),
  ];
  assert.equal(priorSendBackCount(history), 2);
  assert.equal(nextRound(history), 3);
});

test('the rounds are numbered oldest-first, whatever order the comments arrive in', () => {
  // ClickUp does not promise an order, and the round numbers are the whole
  // point — reading them backwards would tell Dane round 1 found what round 3
  // found.
  const history = [
    sentBack('third finding', 3000),
    sentBack('first finding', 1000),
    sentBack('second finding', 2000),
  ];
  assert.deepEqual(sendBacks(history).map((s) => [s.round, s.reason]), [
    [1, 'first finding'],
    [2, 'second finding'],
    [3, 'third finding'],
  ]);
});

test('the reason is the clause the verdict carried, first line only', () => {
  assert.equal(reasonOf('REVIEW: sent back to Queued — three docs now contradict the change'),
    'three docs now contradict the change');
  assert.equal(
    reasonOf('REVIEW: sent back to Queued — the short why\n\nthe long detail\nover several lines'),
    'the short why',
    'only the first line is a reason; the rest belongs on the ticket, not the board');
  assert.equal(reasonOf('REVIEW: sent back to Queued'), '', 'a verdict with no reason reports none');
});

test('the escalation threshold: three send-backs is fine, the fourth escalates', () => {
  // The break-test the ticket asks for, at the boundary in both directions.
  const rounds = (n) => Array.from({ length: n }, (_, i) => sentBack(`finding ${i + 1}`, 1000 * (i + 1)));
  assert.equal(wouldEscalate(rounds(0)), false, 'a fresh ticket must never escalate');
  assert.equal(wouldEscalate(rounds(1)), false);
  assert.equal(wouldEscalate(rounds(2)), false, 'two rounds is ordinary and healthy');
  assert.equal(wouldEscalate(rounds(3)), true, 'a FOURTH send-back is the one that escalates');
  assert.equal(nextRound(rounds(3)), ESCALATE_AT_ROUND);
});

test('a ticket already past the threshold stays escalating — the guard never lapses', () => {
  // `>=`, not `===`. An override (--fourth-round-anyway) or a hand-written
  // verdict must not carry a ticket past the threshold and leave it unguarded
  // from then on.
  const many = Array.from({ length: 6 }, (_, i) => sentBack(`finding ${i + 1}`, 1000 * (i + 1)));
  assert.equal(wouldEscalate(many), true);
});

test('the escalation summary names what EACH round found, one line each', () => {
  const history = [
    sentBack('the tenancy columns are missing', 1000),
    sentBack('the safety property is inverted', 2000),
    sentBack('three docs now contradict the change', 3000),
  ];
  assert.deepEqual(roundSummaryLines(history), [
    'Round 1: the tenancy columns are missing',
    'Round 2: the safety property is inverted',
    'Round 3: three docs now contradict the change',
  ]);
});

test('a round whose verdict carried no reason says so rather than rendering an empty bullet', () => {
  assert.deepEqual(roundSummaryLines([sentBack('', 1000)]), ['Round 1: (the verdict recorded no reason)']);
});

test('currentRound is the round already recorded, for the note stamped after the verdict', () => {
  const history = [sentBack('one', 1000), sentBack('two', 2000)];
  assert.equal(currentRound(history), 2, 'the send-back just written IS round 2');
  assert.equal(nextRound(history), 3, 'a further one would be round 3');
});

test('the loop note reads as the ticket specified it', () => {
  assert.equal(
    loopNote('sent-back', { at: '12:28pm', round: 3, reason: 'three docs now contradict the change' }),
    '↩ round 3 — three docs now contradict the change (12:28pm)');
});

test('a long reason is truncated to fit — the round and the clock survive, the reason gives way', () => {
  const note = loopNote('sent-back', {
    at: '12:28pm',
    round: 12,
    reason: 'a reason so long it could not possibly fit inside a ClickUp short-text field. '.repeat(12),
  });
  assert.ok(note.length <= LOOP_NOTE_MAX, `note is ${note.length} chars, over the ${LOOP_NOTE_MAX} limit`);
  assert.match(note, /^↩ round 12 — /, 'the round survives at full length');
  assert.match(note, /\(12:28pm\)$/, 'so does the clock');
  assert.match(note, /…/, 'the cut is visible, not silent');
});

test('a reason with nothing left to cut degrades to an ellipsis, never to a mangled round', () => {
  assert.equal(truncateReason('anything at all', 1), '…');
  assert.equal(truncateReason('anything at all', 0), '');
  assert.equal(truncateReason('short', 40), 'short');
});

test('a send-back with no reason keeps the old wording as its clause', () => {
  assert.equal(loopNote('sent-back', { at: '11:05am', round: 1 }),
    '↩ round 1 — returned to the line with notes for the builder (11:05am)');
});

test('a send-back note without a round is REFUSED — a failed derivation must not look like an old note', () => {
  assert.throws(() => loopNote('sent-back', { at: '11:05am' }), /needs the round number/);
  assert.throws(() => loopNote('sent-back', { at: '11:05am', round: 0 }), /needs the round number/);
});

test('a ticket that has never been sent back is untouched — no round marker anywhere else', () => {
  // Criterion 5: this must not become a way for normal work to get stuck.
  assert.equal(loopNote('claimed', { at: '10:12am' }), '🔨 building — claimed 10:12am');
  assert.equal(loopNote('pr-open', { at: '10:20am', pr: 351 }), '🔀 PR #351 open — waiting for a review pass (10:20am)');
  assert.equal(loopNote('verified', { at: '11:00am' }), '👀 verified — waiting on Dane to say "merge" (11:00am)');
  assert.equal(loopNote('escalated', { at: '9:00am' }), '🙋 needs Dane — a question is waiting (9:00am)');
  assert.equal(loopNote('merged', { at: '8/20' }), '✅ live 8/20');
});

test('the round survives the exact shape the loop writes, end to end', () => {
  // Writer and reader in one test: verdictComment renders it, sendBackRounds
  // counts it, loopNote states it. If any of the three drifts, this fails.
  const history = [sentBack('the tenancy columns are missing', 1000), sentBack('a doc now contradicts it', 2000)];
  const round = currentRound(history);
  const reason = sendBacks(history)[round - 1].reason;
  assert.equal(loopNote('sent-back', { at: '1:00pm', round, reason }),
    '↩ round 2 — a doc now contradicts it (1:00pm)');
});
