'use strict';

/**
 * Task 86bbtqpxd — a terminal merge refusal must stop saying the approval is
 * still standing.
 *
 * Ticket 86bbqw49y sat in Ready to launch for twelve hours with its work
 * already merged and live. Twenty-five refusal comments, sixteen of them for
 * "the PR is already merged" — a reason no later pass could ever clear —
 * every one of them closing with "your approval is still standing ... it goes
 * through on its own". The reassurance is what stopped anybody looking.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { doorSource, skipWithoutDoor } = require('./productScripts.js');

const {
  REFUSAL_CODES,
  REFUSAL_CLASSES,
  REFUSAL_REASONS,
  classifyRefusal,
  speaksAsTerminal,
  refusalNeeds,
} = require('./refusalClass.js');

const {
  refusalNotice,
  githubGate,
  mergeDecision,
  APPROVAL_CARRIES_OVER,
} = require('./mergeOnComment.js');

// ---------- AC1: every reason is classified, and there is no default

test('every code has an entry, and every entry has a code — no orphans either way', () => {
  const codes = Object.values(REFUSAL_CODES);
  assert.ok(codes.length >= 15, 'the table should cover every refusal the merge step can raise');
  for (const code of codes) {
    const entry = REFUSAL_REASONS[code];
    assert.ok(entry, `code "${code}" is raised but has no classification entry`);
    assert.ok(REFUSAL_CLASSES.includes(entry.kind), `code "${code}" has kind "${entry.kind}", not one of ${REFUSAL_CLASSES.join('/')}`);
  }
  for (const key of Object.keys(REFUSAL_REASONS)) {
    assert.ok(codes.includes(key), `entry "${key}" is classified but no code names it — dead entry`);
  }
});

test('THE RULE: a reason absent from the table throws — there is no default', () => {
  // Break test 1 from the ticket: add a refusal reason without classifying it.
  assert.throws(
    () => classifyRefusal('a-brand-new-reason-nobody-classified'),
    /unclassified merge refusal reason/,
    'an unclassified reason must fail loudly, never inherit a promise by default',
  );
  assert.throws(() => classifyRefusal(undefined), /unclassified merge refusal reason/);
  assert.throws(() => classifyRefusal(''), /unclassified merge refusal reason/);
});

test('a "could not tell" is its own class and SPEAKS as terminal', () => {
  // DOCTRINE 3.11: a reader who cannot be told to wait must be told to look.
  const unknowns = Object.entries(REFUSAL_REASONS).filter(([, e]) => e.kind === 'unknown');
  assert.ok(unknowns.length >= 3, 'the CANNOT TELL answers must be classified, not folded into terminal or transient');
  for (const [code] of unknowns) {
    assert.equal(speaksAsTerminal(code), true, `${code}: unknown must speak as terminal`);
  }
});

test('every raise site in mergeOnComment.js carries a code', () => {
  // The source scan is the guard that a NEW refusal cannot be added without a
  // classification. `classifyRefusal` catches a WRONG code at runtime; this
  // catches a MISSING one, which is the likelier mistake — a refusal added by
  // copying the line above it.
  //
  // Counted rather than matched inside each object literal, because those
  // literals carry template strings with `${...}` in them and a brace-matching
  // regex over that is a second parser waiting to be wrong.
  const src = fs.readFileSync(path.join(__dirname, 'mergeOnComment.js'), 'utf8');
  const count = (re) => (src.match(re) || []).length;

  const gateRefusals = count(/action: 'refuse'/g);
  const gateCodes = count(/refusalCode: R\./g);
  assert.ok(gateRefusals >= 9, `expected githubGate's refusals to be found; saw ${gateRefusals}`);
  assert.equal(gateCodes, gateRefusals,
    `${gateRefusals} refusals are raised with "action: 'refuse'" but only ${gateCodes} carry a "refusalCode: R.<code>" — a refusal was added without classifying it`);

  // mergeDecision raises through its own helper, which takes the code first.
  const decisionRefusals = count(/\brefuse\(/g);
  const decisionCoded = count(/\brefuse\(R\./g);
  assert.ok(decisionCoded >= 4, `expected mergeDecision's refusals to be found; saw ${decisionCoded}`);
  assert.equal(decisionCoded, decisionRefusals,
    `${decisionRefusals} calls to refuse() but only ${decisionCoded} name a code from REFUSAL_CODES`);
});

// ---------- AC2: a terminal refusal drops the promise and names the actor

/** Every code, rendered as the comment the operator actually reads. */
function noticeFor(code) {
  return refusalNotice({
    commentId: '900',
    why: `some reason for ${code}`,
    plainEnglish: 'This ticket is not in a state a script may merge from.',
    refusalCode: code,
  });
}

test('THE BUG: a terminal refusal never says the approval is still standing', () => {
  // Break test 2 from the ticket: force `already merged` and read the message.
  const notice = noticeFor(REFUSAL_CODES.prAlreadyMerged);
  assert.equal(notice.terminal, true);
  assert.ok(
    !notice.body.includes(APPROVAL_CARRIES_OVER),
    'the standing-approval paragraph is the sentence that cost twelve hours; it must be absent',
  );
  assert.ok(!/goes through on its own/.test(notice.body), 'nothing may imply a later pass will handle it');
  assert.match(notice.body, /This PR is merged; the work is live/);
  assert.match(notice.body, /moving to Live/);
});

test('every terminal and unknown reason drops the promise; every transient one keeps it', () => {
  for (const code of Object.values(REFUSAL_CODES)) {
    const notice = noticeFor(code);
    const promises = notice.body.includes(APPROVAL_CARRIES_OVER);
    const terminal = speaksAsTerminal(code);
    assert.equal(promises, !terminal,
      `${code} (${classifyRefusal(code).kind}): body ${promises ? 'promises' : 'does not promise'} the approval carries over and should ${terminal ? 'not ' : ''}`);
    assert.equal(notice.terminal, terminal);
    assert.equal(notice.actor, terminal ? 'agent-or-operator' : 'later-pass');
  }
});

test('AC: every terminal message names WHO must act — never an unnamed actor', () => {
  // docs/DOCTRINE.md §2.5. A hand-off that cannot name an actor does not get
  // to imply one; "this needs to be dealt with" is the defect, not the fix.
  const BANNED = [
    /\bsomebody\b/i, /\bsomeone\b/i, /\banybody\b/i, /\banyone\b/i,
    /needs to be (?:dealt with|looked at|handled)/i,
    /will be (?:dealt with|looked at|handled)/i,
  ];
  for (const code of Object.values(REFUSAL_CODES)) {
    if (!speaksAsTerminal(code)) {
      assert.equal(refusalNeeds(code), '', `${code}: a transient reason must not carry a "what to do" sentence`);
      continue;
    }
    const needs = refusalNeeds(code);
    assert.ok(needs, `${code}: a terminal reason must say what it needs instead of the promise`);
    assert.match(needs, /an agent session|Dane/i, `${code}: names no actor — "${needs}"`);
    for (const banned of BANNED) {
      assert.ok(!banned.test(needs), `${code}: passive/unnamed actor matched ${banned} — "${needs}"`);
    }
    assert.match(needs, /will not ask again|will not post about it again/i,
      `${code}: a terminal refusal must say out loud that nothing further is coming`);
  }
});

test('refusalNotice REFUSES to render without a classification', () => {
  assert.throws(
    () => refusalNotice({ commentId: '1', why: 'x', plainEnglish: 'y' }),
    /unclassified merge refusal reason/,
    'an unclassified refusal must not be able to reach the operator at all',
  );
});

// ---------- the codes actually reach the notices from the real raise sites

const PR_URL = 'https://github.com/o/r/pull/512';
const VERDICT = { id: '1', date: '1000', user: { id: 9 }, comment_text: 'REVIEW: PASSED (everything green)' };
const PR_TRAIL = { id: '2', date: '1001', user: { id: 9 }, comment_text: `PR opened: ${PR_URL}` };
const MERGE_WORD = { id: '3', date: '2000', user: { id: 42 }, comment_text: 'merge' };

function decide(comments, refused) {
  return mergeDecision({
    status: 'Ready to launch',
    comments: [...comments].reverse(),
    operatorId: 42,
    handled: new Set(),
    refused,
  });
}

test('mergeDecision hands its refusals out with the code attached', () => {
  const noVerdict = decide([PR_TRAIL, MERGE_WORD]);
  assert.equal(noVerdict.act, 'refuse');
  assert.equal(noVerdict.refusalCode, REFUSAL_CODES.noReviewVerdict);
  assert.equal(speaksAsTerminal(noVerdict.refusalCode), false, 'loop-review will write the verdict — genuinely transient');

  const noPr = decide([VERDICT, MERGE_WORD]);
  assert.equal(noPr.act, 'refuse');
  assert.equal(noPr.refusalCode, REFUSAL_CODES.noPrRecorded);
  assert.equal(speaksAsTerminal(noPr.refusalCode), true, 'no later pass can invent a PR link');
});

test('githubGate hands its refusals out with the code attached', () => {
  assert.equal(githubGate({ state: 'MERGED' }).refusalCode, REFUSAL_CODES.prAlreadyMerged);
  assert.equal(githubGate({ state: 'CLOSED' }).refusalCode, REFUSAL_CODES.prNotOpen);
  assert.equal(githubGate({ state: 'OPEN', isDraft: true }).refusalCode, REFUSAL_CODES.prIsDraft);
  const red = githubGate({
    state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
    statusCheckRollup: [{ name: 'verify', status: 'COMPLETED', conclusion: 'FAILURE' }],
  });
  assert.equal(red.refusalCode, REFUSAL_CODES.checksRed);
  const noChecks = githubGate({
    state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: [],
  });
  assert.equal(noChecks.refusalCode, REFUSAL_CODES.noChecksAtAll);
  assert.equal(speaksAsTerminal(noChecks.refusalCode), true,
    'GitHub creates a check run for a push, not for waiting — a checkless PR stays checkless');
});

test('the three reasons from the 86bbqw49y wreck classify the way the incident showed', () => {
  // The ticket's own table: 16 already-merged (terminal), 3 no-PR-opened
  // (terminal), 6 no-review-verdict (transient). Two thirds of the refusals
  // told the reader to wait for something that was never coming.
  assert.equal(classifyRefusal(REFUSAL_CODES.prAlreadyMerged).kind, 'terminal');
  assert.equal(classifyRefusal(REFUSAL_CODES.noPrRecorded).kind, 'terminal');
  assert.equal(classifyRefusal(REFUSAL_CODES.noReviewVerdict).kind, 'transient');
});

// ---------- AC3: one comment, one bus post, then it stops

/**
 * THE ESCALATION SHAPE. A terminal refusal is the end of the line, so it says
 * so once and goes quiet — it must not bury the ticket in identical comments,
 * and it must not go quiet while still sounding like progress. The first half
 * is the dedup, tested here across three consecutive passes; the second half
 * is the wording, tested above.
 *
 * This drives the REAL decision function with the marker the previous pass
 * would have written, which is exactly what the relay does (it reads its own
 * markers back off the ticket).
 */
test('AC3: three consecutive passes over a terminal refusal post ONE comment', () => {
  const comments = [VERDICT, MERGE_WORD]; // a verdict and his word, but no PR trail
  const posted = [];
  const refused = new Map();

  for (let pass = 1; pass <= 3; pass += 1) {
    const decision = decide(comments, refused);
    if (decision.act === 'refuse') {
      // What the relay does: post the notice, then record the marker.
      posted.push(refusalNotice({
        commentId: decision.commentId,
        why: decision.reason,
        plainEnglish: 'This ticket is not in a state a script may merge from.',
        refusalCode: decision.refusalCode,
      }));
      refused.set(String(decision.commentId), decision.reason);
    } else {
      assert.equal(decision.act, 'ignore', `pass ${pass}: a repeat must be quiet, not a second refusal`);
      assert.match(decision.reason, /already refused for the same reason/);
    }
  }

  assert.equal(posted.length, 1, 'three passes, one comment — the repeat is not news');
  assert.equal(posted[0].terminal, true);
  assert.ok(!posted[0].body.includes(APPROVAL_CARRIES_OVER));
  // And the one comment that DID go out says nothing further is coming, which
  // is what turns "went quiet" from a silence into a full stop.
  assert.match(posted[0].body, /will not ask again/i);
});

test('a TRANSIENT refusal goes quiet the same way — the dedup is not the defect', () => {
  // Worth pinning: the fix is to the WORDING and the escalation, not to the
  // dedup. Quieting an unchanged repeat was always right.
  const comments = [PR_TRAIL, MERGE_WORD]; // no verdict yet
  const refused = new Map();
  const first = decide(comments, refused);
  assert.equal(first.act, 'refuse');
  refused.set(String(first.commentId), first.reason);
  const second = decide(comments, refused);
  assert.equal(second.act, 'ignore');
  assert.equal(second.refusalCode, REFUSAL_CODES.noReviewVerdict, 'even a quiet repeat carries its code');
});

// ---------- ROUND 2: the code has to SURVIVE the trip, not just be raised
//
// Review round 1 of this task found the classification correct and the
// plumbing broken. `afterCatchUpDecision` is the funnel both in-pass waits go
// through, and it rebuilt the gate object without the code — so every refusal
// discovered while waiting arrived unclassified. Two consequences, both worse
// than the original bug: `refusalNotice` threw and killed the whole relay
// pass, and the one path that supplied a fallback code labelled genuinely
// terminal reasons transient, rebuilding the standing-approval lie the fix
// existed to remove. These tests follow a refusal all the way from the gate to
// the rendered message.

const {
  afterCatchUpDecision,
  IN_PASS_WAIT_MS,
  refusalBusLine,
} = require('./mergeOnComment.js');
const reviewGate = require('./reviewGate.js');

test('ROUND 2: afterCatchUpDecision carries the refusal code through', () => {
  for (const [prJson, expected] of [
    [{ state: 'CLOSED' }, REFUSAL_CODES.prNotOpen],
    [{ state: 'MERGED' }, REFUSAL_CODES.prAlreadyMerged],
    [{ state: 'OPEN', isDraft: true }, REFUSAL_CODES.prIsDraft],
    [{
      state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
      statusCheckRollup: [{ name: 'verify', status: 'COMPLETED', conclusion: 'FAILURE' }],
    }, REFUSAL_CODES.checksRed],
  ]) {
    const gate = githubGate(prJson);
    assert.equal(gate.action, 'refuse', 'fixture should refuse');
    const next = afterCatchUpDecision({ gate, elapsedMs: 0, budgetMs: IN_PASS_WAIT_MS });
    assert.equal(next.action, 'refuse');
    assert.equal(next.refusalCode, expected,
      `the code was dropped crossing afterCatchUpDecision — this is the round 1 defect (${expected})`);
  }
});

test('ROUND 2: an unclassified refusal can no longer reach the operator by way of the wait', () => {
  // The exact measured failure from the send-back: gate refuses, the code is
  // stripped, refusalNotice throws, runMergeStep dies mid-pass.
  const gate = githubGate({ state: 'CLOSED' });
  const next = afterCatchUpDecision({ gate, elapsedMs: 0 });
  assert.doesNotThrow(() => refusalNotice({
    commentId: '900', why: next.reason, plainEnglish: 'x', refusalCode: next.refusalCode,
  }), 'a refusal that came out of the wait must still be classifiable');
});

test('ROUND 2: a PR read back as CLOSED during the wait does NOT promise the approval carries over', () => {
  // This is the 86bbqw49y sentence rebuilt on the review-gate re-run path: the
  // stripped code meant the `|| reviewGateRerunUnresolved` fallback fired
  // every time, and that code is classified TRANSIENT.
  const afterWait = afterCatchUpDecision({ gate: githubGate({ state: 'CLOSED' }), elapsedMs: 0 });
  const decided = reviewGate.afterRerunDecision(afterWait);
  assert.equal(decided.action, 'refuse');
  assert.equal(decided.refusalCode, REFUSAL_CODES.prNotOpen,
    'the re-run path must pass githubGate\'s own code through, not relabel it');

  const notice = refusalNotice({
    commentId: '900', why: decided.reason, plainEnglish: 'x', refusalCode: decided.refusalCode,
  });
  assert.equal(notice.terminal, true);
  assert.ok(!notice.body.includes(APPROVAL_CARRIES_OVER),
    'a closed PR never reopens on its own — promising otherwise is the whole bug');
  assert.ok(!/goes through on its own/.test(notice.body));
});

test('ROUND 2: the re-run path has no silent code fallback left in the relay', (t) => {
  if (skipWithoutDoor(t)) return;
  // A source scan, because the defect was a `||` default that read as a belt
  // and was in fact the entire answer. refusalClass.js's own header forbids a
  // default; this is the one place one had crept back in.
  const relay = doorSource() || '';
  const fallbacks = relay.match(/refusalCode\s*\|\|/g) || [];
  assert.equal(fallbacks.length, 0,
    `${fallbacks.length} place(s) in clickup_direct.mjs default a missing refusalCode — a reason nothing classified must fail loudly, never inherit a class`);
});

test('ROUND 2: every gate reassignment in the relay carries the code with it', (t) => {
  if (skipWithoutDoor(t)) return;
  // The two rebuilt gate objects are what reach `refuse(gate.reason, ...,
  // gate.refusalCode)` at the bottom of runMergeStep. A rebuild that omits the
  // code is the crash.
  const relay = doorSource() || '';
  const rebuilds = relay.match(/^\s*gate = \{[^}]*\}/gm) || [];
  assert.ok(rebuilds.length >= 2, `expected the gate reassignments to be found; saw ${rebuilds.length}`);

  let checked = 0;
  for (const line of rebuilds) {
    // `{ ...gate, ... }` keeps everything by construction.
    if (line.includes('...gate')) continue;
    // A rebuild that hard-codes a NON-refusal action (`action: 'conflict'`,
    // `action: 'wait'`) has no code to carry — it is not a refusal and could
    // not become one. The dangerous shape is the one that copies an action it
    // has not read: `action: after.action` may be a refusal, and those are the
    // two the round 1 review measured the code being lost on.
    const literal = /action: '[a-z-]+'/.test(line);
    if (literal) continue;
    checked += 1;
    assert.ok(/refusalCode/.test(line),
      `a gate is rebuilt from an action it did not read, without carrying its refusalCode — ${line.trim()}`);
  }
  assert.ok(checked >= 2, `expected at least the two waits' gate rebuilds to be checked; saw ${checked}`);
});

// ---------- ROUND 2: 'unknown' is not 'terminal' on the bus

test('ROUND 2: a CANNOT-TELL refusal is not announced as a certainty', () => {
  // The bus post branched on `notice.terminal`, true for 'unknown' too, so it
  // said "no later pass will clear it" beside a ticket comment that correctly
  // said it could not say. `blockedCannotTell` routinely DOES clear.
  const notice = noticeFor(REFUSAL_CODES.blockedCannotTell);
  assert.equal(notice.kind, 'unknown', 'the notice must expose the three-way class, not just terminal/not');
  assert.equal(notice.terminal, true, 'it still speaks as terminal — it may not promise the approval carries over');

  const line = refusalBusLine({ label: 't', url: 'u', why: 'w', kind: notice.kind });
  assert.ok(!/no later pass will clear it/.test(line),
    'the gate could not tell; the bus may not assert what it could not tell');
  assert.match(line, /CANNOT TELL/);
  assert.match(line, /an agent session or Dane/, 'DOCTRINE §2.5 — name the actor');
  assert.match(line, /will not post about it again/);
});

test('ROUND 2: each class gets its own bus sentence, and an unclassed one throws', () => {
  const terminal = refusalBusLine({ label: 't', url: 'u', why: 'w', kind: 'terminal' });
  const unknown = refusalBusLine({ label: 't', url: 'u', why: 'w', kind: 'unknown' });
  const transient = refusalBusLine({ label: 't', url: 'u', why: 'w', kind: 'transient' });
  assert.notEqual(terminal, unknown, 'terminal and unknown must not read the same — that was the defect');
  assert.notEqual(unknown, transient);
  assert.match(terminal, /TERMINAL/);
  assert.ok(!/TERMINAL|CANNOT TELL/.test(transient), 'a transient refusal is ordinary news');

  for (const kind of REFUSAL_CLASSES) {
    assert.doesNotThrow(() => refusalBusLine({ label: 't', url: 'u', why: 'w', kind }),
      `${kind} has no bus sentence`);
  }
  assert.throws(() => refusalBusLine({ label: 't', url: 'u', why: 'w', kind: 'made-up' }),
    /unknown refusal class/);
});

test('ROUND 2: every notice exposes the class its code was given', () => {
  for (const code of Object.values(REFUSAL_CODES)) {
    assert.equal(noticeFor(code).kind, classifyRefusal(code).kind, `${code}: notice.kind must be the classification`);
  }
});

// ---------- ROUND 2: a bug in the merge step must not take the PASS with it
//
// `classifyRefusal` throws by design — there is no default, and a refusal must
// never inherit the reassuring wording by accident. But the relay called
// `runMergeStep` bare, inside a loop over every watched ticket, so that throw
// ended the whole pass: no refusal comment, no bus post, and every remaining
// ticket never looked at. A silence indistinguishable from a quiet week, which
// is the failure mode this entire ticket exists to remove.
//
// Source scans, because `scripts/clickup_direct.mjs` is a CLI script with no
// exports — the same reason the raise-site scan above is a source scan.

/** Is this offset inside a `try {` that opened shortly before it? */
function guardedBy(src, index, window = 700) {
  return src.slice(Math.max(0, index - window), index).includes('try {');
}

test('ROUND 2: every runMergeStep call is guarded, so one ticket cannot end the pass', (t) => {
  if (skipWithoutDoor(t)) return;
  const relay = doorSource() || '';
  const calls = [...relay.matchAll(/await runMergeStep\(/g)];
  assert.ok(calls.length >= 2, `expected both runMergeStep call sites; saw ${calls.length}`);
  for (const m of calls) {
    assert.ok(guardedBy(relay, m.index),
      'runMergeStep is called with nothing catching a throw — a defect on one ticket would end the relay pass silently');
  }
});

test('ROUND 2: rendering a refusal notice is guarded, and the guard invents no wording', (t) => {
  if (skipWithoutDoor(t)) return;
  const relay = doorSource() || '';
  const calls = [...relay.matchAll(/= refusalNotice\(/g)];
  assert.ok(calls.length >= 1, 'expected the relay to render a refusal notice');
  for (const m of calls) {
    assert.ok(guardedBy(relay, m.index),
      'refusalNotice throws on an unclassified reason; rendering it unguarded is what killed the pass');
  }
  // The catch must report, not soften: no fallback code, and nothing posted to
  // the ticket. A guard that supplied a class would be the silent default
  // refusalClass.js forbids, reintroduced as error handling.
  assert.match(relay, /could not be classified/,
    'the guard must say out loud that the reason was unclassifiable');
  assert.match(relay, /refused-unclassified/,
    'and hand back an outcome the pass summary counts, so it cannot read as clean');
});
