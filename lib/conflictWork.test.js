'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  CONFLICT_TICKET_TRAIL,
  STALE_HAND_OFF_MS,
  MERGE_ATTEMPT_ALARM,
  conflictTicketFiledComment,
  findConflictTicket,
  conflictTicketName,
  conflictTicketBody,
  ageText,
  handOffStalled,
  stalledHandOffLine,
  stalledHandOffHeadline,
  conflictVerdictKind,
  conflictActor,
  isRealOverlap,
  isSelfHealing,
  couldNotCheck,
  isPermanent,
  shouldFileConflictTicket,
  verdictFromCatchUp,
  CATCH_UP_VERDICTS,
  VERDICT_KINDS,
  WORK_VOCABULARY,
  stalledSummaryHeadline,
  stalledSummaryClause,
} = require('./conflictWork.js');
const { CODES: CATCH_UP_CODES } = require('./branchCatchUp.js');
const { conflictHandOffNotice } = require('./mergeOnComment.js');
const { doorSource, skipWithoutDoor } = require('./productScripts.js');

const PR = { number: 434, url: 'https://github.com/mentor24-maker/starcaster/pull/434', repo: 'starcaster' };
const TASK = { id: '86bbmfc15', name: 'A sanctioned way to clear the decks', url: 'https://app.clickup.com/t/86bbmfc15' };
const FILED = { id: '86bbzzzzz', url: 'https://app.clickup.com/t/86bbzzzzz' };

let nextId = 1;
const comment = (text) => ({ id: String(nextId++), date: '1000', comment_text: text });

// ---------------------------------------------------------------- the trail

test('the comment it writes is the comment it reads back', () => {
  // Same discipline as loopTrail: a trail the next pass cannot parse is not a
  // trail. If these two ever drift, a conflict is re-filed on every pass.
  const written = conflictTicketFiledComment({ id: FILED.id, url: FILED.url, prNumber: PR.number });
  assert.ok(written.startsWith(CONFLICT_TICKET_TRAIL));
  const read = findConflictTicket([comment(written)], PR.number);
  assert.ok(read, 'the freshly written comment must parse back');
  assert.equal(read.id, FILED.id);
  assert.equal(read.url, FILED.url);
});

test('THE DUPLICATE GUARD: a conflict already filed is never filed twice', () => {
  // The merge step runs every pass. Without this, a conflict that persists for
  // a day files twenty-four identical tickets into the queue the build loop is
  // trying to drain.
  const comments = [
    comment('PR opened: https://github.com/mentor24-maker/starcaster/pull/434'),
    comment(conflictTicketFiledComment({ id: FILED.id, url: FILED.url, prNumber: 434 })),
    comment('merge'),
  ];
  assert.equal(findConflictTicket(comments, 434).id, FILED.id);
});

test('a ticket filed for a DIFFERENT PR does not count as this one', () => {
  // A rebuilt ticket carries the trail of the PR before it. Matching that
  // would leave the new conflict unfiled while reporting an actor that is
  // working on something else.
  const comments = [comment(conflictTicketFiledComment({ id: FILED.id, url: FILED.url, prNumber: 380 }))];
  assert.equal(findConflictTicket(comments, 434), null);
});

test('no trail at all reads as "nothing is filed", not as an error', () => {
  assert.equal(findConflictTicket([], 434), null);
  assert.equal(findConflictTicket([comment('merge'), comment('looks good')], 434), null);
  assert.equal(findConflictTicket(null, 434), null);
});

test('prose that merely mentions a conflict ticket is not a trail', () => {
  const comments = [comment('I think the conflict ticket for PR #434 is somewhere in the queue')];
  assert.equal(findConflictTicket(comments, 434), null);
});

// ------------------------------------------------------- the filed ticket

test('the filed ticket names the branch a session has to check out', () => {
  const name = conflictTicketName({ pr: PR, branch: 'pipeline-pause' });
  assert.match(name, /#434/);
  assert.match(name, /pipeline-pause/);
});

test('the filed ticket tells its builder NOT to ask Dane to approve again', () => {
  // task 86bbk0g4u removed the second-approval failure once. A ticket that
  // reintroduces it by asking him from a different direction is the same bug.
  const body = conflictTicketBody({
    task: TASK, pr: PR, branch: 'pipeline-pause', commentId: '77',
    localVerdict: { kind: 'real-conflict', reason: 'both touched scripts/clickup_direct.mjs' },
  });
  assert.match(body, /Do NOT ask Dane to say "merge" again/);
  assert.match(body, /86bbmfc15/, 'it must link back to the ticket that is waiting');
  assert.match(body, /pipeline-pause/, 'and name the branch');
  assert.match(body, /both touched scripts\/clickup_direct\.mjs/, 'and carry WHY it conflicts');
  assert.match(body, /never rebase-and-force/, 'DOCTRINE 6.6 travels with the work');
});

test('the filed ticket says what it is when the local check could not run', () => {
  const body = conflictTicketBody({
    task: TASK, pr: PR, branch: 'x', commentId: '77',
    localVerdict: { kind: 'could-not-check', reason: 'the worktree could not be created' },
  });
  assert.match(body, /could not check whether that is true/);
  assert.ok(!/no overlap/i.test(body), 'a check that did not run may not report a finding');
});

test('a WRONG_REPO ticket says the answer is permanent from that machine', () => {
  // Review round 2, item 2. The queue carries repo:normie, repo:pulse and
  // repo:vault. A conflicting PR in one of those returns WRONG_REPO from the
  // relay machine deterministically, every pass, forever — so "the next pass
  // retries" is a promise no pass can keep, and the ticket has to say so.
  const body = conflictTicketBody({
    task: TASK, pr: PR, branch: 'x', commentId: '77',
    localVerdict: verdictFromCatchUp({ code: CATCH_UP_CODES.WRONG_REPO, reason: 'this checkout is a/b, but the PR is on c/d' }),
  });
  assert.match(body, /could not check whether that is true/);
  assert.match(body, /never clear from that machine on its own/);
});

test('the filed ticket does NOT claim an overlap it never found', () => {
  const body = conflictTicketBody({
    task: TASK, pr: PR, branch: 'x', commentId: '77',
    localVerdict: { kind: 'no-overlap', reason: 'the catch-up merged cleanly but could not be pushed' },
  });
  assert.ok(!/changed the same lines/.test(body), 'only a real overlap may say that');
  assert.match(body, /with no overlap at all/);
});

// ------------------------------------------------------------- staleness

test('THE THREE DAYS: no ticket filed is stalled from the very first pass', () => {
  // PR #434 sat from 2026-08-26 to 2026-08-29 while every pass logged
  // "MERGE HANDED OFF (unchanged, nothing posted)" and "0 merged". Quiet was
  // correct behaviour and the design had no actor behind it.
  const s = handOffStalled({ at: new Date().toISOString(), now: Date.now(), filed: null });
  assert.equal(s.stalled, true);
  assert.match(s.why, /nothing is going to pick this up/i);
});

test('a freshly filed ticket buys silence — that is the whole point of filing it', () => {
  const now = Date.parse('2026-08-30T12:00:00.000Z');
  const s = handOffStalled({ at: '2026-08-30T11:00:00.000Z', now, filed: FILED });
  assert.equal(s.stalled, false);
});

test('a filed ticket that has not cleared it in a day stops being silent', () => {
  const now = Date.parse('2026-08-30T12:00:00.000Z');
  const s = handOffStalled({ at: '2026-08-28T11:00:00.000Z', now, filed: FILED });
  assert.equal(s.stalled, true);
  assert.match(s.why, /86bbzzzzz/, 'the report must name the ticket that is not moving');
  assert.match(s.why, /2 days/);
});

test('the threshold is a named constant, and it is under the three days that caused this', () => {
  assert.equal(STALE_HAND_OFF_MS, 24 * 60 * 60 * 1000);
  const threeDays = 3 * 24 * 60 * 60 * 1000;
  assert.ok(STALE_HAND_OFF_MS < threeDays,
    'a threshold at or above the incident duration would not have caught the incident');
});

test('an unreadable timestamp counts as stalled — fail safe, the same as everywhere else', () => {
  // "nobody is working on it" and "I cannot tell" look identical, and only one
  // of them is safe to sit on quietly.
  for (const at of ['', null, undefined, 'not a date']) {
    assert.equal(handOffStalled({ at, now: Date.now(), filed: FILED }).stalled, true, String(at));
  }
});

test('the age reads in plain language, not milliseconds', () => {
  assert.equal(ageText(5 * 60 * 1000), '5 minutes');
  assert.equal(ageText(60 * 1000), '1 minute');
  assert.equal(ageText(3 * 60 * 60 * 1000), '3 hours');
  assert.equal(ageText(72 * 60 * 60 * 1000), '3 days');
  assert.equal(ageText(24 * 60 * 60 * 1000), '24 hours');
  assert.equal(ageText(-1), 'an unknown time');
  assert.equal(ageText('nonsense'), 'an unknown time');
});

test('the stalled report line names the actor, or says out loud there is none', () => {
  const withTicket = stalledHandOffLine({
    task: TASK, pr: PR, filed: FILED,
    stalled: { stalled: true, why: 'conflict ticket 86bbzzzzz has been open 2 days without clearing this conflict' },
  });
  assert.match(withTicket, /86bbzzzzz/);
  assert.match(withTicket, /filed as/);

  const without = stalledHandOffLine({
    task: TASK, pr: PR, filed: null,
    stalled: { stalled: true, why: 'no conflict ticket has been filed, so nothing is going to pick this up' },
  });
  assert.match(without, /NOT filed anywhere — no actor exists for it/);
});

// ------------------------------------------- one predicate, two decisions
//
// TASK 86bbq80j5 (2026-08-31). On 2026-08-30 PR #444's catch-up merged cleanly
// and lost a race on the PUSH. The hand-off comment read the verdict and said,
// correctly, that the next pass would merge it. 200ms earlier the same pass had
// filed "Resolve the merge conflict on PR #444" into the Loop Queue, because
// the filing decision never consulted the verdict at all. Two comments, two
// actors, and a ticket describing work that did not exist.

/**
 * Every shape a localVerdict is ever handed to this code in.
 *
 * `real` = a genuine overlap was found. `healing` = this machine looked and
 * found nothing to resolve. Anything that is neither never looked, and the
 * whole of review round 2 is that those last two are NOT the same row.
 */
const VERDICTS = [
  { label: 'a real overlap', v: { kind: 'real-conflict', reason: 'both touched routes/index.js' }, real: true, healing: false },
  { label: 'the legacy realConflict flag', v: { realConflict: true, reason: 'both touched routes/index.js' }, real: true, healing: false },
  { label: 'a lost push race', v: { kind: 'no-overlap', reason: 'the catch-up merged cleanly but could not be pushed' }, real: false, healing: true },
  { label: 'a clean merge GitHub has not caught up with', v: { kind: 'no-overlap', reason: 'main merged into feature-x with no conflict' }, real: false, healing: true },
  { label: 'a failed fetch', v: { kind: 'could-not-check', reason: 'could not fetch feature-x and main' }, real: false, healing: false },
  { label: 'the wrong repo, permanently', v: { kind: 'could-not-check', permanent: true, reason: 'this checkout is a/b, but the PR is on c/d' }, real: false, healing: false },
  { label: 'the legacy flag, false', v: { realConflict: false, reason: 'could not fetch the branch' }, real: false, healing: false },
  { label: 'no verdict at all', v: null, real: false, healing: false },
  { label: 'an undefined verdict', v: undefined, real: false, healing: false },
];

test('THE LOST PUSH RACE: a proven no-overlap files nothing', () => {
  const race = { kind: 'no-overlap', reason: 'the catch-up merged cleanly but could not be pushed' };
  assert.equal(shouldFileConflictTicket(race), false, 'nothing needs resolving, so nothing may be filed');
  const notice = conflictHandOffNotice({ commentId: '77', pr: PR, localVerdict: race, filed: null });
  assert.equal(notice.actor, 'later-pass');
  assert.match(notice.body, /merged on the next run/i, 'and the promise it already made is unchanged');
});

test('a real overlap still files, exactly as before', () => {
  assert.equal(shouldFileConflictTicket({ kind: 'real-conflict', reason: 'both touched routes/index.js' }), true);
  assert.equal(shouldFileConflictTicket({ realConflict: true, reason: 'both touched routes/index.js' }), true);
});

test('THE DRIFT PROOF: the filing decision and the notice actor read one predicate', () => {
  // Not "they happen to agree on these cases" — they cannot disagree, because
  // conflictHandOffNotice calls isRealOverlap and so does the merge step. This
  // test is the alarm if a future edit gives either side its own copy again.
  for (const { label, v, real, healing } of VERDICTS) {
    const files = shouldFileConflictTicket(v);
    const { actor } = conflictHandOffNotice({ commentId: '77', pr: PR, localVerdict: v, filed: null });
    assert.equal(files, !healing, `${label}: filing decision`);
    assert.equal(actor !== 'later-pass', !healing, `${label}: the notice names a different actor than the filing decision`);
    assert.equal(files, !isSelfHealing(v), `${label}: both sides must be the same function`);
    assert.equal(isRealOverlap(v), real, `${label}: only a real overlap is a real overlap`);
  }
});

test('NO VERDICT AT ALL is a decision, and the reason is written down', () => {
  // Criterion 4, revisited in review round 2. Null now means exactly one
  // thing — a dry run, which never attempts the catch-up — because the other
  // case (the catch-up SUCCEEDED and GitHub's re-read still said conflict) is
  // carried through as a stated no-overlap instead of being dropped.
  //
  // "Nothing was checked" IS could-not-check, so that is what it reads as. It
  // is also what makes a dry run report an unfiled, actor-less hand-off as
  // stalled rather than calling it self-healing, which is review item 5.
  assert.equal(conflictVerdictKind(null), VERDICT_KINDS.COULD_NOT_CHECK);
  assert.equal(isSelfHealing(null), false, 'a dry run never found anything, so it may not claim it did');
  assert.equal(couldNotCheck(null), true);
  const src = fs.readFileSync(path.join(__dirname, 'conflictWork.js'), 'utf8');
  const fn = src.slice(src.indexOf('function conflictVerdictKind'), src.indexOf('/** Did this machine find a genuine overlap?'));
  assert.match(fn, /DELIBERATE/, 'the null choice must be stated, not left to be re-derived by a reader');
  assert.match(fn, /dry run/i);
});

test('AN UNRECOGNISED KIND FAILS TO "I DID NOT LOOK", never to a finding', () => {
  // The default bucket is what caused this round: four ways of never looking
  // wore the same answer as a proven clean merge. Whatever arrives here next
  // must land on the answer that claims nothing.
  for (const v of [{ kind: 'unknown' }, { kind: 'weather' }, { kind: '' }, {}]) {
    assert.equal(isSelfHealing(v), false, JSON.stringify(v));
    assert.equal(isRealOverlap(v), false, JSON.stringify(v));
  }
});

test('a self-healing hand-off is quiet without a ticket — but not forever', () => {
  // handOffStalled read "no ticket" as "no actor". For a later-pass hand-off
  // the actor is the next pass and it is real, so nagging the bus every ten
  // minutes would be the same false alarm one level down. Age still applies.
  const now = Date.parse('2026-08-30T12:00:00.000Z');
  const HEALED = { kind: 'no-overlap', reason: 'the catch-up merged cleanly' };
  const fresh = handOffStalled({ at: '2026-08-30T11:00:00.000Z', now, filed: null, localVerdict: HEALED });
  assert.equal(fresh.stalled, false, 'a branch that is healing itself is not news');

  const old = handOffStalled({ at: '2026-08-28T11:00:00.000Z', now, filed: null, localVerdict: HEALED });
  assert.equal(old.stalled, true, 'but one that has not healed in a day is');
  assert.match(old.why, /has not cleared in 2 days/);

  // Any other verdict keeps the original rule, which fails toward noise.
  for (const v of [{ kind: 'real-conflict', reason: 'r' }, { kind: 'could-not-check', reason: 'r' }, null]) {
    assert.equal(handOffStalled({ at: '2026-08-30T11:00:00.000Z', now, filed: null, localVerdict: v }).stalled, true, JSON.stringify(v));
  }
});

// ----------------------------- the two halves, joined the way the code joins
//
// REVIEW ROUND 1 of task 86bbq80j5 sent the first attempt back. Every test
// above checks `handOffStalled` and `stalledHandOffLine` SEPARATELY, and both
// were correct on their own — which is why the defect survived a green suite.
// It exists only where the merge step feeds one into the other, so these tests
// compose them exactly as `runMergeStep` does and assert on the finished bus
// line rather than on either half.

/** The real 2026-08-30 incident, as the merge step saw it. */
const PR444 = { number: 444, url: 'https://github.com/mentor24-maker/starcaster/pull/444', repo: 'starcaster' };
const TASK444 = { id: '86bbmmv7t', name: 'Review gate holes', url: 'https://app.clickup.com/t/86bbmmv7t' };
const LOST_PUSH_RACE = { kind: 'no-overlap', reason: 'the catch-up merged cleanly but could not be pushed' };

/** What actually goes to the bus, built the one way the merge step builds it.
 *  It takes the VERDICT, because that is what the merge step passes now — the
 *  actor is a two-valued shadow of a three-valued answer, and reading it was
 *  review round 3's finding. */
function busLine({ task, pr, filed, stalled, localVerdict }) {
  return `[CC-starcaster bus-relay] ${stalledHandOffHeadline({ localVerdict })} — ${stalledHandOffLine({ task, pr, filed, stalled, localVerdict })}`;
}

test('THE COMPOSED BUS LINE: a self-healing stall names ONE actor, end to end', () => {
  // The sentence review round 1 produced, verbatim, was:
  //
  //   PR #444 has been waiting on a conflict resolution — NOT filed anywhere
  //   — no actor exists for it. no overlap was found, so every pass has been
  //   retrying the catch-up on its own — and it has not cleared in 25 hours.
  //
  // Two clauses, one sentence, two different actors — the same failure shape
  // as the two comments 200ms apart, arriving where Dane reads.
  const notice = conflictHandOffNotice({ commentId: '77', pr: PR444, localVerdict: LOST_PUSH_RACE, filed: null });
  assert.equal(notice.actor, 'later-pass');

  const stalled = handOffStalled({
    at: '2026-08-30T02:00:00.000Z',
    now: Date.parse('2026-08-31T03:00:00.000Z'),
    filed: null,
    localVerdict: LOST_PUSH_RACE,
  });
  assert.equal(stalled.stalled, true, '25 hours is past the threshold, so this line really does get posted');

  const posted = busLine({ task: TASK444, pr: PR444, filed: null, stalled, localVerdict: LOST_PUSH_RACE });

  assert.ok(!/no actor exists for it/.test(posted),
    `a self-healing stall must not say nobody is on it:\n${posted}`);
  assert.ok(!/CONFLICT STILL UNRESOLVED/.test(posted),
    `and must not call a branch with no overlap a conflict:\n${posted}`);
  assert.match(posted, /no ticket, and none is needed/, 'it says why there is no ticket');
  assert.match(posted, /every pass has been retrying the catch-up on its own/, 'and who is acting');
  assert.match(posted, /has not cleared in 25 hours/, 'and that it is still news');
});

test('THE DRIFT PROOF EXTENDS TO THE STALL: no message names an actor the notice did not pick', () => {
  // The invariant worth locking, one loop over the same VERDICTS table: the
  // stalled announcement — banner included — may only describe the actor
  // `conflictHandOffNotice` chose. Any future branch that reaches for `filed`
  // again fails here rather than on the bus a day later.
  const now = Date.parse('2026-08-31T12:00:00.000Z');
  const threeDaysAgo = '2026-08-28T12:00:00.000Z';

  for (const { label, v, healing } of VERDICTS) {
    // `filed` IS free, and assuming otherwise is what review round 2 caught.
    // `findConflictTicket` reads the ticket out of comment history with no
    // reference to today's verdict, so a ticket filed when the branch really
    // did conflict is still there on the pass that finds the overlap gone.
    // Every verdict is therefore paired with both.
    for (const filed of [FILED, null]) {
      const { actor, kind } = conflictHandOffNotice({ commentId: '77', pr: PR, localVerdict: v, filed });
      // The notice's own answers, both of them, checked against the one
      // predicate rather than trusted (review round 3 — `kind` is new, and it
      // is what the stall surfaces read now).
      assert.equal(kind, conflictVerdictKind(v), `${label}: the notice must carry the verdict it was given`);
      assert.equal(actor, conflictActor({ localVerdict: v, filed }), `${label}: one actor, one function`);
      const stalled = handOffStalled({ at: threeDaysAgo, now, filed, localVerdict: v });
      assert.equal(stalled.stalled, true, `${label}: three days is stalled whatever the actor`);
      const posted = busLine({ task: TASK, pr: PR, filed, stalled, localVerdict: v });
      const where = `${label} (filed=${Boolean(filed)}, actor=${actor}, kind=${kind})`;

      assert.equal(/no actor exists for it/.test(posted), actor === 'nobody',
        `${where}: "nobody" may appear exactly when the notice picked nobody\n${posted}`);
      assert.equal(posted.includes(FILED.url), Boolean(filed),
        `${where}: an open ticket is named whenever there is one, and never invented\n${posted}`);
      // THE ASSERTION NOW SAYS WHAT ITS MESSAGE ALWAYS SAID (review round 3).
      // It read `actor !== 'later-pass'`, which is true for a check that never
      // ran — so it actively LOCKED IN the announcement of a conflict nobody
      // had found, under a message declaring the opposite rule.
      assert.equal(/CONFLICT STILL UNRESOLVED/.test(posted), kind === VERDICT_KINDS.REAL_CONFLICT,
        `${where}: only a hand-off with a real overlap may be announced as a conflict\n${posted}`);
      // ...and the words that assert an overlap may not appear without one.
      assert.equal(/conflict resolution|without clearing this conflict/.test(posted), kind === VERDICT_KINDS.REAL_CONFLICT,
        `${where}: a verdict that found no overlap may not be described as one being resolved\n${posted}`);

      // THE INVARIANT EXTENDED TO FACTS, not only to actors (review round 2).
      // Criterion 3 locked "no message names an actor the notice did not
      // pick". The half that was missing is that no message may assert a
      // FINDING the pass did not make.
      assert.equal(/no overlap was found/.test(posted), healing,
        `${where}: "no overlap was found" may only be said when one was actually looked for\n${posted}`);
      assert.ok(!(/was expected to clear itself/.test(posted) && /without clearing this conflict/.test(posted)),
        `${where}: a self-healing stall may not also be described as an unresolved conflict\n${posted}`);
    }
  }
});

test('A STALE TICKET DOES NOT MAKE A HEALED BRANCH A CONFLICT — the pairing round 2 found', () => {
  // Reachable, and it was: a real conflict files a ticket, the build loop
  // pushes a catch-up, and the next pass finds no overlap while GitHub is
  // still stale. `filed` is truthy, today's verdict is no-overlap. The old
  // line read `filed` first and produced:
  //
  //   PR #444 was expected to clear itself — filed as <url>. conflict ticket
  //   86bbq6bam has been open 25 hours without clearing this conflict.
  const { actor } = conflictHandOffNotice({ commentId: '77', pr: PR444, localVerdict: LOST_PUSH_RACE, filed: FILED });
  assert.equal(actor, 'later-pass', 'the verdict decides the actor; an old ticket does not');

  const stalled = handOffStalled({
    at: '2026-08-30T02:00:00.000Z', now: Date.parse('2026-08-31T03:00:00.000Z'), filed: FILED, localVerdict: LOST_PUSH_RACE,
  });
  const posted = busLine({ task: TASK444, pr: PR444, filed: FILED, stalled, localVerdict: LOST_PUSH_RACE });

  assert.ok(!/without clearing this conflict/.test(posted),
    `nothing is failing to clear a conflict that this pass says is not there:\n${posted}`);
  assert.match(posted, /no overlap left to resolve/, 'it says what the open ticket now means');
  assert.match(posted, /86bbzzzzz/, 'and still names it, rather than pretending it is gone');
});

// ------------------------- three answers, because two of them were one answer
//
// REVIEW ROUND 2 of task 86bbq80j5. The first two rounds collapsed "I looked
// and found nothing" together with "I never looked" into one bucket called
// 'unknown', and then wrote copy for that bucket which asserted a finding. The
// bus post said "this machine found no overlap between the branch and main.
// Nothing needs resolving and nobody needs to claim it" for a verdict whose
// ticket comment, seconds earlier, said it could not check at all.

test('EVERY catch-up code has a decision — no default bucket', () => {
  // The default bucket IS the defect. Four ways of never looking fell into it
  // silently. A new code added to branchCatchUp must be decided here, not
  // absorbed.
  for (const code of Object.values(CATCH_UP_CODES)) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(CATCH_UP_VERDICTS, code),
      `catch-up code "${code}" has no verdict decision — add one to CATCH_UP_VERDICTS`,
    );
  }
});

test('ONLY A PROVEN CLEAN MERGE counts as "no overlap was found"', () => {
  // The whole of review round 2, in one table.
  const expected = {
    [CATCH_UP_CODES.CLEAN]: VERDICT_KINDS.NO_OVERLAP,
    [CATCH_UP_CODES.PUSH_FAILED]: VERDICT_KINDS.NO_OVERLAP,
    [CATCH_UP_CODES.REAL_CONFLICT]: VERDICT_KINDS.REAL_CONFLICT,
    [CATCH_UP_CODES.WRONG_REPO]: VERDICT_KINDS.COULD_NOT_CHECK,
    [CATCH_UP_CODES.FETCH_FAILED]: VERDICT_KINDS.COULD_NOT_CHECK,
    [CATCH_UP_CODES.WORKTREE_FAILED]: VERDICT_KINDS.COULD_NOT_CHECK,
    [CATCH_UP_CODES.NOT_ANCESTOR]: VERDICT_KINDS.COULD_NOT_CHECK,
  };
  for (const [code, kind] of Object.entries(expected)) {
    const v = verdictFromCatchUp({ code, reason: 'because' });
    assert.equal(conflictVerdictKind(v), kind, code);
    assert.equal(isSelfHealing(v), kind === VERDICT_KINDS.NO_OVERLAP, `${code}: may it claim a finding?`);
  }
});

test('A CHECK THAT COULD NOT RUN STILL FILES — the regression round 2 caught', () => {
  // Before the filing gate, a conflicting PR in a repo this machine has no
  // checkout of filed a ticket and named an actor. The gate turned that into
  // "nothing filed, and the bus says nobody needs to claim it", forever,
  // because WRONG_REPO is deterministic from that machine.
  for (const code of [CATCH_UP_CODES.WRONG_REPO, CATCH_UP_CODES.FETCH_FAILED, CATCH_UP_CODES.WORKTREE_FAILED, CATCH_UP_CODES.NOT_ANCESTOR]) {
    const v = verdictFromCatchUp({ code, reason: 'because' });
    assert.equal(shouldFileConflictTicket(v), true, `${code} must still get an actor`);
  }
  // ...and the two findings keep the behaviour the first round shipped.
  assert.equal(shouldFileConflictTicket(verdictFromCatchUp({ code: CATCH_UP_CODES.PUSH_FAILED, reason: 'r' })), false);
  assert.equal(shouldFileConflictTicket(verdictFromCatchUp({ code: CATCH_UP_CODES.REAL_CONFLICT, reason: 'r' })), true);
});

test('WRONG_REPO is permanent, and every surface says so', () => {
  const v = verdictFromCatchUp({ code: CATCH_UP_CODES.WRONG_REPO, reason: 'this checkout is a/b, but the PR is on c/d' });
  assert.equal(isPermanent(v), true);
  assert.equal(isPermanent(verdictFromCatchUp({ code: CATCH_UP_CODES.FETCH_FAILED, reason: 'r' })), false,
    'a failed fetch may well work next pass — only the wrong checkout never will');
  const notice = conflictHandOffNotice({ commentId: '77', pr: PR, localVerdict: v, filed: FILED });
  assert.match(notice.body, /never will from the relay machine/);
  assert.ok(!/merged on the next run/.test(notice.body), 'a promise no pass can keep must not be made');
});

test('THE TICKET COMMENT AND THE BUS POST CANNOT DISAGREE about what was found', () => {
  // The two texts that went out seconds apart on a FETCH_FAILED verdict: one
  // said it could not check, the other asserted a finding and stood the room
  // down on it. They read one predicate now, so the pairing is checked here.
  for (const { label, v, healing } of VERDICTS) {
    const notice = conflictHandOffNotice({ commentId: '77', pr: PR, localVerdict: v, filed: null });
    const claimsAFinding = /with no overlap at all/.test(notice.body);
    assert.equal(claimsAFinding, healing, `${label}: the notice may only report a finding it made`);
    assert.equal(notice.actor === 'later-pass', healing,
      `${label}: and may only stand the room down on one`);
    if (!healing) {
      assert.ok(!/merged on the next run/.test(notice.body),
        `${label}: no self-healing promise without a self-healing verdict`);
    }
  }
});

test('THE REAL-OVERLAP WORDING IS LEFT ALONE — it was verified byte-for-byte', () => {
  // Review round 2 checked both real-overlap bodies against main character by
  // character, as evidence that round 1 had not disturbed the case it was not
  // about. Widening a shared sentence to cover could-not-check would have
  // silently spent that; the two kinds get their own noun instead.
  const real = conflictHandOffNotice({
    commentId: '77', pr: PR, filed: FILED,
    localVerdict: { kind: 'real-conflict', reason: 'it genuinely conflicts, in 1 file(s): routes/index.js' },
  }).body;
  assert.match(real, /Sorting that overlap out is a code change rather than a decision, and a script must never resolve one blind, so it was not attempted\. Resolving it is now ticket 86bbzzzzz/);

  const unchecked = conflictHandOffNotice({
    commentId: '77', pr: PR, filed: FILED,
    localVerdict: { kind: 'could-not-check', reason: 'could not fetch the branch' },
  }).body;
  assert.ok(!/Sorting that overlap out/.test(unchecked),
    'a check that never ran has no overlap to sort out');
  assert.match(unchecked, /Whether there is anything to resolve is still unknown/);
});

// ------------------------------------------------ the end-of-pass summary
//
// Review round 2, item 4: `CONFLICTS STILL UNRESOLVED` was hardcoded in the
// pass report and printed directly above the very lines saying no overlap was
// found and every pass is retrying. Same contradiction as the per-line banner,
// one surface across.

const REAL = VERDICT_KINDS.REAL_CONFLICT;
const HEAL = VERDICT_KINDS.NO_OVERLAP;
const NEVER = VERDICT_KINDS.COULD_NOT_CHECK;

test('THE SUMMARY BANNER does not call a deferral a conflict', () => {
  assert.equal(stalledSummaryHeadline([HEAL]), 'MERGES STILL NOT CLEARED');
  assert.equal(stalledSummaryHeadline([HEAL, HEAL]), 'MERGES STILL NOT CLEARED');
  assert.equal(stalledSummaryHeadline([REAL, REAL]), 'CONFLICTS STILL UNRESOLVED');
  assert.match(stalledSummaryHeadline([HEAL, REAL]), /SOME ARE CONFLICTS, SOME ARE NOT/,
    'a mixed pass may not be described as either one alone');
  assert.equal(stalledSummaryHeadline([]), 'MERGES STILL NOT CLEARED');
});

test('THE SUMMARY BANNER does not call an unchecked merge a conflict either', () => {
  // Review round 3, item 2, at the summary. It read actors, where everything
  // that was not `later-pass` counted as a conflict — so a pass stalled only
  // on checks that never ran announced CONFLICTS STILL UNRESOLVED above lines
  // saying nothing had been checked. `nobody` and `loop-queue` are BOTH
  // reachable from a could-not-check verdict, which is what made the old
  // assertion unable to see this.
  assert.equal(stalledSummaryHeadline([NEVER]), 'MERGES STILL BLOCKED — THE CHECK NEVER RAN');
  assert.equal(stalledSummaryHeadline([NEVER, NEVER]), 'MERGES STILL BLOCKED — THE CHECK NEVER RAN');
  assert.ok(!/CONFLICT/.test(stalledSummaryHeadline([NEVER])), 'no conflict was ever established');
  assert.match(stalledSummaryHeadline([NEVER, HEAL]), /SOME WERE NEVER CHECKED/);
  assert.match(stalledSummaryHeadline([NEVER, REAL]), /SOME ARE CONFLICTS, SOME ARE NOT/);
});

test('THE SUMMARY CLAUSE counts the three kinds apart, and vanishes at zero', () => {
  assert.equal(stalledSummaryClause([]), '');
  assert.equal(stalledSummaryClause([HEAL]), ', 1 merge(s) STILL NOT CLEARED');
  assert.equal(stalledSummaryClause([REAL, REAL]), ', 2 conflict(s) STILL UNRESOLVED');
  assert.equal(stalledSummaryClause([NEVER, NEVER]), ', 2 merge(s) NEVER CHECKED');
  assert.equal(stalledSummaryClause([REAL, HEAL]),
    ', 1 conflict(s) STILL UNRESOLVED, 1 merge(s) STILL NOT CLEARED');
  assert.equal(stalledSummaryClause([REAL, NEVER, HEAL]),
    ', 1 conflict(s) STILL UNRESOLVED, 1 merge(s) NEVER CHECKED, 1 merge(s) STILL NOT CLEARED');
});

// ------------------------------ the ticket the comment points AT (round 3)
//
// REVIEW ROUND 3 of task 86bbq80j5. The three-way answer reached the hand-off
// comment and stopped there. The FILED TICKET — the thing that comment links
// to, and the thing a build session actually reads — still had one set of
// words for every verdict, so a `WRONG_REPO` hand-off said "Whether there is
// anything to resolve is still unknown" directly above a link to a ticket
// titled "Resolve the merge conflict on PR #501" whose acceptance criteria
// said to leave no conflict markers behind. That is the PR #444 defect this
// whole ticket exists to remove, reproduced one level down — and it is
// deterministic, not a corner: WRONG_REPO is what the relay machine returns
// for EVERY conflicting PR on a repo:normie, repo:pulse or repo:vault ticket.

const UNCHECKED_VERDICTS = [
  { label: 'the wrong repo', v: verdictFromCatchUp({ code: CATCH_UP_CODES.WRONG_REPO, reason: 'this checkout is a/b, but the PR is on c/d' }) },
  { label: 'a failed fetch', v: verdictFromCatchUp({ code: CATCH_UP_CODES.FETCH_FAILED, reason: 'could not fetch feature-x and main' }) },
  { label: 'no scratch worktree', v: verdictFromCatchUp({ code: CATCH_UP_CODES.WORKTREE_FAILED, reason: 'the worktree could not be created' }) },
  { label: 'a merge that failed its ancestor proof', v: verdictFromCatchUp({ code: CATCH_UP_CODES.NOT_ANCESTOR, reason: 'the result does not contain main' }) },
];

test('THE FILED TICKET DOES NOT ORDER A RESOLUTION NOBODY ESTABLISHED IS NEEDED', () => {
  for (const { label, v } of UNCHECKED_VERDICTS) {
    const name = conflictTicketName({ pr: PR, branch: 'feature-x', localVerdict: v });
    assert.ok(!/resolve the merge conflict/i.test(name),
      `${label}: the title may not name a conflict the pass never found — got "${name}"`);
    assert.match(name, /Find out why PR #434 \(feature-x\) will not merge/, label);

    const body = conflictTicketBody({ task: TASK, pr: PR, branch: 'feature-x', localVerdict: v, commentId: '77' });
    assert.ok(!/resolve the overlap by hand/i.test(body),
      `${label}: the Scope may not order an overlap resolved before one is found\n${body}`);
    assert.match(body, /FIRST find out whether/, `${label}: the work is to find out`);
    assert.match(body, /git merge-tree --write-tree origin\/main origin\/feature-x/,
      `${label}: and it names the command that answers the question`);
    assert.match(body, /resolve an overlap only if there turns out to be one/i, label);
  }
});

test('THE COMMENT AND THE TICKET IT POINTS AT CANNOT DISAGREE', () => {
  // The reader's actual path: hand-off comment -> "Finding out is now ticket
  // X" -> click -> the ticket's title. Both ends are asserted together here,
  // because each was correct on its own and the contradiction lived between
  // them — the same reason the round-1 tests had to compose two halves.
  for (const { label, v } of [...UNCHECKED_VERDICTS, { label: 'a real overlap', v: { kind: 'real-conflict', reason: 'both touched routes/index.js' } }]) {
    const notice = conflictHandOffNotice({ commentId: '77', pr: PR, localVerdict: v, filed: FILED });
    const name = conflictTicketName({ pr: PR, branch: 'feature-x', localVerdict: v });
    const filedComment = conflictTicketFiledComment({ id: FILED.id, url: FILED.url, prNumber: PR.number, localVerdict: v });
    const real = isRealOverlap(v);

    // "Resolving it" in the comment <=> "Resolve..." in the title, both ways.
    assert.equal(/Resolving it is now ticket/.test(notice.body), real, `${label}: the noun\n${notice.body}`);
    assert.equal(/^Resolve the merge conflict/.test(name), real, `${label}: the title "${name}"`);
    assert.equal(/Resolving the conflict/.test(filedComment), real, `${label}: the trail comment\n${filedComment}`);
    assert.equal(/Finding out/.test(notice.body), !real, `${label}: the other noun\n${notice.body}`);
    assert.equal(/Finding out why PR #434 will not merge/.test(filedComment), !real, label);
  }
});

test('THE WRONG-REPO TICKET SAYS WHICH MACHINE CAN ANSWER IT', () => {
  // Permanent from the relay machine, so a ticket that does not say so sends
  // its builder to a checkout that does not exist there.
  const v = verdictFromCatchUp({ code: CATCH_UP_CODES.WRONG_REPO, reason: 'this checkout is a/b, but the PR is on c/d' });
  const body = conflictTicketBody({ task: TASK, pr: PR, branch: 'feature-x', localVerdict: v, commentId: '77' });
  assert.match(body, /machine that HAS a checkout of that repo/);
  // ...and a merely transient one does not claim that.
  const fetchFailed = verdictFromCatchUp({ code: CATCH_UP_CODES.FETCH_FAILED, reason: 'could not fetch' });
  assert.ok(!/machine that HAS a checkout/.test(conflictTicketBody({ task: TASK, pr: PR, branch: 'feature-x', localVerdict: fetchFailed, commentId: '77' })));
});

test('EVERY VERDICT KIND HAS A COMPLETE SET OF WORDS — no surface improvises', () => {
  // The structural half of criterion 3, extended to round 3's four surfaces.
  // A kind added without an entry here does not fall back to a conflict's
  // vocabulary; it fails the suite.
  const required = ['ticketName', 'handOver', 'filedWork', 'stallHeadline', 'stallWhat', 'stallWhy', 'summaryCount'];
  for (const kind of Object.values(VERDICT_KINDS)) {
    const entry = WORK_VOCABULARY[kind];
    assert.ok(entry, `verdict kind "${kind}" has no vocabulary — add one to WORK_VOCABULARY`);
    for (const key of required) {
      assert.ok(entry[key] !== undefined, `verdict kind "${kind}" is missing "${key}"`);
    }
  }
  assert.equal(Object.keys(WORK_VOCABULARY).length, Object.values(VERDICT_KINDS).length,
    'and no vocabulary entry exists for a kind that is not a verdict');
});

test('A PROVEN NO-OVERLAP IS NEVER FILED, so its words are unreachable by design', () => {
  // WORK_VOCABULARY carries a truthful no-overlap column, and this is what
  // stops it from ever being read as a filed ticket: the gate refuses first.
  for (const v of [{ kind: 'no-overlap', reason: 'clean' }, verdictFromCatchUp({ code: CATCH_UP_CODES.PUSH_FAILED, reason: 'r' })]) {
    assert.equal(shouldFileConflictTicket(v), false);
  }
  // ...and if a future caller reaches them anyway, they still do not lie.
  const name = conflictTicketName({ pr: PR, branch: 'feature-x', localVerdict: { kind: 'no-overlap', reason: 'clean' } });
  assert.ok(!/resolve the merge conflict/i.test(name), `got "${name}"`);
});

test('THE STALL SENTENCE DOES NOT INVENT A CONFLICT EITHER — round 3, item 2', () => {
  const now = Date.parse('2026-08-31T12:00:00.000Z');
  for (const { label, v } of UNCHECKED_VERDICTS) {
    const stalled = handOffStalled({ at: '2026-08-28T12:00:00.000Z', now, filed: FILED, localVerdict: v });
    const posted = busLine({ task: TASK, pr: PR, filed: FILED, stalled, localVerdict: v });
    assert.ok(!/CONFLICT STILL UNRESOLVED/.test(posted), `${label}: the banner\n${posted}`);
    assert.ok(!/without clearing this conflict/.test(posted), `${label}: the reason\n${posted}`);
    assert.ok(!/waiting on a conflict resolution/.test(posted), `${label}: what it is waiting on\n${posted}`);
    assert.match(posted, /THE CHECK NEVER RAN/, label);
    assert.match(posted, /nobody has established whether there is a conflict at all/, label);
  }
});

test('THE UNCHECKED LINE MAY NOT ASSERT THE FINDING — round 3, item 3', (t) => {
  if (skipWithoutDoor(t)) return;
  const block = SCRIPT.slice(SCRIPT.indexOf('IT MAY NOT ASSERT THE FINDING EITHER'), SCRIPT.indexOf('if (alreadyFiled) console.error'));
  assert.match(block, /if \(!filed && !selfHealing\) unchecked\.push\(isRealOverlapVerdict/,
    'the report line must branch on whether an overlap was actually found');
  assert.match(block, /could not check whether that is true, and NO Loop Queue ticket could be filed to find out/,
    'and the could-not-check branch must say that is what it is');
});

// ------------------------------------------------- the wiring, checked flat

const SCRIPT = doorSource() || '';

test('the merge step files the ticket BEFORE it builds the hand-off comment', (t) => {
  if (skipWithoutDoor(t)) return;
  // Order is load-bearing: the body's promise is decided by whether a ticket
  // exists, so filing after building it would always report "nobody".
  const fileAt = SCRIPT.indexOf('filed = await fileConflictTicket(');
  const noticeAt = SCRIPT.indexOf('const notice = conflictHandOffNotice(');
  assert.ok(fileAt > 0, 'the merge step must file a conflict ticket');
  assert.ok(noticeAt > 0);
  assert.ok(fileAt < noticeAt, 'the ticket must be filed before the notice that names it is built');
});

test('the conflict ticket is filed into the Loop Queue as Queued — the list the build loop drains', (t) => {
  if (skipWithoutDoor(t)) return;
  // Dane's option C, 2026-08-30. Any other list has no consumer, which is the
  // bug: the bus had none either.
  const fn = SCRIPT.slice(SCRIPT.indexOf('async function fileConflictTicket'), SCRIPT.indexOf('async function runMergeStep'));
  assert.match(fn, /\$\{LOOP_QUEUE_LIST\}\/task/, 'it must file into the Loop Queue');
  assert.match(fn, /status: 'Queued'/, 'and as Queued, or no build loop will claim it');
  assert.match(fn, /PRIORITY\.high/, 'High — Urgent is the operator lane');
});

test('the old bus post no longer asks an empty room for a session', (t) => {
  if (skipWithoutDoor(t)) return;
  // The exact sentence that went nowhere for three days.
  assert.ok(
    !/a session needs to resolve the conflict and push/.test(SCRIPT),
    'the bus post must not request an actor the bus cannot deliver',
  );
});

test('a failure to file is reported, never swallowed', (t) => {
  if (skipWithoutDoor(t)) return;
  // DOCTRINE 3.11: a sweep must report what it could not check. An unfiled
  // conflict with a silent catch is the original bug wearing a new hat.
  const fn = SCRIPT.slice(SCRIPT.indexOf('async function fileConflictTicket'), SCRIPT.indexOf('async function runMergeStep'));
  const pushes = fn.match(/unchecked\.push\(/g) || [];
  assert.ok(pushes.length >= 3, `every failure path must report; found ${pushes.length}`);
  assert.match(fn, /return null;/, 'and must return null so the notice says nobody is on it');
});

test('a stalled conflict is counted ONCE in the summary line', (t) => {
  if (skipWithoutDoor(t)) return;
  // Review round 1 (task 86bbq0fh8): `merges.stalled` and `stalledHandOffs`
  // fire on the same event, and both clauses landed in one console.log —
  // "1 conflict(s) still unresolved, 1 conflict(s) STILL UNRESOLVED" reads as
  // two problems. Only stalledLine reports it, because it vanishes at zero.
  const mergeLine = SCRIPT.slice(SCRIPT.indexOf('const mergeLine'), SCRIPT.indexOf('const stalledLine'));
  assert.ok(mergeLine.length > 0, 'mergeLine must be built before stalledLine');
  assert.ok(!/unresolved/i.test(mergeLine), 'mergeLine must not also count stalled conflicts');
  // The clause is built by the shared helper now (review round 2, item 4), and
  // the helper is what returns '' at zero — the property this test protects.
  assert.match(SCRIPT, /const stalledLine = stalledSummaryClause\(stalledKinds\);/);
  assert.equal(stalledSummaryClause([]), '', 'and it must still vanish at zero');
});

test('announcing a stall re-stamps the marker; a failed announcement does not', (t) => {
  if (skipWithoutDoor(t)) return;
  // The cadence promise in conflictWork.js is one pass of noise per DAY, and
  // the clock is the marker timestamp. Without the re-stamp, every pass after
  // the threshold nags again (review round 1). And the re-stamp must be gated
  // on the bus post SUCCEEDING, or a post nobody saw buys a day of silence.
  const block = SCRIPT.slice(SCRIPT.indexOf('MERGE HAND-OFF STALLED'), SCRIPT.indexOf("outcome: 'handed-off-stalled'"));
  assert.match(block, /else await markMergeHandled\(decision\.commentId, task, unchecked, notice\.marker\)/);
  assert.ok(block.indexOf('busStall.ok') < block.indexOf('markMergeHandled'), 'the re-stamp is the else of the failed-announcement branch');
});

test('a stalled conflict is reported separately from things the pass could not check', (t) => {
  if (skipWithoutDoor(t)) return;
  // `unchecked` exits 1 — that is a health signal about the PASS. A stalled
  // ticket is a healthy pass reporting an unhealthy ticket; conflating them
  // would make the relay look permanently broken and get its exit code ignored.
  assert.match(SCRIPT, /const stalledHandOffs = \[\]/);
  // The banner comes from the shared helper now, so it can no longer say
  // "conflict" over a body that says no overlap was found (review round 2).
  assert.match(SCRIPT, /stalledSummaryHeadline\(stalledKinds\)/);
  assert.ok(!/\\nCONFLICTS STILL UNRESOLVED — \$\{/.test(SCRIPT), 'the hardcoded summary banner must not come back');
  const exitBlock = SCRIPT.slice(SCRIPT.indexOf('if (unchecked.length) process.exit(1)') - 400);
  assert.ok(
    !/stalledHandOffs\.length\) process\.exit/.test(exitBlock),
    'a stalled conflict must not fail the relay run',
  );
});

test('THE MERGE STEP READS ONE VERDICT TABLE, not an inline copy of it', (t) => {
  if (skipWithoutDoor(t)) return;
  // The two-bucket table used to be written inline at the call site, which is
  // how four ways of never looking came out wearing a finding's answer. It
  // lives beside the predicate that reads it now, and the old form must not
  // come back (review round 2).
  assert.match(SCRIPT, /const localVerdict = verdictFromCatchUp\(gate\.localVerdict\);/,
    'the merge step must use the shared mapper');
  assert.ok(
    !/kind: verdict\.code === branchCatchUp\.CODES\.REAL_CONFLICT \? 'real-conflict' : 'unknown'/.test(SCRIPT),
    'the inline two-bucket table must not come back',
  );
  assert.ok(!/'unknown'/.test(SCRIPT.slice(SCRIPT.indexOf('async function runMergeStep'), SCRIPT.indexOf("outcome: 'handed-off', reason"))),
    'and no bucket called "unknown" may survive in the merge step');
});

test('A CLEAN CATCH-UP CARRIES ITS VERDICT — GitHub disagreeing does not erase it', (t) => {
  if (skipWithoutDoor(t)) return;
  // If the local catch-up merged AND pushed and GitHub still says conflict,
  // this machine has the strongest evidence there is that nothing overlaps:
  // it just did the merge. Dropping the verdict there left it null, which the
  // hand-off then had to guess about — and guessing is the defect.
  const from = SCRIPT.indexOf('const local = branchCatchUp.catchUpBranchLocally(');
  const block = SCRIPT.slice(from, SCRIPT.indexOf('} else {', from));
  // `refusalCode` joined it there in round 1 of task 86bbtqpxd, for the same
  // reason and after the same kind of incident: the rebuilt gate is what
  // reaches `refuse()`, and a field dropped on the way is a finding this
  // machine made and then threw away. BOTH must travel.
  // `cannotTell` joined them in review round 2 of task 86bbuvd50, for the
  // third time and the same reason: the rebuilt gate is what the CANNOT TELL
  // bound classifies, and a field dropped here takes the bound back to never
  // firing. THREE must travel.
  assert.match(block, /gate = \{ action: after\.action, cannotTell: Boolean\(after\.cannotTell\), reason: after\.reason, refusalCode: after\.refusalCode, localVerdict: local \};/,
    'the CLEAN verdict, the refusal code and the cannot-tell classification must all travel with the gate');
  assert.ok(!/gate = \{ action: after\.action, reason: after\.reason \};\n\s*if \(after\.prJson\) prJson = after\.prJson;\n\s*\} else \{/.test(SCRIPT),
    'the verdict-dropping form must not come back');
});

test('THE BUS POST MAY NOT ASSERT A FINDING THE PASS DID NOT MAKE', (t) => {
  if (skipWithoutDoor(t)) return;
  // The sentence that sent this back: "this machine found no overlap between
  // the branch and main. Nothing needs resolving and nobody needs to claim
  // it" — printed for a FETCH_FAILED verdict, seconds after the ticket comment
  // said it could not check at all.
  const from = SCRIPT.indexOf('const couldNotLook =');
  const block = SCRIPT.slice(from, SCRIPT.indexOf('const bus = await postToBus(', from));
  assert.ok(block.length > 0, 'the bus body must distinguish the three answers');
  assert.match(block, /const couldNotLook = !selfHealing && !isRealOverlapVerdict;/,
    '"it found nothing" and "it never looked" must be separate questions');
  assert.match(block, /could not check whether that is true/,
    'and the middle one must say so on the bus, not just on the ticket');
  assert.ok(!/this machine found no overlap between the branch and main/.test(SCRIPT),
    'the sentence that asserted an unmade finding must not come back');
});

test('THE DRY RUN NAMES ALL THREE OUTCOMES, and guesses none of them', (t) => {
  if (skipWithoutDoor(t)) return;
  // Review round 2, item 5. A dry run computes no verdict, so it cannot know
  // which hand-off the real pass would make. It used to pick one confidently.
  const block = SCRIPT.slice(SCRIPT.indexOf('if (dryRun) {\n      // A dry run never attempts'), SCRIPT.indexOf("outcome: 'would-hand-off'"));
  assert.ok(block.length > 0, 'the dry-run branch must exist');
  assert.match(block, /a check that could not run at all/, 'the third outcome must be named too');
  assert.ok(!/console\.error\(selfHealing\n/.test(SCRIPT),
    'the dry run must not branch on a flag it cannot have computed');
});

test('THE FILING GATE IS IN THE MERGE STEP, not just in the predicate', (t) => {
  if (skipWithoutDoor(t)) return;
  // The predicate is only a fix if the call site asks it. This is the exact
  // line that filed on `gate.action` alone for PR #444.
  assert.match(
    SCRIPT,
    /if \(shouldFileConflictTicket\(localVerdict\) && !filed && !dryRun\) \{/,
    'fileConflictTicket must be gated on the shared predicate',
  );
  assert.ok(
    !/if \(!filed && !dryRun\) \{\n\s*filed = await fileConflictTicket/.test(SCRIPT),
    'the ungated form must not come back',
  );
});

test('THE STALL BRANCH PASSES THE VERDICT — the branch round 1 caught, widened in round 3', (t) => {
  if (skipWithoutDoor(t)) return;
  // Three branches were converted to read the notice's actor and this fourth
  // one was not, so it kept deriving the actor from `filed`. It is also the
  // only one of the four that posts to the bus.
  const block = SCRIPT.slice(SCRIPT.indexOf('const stalled = handOffStalled('), SCRIPT.indexOf("outcome: 'handed-off-stalled'"));
  assert.ok(block.length > 0, 'the stall branch must exist');
  assert.match(block, /stalledHandOffLine\(\{ task, pr, filed, stalled, localVerdict \}\)/,
    'the bus line must be built from the actor, not from `filed` alone');
  assert.ok(!/stalledHandOffLine\(\{ task, pr, filed, stalled \}\)/.test(SCRIPT),
    'the actor-blind form must not come back');
  assert.match(block, /stalledHandOffHeadline\(\{ localVerdict \}\)/,
    'and so must the banner above it');
  assert.ok(!/CONFLICT STILL UNRESOLVED — \$\{line\}/.test(SCRIPT),
    'the hardcoded conflict banner must not come back');
});

test('the hand-off messages read the VERDICT, never `filed` and never a two-valued actor', (t) => {
  if (skipWithoutDoor(t)) return;
  // "No ticket" and "no actor" are different things, and every branch that
  // conflated them told the room to point a session at a healthy branch.
  const block = SCRIPT.slice(SCRIPT.indexOf('const selfHealing = notice.actor'), SCRIPT.indexOf("outcome: 'handed-off', reason"));
  assert.match(SCRIPT, /const selfHealing = notice\.actor === 'later-pass';/);
  assert.match(block, /handOffStalled\(\{\s*at: decision\.priorRefusalAt, now: Date\.now\(\), filed, localVerdict,/,
    'the stall check must know WHAT WAS FOUND, not just who is waiting');
  assert.match(block, /const busBody = selfHealing/, 'the bus post must not call a self-healing branch blocked');
  assert.match(block, /if \(!filed && !selfHealing\) unchecked\.push\(/, 'a self-healing hand-off is not an unchecked pass');
});

/*
 * ATTEMPTS, NOT ONLY AGE (2026-09-06, task 86bbvr0j5).
 *
 * PR #628 failed to merge five times in ninety minutes and nothing said so,
 * because the only alarm on this path measured the clock and the clock had
 * barely moved. These pin the rule Dane asked for: notice the repetition.
 */
test('a merge that has failed the alarm number of times is stalled however young it is', () => {
  const now = Date.now();
  const at = new Date(now - 60 * 1000).toISOString(); // one minute ago
  const s = handOffStalled({ at, now, filed: FILED, localVerdict: { kind: 'real-conflict' }, attempts: MERGE_ATTEMPT_ALARM });
  assert.equal(s.stalled, true);
  assert.match(s.why, /failed 3 times/);
  // The age rule alone would have called this fine.
  assert.ok(s.ageMs < STALE_HAND_OFF_MS);
});

test('below the alarm it stays quiet, so a retry that clears itself costs no noise', () => {
  const now = Date.now();
  const at = new Date(now - 60 * 1000).toISOString();
  const s = handOffStalled({ at, now, filed: FILED, localVerdict: { kind: 'real-conflict' }, attempts: MERGE_ATTEMPT_ALARM - 1 });
  assert.equal(s.stalled, false);
});

test('the attempts rule is reached even when the marker carries no readable timestamp', () => {
  // The exact state the broken dedup left behind: no parsable `at`. Checked
  // BEFORE the timestamp guard on purpose — placed after it, the alarm would
  // be unreachable in the case it was written for.
  const s = handOffStalled({ at: '', now: Date.now(), filed: FILED, localVerdict: { kind: 'real-conflict' }, attempts: 4 });
  assert.equal(s.stalled, true);
  assert.match(s.why, /failed 4 times/);
});

test('every verdict kind can say why a repeatedly failing merge is news', () => {
  // Same discipline as the rest of the vocabulary: a kind with no entry here
  // would throw rather than borrow another verdict's words.
  for (const v of [{ kind: 'real-conflict' }, { kind: 'no-overlap' }, { kind: 'could-not-check' }]) {
    const s = handOffStalled({ at: '', now: Date.now(), filed: FILED, localVerdict: v, attempts: 3 });
    assert.equal(s.stalled, true);
    assert.equal(typeof s.why, 'string');
    assert.ok(s.why.length > 0);
  }
});

test('unstuckPullRequest reads back the PR a catch-up ticket was filed for, from the body this module writes (SP-68)', () => {
  const { conflictTicketBody, unstuckPullRequest } = require('./conflictWork.js');
  const body = conflictTicketBody({
    task: { id: 'SP-54', url: 'http://t/SP-54', name: 'Breadcrumbs' },
    pr: { number: 43, url: 'https://github.com/owner/repo/pull/43' },
    branch: 'breadcrumb-trail', localVerdict: null, commentId: '508',
  });
  assert.deepEqual(unstuckPullRequest(body), { url: 'https://github.com/owner/repo/pull/43', owner: 'owner', repo: 'repo', number: 43 });
  assert.equal(unstuckPullRequest('## Goal\nPR: https://github.com/o/r/pull/1'), null, 'only under "## The branch"');
  assert.equal(unstuckPullRequest('## The branch\n\n- Branch: x\n\n## Scope\n- PR: https://github.com/o/r/pull/1'), null, 'not past the section');
  assert.equal(unstuckPullRequest(''), null);
});
