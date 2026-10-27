'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  defaultWatches, handbackTarget, handbackDestination, mergeEnabled, sweepVerdict,
} = require('./busRelayPlan.js');
const { doorSource, skipWithoutDoor } = require('./productScripts.js');

const watches = defaultWatches({ agentResponseList: 'AR', loopQueueList: 'LQ' });
const agentResponse = watches.find((w) => w.list === 'AR');
const loopQueue = watches.find((w) => w.list === 'LQ');

/*
 * ORDER (2026-09-03, task 86bbugakw). The relay sweeps the watches in order,
 * spending one request per open ticket against a ~100-per-minute allowance
 * shared by the whole company's token. With Agent Response first — 92 open
 * tickets, never drained — the budget was gone before the sweep reached the
 * only list that can merge, and the merge lane was dead for sixteen hours.
 *
 * Asserted on the MERGE CAPABILITY rather than on the label or the list id.
 * The rule is "the list that can merge must not be starved", so that is the
 * property worth pinning; a future rename or a third watch should not be able
 * to satisfy this test while breaking the thing it protects.
 */
test('the merge-capable watch is swept FIRST, so a spent budget lands on a notify-only list', () => {
  const order = defaultWatches({ agentResponseList: 'AR', loopQueueList: 'LQ' });
  const firstMergeable = order.findIndex(mergeEnabled);
  assert.notEqual(firstMergeable, -1, 'no watch can merge — the relay could never merge anything');
  assert.equal(
    firstMergeable,
    0,
    'a merge-capable watch is not first: the budget would run out before reaching it'
  );
});

test('every watch after the merge-capable one is notify-only', () => {
  const order = defaultWatches({ agentResponseList: 'AR', loopQueueList: 'LQ' });
  const mergeable = order.filter(mergeEnabled);
  assert.equal(mergeable.length, 1, 'exactly one watch should be able to merge');
  assert.equal(order.slice(1).some(mergeEnabled), false);
});

test('both standing watches exist and carry their statuses', () => {
  assert.deepEqual(agentResponse.statuses, ['pending response', 'responding']);
  assert.deepEqual(loopQueue.statuses, ['needs your input', 'ready to launch']);
});

test('an answered "needs your input" ticket goes back to Queued', () => {
  assert.equal(handbackTarget(loopQueue, 'needs your input', 1), 'Queued');
});

test('status match is case-insensitive (ClickUp echoes lowercase, humans type anything)', () => {
  assert.equal(handbackTarget(loopQueue, 'Needs Your Input', 2), 'Queued');
});

test('"ready to launch" is notify-only: a comment never moves it', () => {
  assert.equal(handbackTarget(loopQueue, 'ready to launch', 1), null);
});

test('no fresh comment, no move — a parked ticket with old comments stays parked', () => {
  assert.equal(handbackTarget(loopQueue, 'needs your input', 0), null);
});

test('the Agent Response list never hands anything back', () => {
  assert.equal(handbackTarget(agentResponse, 'pending response', 3), null);
});

test('a watch with no handback table at all is safe', () => {
  assert.equal(handbackTarget({ statuses: [] }, 'needs your input', 1), null);
});

test('an unknown status is never moved even with fresh comments', () => {
  assert.equal(handbackTarget(loopQueue, 'building', 1), null);
});

test('only the Loop Queue watch may merge — Agent Response never can', () => {
  const { mergeEnabled } = require('./busRelayPlan.js');
  assert.equal(mergeEnabled(loopQueue), true);
  assert.equal(mergeEnabled(agentResponse), false);
});

test('an ad-hoc --list watch (no merge flag) can never merge anything', () => {
  const { mergeEnabled } = require('./busRelayPlan.js');
  assert.equal(mergeEnabled({ list: 'X', statuses: ['ready to launch'], handback: {} }), false);
  assert.equal(mergeEnabled(undefined), false);
});

// ---------------------------------------------------------------------------
// Delivery: what satisfies the handback gate (task 86bbjxew2, 2026-08-23).
// ---------------------------------------------------------------------------

const {
  BUS_RELAY_MARKER,
  deliveryVerdict,
  relayMarkerText,
  receiptText,
  RECEIPT_FINGERPRINT,
  receiptSignature,
  isThisReceipt,
  busFailureBucket,
} = require('./busRelayPlan.js');

const AT = '2026-08-23T22:04:00.000Z';

test('delivered via chat: the party line worked, nothing else was needed', () => {
  const v = deliveryVerdict({ chatOk: true, receiptOk: false, handsBack: true });
  assert.deepEqual(v, { ok: true, via: 'chat' });
  assert.equal(
    relayMarkerText({ ...v, channel: '2kydhxeu-474', at: AT }),
    '[bus-relay] sent to channel 2kydhxeu-474 at 2026-08-23T22:04:00.000Z',
  );
});

test('chat winning is not conditional on the receipt — it is preferred, not a tie', () => {
  assert.deepEqual(deliveryVerdict({ chatOk: true, receiptOk: true, handsBack: true }), { ok: true, via: 'chat' });
});

test('delivered via the fallback: chat failed, the ticket receipt landed', () => {
  const v = deliveryVerdict({
    chatOk: false, handsBack: true, receiptAttempted: true, receiptPosted: true, receiptOk: true,
  });
  assert.deepEqual(v, { ok: true, via: 'ticket' });
  assert.equal(
    relayMarkerText({ ...v, channel: '2kydhxeu-474', at: AT }),
    '[bus-relay] chat unavailable, receipted on the ticket at 2026-08-23T22:04:00.000Z',
  );
});

test('delivered by neither: not delivered, no marker, and so no handback', () => {
  const v = deliveryVerdict({
    chatOk: false, handsBack: true, receiptAttempted: true, receiptPosted: false, receiptStatus: 401,
  });
  assert.equal(v.ok, false);
  assert.equal(v.via, 'none');
  assert.match(v.why, /receipt comment also failed \(HTTP 401\)/);
  // Nothing to mark — a comment nobody received is retried next pass.
  assert.equal(relayMarkerText({ ...v, channel: 'X', at: AT }), null);
  // And the gate holds: fresh counts only delivered comments, so this task
  // stays exactly where it is. This is the non-goal made executable.
  assert.equal(handbackTarget(loopQueue, 'needs your input', 0), null);
});

test('every marker starts with the shared prefix, so "already relayed" still matches', () => {
  for (const via of ['chat', 'ticket']) {
    const text = relayMarkerText({ via, channel: 'C', at: AT });
    assert.ok(text.startsWith(BUS_RELAY_MARKER), `${via} marker must start with the prefix`);
  }
});

test('the receipt is a receipt, not a re-quote of his words', () => {
  const text = receiptText({ why: 'HTTP 400', target: 'Queued', at: AT });
  assert.match(text, /Your answer was read/);
  assert.match(text, /being returned to Queued/);
  assert.match(text, /HTTP 400/);
  assert.match(text, /party line is unavailable/i);
});

// Defence in depth only: since the review fix, deliverToBus never writes a
// receipt without a handback target, because a receipt there delivers nothing.
// The branch stays so a future caller cannot produce a sentence promising a
// move that was never going to happen.
test('a receipt with no target promises no move (unreachable, kept as a guard)', () => {
  const text = receiptText({ why: 'HTTP 400' });
  assert.match(text, /read and picked up/);
  assert.doesNotMatch(text, /going back to/);
});

test('a bus failure that still reached the ticket is skipped, not unchecked', () => {
  assert.equal(busFailureBucket({ delivered: true, cosmetic: false }), 'skipped');
});

test('a bus failure whose explanation is already on the ticket is cosmetic', () => {
  // The merge step's own three posts: each writes its real explanation as a
  // task comment first, so the bus post carries nothing that was lost.
  assert.equal(busFailureBucket({ delivered: false, cosmetic: true }), 'skipped');
});

test('a bus failure nobody was told about is still "could not fully verify"', () => {
  assert.equal(busFailureBucket({ delivered: false, cosmetic: false }), 'unchecked');
  assert.equal(busFailureBucket({}), 'unchecked');
});

// ── The receipt only delivers where something reads the ticket ────────────

/**
 * Review finding, 2026-08-23, and the one that mattered. Of the three watches
 * only ONE hands the ticket back:
 *
 *   Agent Response, fresh comment   -> no target
 *   Loop Queue, "ready to launch"   -> no target
 *   Loop Queue, "needs your input"  -> Queued
 *
 * The fallback's whole justification is "the answer is already a comment on
 * the ticket, which is where every loop reads it from" — true only for that
 * last one. On the other two the party line IS the delivery, so counting a
 * receipt would post a note to Dane on a ticket he is already reading, write
 * the permanent dedup marker, and lose the bus message for good once chat
 * recovered. That converts a self-healing retry into silent permanent loss,
 * which is the exact bug this whole ticket exists to remove.
 */
test('a receipt on a watch that hands nothing back is NOT delivery', () => {
  const v = deliveryVerdict({ chatOk: false, receiptAttempted: true, receiptOk: true, handsBack: false });
  assert.equal(v.ok, false, 'nothing reads this ticket — the party line was the delivery');
  assert.equal(v.via, 'none');
  assert.match(v.why, /hands nothing back/);
});

test('handsBack omitted is treated as no handback, not as yes', () => {
  // The safe default, because the failure is silent in one direction only.
  assert.equal(deliveryVerdict({ chatOk: false, receiptAttempted: true, receiptPosted: true, receiptOk: true }).ok, false);
});

test('and so no marker is written for it — it retries next pass', () => {
  const v = deliveryVerdict({ chatOk: false, receiptAttempted: true, receiptOk: true, handsBack: false });
  assert.equal(relayMarkerText({ ...v, channel: 'c', at: AT }), null,
    'a marker here would make the "already relayed" check skip it forever');
});

test('exactly one of the three watched cases hands the ticket back', () => {
  const handsBack = (watch, status) => Boolean(handbackTarget(watch, status, 1));
  // This is the table the fix is built on, asserted rather than assumed.
  assert.equal(handsBack(loopQueue, 'needs your input'), true);
  assert.equal(handsBack(loopQueue, 'ready to launch'), false);
  assert.equal(handsBack(agentResponse, 'pending response'), false);
  assert.equal(handsBack(agentResponse, 'responding'), false);
});

// ── The receipt says what has happened, never what is about to ────────────

test('the receipt does not announce a move it has not made', () => {
  const text = receiptText({ why: 'HTTP 400', target: 'Queued' });
  assert.match(text, /Your answer was read and picked up\./);
  assert.match(text, /being returned to Queued/);
  // "is going back to" promised a completed move before the PUT was tried; a
  // failed move then left the ticket carrying a comment saying otherwise.
  assert.doesNotMatch(text, /is going back to/);
  assert.doesNotMatch(text, /has been returned|was returned|has moved/);
});

test('the receipt carries the fingerprint the read-back searches for', () => {
  // deliverToBus proves the receipt stuck by finding this string. If the
  // wording and the fingerprint ever drift apart, every receipt reads as
  // "posted but could not be read back" and no ticket is ever handed back.
  assert.ok(receiptText({ why: 'x', target: 'Queued' }).includes(RECEIPT_FINGERPRINT));
});

test('the receipt still names why the party line was skipped', () => {
  assert.match(receiptText({ why: 'HTTP 400', target: 'Queued' }), /HTTP 400/);
  assert.match(receiptText({ target: 'Queued' }), /reason unknown/);
});

// ── The undelivered reason is a decision, not a sentence in the caller ────

/**
 * Review finding, 2026-08-24, hit verbatim in a real run. The caller printed
 * "the party line failed and so did the receipt comment" for EVERY undelivered
 * case — including the notify-only watches, where no receipt is ever attempted.
 * During a chat outage that line appears against every Agent Response comment
 * and tells the reader task comments are failing too, which is the opposite of
 * what is true and the opposite of what LOOP_ENGINEERING says to conclude.
 */
test('no handback, no receipt attempted: the reason says exactly that', () => {
  const v = deliveryVerdict({ chatOk: false, handsBack: false, receiptAttempted: false });
  assert.equal(v.ok, false);
  assert.match(v.why, /no receipt was attempted/);
  assert.match(v.why, /hands nothing back/);
  // The wrong sentence, made unsayable.
  assert.doesNotMatch(v.why, /also failed/);
});

test('the receipt POST failing names the status it actually got', () => {
  const v = deliveryVerdict({
    chatOk: false, handsBack: true, receiptAttempted: true, receiptPosted: false, receiptStatus: 503,
  });
  assert.equal(v.ok, false);
  assert.match(v.why, /receipt comment also failed \(HTTP 503\)/);
});

test('a 200 that did not stick is reported as unread-back, not as a failed post', () => {
  const v = deliveryVerdict({
    chatOk: false, handsBack: true, receiptAttempted: true, receiptPosted: true, receiptOk: false,
  });
  assert.equal(v.ok, false, 'an unverified receipt is not delivery');
  assert.match(v.why, /could not be read back/);
  assert.doesNotMatch(v.why, /also failed/);
});

test('a delivered verdict carries no reason to print', () => {
  for (const v of [
    deliveryVerdict({ chatOk: true }),
    deliveryVerdict({ chatOk: false, handsBack: true, receiptAttempted: true, receiptPosted: true, receiptOk: true }),
  ]) {
    assert.equal(v.ok, true);
    assert.equal(v.why, undefined, 'nothing failed, so there is nothing to explain');
  }
});

// ── Telling THIS receipt from a receipt ───────────────────────────────────

/**
 * Review finding, 2026-08-24. The read-back searched every comment on the task
 * for RECEIPT_FINGERPRINT, a constant. A ticket that took a receipt during one
 * outage, went back to Queued, later returned to "Needs your input" and hit a
 * second outage would have its new 200-that-did-not-stick "verified" by the
 * leftover from the first — the precise case the read-back was added to catch.
 */
test('the receipt carries the instant it was written', () => {
  const text = receiptText({ why: 'HTTP 400', target: 'Queued', at: AT });
  assert.ok(text.includes(receiptSignature(AT)));
  assert.match(text, /2026-08-23T22:04:00\.000Z/);
});

test('an older receipt on the same ticket does NOT verify a newer write', () => {
  const older = { id: 111, comment_text: receiptText({ why: 'HTTP 400', target: 'Queued', at: '2026-08-01T00:00:00.000Z' }) };
  assert.equal(isThisReceipt(older, { id: 222, at: AT }), false,
    'a leftover receipt must not stand in for one that never stuck');
});

test('the id from the POST identifies it', () => {
  assert.equal(isThisReceipt({ id: 222, comment_text: 'anything' }, { id: 222, at: AT }), true);
  assert.equal(isThisReceipt({ id: '222', comment_text: '' }, { id: 222 }), true, 'ids compare as strings');
});

test('the timestamp identifies it when the response carried no id', () => {
  const mine = { id: 999, comment_text: receiptText({ why: 'HTTP 400', target: 'Queued', at: AT }) };
  assert.equal(isThisReceipt(mine, { id: undefined, at: AT }), true);
});

test('a comment that is not a receipt at all never matches', () => {
  assert.equal(isThisReceipt({ id: 1, comment_text: 'Dane: go ahead' }, { id: 2, at: AT }), false);
  assert.equal(isThisReceipt(null, { id: 2, at: AT }), false);
  // And with nothing to match on, nothing matches — an unverifiable write is
  // reported, never assumed.
  assert.equal(isThisReceipt({ id: 1, comment_text: receiptText({ why: 'x', target: 'Queued', at: AT }) }, {}), false);
});

// ── The plumbing side of the two review findings ──────────────────────────

/**
 * These two fixes live in scripts/clickup_direct.mjs, which holds only network
 * plumbing and has no test harness. They are pinned here because both fail
 * SILENTLY: an unverified receipt hands a ticket back with the acknowledgement
 * existing nowhere, and a per-comment receipt piles duplicate notes onto a
 * ticket during exactly the outage this feature exists for.
 */
const RELAY_SRC = doorSource() || '';

test('the receipt is read back before it is trusted', (t) => {
  if (skipWithoutDoor(t)) return;
  const post = RELAY_SRC.indexOf('comment_text: body });');
  assert.ok(post > -1, 'the receipt POST moved — re-point this test');
  assert.ok(RELAY_SRC.includes('isThisReceipt(c, { id: out.json && out.json.id, at })'),
    'the read-back must identify THIS write, by id or by its timestamp');
  // The verdict must be built from the read-back, never from the POST status.
  assert.match(RELAY_SRC, /receiptPosted: posted, receiptOk: stuck/,
    'the verdict must use the read-back result, not out.res.ok, as the delivery');
});

test('the read-back does not search for the bare fingerprint', (t) => {
  if (skipWithoutDoor(t)) return;
  // Review finding, 2026-08-24. RECEIPT_FINGERPRINT is a constant, so every
  // receipt ever written to a ticket looks identical to it: a leftover from an
  // earlier outage would "verify" a fresh POST that never stuck, which is the
  // precise case the read-back exists to catch.
  assert.ok(!RELAY_SRC.includes('RECEIPT_FINGERPRINT'),
    'matching on the constant fingerprint cannot tell this receipt from an old one');
});

test('a watch with no handback target never posts a receipt at all', (t) => {
  if (skipWithoutDoor(t)) return;
  // Not merely "does not count it" — does not write it. This watch retries
  // every pass until the bus accepts, so a receipt per pass would pile
  // identical notes onto the ticket forever while still losing the message.
  assert.match(RELAY_SRC, /if \(!handsBack\) \{/,
    'deliverToBus must bail out before the receipt when nothing hands back');
});

test('the undelivered line quotes the verdict, it does not invent a reason', (t) => {
  if (skipWithoutDoor(t)) return;
  // Review finding, 2026-08-24: the line hard-coded "and so did the receipt
  // comment" even where no receipt was ever attempted, telling the reader task
  // comments were failing too — the opposite of the truth, during exactly the
  // outage the reader is trying to diagnose.
  assert.ok(!RELAY_SRC.includes('and so did the receipt comment'),
    'the caller must not assert a receipt attempt it knows nothing about');
  assert.match(RELAY_SRC, /delivery\.reason/,
    'the printed reason must come from deliveryVerdict');
  // ...and `reason` must survive: the original bug was spreading the verdict
  // and then overwriting its `why` with the chat failure.
  assert.match(RELAY_SRC, /reason: verdict\.why \|\| ''/,
    'the verdict reason and the chat reason must be separate fields');
});

test('the receipt is deduped per ticket, and remembers whether it verified', (t) => {
  if (skipWithoutDoor(t)) return;
  assert.match(RELAY_SRC, /receipted\.has\(String\(taskId\)\)/);
  assert.match(RELAY_SRC, /const receipted = new Map\(\)/,
    'a Set cannot carry the verified flag a repeat comment needs');
  // Review finding, 2026-08-24: recording only on a successful read-back left
  // a transient GET failure unrecorded, so the next comment in the same pass
  // posted a second identical note — the pile-up the dedup exists to prevent.
  assert.match(RELAY_SRC, /if \(posted && receipted\) receipted\.set\(String\(taskId\), stuck\)/,
    'the ticket is recorded once the POST lands; verification travels in the value');
});

/* -------------------------------------------------------------------------
 * Breaking the party line on purpose (task 86bbjzg83).
 *
 * The fallback above only runs during a vendor outage. Until this switch there
 * was no way to make one happen, so the whole path could be reasoned about and
 * never watched — and `--dry-run`, the one command that sounds like a
 * rehearsal, returned before deliverToBus() was ever reached.
 * ---------------------------------------------------------------------- */

const {
  SIMULATED_BUS_WHY,
  simulationGuard,
  simulationLine,
} = require('./busRelayPlan.js');

test('the simulation refuses to run outside --dry-run', () => {
  const g = simulationGuard({ simulate: true, dryRun: false });
  assert.equal(g.ok, false, 'a live pass must never simulate an outage');
  assert.match(g.why, /requires --dry-run/);
  // The refusal has to explain the damage, not just decline: outside dry-run
  // the forced failure writes a real receipt and a real permanent dedup
  // marker, which drops the genuine bus message for good.
  assert.match(g.why, /marker/i, 'the refusal must name the permanent consequence');
  assert.match(g.why, /Nothing was run/);
});

test('the simulation runs inside --dry-run, and is inert when not asked for', () => {
  assert.equal(simulationGuard({ simulate: true, dryRun: true }).ok, true);
  assert.equal(simulationGuard({ simulate: false, dryRun: false }).ok, true);
  assert.equal(simulationGuard({}).ok, true);
});

test('a simulated failure says "simulated" in the text a human will read', () => {
  // This string reaches the run report AND the body of the rehearsed receipt.
  // A reader finding it in a log later must not mistake it for a real outage.
  assert.match(SIMULATED_BUS_WHY, /SIMULATED/);
  assert.match(SIMULATED_BUS_WHY, /no request was sent/);
});

test('the rehearsal reports delivery by receipt, and that the hand-back fires', () => {
  const verdict = deliveryVerdict({
    chatOk: false, handsBack: true, receiptAttempted: true,
    receiptPosted: true, receiptOk: true,
  });
  const line = simulationLine({ verdict, target: 'Queued' });
  assert.match(line, /receipt on the ticket/);
  assert.match(line, /hand-back to "Queued" WOULD fire/);
});

test('on a notify-only watch the rehearsal reports NOT delivered and no hand-back', () => {
  // The deliberate asymmetry: Agent Response and "ready to launch" hand nothing
  // back, so a receipt there delivers nothing. This is the case a rehearsal
  // most needs to show, because it is the one that looks like a bug.
  const verdict = deliveryVerdict({ chatOk: false, handsBack: false, receiptAttempted: false });
  // Shaped as deliverToBus hands it over: `why` is the chat failure, `reason`
  // is the verdict's account. The line must quote the SECOND one — the first
  // says "HTTP 000" and explains nothing about why this watch is different.
  const line = simulationLine({
    verdict: { ...verdict, why: SIMULATED_BUS_WHY, reason: verdict.why },
    target: null,
  });
  assert.match(line, /NOT delivered/);
  assert.match(line, /no hand-back/);
  assert.match(line, /only the party line delivers here/);
  assert.ok(!line.includes('HTTP 000'),
    'the chat error must not crowd out the reason nothing was delivered');
});

test('a rehearsal that reports delivery via chat is called INVALID, not a pass', () => {
  // If the simulation did not take effect, the run must not read as a green
  // rehearsal — that would be a check that cannot fail.
  const line = simulationLine({ verdict: { ok: true, via: 'chat' }, target: 'Queued' });
  assert.match(line, /INVALID/);
});

test('the switch is wired into the relay, and dry-run stops short-circuiting for it', (t) => {
  if (skipWithoutDoor(t)) return;
  assert.match(RELAY_SRC, /flag\('simulate-bus-failure'\)/,
    'the flag must be parsed');
  assert.match(RELAY_SRC, /if \(!simGuard\.ok\)/,
    'the guard must be enforced, not merely computed');
  // The whole point: plain dry-run still returns early, a simulated one does not.
  assert.match(RELAY_SRC, /if \(dryRun && !simulateBusFailure\) \{/,
    'a simulated dry-run must reach deliverToBus, or it rehearses nothing');
  assert.match(RELAY_SRC, /simulate: simulateBusFailure/,
    'the simulation must be threaded into the delivery call');
});

test('a simulated pass sends no write of any kind', (t) => {
  if (skipWithoutDoor(t)) return;
  // postToBus returns before its request...
  assert.match(RELAY_SRC, /if \(simulate\) return \{ ok: false, why: SIMULATED_BUS_WHY \}/,
    'the chat write must be skipped, not merely failed after sending');

  // ...the receipt is rehearsed rather than posted. Checking only that the
  // simulation branch appears BEFORE the POST is a check that cannot fail:
  // source order survives `if (false && simulate)`, which is exactly how this
  // assertion was first written and exactly what it failed to catch when the
  // branch was disabled on purpose. So: the guard must be reachable, and the
  // slice between it and the POST must actually return.
  const receiptSim = RELAY_SRC.indexOf('  if (simulate) {\n    console.error(`  SIMULATION — would post the fallback receipt');
  assert.ok(receiptSim > -1,
    'the receipt simulation branch is missing or no longer plainly `if (simulate)` — a disabled or narrowed condition posts a real comment during a rehearsal');
  const receiptPost = RELAY_SRC.indexOf("call('POST', `/api/v2/task/${taskId}/comment`");
  assert.ok(receiptPost > receiptSim, 'the receipt POST moved — re-point this test');
  const between = RELAY_SRC.slice(receiptSim, receiptPost);
  assert.match(between, /return answer\(deliveryVerdict\(/,
    'the simulation branch must RETURN before the receipt POST, not fall through to it');

  // ...and the dedup marker, which is permanent, is never written. The
  // simulation branch records delivery in `deliveredIds` alongside `fresh`
  // (task 86bbvr4w3) — both are in-memory counters for THIS pass, and neither
  // touches ClickUp. What must stay true is that the branch continues rather
  // than falling through to the marker POST.
  assert.match(RELAY_SRC, /if \(delivery\.ok\) \{ relayed\+\+; fresh\+\+; deliveredIds\.add\(String\(c\.id\)\); \}/,
    'a simulated pass must continue before the marker write');
});

test('the guard is checked before the relay reads anything', (t) => {
  if (skipWithoutDoor(t)) return;
  const guardAt = RELAY_SRC.indexOf('const simGuard = simulationGuard(');
  const firstWatchRead = RELAY_SRC.indexOf('const watches = (arg(');
  assert.ok(guardAt > -1 && firstWatchRead > -1, 'the guard or the watch setup moved — re-point this test');
  assert.ok(guardAt < firstWatchRead,
    'a refused run must do nothing at all, not even look');
});

/* ------------------------------------------------------------------ *
 * Whose word is it? (task 86bbqx2xe)
 *
 * The loops post under Dane's own API token, so his user id is on comments he
 * never wrote. These pin the filter the relay actually uses.
 * ------------------------------------------------------------------ */

const { operatorComments } = require('./busRelayPlan.js');
const { isMachineComment, stampMachineComment } = require('./machineComment.js');

const DANE = 48012725;
const opts = { operatorId: DANE, isMachine: isMachineComment };

const hisWord = { id: 'h', user: { id: DANE }, comment_text: 'B, go with the marker' };
const itsOwnCard = { id: 'm', user: { id: DANE }, comment_text: stampMachineComment('@@ASKED Which option?') };
const someoneElse = { id: 'x', user: { id: 999 }, comment_text: 'drive-by' };

test('a machine-authored comment is not a fresh operator answer', () => {
  assert.deepEqual(operatorComments([itsOwnCard], opts), []);
});

test("the relay still hears Dane when he actually answers", () => {
  assert.deepEqual(operatorComments([itsOwnCard, hisWord, someoneElse], opts).map((c) => c.id), ['h']);
});

test('an escalated ticket with only its own ask card has nothing fresh, so it is never handed back', () => {
  const fresh = operatorComments([itsOwnCard], opts).length;
  assert.equal(handbackTarget(loopQueue, 'needs your input', fresh), null);
});

test('...and the same ticket IS handed back once he answers for real', () => {
  const fresh = operatorComments([itsOwnCard, hisWord], opts).length;
  assert.equal(handbackTarget(loopQueue, 'needs your input', fresh), 'Queued');
});

test('an unreadable comment list is not somebody\'s word', () => {
  assert.deepEqual(operatorComments(null, opts), []);
  assert.deepEqual(operatorComments(undefined, opts), []);
});

test('without an isMachine predicate the filter is id-only — the caller must pass the guard', () => {
  // Pinned deliberately: this is the OLD behaviour, and it is what the relay
  // would fall back to if a future edit dropped the predicate. If this ever
  // needs changing, the relay's call site is what to look at first.
  assert.equal(operatorComments([itsOwnCard], { operatorId: DANE }).length, 1);
});


/*
 * THE SWEEP VERDICT (2026-09-03, task 86bbugdv9). The unit is the LIST, not
 * the ticket: on 2026-09-03 a pass that had entirely failed to sweep the
 * merge-capable list reported "3 could not be checked" and three ticket ids,
 * one of which was carrying Dane's own merge command. Three ids read as three
 * minor gaps; the truth was that the merge lane had not run.
 */
const COMPLETE_BOTH = [
  { label: 'Loop Queue', merge: true, complete: true },
  { label: 'Agent Response', merge: false, complete: true },
];

test('a fully swept pass is COMPLETE and exits 0', () => {
  const v = sweepVerdict(COMPLETE_BOTH);
  assert.equal(v.complete, true);
  assert.equal(v.exitCode, 0);
  assert.match(v.line, /^COMPLETE/);
});

test('an empty sweep with nothing relayed is still COMPLETE — quiet is not broken', () => {
  const v = sweepVerdict(COMPLETE_BOTH);
  assert.equal(v.exitCode, 0);
  assert.equal(v.mergeLaneRan, true);
});

test('an unfinished merge-capable list is named, and named AS the merge list', () => {
  const v = sweepVerdict([
    { label: 'Loop Queue', merge: true, complete: false, why: 'HTTP 429' },
    { label: 'Agent Response', merge: false, complete: true },
  ]);
  assert.equal(v.complete, false);
  assert.equal(v.exitCode, 1);
  assert.match(v.line, /^INCOMPLETE/);
  assert.match(v.line, /Loop Queue/);
  assert.match(v.line, /merge-capable/);
  assert.equal(v.mergeLaneRan, false);
});

/*
 * The consequence, not the mechanism. "Could not read comments" is what broke;
 * "a merge command may be sitting unacted on" is what it COSTS, and the cost is
 * what a reader needs at 2am.
 */
test('an unfinished merge list says a merge command may be sitting unacted on', () => {
  const v = sweepVerdict([
    { label: 'Loop Queue', merge: true, complete: false, why: 'HTTP 429' },
  ]);
  assert.match(v.line, /Merge commands on that list were NOT read/);
});

test('an unfinished notify-only list does NOT claim a merge was missed', () => {
  const v = sweepVerdict([
    { label: 'Loop Queue', merge: true, complete: true },
    { label: 'Agent Response', merge: false, complete: false, why: '3 ticket(s) on it could not be read' },
  ]);
  assert.equal(v.complete, false);
  assert.equal(v.exitCode, 1);
  assert.equal(v.mergeLaneRan, true, 'the merge lane DID run — only the notify-only list fell short');
  assert.doesNotMatch(v.line, /Merge commands on that list were NOT read/);
  assert.match(v.line, /Agent Response/);
});

test('no sweep at all is INCOMPLETE — absence of evidence is not a clean pass', () => {
  const v = sweepVerdict([]);
  assert.equal(v.complete, false);
  assert.equal(v.exitCode, 1);
  assert.match(v.line, /no list was swept at all/);
});

test('a complete pass and an unfinished one never produce the same line', () => {
  const ok = sweepVerdict(COMPLETE_BOTH).line;
  const bad = sweepVerdict([
    { label: 'Loop Queue', merge: true, complete: false, why: 'HTTP 429' },
    { label: 'Agent Response', merge: false, complete: true },
  ]).line;
  assert.notEqual(ok, bad);
});

test('the reason a list fell short is carried into the line, not dropped', () => {
  const v = sweepVerdict([
    { label: 'Loop Queue', merge: true, complete: false, why: 'HTTP 429' },
  ]);
  assert.match(v.line, /HTTP 429/);
});

/*
 * THE HIGH-WATER MARK (2026-09-03, task 86bbugbay).
 *
 * The ordering fix above kept a spent budget off the merge lane. It did not
 * make the budget smaller: a pass still spent 114-115 requests against a
 * ~100-per-minute allowance, was rate-limited partway, and finished
 * INCOMPLETE — which disables Lane A by standing condition 4. Lane A halted
 * 271 consecutive passes and had never merged anything.
 *
 * Recency is a sound proxy here because a task's `date_updated` equals its
 * newest comment's timestamp to the millisecond (measured on 86bbqpwfa,
 * 2026-09-03). The risk is not cost, it is a MISSED operator comment, which
 * is silent — so every test below is about what must still be read.
 */
const { ticketsToRead, markAfterPass, DEFAULT_OVERLAP_MS } = require('./busRelayPlan.js');

const at = (ms) => ({ id: `t${ms}`, date_updated: String(ms) });
const NOTIFY = { list: 'AR', merge: false };
const MERGES = { list: 'LQ', merge: true };

test('a ticket untouched since the last completed pass costs no comment read', () => {
  const mark = 10_000_000;
  const out = ticketsToRead({ watch: NOTIFY, tasks: [at(1), at(mark + 5_000)], mark });
  assert.equal(out.read.length, 1);
  assert.equal(out.read[0].id, `t${mark + 5000}`);
  assert.equal(out.skipped, 1);
});

test('a comment posted BETWEEN two passes is read on the next one', () => {
  const mark = 10_000_000;
  const between = at(mark + 1);
  const out = ticketsToRead({ watch: NOTIFY, tasks: [between], mark });
  assert.deepEqual(out.read, [between]);
});

/*
 * THE TRAP THE TICKET NAMED. A comment that lands WHILE a pass is running, on
 * a ticket that pass has already read, is older than the mark that pass then
 * writes. Without an overlap it falls into the gap between the two passes and
 * is never relayed — and a missed merge command is the exact failure this
 * whole epic exists to fix.
 *
 * BREAK-TEST: set overlapMs to 0 and this assertion fails (verified by hand,
 * 2026-09-03) — `read` comes back empty.
 */
test('a comment posted DURING a pass, on a ticket that pass already read, is still read next pass', () => {
  const mark = 10_000_000;
  const duringPass = at(mark - 30_000); // 30s before the mark: mid-pass
  const out = ticketsToRead({ watch: NOTIFY, tasks: [duringPass], mark, overlapMs: DEFAULT_OVERLAP_MS });
  assert.deepEqual(out.read, [duringPass], 'the overlap window must cover a comment that landed mid-pass');
});

test('the overlap is at least one relay interval, or the blind spot reopens', () => {
  assert.ok(DEFAULT_OVERLAP_MS >= 600 * 1000);
});

/*
 * BREAK-TEST: return `{ mark: startedAt, advanced: true }` unconditionally and
 * this fails (verified by hand) — the mark advances past tickets the pass
 * never reached, and their comments are skipped forever.
 */
test('a pass that did not complete a list does NOT advance that list\'s mark', () => {
  const out = markAfterPass({ complete: false, startedAt: 20_000_000, previous: 10_000_000 });
  assert.equal(out.mark, 10_000_000);
  assert.equal(out.advanced, false);
  assert.match(out.why, /re-read/);
});

test('a completed list stamps the time the pass STARTED, never when it finished', () => {
  const out = markAfterPass({ complete: true, startedAt: 20_000_000, previous: 10_000_000 });
  assert.equal(out.mark, 20_000_000);
  assert.equal(out.advanced, true);
});

test('a cold start reads everything and says so, rather than relaying nothing', () => {
  const out = ticketsToRead({ watch: NOTIFY, tasks: [at(1), at(2)], mark: NaN });
  assert.equal(out.read.length, 2);
  assert.match(out.reason, /cold start/);
});

/*
 * THE NON-GOAL THE TICKET ASKED US TO DECIDE, pinned as a test so a later
 * "optimisation" cannot quietly extend the filter to the merge lane.
 *
 * A refused merge command is re-decided every pass (task 86bbjt18r): PR #558
 * was refused on 2026-09-03 because CI had not finished inside the merge
 * step's wait, and the promise made to the operator was that a later pass
 * would pick it up. The ticket then goes quiet — so a recency filter here
 * would turn "you do not have to say merge again" into a lie. Lane A's own
 * window works the same way: going quiet for an hour IS the lane.
 */
test('a merge-capable watch reads every ticket regardless of recency', () => {
  const ancient = at(1);
  const out = ticketsToRead({ watch: MERGES, tasks: [ancient], mark: 10_000_000 });
  assert.deepEqual(out.read, [ancient], 'a quiet Ready-to-launch ticket must still be re-decided every pass');
  assert.equal(out.skipped, 0);
});

/* ------------------------------------------------------------------ *
 * THE HAND-BACK IS RETRIED (2026-09-06, task 86bbvr4w3).
 *
 * The trigger used to be "a comment relayed in THIS pass", which is an event
 * that can happen exactly once: relaying writes a permanent dedup marker, so
 * every later pass computed fresh = 0 and moved nothing. A pass that died
 * between the relay and the move stranded its ticket in `Needs your input`
 * for good — 86bbv8nvy, 3.5 hours, found by Dane rather than by any alarm.
 *
 * These pin the durable derivation that replaced it. Each one fails if the
 * fix is reverted; the ticket's break-test list names which.
 * ------------------------------------------------------------------ */

const {
  answerAwaitingHandback, isEscalationCard, ESCALATION_BANNER,
  HANDBACK_FAILURE_MARKER, handbackFailureText, BUS_RELAY_MARKER: DEDUP_MARKER,
  HANDBACK_DONE_MARKER, handbackDoneText,
  repliesShowRelayed, repliesShowHandbackDone, repliesShowHandbackFailure,
} = require('./busRelayPlan.js');
const { stampMachineComment: stampCard } = require('./machineComment.js');

const CARD = stampCard(`Some context.\n\n#############################\n${ESCALATION_BANNER} Which option, A or B?`);
const card = (id, at) => ({ id, date: String(at), user: { id: DANE }, comment_text: CARD });
const his = (id, at, text = 'B') => ({ id, date: String(at), user: { id: DANE }, comment_text: text });

const answeredOpts = { operatorId: DANE, isMachine: isMachineComment };
const allDelivered = () => true;
const noneDelivered = () => false;

test('the escalation card is recognised by its banner', () => {
  assert.ok(isEscalationCard(CARD));
  assert.ok(!isEscalationCard('B, go with the marker'));
  assert.ok(!isEscalationCard(null), 'an unread comment is an unknown, never a question');
});

test('an answer already relayed on an EARLIER pass still authorizes the hand-back', () => {
  // This is the incident exactly: the comment was delivered, the marker was
  // written, and the move never happened. Nothing about this ticket is "fresh"
  // any more, and that must not matter.
  const out = answerAwaitingHandback({
    comments: [card('c1', 1000), his('a1', 2000)],
    ...answeredOpts,
    delivered: allDelivered,
  });
  assert.equal(out.state, 'answered');
  assert.equal(out.delivered, true);
  assert.equal(out.answer.id, 'a1');
  assert.equal(handbackTarget(loopQueue, 'needs your input', out.state === 'answered' && out.delivered), 'Queued',
    'a delivered answer to the newest question releases the ticket, whichever pass delivered it');
});

test('an answer that reached NOBODY still moves nothing', () => {
  // The delivery gate is re-pointed, never weakened: a ticket must not move on
  // an answer nobody ever got.
  const out = answerAwaitingHandback({
    comments: [card('c1', 1000), his('a1', 2000)],
    ...answeredOpts,
    delivered: noneDelivered,
  });
  assert.equal(out.state, 'answered');
  assert.equal(out.delivered, false);
  assert.equal(handbackTarget(loopQueue, 'needs your input', out.state === 'answered' && out.delivered), null);
});

test('an answer from an EARLIER round cannot release a fresh escalation', () => {
  // The reason the question is anchored on the newest card rather than on a
  // marker: if a "handled" marker were ever lost, an old answer must still not
  // release a question asked after it.
  const out = answerAwaitingHandback({
    comments: [card('c1', 1000), his('a1', 2000), card('c2', 3000)],
    ...answeredOpts,
    delivered: allDelivered,
  });
  assert.equal(out.state, 'none');
  assert.equal(handbackTarget(loopQueue, 'needs your input', out.state === 'answered'), null);
});

test('his NEWEST word after the question is the one that must have landed', () => {
  const out = answerAwaitingHandback({
    comments: [card('c1', 1000), his('a1', 2000, 'B'), his('a2', 4000, 'actually A')],
    ...answeredOpts,
    delivered: (c) => c.id === 'a1',
  });
  assert.equal(out.answer.id, 'a2', 'the move is made on what he last said');
  assert.equal(out.delivered, false, 'releasing the ticket while his latest sentence reached nobody is the bug');
});

test('a machine card under his token is never read as his answer', () => {
  // The 86bbqx2xe failure, re-pinned here because this derivation is a second
  // reader of "whose word is it" and would resurrect the bug on its own.
  const out = answerAwaitingHandback({
    comments: [card('c1', 1000), itsOwnCard],
    ...answeredOpts,
    delivered: allDelivered,
  });
  assert.equal(out.state, 'none');
});

test('no escalation card is `no-question`, never `answered`', () => {
  // A ticket parked by hand gives no way to tell an answer from something he
  // said last week. The relay keeps the old fresh-only rule there and
  // stale-answer reports it as CANNOT TELL — neither guesses.
  const out = answerAwaitingHandback({
    comments: [his('a1', 2000)],
    ...answeredOpts,
    delivered: allDelivered,
  });
  assert.equal(out.state, 'no-question');
  assert.equal(out.delivered, null, 'delivery is not claimed about an answer that could not be identified');
});

test('a failed hand-back is recorded on the ticket, under a prefix the dedup check cannot read', () => {
  const text = handbackFailureText({ target: 'Queued', status: 'needs your input', why: 'HTTP 429', at: 'ISO' });
  assert.ok(text.startsWith(HANDBACK_FAILURE_MARKER));
  assert.ok(text.includes('Queued') && text.includes('HTTP 429'), 'the note must name the target and the reason');
  assert.ok(text.includes('next relay pass'), 'and say the retry does not depend on this note');
  // THE ONE THAT WOULD HURT: `[bus-relay]` is the marker meaning "this comment
  // was already relayed". A failure note that started with it would claim a
  // delivery that never happened and drop the real bus message for good.
  assert.ok(!text.startsWith(DEDUP_MARKER),
    'the failure note must not be readable as a delivery marker');
  assert.ok(isMachineComment(text), 'and it must never come back as Dane\'s own word');
});

test('the relay reads the durable marker as delivery, which is the whole of the fix', (t) => {
  if (skipWithoutDoor(t)) return;
  // The pure derivation above is only half of it. The other half is that the
  // relay tells it about a comment relayed on an EARLIER pass — the branch
  // that used to `continue` straight past, leaving `fresh` at 0 for ever.
  // Nothing but the source can pin that, and without it every unit test here
  // passes while the ticket still strands.
  assert.match(RELAY_SRC, /if \(already\) \{ deliveredIds\.add\(String\(c\.id\)\); skipped\+\+; continue; \}/,
    'an already-relayed comment must be recorded as DELIVERED, not merely skipped');

  const authorizedAt = RELAY_SRC.indexOf('const authorized = answered.state ===');
  const targetAt = RELAY_SRC.indexOf("const plan = handbackDestination(watch, t.status?.status, authorized, handbackPr, answered.answer?.comment_text)");
  assert.ok(authorizedAt > -1 && targetAt > authorizedAt,
    'the hand-back must be decided from the durable verdict, never from this pass\'s `fresh` count');

  // A ticket with no escalation card keeps the OLD rule, so nothing regresses
  // where the question cannot be identified.
  assert.match(RELAY_SRC, /answered\.state === 'no-question'\s*\n?\s*\? fresh/,
    'without a card the fresh-only rule must still stand — guessing there is worse than the bug');

  // And the failure goes on the ticket (criterion 2), best-effort.
  assert.match(RELAY_SRC, /comment_text: handbackFailureText\(\{/,
    'a hand-back that fails must leave a record on the ticket, not only in a bus post a rate limit can swallow');
});

/* ------------------------------------------------------------------ *
 * ROUND 1 REVIEW (2026-09-07). Three defects in the derivation above,
 * each one reproduced before it was fixed.
 * ------------------------------------------------------------------ */

test('a comment of HIS that quotes the card is not the question', () => {
  // Finding 3. `isEscalationCard` looked only for the banner text, on any
  // comment from anyone — and quoting the card above your reply is how people
  // answer. His quote is NEWER than the card it quotes, so the question was
  // anchored on his own comment, nothing of his came after it, and the verdict
  // was `none`: the relay handed nothing back — a REGRESSION against the old
  // fresh-only rule, which would have moved it — while stale-answer filed the
  // same ticket as healthy. Stranded, with the watchdog saying all-clear.
  const quoted = {
    id: 'a1',
    date: '2000',
    user: { id: DANE },
    comment_text: `> ${ESCALATION_BANNER} Which option, A or B?\n\nB`,
  };
  assert.ok(isEscalationCard(quoted.comment_text), 'the banner really is in his text — that is the trap');
  assert.ok(!isMachineComment(quoted.comment_text), 'and it is still his word');

  const out = answerAwaitingHandback({
    comments: [card('c1', 1000), quoted],
    ...answeredOpts,
    delivered: allDelivered,
  });
  assert.equal(out.state, 'answered', 'only a MACHINE card may be the question');
  assert.equal(out.answer.id, 'a1');
});

test('without an isMachine test nothing can be a card — the safe direction', () => {
  // A caller that forgets the predicate must fall through to `no-question`,
  // which keeps the old fresh-only rule at the relay and CANNOT TELL in the
  // report. Both are safe; guessing a question is not.
  const out = answerAwaitingHandback({ comments: [card('c1', 1000), his('a1', 2000)], operatorId: DANE });
  assert.equal(out.state, 'no-question');
});

test('an answer a hand-back already completed on is spent, so a hand-park is left alone', () => {
  // The judgment call from round 1, decided. The authorization is a property of
  // the ticket with no memory of the move: a ticket answered, released, and then
  // re-parked in `Needs your input` BY HAND still satisfies "delivered answer
  // newer than the newest card", so the next pass dragged it back out and
  // stripped his assignment inside ten minutes. The old rule left it alone, and
  // `Needs your input` is a status only he may be taken out of.
  const comments = [card('c1', 1000), his('a1', 2000)];
  const out = answerAwaitingHandback({
    comments, ...answeredOpts, delivered: allDelivered, handled: (c) => c.id === 'a1',
  });
  assert.equal(out.state, 'handled');
  assert.equal(handbackTarget(loopQueue, 'needs your input', out.state === 'answered' && out.delivered), null,
    'a spent answer must not move the ticket again');

  // ...and a NEW escalation on the same ticket is unaffected: the question is
  // anchored on the newest card, so his next answer is a different comment.
  const again = answerAwaitingHandback({
    comments: [...comments, card('c2', 3000), his('a2', 4000)],
    ...answeredOpts,
    delivered: allDelivered,
    handled: (c) => c.id === 'a1',
  });
  assert.equal(again.state, 'answered');
  assert.equal(again.answer.id, 'a2');
});

test('the three reply markers are told apart by the one reader both halves use', () => {
  const done = handbackDoneText({ target: 'Queued', at: 'ISO' });
  const failed = handbackFailureText({ target: 'Queued', status: 'needs your input', why: 'HTTP 429', at: 'ISO' });
  assert.ok(done.startsWith(HANDBACK_DONE_MARKER));
  assert.ok(!done.startsWith(DEDUP_MARKER), 'a completed hand-back must not claim a bus delivery');
  assert.ok(!done.startsWith(HANDBACK_FAILURE_MARKER), 'a completed hand-back must not read as a failed one');
  assert.ok(!failed.startsWith(HANDBACK_DONE_MARKER), 'and a failed one must not read as completed');
  assert.ok(isMachineComment(done), 'it must never come back as Dane\'s own word');

  assert.equal(repliesShowHandbackDone([{ comment_text: done }]), true);
  assert.equal(repliesShowHandbackFailure([{ comment_text: done }]), false);
  assert.equal(repliesShowHandbackFailure([{ comment_text: failed }]), true);
  assert.equal(repliesShowRelayed([{ comment_text: `${DEDUP_MARKER} sent to channel x` }]), true);
  assert.equal(repliesShowRelayed([{ comment_text: done }]), false);
  assert.equal(repliesShowRelayed(null), false, 'no replies is not a delivery');
});

test('the failed hand-back note is written once per answer, not once per pass', (t) => {
  if (skipWithoutDoor(t)) return;
  // Finding 4. It was written unconditionally. On a persistent NON-429 failure
  // — a renamed status, a permission error — the status write keeps failing
  // while comment writes keep succeeding, so the relay adds a fresh note every
  // ten minutes: ~144 a day on the ticket Dane is reading. Everything else in
  // this family throttles once per reason per 6h.
  assert.match(RELAY_SRC, /if \(repliesShowHandbackFailure\(replies\)\) handbackNotedIds\.add\(String\(c\.id\)\);/,
    'the pass must record which answers already carry a note — off a read it already paid for');
  assert.match(RELAY_SRC, /if \(answered\.answer && handbackNotedIds\.has\(String\(answered\.answer\.id\)\)\)/,
    'and must consult it before posting another');

  // Both marker reads must happen BEFORE the already-relayed `continue`, or
  // they are never run on the one comment that matters — a hand-back always
  // acts on an answer relayed by an earlier pass.
  const doneAt = RELAY_SRC.indexOf('repliesShowHandbackDone(replies)');
  const notedAt = RELAY_SRC.indexOf('repliesShowHandbackFailure(replies)');
  const skipAt = RELAY_SRC.indexOf('if (already) { deliveredIds.add');
  assert.ok(doneAt > -1 && notedAt > -1 && skipAt > -1, 'the relay moved — re-point this test');
  assert.ok(doneAt < skipAt && notedAt < skipAt,
    'a marker read after the already-relayed `continue` never runs on the answer a hand-back acts on');
});

test('a completed hand-back marks the answer, and only after the move verified', (t) => {
  if (skipWithoutDoor(t)) return;
  const marker = RELAY_SRC.indexOf('comment_text: handbackDoneText({');
  const verified = RELAY_SRC.indexOf("unchecked.push(`${t.id}: hand-back did not stick");
  assert.ok(marker > -1 && verified > -1, 'the relay moved — re-point this test');
  assert.ok(marker > verified,
    'marking an answer spent before the move is verified would suppress the retry this ticket exists to add');
  assert.match(RELAY_SRC, /handled: \(c\) => handbackDoneIds\.has\(String\(c\.id\)\)/,
    'and the relay must READ that marker, or writing it changes nothing');
});


/* ------------------------------------------------------------------ *
 * WHERE AN ANSWERED TICKET GOES (2026-09-08, task 86bbw596q).
 *
 * The handback used to be a flat map: every answered "needs your input"
 * ticket went to `Queued`, which is a status `loop-build` claims from — even
 * when the ticket's own work was already merged and its branch deleted. That
 * is 86bbw4dch on 2026-09-07 (PR #650): merged, answered, handed back as
 * claimable work, caught by hand within minutes.
 * ------------------------------------------------------------------ */

test('an answered ticket whose work is ALREADY MERGED does not go back in the build queue', () => {
  const plan = handbackDestination(loopQueue, 'needs your input', 1, { number: 650, state: 'MERGED' });
  assert.equal(plan.act, 'move');
  assert.equal(plan.target, 'Live', 'merged work belongs in Live, where the relay\'s own merge path puts it');
  // The claim guard reads status alone, so the destination is the ONLY thing
  // standing between a merged ticket and a build pass claiming it.
  const claimable = ['Queued', 'Rework'];
  assert.equal(claimable.includes(plan.target), false,
    'a merged ticket landed in a status loop-build claims from — this is the bug');
  assert.match(plan.why, /#650/, 'the reason must name the pull request it read');
});

test('merged work whose description names a next slice goes back to Queued, by the merge path\'s own rule', () => {
  const { mergeDestination } = require('./nextSlice.js');
  const description = 'Next slice: the ClickUp door';
  const plan = handbackDestination(loopQueue, 'needs your input', 1, { number: 5, state: 'MERGED' }, '(a)', description);
  assert.deepEqual([plan.act, plan.target], ['move', mergeDestination(description).status]);
  assert.equal(plan.target, 'Queued');
  assert.match(plan.why, /#5 is already merged, but the description says more remains — "Next slice: the ClickUp door"/);
  assert.equal(handbackDestination(loopQueue, 'needs your input', 1, { number: 5, state: 'MERGED' }, '(a)', 'Next slice: none').target, 'Live');
  assert.equal(handbackDestination(loopQueue, 'needs your input', 1, { number: 5, state: 'MERGED' }, 'close it', description).target, 'Live');
});

test('ClickUp and gh spell state differently, and neither casing may claim-queue merged work', () => {
  // gh answers "MERGED"; nothing guarantees a future caller keeps the case.
  assert.equal(handbackDestination(loopQueue, 'needs your input', 1, { number: 650, state: 'merged' }).target, 'Live');
  assert.equal(handbackDestination(loopQueue, 'NEEDS YOUR INPUT', 1, { number: 650, state: ' Merged ' }).target, 'Live');
});

test('the ordinary case is unchanged: an answered ticket with no PR trail still goes to Queued', () => {
  // This is the case the hand-back exists for (task 86bbh9g7k) and the one it
  // must not regress — a ticket nobody has built belongs back in the queue.
  const plan = handbackDestination(loopQueue, 'needs your input', 1, null);
  assert.equal(plan.act, 'move');
  assert.equal(plan.target, 'Queued');
  assert.match(plan.why, /nothing has been built/);
  // And undefined must read the same as null: the caller passes whatever its
  // trail lookup returned.
  assert.equal(handbackDestination(loopQueue, 'needs your input', 1).target, 'Queued');
});

test('an answered ticket with an OPEN pull request goes to Rework, where migrate-rework says it belongs', () => {
  const plan = handbackDestination(loopQueue, 'needs your input', 1, { number: 651, state: 'OPEN' });
  assert.equal(plan.act, 'move');
  assert.equal(plan.target, 'Rework',
    'a queued ticket with a branch behind it is one a build pass misreads — that is what migrate-rework asserts');
});

test('a pull request closed WITHOUT merging goes back to Queued — GitHub deleted the branch, so there is nothing to continue', () => {
  const plan = handbackDestination(loopQueue, 'needs your input', 1, { number: 652, state: 'CLOSED' });
  assert.equal(plan.act, 'move');
  assert.equal(plan.target, 'Queued');
});

test('a pull request whose state could not be read moves NOTHING and says so', () => {
  // DOCTRINE 3.11: "could not check" must never read as "clear". Guessing
  // Queued here is exactly the bug; guessing Live would close live work.
  const plan = handbackDestination(loopQueue, 'needs your input', 1,
    { number: 653, state: '', why: 'the `gh` command is not installed on this machine' });
  assert.equal(plan.act, 'cannot-tell');
  assert.equal(plan.target, null, 'a ticket whose PR could not be read must stay exactly where it is');
  assert.match(plan.why, /gh` command is not installed/, 'and the reason it could not tell must survive to the report');
});

test('the doctrine checkpoint still comes first: no authorization, no move, whatever the PR says', () => {
  for (const pr of [null, { number: 650, state: 'MERGED' }, { number: 651, state: 'OPEN' }]) {
    const plan = handbackDestination(loopQueue, 'needs your input', 0, pr);
    assert.equal(plan.act, 'skip');
    assert.equal(plan.target, null);
  }
});

test('"ready to launch" and the Agent Response list are still released by nothing', () => {
  assert.equal(handbackDestination(loopQueue, 'ready to launch', 1, { number: 650, state: 'MERGED' }).act, 'skip');
  assert.equal(handbackDestination(agentResponse, 'pending response', 1, null).act, 'skip');
  assert.equal(handbackDestination(loopQueue, 'building', 1, null).act, 'skip');
});

test('the relay decides the hand-back from the ticket, and reports a reading it could not take', (t) => {
  if (skipWithoutDoor(t)) return;
  // The pure function above is only half of it. Nothing but the source can pin
  // that the relay actually resolves the trail and passes it in — without
  // these, every unit test here passes while the flat map is still live.
  assert.match(RELAY_SRC, /const trailPr = releasesThisStatus \? findPullRequest\(/,
    'the relay must read this ticket\'s own "PR opened:" trail');
  assert.match(RELAY_SRC, /const handbackPr = trailPr \? readPullRequestState\(trailPr\) : null;/,
    'and resolve that pull request\'s state before deciding');
  assert.match(RELAY_SRC, /if \(plan\.act === 'cannot-tell'\) \{/,
    'a state it could not read must stop the move, not fall through to one');
  assert.match(RELAY_SRC, /unchecked\.push\(`\$\{t\.id\}: his answer was delivered, but \$\{plan\.why\}`\)/,
    'and it must be reported, or "could not check" reads as a clean pass');
  // The receipt names the status the move will ask for, not a hard-coded one.
  // Since task 86bccgp8q it is filtered through receiptTargetFor, so it names
  // that destination only for the comment that actually releases the ticket.
  assert.match(RELAY_SRC, /target: handbackDestination\(watch, t\.status\?\.status, 1, handbackPr, c\.comment_text\)\.target,/,
    'the fallback receipt must name the destination this ticket is actually going to');
});

// ── An answer that says "close it" closes the ticket (task 86bc08xx5) ───────
//
// 2026-09-14: 86bbwmumk was already fixed on main; a build pass asked Dane to
// close it, he answered "close it", and the relay returned it to Queued — the
// top of the claim line — so the next build pass claimed it and spent a whole
// pass re-verifying a fix. The watch never read the answer.
{
  const { isCloseCommand, handbackDoneText: doneText, receiptText: receipt } = require('./busRelayPlan.js');
  const needsInput = loopQueue;

  test('his answer "close it" moves an answered ticket to Live, not back to Queued', () => {
    const plan = handbackDestination(needsInput, 'needs your input', 1, null, 'close it');
    assert.equal(plan.act, 'move');
    assert.equal(plan.target, 'Live');
    assert.match(plan.why, /close it/);
  });

  test('the recognised phrasings, in the shapes the editor actually stores', () => {
    for (const text of ['close it', 'Close it.', 'CLOSE IT!', '`close it`', '**close it**', '```\nclose it\n```',
      'close', 'close this', 'close this ticket', 'close the ticket', 'please close it', 'close it please',
      'yes, close it', 'ok close it', 'closed', 'close it\n']) {
      assert.equal(isCloseCommand(text), true, `should close on ${JSON.stringify(text)}`);
    }
  });

  test('near-misses do NOT close — narrow on purpose, because a wrong close loses his ticket', () => {
    for (const text of [
      'can you close the gap in the header?',
      'close the PR but keep the ticket open',
      'do not close it',
      "don't close it",
      'close it after you fix the footer',
      'this is close to done',
      'done',
      'nothing to do',
      'ran the SQL, done',
      'merge',
      '',
      undefined,
      null,
    ]) {
      assert.equal(isCloseCommand(text), false, `must NOT close on ${JSON.stringify(text)}`);
      const plan = handbackDestination(needsInput, 'needs your input', 1, null, text);
      assert.equal(plan.target, 'Queued', `and must fall through to today's Queued on ${JSON.stringify(text)}`);
    }
  });

  test('any other answer still releases to Queued exactly as before, trail rules unchanged', () => {
    assert.equal(handbackDestination(needsInput, 'needs your input', 1, null, 'yes, go ahead').target, 'Queued');
    assert.equal(handbackDestination(needsInput, 'needs your input', 1, { number: 7, state: 'OPEN' }, 'looks good').target, 'Rework');
    assert.equal(handbackDestination(needsInput, 'needs your input', 1, { number: 7, state: 'MERGED' }, 'ok').target, 'Live');
    // Omitting the answer entirely is the old four-argument call: unchanged.
    assert.equal(handbackDestination(needsInput, 'needs your input', 1, null).target, 'Queued');
  });

  test('"close it" is still gated by the doctrine checkpoint — no delivered answer, no move', () => {
    assert.equal(handbackDestination(needsInput, 'needs your input', 0, null, 'close it').act, 'skip');
    assert.equal(handbackDestination(needsInput, 'ready to launch', 1, null, 'close it').act, 'skip');
  });

  test('closing with an OPEN pull request says the PR was left alone', () => {
    const plan = handbackDestination(needsInput, 'needs your input', 1, { number: 692, state: 'OPEN' }, 'close it');
    assert.equal(plan.target, 'Live');
    assert.match(plan.why, /PR #692 is still open/);
  });

  test('both notes on the ticket say CLOSED, never "returned to Queued"', () => {
    const done = doneText({ target: 'Live', at: '2026-09-14T21:00:00Z' });
    assert.match(done, /this ticket was closed/);
    assert.doesNotMatch(done, /back with the machines/);
    assert.match(doneText({ target: 'Queued' }), /returned to "Queued", so it is back with the machines/);

    assert.match(receipt({ why: 'HTTP 400', target: 'Live', at: 'x' }), /being closed, as you asked/);
    assert.match(receipt({ why: 'HTTP 400', target: 'Queued', at: 'x' }), /being returned to Queued/);
  });

  test('the relay hands his answer text to both decisions — the receipt and the move', (t) => {
    if (skipWithoutDoor(t)) return;
    assert.match(RELAY_SRC, /handbackDestination\(watch, t\.status\?\.status, 1, handbackPr, c\.comment_text\)/);
    assert.match(RELAY_SRC, /handbackDestination\(watch, t\.status\?\.status, authorized, handbackPr, answered\.answer\?\.comment_text\)/);
  });
}

// ── A notify-only watch falls back to the Undelivered alarms ticket (task 86bc0mxv0) ──
//
// 2026-09-14: Dane's "merge" on two Ready to launch tickets could not reach the
// refused party line, and this watch had no fallback — so every relay pass
// logged "could not deliver anywhere", failed, and retried the same comments.
// 18 of 40 passes exited 1; the relay read QUIET for 5h40m. The receipt tests
// above still hold (a note on the SAME ticket delivers nothing); the standing
// Undelivered alarms ticket is a different, read place, and keeps the message.
test('notify-only watch: saved on the Undelivered alarms ticket IS delivery', () => {
  const v = deliveryVerdict({ chatOk: false, handsBack: false, alarmTicketAttempted: true, alarmTicketOk: true });
  assert.equal(v.ok, true);
  assert.equal(v.via, 'alarm-ticket');
  assert.match(relayMarkerText({ ...v, channel: 'c', at: AT }), /^\[bus-relay\] chat unavailable, saved on the "Team chat" ticket at /,
    'the marker must keep the [bus-relay] prefix, or the "already relayed" check retries it forever');
});

test('notify-only watch: a double refusal is still NOT delivered, says why, and writes no marker', () => {
  const v = deliveryVerdict({ chatOk: false, handsBack: false, alarmTicketAttempted: true, alarmTicketOk: false, alarmTicketWhy: 'HTTP 429' });
  assert.equal(v.ok, false);
  assert.match(v.why, /"Team chat" ticket refused it too \(HTTP 429\)/);
  assert.equal(relayMarkerText({ ...v, channel: 'c', at: AT }), null);
});

test('the alarm ticket never stands in for a hand-back watch — that one still needs its own receipt', () => {
  const v = deliveryVerdict({ chatOk: false, handsBack: true, alarmTicketAttempted: true, alarmTicketOk: true, receiptAttempted: true, receiptPosted: false, receiptStatus: 500 });
  assert.equal(v.ok, false, 'a ticket that is about to be handed back must carry its own receipt');
});

test('the relay attempts the alarm ticket on a notify-only watch and reports it as a skipped post, not a failure', (t) => {
  if (skipWithoutDoor(t)) return;
  const start = RELAY_SRC.indexOf('async function deliverToBus(');
  const body = RELAY_SRC.slice(start, RELAY_SRC.indexOf('\n}\n', start));
  const noHandback = body.slice(body.indexOf('if (!handsBack) {'), body.indexOf('if (receipted && receipted.has('));
  assert.match(noHandback, /await saveUndeliveredAlarm\(\{ text: content, channel, why: chat\.why \}\)/);
  assert.match(noHandback, /alarmTicketOk: Boolean\(saved\.ok\)/);
  assert.match(RELAY_SRC, /if \(delivery\.via === 'alarm-ticket'\) \{\s*reportBusFailure\(\{ delivered: true,/);
});

test('a rehearsal names the alarm-ticket delivery', () => {
  const line = simulationLine({ verdict: { ok: true, via: 'alarm-ticket' }, target: null });
  assert.match(line, /Team chat/);
  assert.doesNotMatch(line, /INVALID|NOT delivered/);
});
