'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const staleAnswer = require('../../lib/staleAnswer.js');
const busRelayPlan = require('./busRelayPlan.js');

const {
  answerFindings, classifyAnswer, duePosts, exitCodeFor, postKey, stampKeyTaskId,
  renderReport, renderStalePost, STALE_AFTER_MINUTES, MACHINE, CANNOT_TELL,
  markersFromReplyEnvelope, stampsToClear,
} = staleAnswer;

const ROOT = path.join(__dirname, '..', '..');

const ticket = (over = {}) => ({
  taskId: '86bbv8nvy',
  name: 'Lane A reads its own machine comments',
  url: 'https://app.clickup.com/t/86bbv8nvy',
  commentsReadable: true,
  state: 'answered',
  operatorSpokeLast: true,
  answerMinutes: 210,
  ...over,
});

/* ------------------------------------------------------------------ *
 * The threshold. Minutes, and derived rather than typed.
 * ------------------------------------------------------------------ */

test('the threshold is minutes, not a day, and is derived from the relay interval', () => {
  assert.equal(STALE_AFTER_MINUTES, 30);
  assert.equal(
    STALE_AFTER_MINUTES,
    (busRelayPlan.DEFAULT_OVERLAP_MS / 60000) * staleAnswer.PASSES_BEFORE_STALE,
    'the number must move when the relay cadence does — two copies of a threshold are two thresholds',
  );
  assert.ok(STALE_AFTER_MINUTES < 60, 'the incident sat 3.5 hours; a threshold in hours cannot see it');
});

/* ------------------------------------------------------------------ *
 * The one shape this exists for: he replied and nothing moved.
 * ------------------------------------------------------------------ */

test('an answer past the threshold is a finding, and it is NOT on Dane', () => {
  const { findings } = answerFindings([ticket()]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].actor, MACHINE, 'he has spoken — naming him the blocker is DOCTRINE 2.5');
  assert.match(findings[0].message, /NOT waiting on you/);
  assert.match(findings[0].message, /never left Needs your input/);
  assert.equal(exitCodeFor(findings), 1);
});

test('an answer still inside the threshold is quiet', () => {
  const { findings, fresh } = answerFindings([ticket({ answerMinutes: 12 })]);
  assert.deepEqual(findings, [], 'a pass caught mid-flight is not an alarm');
  assert.deepEqual(fresh, ['86bbv8nvy']);
  assert.equal(exitCodeFor(findings), 0);
});

test('a ticket he has NOT answered is quiet — this check never chases him', () => {
  const { findings, fresh } = answerFindings([ticket({ state: 'none', answerMinutes: 9999 })]);
  assert.deepEqual(findings, []);
  assert.deepEqual(fresh, ['86bbv8nvy']);
});

test('an undelivered answer names the party line, not the hand-back', () => {
  const { findings } = answerFindings([ticket({ delivered: false })]);
  assert.equal(findings[0].reasonKey, 'answer-undelivered');
  assert.match(findings[0].message, /not your reply/);
});

/* ------------------------------------------------------------------ *
 * CANNOT TELL is one of the answers, and never renders as healthy.
 * ------------------------------------------------------------------ */

test('an unreadable trail is CANNOT TELL at any age, and exits 2', () => {
  const { findings } = answerFindings([ticket({ commentsReadable: false, answerMinutes: 3 })]);
  assert.equal(findings.length, 1, 'a read that did not happen is not a clean read');
  assert.equal(findings[0].actor, CANNOT_TELL);
  assert.equal(exitCodeFor(findings), 2);
});

test('a ticket with no escalation card is CANNOT TELL, not answered', () => {
  const { findings } = answerFindings([ticket({ state: 'no-question' })]);
  assert.equal(findings[0].actor, CANNOT_TELL);
  assert.equal(findings[0].reasonKey, 'no-escalation-card');
  assert.match(findings[0].message, /will not hand it back on its own/,
    'the report must say the relay is also declining to guess, or the reader assumes it is handled');
});

test('no card AND he did not speak last is genuinely quiet', () => {
  const { findings } = answerFindings([ticket({ state: 'no-question', operatorSpokeLast: false, answerMinutes: NaN })]);
  assert.deepEqual(findings, [], 'there is no answer in sight, so there is nothing to be late');
});

test('an answer with no usable timestamp is CANNOT TELL, never quiet', () => {
  const { findings } = answerFindings([ticket({ answerMinutes: NaN })]);
  assert.equal(findings[0].reasonKey, 'answer-age-unknown');
  assert.equal(exitCodeFor(findings), 2);
});

test('CANNOT TELL outranks a clean sweep in the exit code', () => {
  const { findings } = answerFindings([
    ticket({ taskId: 'a' }),
    ticket({ taskId: 'b', commentsReadable: false }),
  ]);
  assert.equal(exitCodeFor(findings), 2);
});

/* ------------------------------------------------------------------ *
 * Criterion 4: an alarm that fires once is not an alarm. The suppression
 * window is keyed on the REASON and clears when the condition does.
 * ------------------------------------------------------------------ */

test('the suppression key is the reason, so a condition that changes posts again', () => {
  const a = classifyAnswer(ticket());
  const b = classifyAnswer(ticket({ delivered: false }));
  assert.notEqual(postKey(a), postKey(b));
  assert.equal(stampKeyTaskId(postKey(a)), '86bbv8nvy', 'the writer and the reader of the key must agree');
});

test('a finding inside the window is held, and one outside it posts again', () => {
  const f = classifyAnswer(ticket());
  const now = Date.parse('2026-09-06T12:00:00Z');
  const held = duePosts({ findings: [f], stamps: { [postKey(f)]: '2026-09-06T11:00:00Z' }, now, everyMs: 6 * 3600_000 });
  assert.equal(held.due.length, 0);
  assert.equal(held.held.length, 1);
  const due = duePosts({ findings: [f], stamps: { [postKey(f)]: '2026-09-06T01:00:00Z' }, now, everyMs: 6 * 3600_000 });
  assert.equal(due.due.length, 1, 'a condition that is still true after the window must be said again');
});

test('the check clears its own stamps, so a bus post is not the only record', () => {
  // The incident's fourth criterion in one line: the pass that could not post
  // must leave the condition re-derivable, and the stamp for a ticket that is
  // no longer stuck must go.
  const keys = ['86bbaaa:answer-unhandled', '86bbbbb:answer-undelivered'];
  assert.deepEqual(stampsToClear(keys, ['86bbaaa']), ['86bbbbb:answer-undelivered'],
    'a ticket that is no longer stuck must lose its stamps');
  assert.deepEqual(stampsToClear(keys, ['86bbaaa', '86bbbbb']), [],
    'a ticket that IS still stuck keeps its stamp, or the 6h window means nothing');

  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'stale_answer.mjs'), 'utf8');
  assert.match(src, /Not stamping it as sent, so the next pass tries again/,
    'a bus post that FAILED must not be recorded as said');
});

test('a ticket that LEAVES the stage loses its stamp — the healthy ending counts too', () => {
  // Round 1 review, finding 2. The clearing used to be handed only the ids of
  // tickets still parked in `Needs your input`, so the normal healthy ending —
  // the ticket moving on — never cleared anything. Get stuck, get fixed, get
  // re-escalated and stick again for the same reason inside six hours, and the
  // alarm is silently suppressed: fire-once, which is what criterion 4 forbids.
  const keys = ['86bbgone:answer-unhandled'];
  assert.deepEqual(stampsToClear(keys, []), ['86bbgone:answer-unhandled'],
    'a ticket no longer in the stage at all must lose its stamps');
});

/* ------------------------------------------------------------------ *
 * The delivery reading, off the envelope this client ACTUALLY returns.
 * ------------------------------------------------------------------ */

test('the delivery check reads the envelope scripts/lib/clickup.cjs returns', () => {
  // Round 1 review, finding 1 — the BLOCKER. This tested `out.res.ok`, which is
  // the OTHER ClickUp client's shape; `call()` here returns `{ ok, status, json,
  // text }` and has no `res`. So it answered null on every reading ever taken:
  // `delivered` could never be false, the `answer-undelivered` finding was
  // unreachable in production, and every finding printed "the answer was
  // delivered ... the hand-back is failing" — the exact mis-diagnosis this
  // module says it exists to prevent, on the one surface Dane reads.
  const relayed = {
    ok: true,
    status: 200,
    json: { comments: [{ comment_text: `${busRelayPlan.BUS_RELAY_MARKER} sent to channel x at ...` }] },
  };
  assert.equal(markersFromReplyEnvelope(relayed).delivered, true);

  const silent = { ok: true, status: 200, json: { comments: [{ comment_text: 'something else' }] } };
  assert.equal(markersFromReplyEnvelope(silent).delivered, false,
    'an answer that reached nobody must be able to say so — that finding names the party line');

  assert.equal(markersFromReplyEnvelope({ ok: false, status: 429, json: {} }), null,
    '"I could not check" and "it was not delivered" are different findings');
  assert.equal(markersFromReplyEnvelope(null), null);

  // The shape it used to read. If someone reintroduces it, this is what they get.
  assert.equal(markersFromReplyEnvelope({ res: { ok: true }, json: { comments: [] } }), null,
    'the wrong envelope must come back as CANNOT TELL, never as a reading');
});

test('answerFindings returns nothing the report never mentions', () => {
  // Round 1 review, finding 5. `unmeasured` was declared, documented as "the
  // report says so", returned — and never populated and never read. It could
  // not be populated: it was meant for a ticket inside the clock whose comments
  // would not read, and an unreadable ticket is a finding at ANY age. A bucket
  // nothing renders is a silence dressed as coverage, which is this module's
  // own thesis turned on itself.
  assert.deepEqual(
    Object.keys(answerFindings([ticket()])).sort(),
    ['findings', 'fresh', 'staleAfterMinutes'],
    'every bucket this returns must reach the report, or it is not coverage',
  );
});

test('an answer already acted on is quiet, not an alarm every six hours', () => {
  // The judgment call from round 1, decided: a completed hand-back marks the
  // answer, so a ticket parked here again by hand is left where it was put.
  // The relay reads the same marker, so an alarm here would fire for as long
  // as he chose to leave it — about a deliberate act, on the ticket he parked.
  const { findings, fresh } = answerFindings([ticket({ state: 'handled', answerMinutes: 900 })]);
  assert.deepEqual(findings, []);
  assert.deepEqual(fresh, ['86bbv8nvy']);
  assert.equal(exitCodeFor(findings), 0);
});

/* ------------------------------------------------------------------ *
 * The renderings, and the wiring nothing else would catch.
 * ------------------------------------------------------------------ */

test('an all-clear and a run that died halfway do not look the same', () => {
  const clear = renderReport({ findings: [], fresh: ['x'], stageCount: 1 });
  assert.match(clear, /Nothing is stuck/);
  const stuck = renderReport({ findings: answerFindings([ticket()]).findings, fresh: [], stageCount: 1 });
  assert.match(stuck, /\[MACHINE\]/);
  assert.doesNotMatch(stuck, /Nothing is stuck/);
});

test('the bus post leads with whose hands it is, and signs itself', () => {
  const text = renderStalePost({ findings: answerFindings([ticket()]).findings, node: 'mac-mini' });
  assert.match(text, /Whose hands: 1 on the machine side/);
  assert.match(text, /npm run stale-answer/);
  assert.match(text, /\[CC-starcaster\]/);
});

test('it is wired to run, and often enough to see its own window', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.scripts['stale-answer'], 'npm run stale-answer must exist');
  assert.match(pkg.scripts['stale-answer'], /scripts\/stale_answer\.mjs/);
  assert.match(pkg.scripts['stale-answer'], /doppler run/, 'Doppler supplies the ClickUp token');

  // Logic that exists and is never reached is the failure `npm run pulse`
  // shipped with for weeks. It runs on the relay's idle wake, BEFORE the
  // ownership check, so it survives the owning machine being off.
  const sh = fs.readFileSync(path.join(ROOT, 'scripts', 'run_bus_relay.sh'), 'utf8');
  assert.match(sh, /npm run --silent stale-answer -- --check \|\| true/,
    'it must run on the relay wake, and must never be able to fail the relay');
  // The ownership gate is inside the relay itself (`clickup -- bus-relay`
  // reads lib/nodeRoles.js and stands down on a machine that does not own it),
  // so "before the ownership check" means before that line.
  const checkAt = sh.indexOf('stale-answer');
  const ownershipAt = sh.indexOf('npm run --silent clickup -- bus-relay');
  assert.ok(checkAt > -1 && ownershipAt > -1, 'the check or the ownership gate moved — re-point this test');
  assert.ok(checkAt < ownershipAt,
    'the machine that does NOT own the relay is the only vantage point that survives the owner being dead');

  // The read throttle must be tighter than the window it watches, or the check
  // can report a 30-minute miss an hour late and still look like it works.
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'stale_answer.mjs'), 'utf8');
  const throttle = /const READ_EVERY_MS = (\d+) \* 60 \* 1000;/.exec(src);
  assert.ok(throttle, 'the read throttle moved — re-point this test');
  assert.ok(Number(throttle[1]) < STALE_AFTER_MINUTES,
    `a ${throttle[1]}-minute read cadence cannot resolve a ${STALE_AFTER_MINUTES}-minute window`);
});

test('the report and the relay ask the SAME question, through the same function', () => {
  // Two readers of "has he answered?" would be two definitions, and the quiet
  // way they fail is this report saying all-clear about the very ticket the
  // relay is refusing to move.
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'stale_answer.mjs'), 'utf8');
  assert.match(src, /busRelayPlan\.answerAwaitingHandback\(/);
  const relay = fs.readFileSync(path.join(ROOT, 'scripts', 'clickup_direct.mjs'), 'utf8');
  assert.match(relay, /const answered = answerAwaitingHandback\(\{/);
});
