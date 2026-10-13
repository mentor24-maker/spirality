'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  WAITING, NOT_WAITING, CANNOT_TELL,
  newestComment, operatorSpokeLast, waitingVerdict, verdictFromStatusAlone, verdictLine,
  excerpt, renderTicket, exitCodeFor, sweepSummary,
} = require('./waitingOnOperator.js');

/**
 * 2026-08-23: two confident, wrong claims about what was waiting on Dane, an
 * hour apart, and he acted on both. The cases below are those two, plus the
 * boundaries the verdict has to hold at.
 */

const DANE = 48012725;
const OPS = { operatorId: DANE };

/** A comment in the shape ClickUp returns it. */
const c = (id, userId, username, text, date) => ({
  id: String(id),
  user: { id: userId, username },
  comment_text: text,
  date: String(date),
});

const daneSays = (id, text, date) => c(id, DANE, 'Dane', text, date);
const machineSays = (id, text, date) => c(id, 90101010, 'CC-starcaster', text, date);

const task = (status, { assigned = false, name = 'a ticket' } = {}) => ({
  id: '86bbjve6b',
  name,
  status: { status },
  assignees: assigned ? [{ id: DANE, username: 'Dane' }] : [],
});

// ---------------------------------------------------------------------------
// The real case, criterion 3: 86bbjve6b as it actually stood.
// ---------------------------------------------------------------------------

/**
 * The ticket that produced "The YouTube worker decision is the one thing
 * waiting on you." He had answered `A` an hour before, and the relay had
 * already cleared his name and moved the ticket to Queued. Its newest comment
 * is his own one-letter answer — which is the fact that settles it.
 */
const YOUTUBE_SLICE_3 = {
  task: { ...task('queued'), name: 'Acquire YouTube slice 3/4' },
  comments: [
    machineSays(1, 'PR opened: https://github.com/mentor24-maker/starcaster/pull/419', 1_724_000_000_000),
    machineSays(2, 'NEEDED FROM DANE: pick where the worker lives. A — the Mac Mini. B — fly.io.', 1_724_003_000_000),
    daneSays(3, 'A', 1_724_006_600_000),
  ],
};

test('the real case: his own "A" is the newest comment, so nothing is waiting on him', () => {
  const out = waitingVerdict(YOUTUBE_SLICE_3, OPS);
  assert.equal(out.verdict, NOT_WAITING);
  assert.match(verdictLine(out), /NOT waiting on Dane/);
  assert.equal(out.facts.lastWord.isOperator, true);
  assert.equal(out.facts.lastWord.text, 'A');
});

test('his newest comment wins even in his own lane, still assigned to him', () => {
  // The break-it-on-purpose case the ticket names: if this ever returns
  // WAITING, the whole command has stopped protecting against the thing it
  // was built for — an answered ticket asked a second time.
  const out = waitingVerdict({
    task: task('needs your input', { assigned: true }),
    comments: [
      machineSays(1, 'NEEDED FROM DANE: A or B?', 1_000),
      daneSays(2, 'A', 2_000),
    ],
  }, OPS);
  assert.equal(out.verdict, NOT_WAITING, 'a ticket he has already answered must never read as waiting on him');
});

test('a machine comment AFTER his answer still does not put it back on him', () => {
  // 86bbjve6b would look like this once the relay files its receipt: the
  // newest comment is the machine's, but the status has left his lane, and
  // that second rule has to hold on its own.
  const out = waitingVerdict({
    task: task('queued'),
    comments: [
      daneSays(1, 'A', 1_000),
      machineSays(2, 'Your answer was read and picked up. Handed back to Queued.', 2_000),
    ],
  }, OPS);
  assert.equal(out.verdict, NOT_WAITING);
  assert.match(out.why, /machine status/);
});

// ---------------------------------------------------------------------------
// The other wrong claim: seventeen "waiting on your merge word"
// ---------------------------------------------------------------------------

test('ready to launch, assigned, machine had the last word — genuinely waiting', () => {
  const out = waitingVerdict({
    task: task('ready to launch', { assigned: true }),
    comments: [machineSays(1, 'REVIEW: PASS. PR #362 is green.', 1_000)],
  }, OPS);
  assert.equal(out.verdict, WAITING);
  assert.match(verdictLine(out), /^WAITING ON DANE/);
});

test('ready to launch where he already said merge — waiting on the machine, not him', () => {
  // Eleven of the seventeen were exactly this: his approval already given,
  // the ticket stuck on a machine that could not push to GitHub.
  const out = waitingVerdict({
    task: task('ready to launch', { assigned: true }),
    comments: [
      machineSays(1, 'REVIEW: PASS.', 1_000),
      daneSays(2, 'merge', 2_000),
    ],
  }, OPS);
  assert.equal(out.verdict, NOT_WAITING);
});

test('needs your input, assigned, no comments at all — waiting on him', () => {
  const out = waitingVerdict({
    task: task('needs your input', { assigned: true }),
    comments: [],
  }, OPS);
  assert.equal(out.verdict, WAITING);
  assert.equal(out.facts.lastWord.none, true);
});

// ---------------------------------------------------------------------------
// Never guess (criterion 4, DOCTRINE 3.11)
// ---------------------------------------------------------------------------

test('an unread ticket is CANNOT TELL, never a quiet "not waiting"', () => {
  const out = waitingVerdict({ task: null, comments: [] }, OPS);
  assert.equal(out.verdict, CANNOT_TELL);
  assert.match(out.why, /could not be read/);
});

test('unread comments are CANNOT TELL — a failed read is not an empty one', () => {
  const out = waitingVerdict({ task: task('needs your input', { assigned: true }), comments: null }, OPS);
  assert.equal(out.verdict, CANNOT_TELL);
  assert.match(out.why, /comments could not be read/);
});

test('a missing assignees array is CANNOT TELL, not "nobody is assigned"', () => {
  const partial = { id: '1', name: 'x', status: { status: 'needs your input' } };
  const out = waitingVerdict({ task: partial, comments: [] }, OPS);
  assert.equal(out.verdict, CANNOT_TELL);
  assert.match(out.why, /assignees could not be read/);
});

test('a ticket with no readable status is CANNOT TELL', () => {
  const out = waitingVerdict({ task: { id: '1', assignees: [] }, comments: [] }, OPS);
  assert.equal(out.verdict, CANNOT_TELL);
  assert.match(out.why, /no readable status/);
});

test('his lane but not assigned is a half-finished handoff, not a verdict', () => {
  const out = waitingVerdict({
    task: task('needs your input', { assigned: false }),
    comments: [machineSays(1, 'NEEDED FROM DANE: A or B?', 1_000)],
  }, OPS);
  assert.equal(out.verdict, CANNOT_TELL);
  assert.match(out.why, /NOT assigned/);
  assert.match(out.why, /Fix the assignment/);
});

// ---------------------------------------------------------------------------
// The pieces
// ---------------------------------------------------------------------------

test('newest comment is picked by date, not by the order the API happened to return', () => {
  const shuffled = [
    machineSays(2, 'second', 2_000),
    daneSays(3, 'third', 3_000),
    machineSays(1, 'first', 1_000),
  ];
  assert.equal(newestComment(shuffled, OPS).text, 'third');
  assert.equal(operatorSpokeLast(shuffled, OPS), true);
});

test('newestComment separates "read failed" from "no comments"', () => {
  assert.equal(newestComment(null, OPS), null);
  assert.equal(newestComment([], OPS).none, true);
  assert.equal(operatorSpokeLast(null, OPS), false);
  assert.equal(operatorSpokeLast([], OPS), false);
});

test('a comment from someone else with no user id is not mistaken for his', () => {
  const anon = [{ id: '9', comment_text: 'hi', date: '5000' }];
  assert.equal(operatorSpokeLast(anon, OPS), false);
});

test('excerpt flattens and truncates, and says so when a comment is empty', () => {
  assert.equal(excerpt('A'), 'A');
  assert.equal(excerpt('  two   lines\nhere '), 'two lines here');
  assert.equal(excerpt(''), '(empty)');
  assert.equal(excerpt('x'.repeat(80)).length, 60);
  assert.ok(excerpt('x'.repeat(80)).endsWith('…'));
});

test('exit codes: 0 carry on, 3 it is his, 1 could not tell — and 1 outranks 3', () => {
  assert.equal(exitCodeFor([NOT_WAITING, NOT_WAITING]), 0);
  assert.equal(exitCodeFor([NOT_WAITING, WAITING]), 3);
  assert.equal(exitCodeFor([WAITING, CANNOT_TELL]), 1);
  assert.equal(exitCodeFor(CANNOT_TELL), 1);
  assert.equal(exitCodeFor([]), 0);
});

test('the sweep summary always says how many it checked', () => {
  assert.match(sweepSummary({ checked: 0, waiting: 0, cannotTell: 0 }), /checked 0 open ticket\(s\)/);
  assert.match(sweepSummary({ checked: 12, waiting: 2, cannotTell: 0 }), /^2 ticket\(s\) waiting on Dane — checked 12/);
  assert.match(sweepSummary({ checked: 12, waiting: 0, cannotTell: 3 }), /3 could NOT be decided/);
  assert.match(
    sweepSummary({ checked: 5, waiting: 0, cannotTell: 0, lists: ['Agent Response', 'Loop Queue'] }),
    /across Agent Response \+ Loop Queue/,
  );
});

test('the printed block carries the three facts and the verdict', () => {
  const result = waitingVerdict(YOUTUBE_SLICE_3, OPS);
  const block = renderTicket(
    { id: '86bbjve6b', name: 'Acquire YouTube slice 3/4', result },
    { formatWhen: () => '2026-08-23 8:11pm' },
  );
  assert.equal(block, [
    '86bbjve6b  Acquire YouTube slice 3/4',
    '  status:     queued',
    '  assignee:   (not Dane)',
    '  last word:  Dane, "A", 2026-08-23 8:11pm',
    '  VERDICT:    NOT waiting on Dane — his own comment is the newest word on it — '
      + 'a machine owes the next move, whatever the status says',
  ].join('\n'));
});

test('an unreadable ticket still prints a block, and it says so on every line', () => {
  const result = waitingVerdict({ task: null, comments: null }, OPS);
  const block = renderTicket({ id: '86bbxxxxx', name: 'a ticket', result }, {});
  assert.match(block, /status:     \(unreadable\)/);
  assert.match(block, /assignee:   \(unreadable\)/);
  assert.match(block, /last word:  \(unreadable\)/);
  assert.match(block, /VERDICT:    CANNOT TELL/);
});

// ---------------------------------------------------------------------------
// The sweep's shortcut, pinned against the full verdict
// ---------------------------------------------------------------------------

test('the status-alone shortcut agrees with the full verdict for EVERY comment shape', () => {
  // The sweep skips the comment read on machine-status tickets. That is only
  // sound if the comments genuinely cannot change the answer — so check it
  // rather than reason about it, on both shapes that matter: his comment
  // newest, and a machine's.
  const shapes = {
    'his comment newest': [machineSays(1, 'asked', 1_000), daneSays(2, 'A', 2_000)],
    'a machine comment newest': [daneSays(1, 'A', 1_000), machineSays(2, 'picked up', 2_000)],
    'no comments': [],
  };
  for (const status of ['queued', 'building', 'in review', 'live']) {
    for (const [shape, comments] of Object.entries(shapes)) {
      for (const assigned of [true, false]) {
        const t = task(status, { assigned });
        const short = verdictFromStatusAlone(t, OPS);
        const full = waitingVerdict({ task: t, comments }, OPS);
        assert.ok(short, `${status} should be decidable from the status alone`);
        assert.equal(short.verdict, full.verdict, `${status} / ${shape} / assigned=${assigned}`);
      }
    }
  }
});

test('the shortcut and the full verdict agree on a PARTIAL read too', () => {
  // The agreement test above called itself pinned but only ever fed shapes
  // where both halves were readable, so this divergence sat under it: a task
  // whose `assignees` array never arrived is a partial read, and the full
  // verdict stops on it before the machine-status rule. The shortcut used to
  // answer NOT_WAITING for the same ticket — so `waiting` and `waiting --task`
  // gave two different answers about one ticket, which is precisely the
  // "stated with confidence" failure this module exists to remove.
  const partial = { id: '86bbjve6b', name: 'a partial read', status: { status: 'queued' } };
  const short = verdictFromStatusAlone(partial, OPS);
  const full = waitingVerdict({ task: partial, comments: [] }, OPS);
  assert.equal(short.verdict, CANNOT_TELL, 'a partial read is never settled by the status alone');
  assert.equal(short.verdict, full.verdict, 'the sweep and --task must not disagree about one ticket');
  assert.equal(short.why, full.why, 'and must give the same reason, so the two outputs read alike');
});

test('the shortcut refuses to answer for his own lane — those need the comments', () => {
  assert.equal(verdictFromStatusAlone(task('needs your input', { assigned: true }), OPS), null);
  assert.equal(verdictFromStatusAlone(task('ready to launch', { assigned: true }), OPS), null);
});

test('the shortcut still reports what it could not read', () => {
  assert.equal(verdictFromStatusAlone(null, OPS).verdict, CANNOT_TELL);
  assert.equal(verdictFromStatusAlone({ id: '1' }, OPS).verdict, CANNOT_TELL);
});
