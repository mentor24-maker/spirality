'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { doorSource, productScript, skipWithoutDoor, skipWithoutProductScript } = require('./productScripts.js');

const {
  DEFAULT_WIP_CAP,
  CAP_ENV,
  resolveCap,
  countOpenPrs,
  wipDecision,
  probeCap,
  undeterminedDecision,
  ticketIdFromPrBody,
  classifyPrs,
  STRANDABLE_STATUS,
  STRANDED_ENV,
  resolveStrandedAfterMs,
  isStrandedBuild,
  normalizeTicketInfo,
} = require('./wipCap');
const pipelinePause = require('./pipelinePause.js');

/**
 * Task 86bbk2fkp. Branch protection is strict:true, so every merge invalidates
 * every other open branch — the catch-up cost is quadratic in the number of
 * open PRs. With 24 open, one merge dated 23 branches.
 *
 * The danger in a feature like this is not that it caps too little. It is that
 * it becomes a quiet way for the loop to STOP WORKING — so the tests that
 * matter most are the ones proving it still claims when it should, and that a
 * capped pass leaves the queue untouched rather than half-stamped.
 */

const open = (n) => Array.from({ length: n }, (_, i) => ({ number: i + 1, state: 'OPEN' }));

// ── The decision ─────────────────────────────────────────────────────────

test('at or above the cap it declines, and says the count, the cap and why', () => {
  const out = wipDecision({ prs: open(21), cap: 5 });
  assert.equal(out.claim, false);
  assert.equal(out.code, 3, 'a normal decline, the same shape as node:owns');
  assert.equal(out.openCount, 21);
  assert.match(out.message, /21 PR\(s\) open/);
  assert.match(out.message, /cap 5/);
  // WITHOUT TICKET STATUSES IT CANNOT TELL which stage holds the slots, and
  // must say so rather than assert one (2026-09-05, task 86bbvh285). The
  // sentence it replaced — "the merge side is the bottleneck" — named a cause
  // this path has no reading for at all.
  assert.match(out.message, /could NOT be determined/);
  assert.doesNotMatch(out.message, /bottleneck/, 'a path with no statuses named a cause anyway');
  assert.match(out.message, /not a failure/, 'it must not read as an error');
});

test('exactly AT the cap declines — the boundary, not one past it', () => {
  assert.equal(wipDecision({ prs: open(5), cap: 5 }).claim, false);
  assert.equal(wipDecision({ prs: open(4), cap: 5 }).claim, true);
});

test('below the cap it behaves exactly as before', () => {
  // The test that matters most: this must never become a silent way for the
  // loop to stop working.
  const out = wipDecision({ prs: open(2), cap: 5 });
  assert.equal(out.claim, true);
  assert.equal(out.code, 0);
  assert.match(out.message, /room to claim/);
});

test('an empty repo claims', () => {
  assert.equal(wipDecision({ prs: [], cap: 5 }).claim, true);
  assert.equal(wipDecision({ cap: 5 }).claim, true);
  assert.equal(wipDecision({ prs: null, cap: 5 }).claim, true);
});

// ── Counting ─────────────────────────────────────────────────────────────

test('only OPEN pull requests count', () => {
  // Miscounting here silently halves or doubles the effective cap.
  const mixed = [
    { number: 1, state: 'OPEN' },
    { number: 2, state: 'MERGED' },
    { number: 3, state: 'CLOSED' },
    { number: 4, state: 'open' },
  ];
  assert.equal(countOpenPrs(mixed), 2);
  assert.equal(wipDecision({ prs: mixed, cap: 3 }).claim, true, '2 open is under a cap of 3');
});

test('a PR with no state is assumed open, not assumed gone', () => {
  // `gh pr list --state open` omits it. Treating an unlabelled row as closed
  // would undercount and let the cap drift upward unnoticed.
  assert.equal(countOpenPrs([{ number: 1 }, { number: 2 }]), 2);
});

test('malformed input does not throw', () => {
  assert.equal(countOpenPrs(null), 0);
  assert.equal(countOpenPrs('nonsense'), 0);
  assert.equal(countOpenPrs([null, undefined, {}]), 1);
});

// ── The cap itself ───────────────────────────────────────────────────────

test('the cap is a named constant, overridable by env', () => {
  assert.equal(DEFAULT_WIP_CAP, 5);
  assert.equal(resolveCap({}), 5);
  assert.equal(resolveCap({ [CAP_ENV]: '12' }), 12);
  assert.equal(resolveCap({ [CAP_ENV]: '0' }), 0, 'zero is a legitimate "stop building"');
});

test('a malformed override is IGNORED, not obeyed', () => {
  // A typo in an env var must not silently switch the loop off, and must not
  // silently switch the cap off either.
  for (const bad of ['abc', '-3', '2.5', '', '   ', 'null']) {
    assert.equal(resolveCap({ [CAP_ENV]: bad }), DEFAULT_WIP_CAP, `"${bad}" should fall back`);
  }
});

// ── Failing open, deliberately, and loudly ───────────────────────────────

test('an uncountable pass proceeds, but says it is unbounded', () => {
  // This is the ONE place that differs from node:owns. That guard protects a
  // check-then-act claim, where guessing wrong means two machines building the
  // same ticket — a correctness problem, so it must refuse. This is a
  // throughput optimisation: guessing wrong costs churn, refusing on a
  // transient gh failure would stop all work.
  const out = undeterminedDecision('gh exited 1');
  assert.equal(out.claim, true, 'a transient failure must not stop all work');
  assert.equal(out.code, 1, 'and must not be reported as a clean pass either');
  assert.match(out.message, /NOT applied/);
  assert.match(out.message, /gh exited 1/);
  assert.match(out.message, /worth noticing if it repeats/);
});

test('the three exit codes are distinct', () => {
  assert.equal(wipDecision({ prs: open(1), cap: 5 }).code, 0);
  assert.equal(wipDecision({ prs: open(9), cap: 5 }).code, 3);
  assert.equal(undeterminedDecision('x').code, 1);
});

// ── A capped pass must touch nothing ─────────────────────────────────────

test('the wip-check command reads only — no ClickUp writes anywhere in it', (t) => {
  if (skipWithoutDoor(t)) return;
  // AC4: a capped pass leaves the queue exactly as it found it. A stray status
  // or Loop note would mark tickets as being worked when nothing is.
  const src = doorSource() || '';
  const start = src.indexOf("} else if (cmd === 'wip-check') {");
  assert.ok(start > -1, 'the wip-check command must exist');
  // Bounded at next-interval, which now follows it. Bounding at `queue` used
  // to sweep both commands into one "block" and would let a write added to
  // next-interval pass as if it were wip-check's (task 86bbq8br2).
  const end = src.indexOf("} else if (cmd === 'next-interval') {", start);
  assert.ok(end > start, 'could not bound the wip-check block');
  const block = src.slice(start, end);

  for (const forbidden of ["call('POST'", "call('PUT'", "call('DELETE'", 'stampLoopNote', 'postToBus']) {
    assert.ok(!block.includes(forbidden), `wip-check must not ${forbidden} — it is a read-only check`);
  }

  // "Open PRs only" is still the rule; since task 86bbq8br2 it is enforced
  // once rather than in this block, because every caller needs it and two
  // copies of a rule are how they drifted in the first place. It moved one
  // level further down in task 86bbr1u9v, into the shared list builder, when
  // `migrate-rework` became a third reader of the same PR list.
  const ls = src.indexOf('function listOpenPullRequests(');
  assert.ok(ls > -1, 'listOpenPullRequests must exist — it is the single PR reading');
  const lister = src.slice(ls, src.indexOf('\n}\n', ls));
  assert.match(lister, /'--state', 'open'/, 'it must ask gh for open PRs only');

  const ps = src.indexOf('function capProbe(');
  assert.ok(ps > -1, 'capProbe must exist — it is the single cap reading');
  const probe = src.slice(ps, src.indexOf('\n}\n', ps));
  assert.match(probe, /listOpenPullRequests\(/, 'capProbe must read PRs through that one builder');
  for (const forbidden of ["call('POST'", "call('PUT'", "call('DELETE'"]) {
    assert.ok(!probe.includes(forbidden), `capProbe must not ${forbidden} — it is a read-only probe`);
    assert.ok(!lister.includes(forbidden), `listOpenPullRequests must not ${forbidden} — it is a read-only probe`);
  }
});

test('the build skill actually consults it before claiming', (t) => {
  if (skipWithoutProductScript(t, 'buildSkill')) return;
  // A check nothing calls is a check that does not run — the buildStart lesson
  // (86bbjymxr), which shipped a guard and then had to add the instruction.
  // Consulted through the preflight table since task 86bbtujen. The intent is
  // unchanged: the cap runs before a claim, and a capped answer is named.
  const preflight = require('./preflight.js');
  const cap = preflight.GATES['loop-build'].find((g) => g.id === 'cap');
  assert.ok(cap, 'the build preflight must include the cap gate');
  assert.deepEqual([...cap.npmArgs], ['clickup', '--', 'wip-check'], 'and it calls wip-check itself, not a re-implementation');
  assert.equal(preflight.interpretGate(cap, 3).stop, true, 'capped stops the claim');
  const skill = productScript('buildSkill') || '';
  assert.match(skill, /npm run preflight -- loop-build/, 'SKILL.md must tell the pass to run the preflight');
  assert.ok(skill.indexOf('npm run preflight -- loop-build') < skill.indexOf('--claimable'),
    'and the preflight comes before the claim reference — a check nothing calls is a check that does not run');
  assert.match(skill, /merge side is full/, 'the capped decline is named in the verdict table');
});

// ── Counting work in flight, not open PRs (2026-08-25, task 86bbm4zwd) ─────

const pr = (number, ticket, state = 'OPEN') => ({
  number, state,
  body: ticket ? `Does the thing.\n\nTicket: https://app.clickup.com/t/${ticket}\n` : 'No ticket link here.',
});

test('the ticket id is read out of the PR body', () => {
  assert.equal(ticketIdFromPrBody('Ticket: https://app.clickup.com/t/86bbk2fuh'), '86bbk2fuh');
  // The workspace-scoped form ClickUp hands out when you copy from the UI.
  assert.equal(ticketIdFromPrBody('see https://app.clickup.com/t/90141423066/86bbjv681 ok'), '86bbjv681');
  assert.equal(ticketIdFromPrBody('no link at all'), null);
  assert.equal(ticketIdFromPrBody(undefined), null);
});

test('it reads a body exactly as loosely as pr-opened ACCEPTS one', () => {
  // Review round 2. At the time, the gate that guarantees every loop-opened PR
  // carries its ticket — prBodyCarriesTicket in loopTrail.js — took a BARE id
  // case-insensitively, while this reader demanded a URL and matched
  // case-sensitively against a lowercase map. So a body reading
  // `ClickUp: 86bbm4zwd` sailed through pr-opened and then went UNCOUNTED
  // here: the cap failing OPEN, the direction this ticket calls the dangerous
  // one. The gate has since tightened to URL-only (86bbmmv7t finding 2); this
  // reader stays loose on purpose, because over-counting is the cap's safe
  // direction and older PR bodies still carry the bare shape.
  //
  // BREAK TEST: revert ticketIdFromPrBody to `return m ? m[1] : null` with no
  // knownIds scan, and the first two assertions fail. Watched fail.
  const known = ['86bbm4zwd', '86bbk2fuh'];
  assert.equal(ticketIdFromPrBody('ClickUp: 86bbm4zwd', known), '86bbm4zwd',
    'a bare id is what pr-opened accepts, so it must be what this reads');
  assert.equal(ticketIdFromPrBody('see https://app.clickup.com/t/86BBM4ZWD', known), '86bbm4zwd',
    'the URL ClickUp\'s own UI copies is mixed case; the map is keyed lowercase');
  assert.equal(ticketIdFromPrBody('a run like 86bbm4zwdxx is not that id', known), null,
    'and it must not match an id buried inside a longer word');
  assert.equal(ticketIdFromPrBody('nothing familiar here', known), null);
});

test('the two readers agree — anything pr-opened lets through, the cap can count', () => {
  // The property, asserted against the REAL gate rather than a description of
  // it, so the two cannot drift apart again without this failing. The property
  // is one-directional on purpose: the cap may count MORE than the gate lets
  // through (over-counting trips the cap early, the safe direction), but it
  // must never count less — an uncounted in-flight PR is the cap failing OPEN.
  const { prBodyCarriesTicket } = require('./loopTrail');
  const id = '86bbm4zwd';
  const bodies = [
    `Ticket: https://app.clickup.com/t/${id}`,
    `Ticket: https://app.clickup.com/t/90141423066/${id}`,
    `ClickUp: ${id}`,
    `Closes ${id.toUpperCase()}.`,
  ];
  for (const body of bodies) {
    if (!prBodyCarriesTicket(body, id)) continue;
    assert.equal(ticketIdFromPrBody(body, [id]), id,
      `pr-opened accepts this, so the cap must resolve it too, or the PR silently stops counting: ${body}`);
  }

  // Pin what the gate accepts, so a loosening or tightening over there shows
  // up HERE as a failed expectation rather than as a silently vacuous loop.
  // Since 2026-08-26 (task 86bbmmv7t, finding 2) a bare id is NOT a ticket
  // reference — clickupTicketLink.js requires the full URL, both live shapes.
  assert.ok(prBodyCarriesTicket(`Ticket: https://app.clickup.com/t/${id}`, id),
    'pr-opened accepts the plain URL the loop writes');
  assert.ok(prBodyCarriesTicket(`Ticket: https://app.clickup.com/t/90141423066/${id}`, id),
    "pr-opened accepts the workspace URL ClickUp's copy-link button produces");
  assert.equal(prBodyCarriesTicket(`ClickUp: ${id}`, id), false,
    'a bare id no longer passes pr-opened (86bbmmv7t finding 2)');

  // The cap still resolves a bare id via the knownIds scan. That is deliberate
  // looseness in the safe direction, not drift: a PR whose body predates the
  // URL rule keeps counting against the cap.
  assert.equal(ticketIdFromPrBody(`ClickUp: ${id}`, [id]), id,
    'the cap counts a bare id even though the gate no longer accepts one');
});

test('casing on EITHER side — the PR body or the queue — must not decide the count', () => {
  // Two separate lowercasings, so two assertions. The reader lowercases what
  // it captures; classifyPrs lowercases the map keys. Drop either one and a
  // real, in-flight PR silently stops counting — the cap failing OPEN.
  //
  // BREAK TEST: drop `.toLowerCase()` from the captured id and the first fails;
  // drop it from the map keys and the second fails. Both watched fail.
  const bodyCased = classifyPrs({
    prs: [pr(1, '86BBM4ZWD')],
    ticketStatusById: { '86bbm4zwd': 'Building' },
  });
  assert.deepEqual(bodyCased.inFlight, [1], 'a mixed-case id in the PR body must still resolve');

  const queueCased = classifyPrs({
    prs: [pr(2, '86bbm4zwd')],
    ticketStatusById: { '86BBM4ZWD': 'Building' },
  });
  assert.deepEqual(queueCased.inFlight, [2], 'a mixed-case id from the QUEUE must still resolve');
  assert.deepEqual(queueCased.unknown, []);
});

test('only in-flight tickets count; queued rework and live zombies do not', () => {
  const prs = [pr(1, 'tBuild'), pr(2, 'tReview'), pr(3, 'tReady'), pr(4, 'tQueued'), pr(5, 'tLive'), pr(6, null)];
  const g = classifyPrs({ prs, ticketStatusById: {
    tBuild: 'Building', tReview: 'In review', tReady: 'Ready to launch',
    tQueued: 'Queued', tLive: 'Live',
  }});
  assert.deepEqual(g.inFlight, [1, 2, 3], 'Building / In review / Ready to launch are in flight');
  assert.deepEqual(g.queued, [4], 'a queued ticket is REWORK — counting it is what caused the deadlock');
  assert.deepEqual(g.live, [5], 'a live ticket means the work shipped elsewhere; the PR is a leftover');
  assert.deepEqual(g.unknown, [6], 'a PR with no ticket is reported, never counted');
});

test('THE DEADLOCK: the real 2026-08-25 state must let the loop claim', () => {
  // Verbatim from the morning that broke it: 7 open PRs against cap 5, of
  // which 3 were queued for rework and 2 were zombies whose tickets were Live.
  // The old counting said "7 open, cap 5 — not claiming" for four consecutive
  // hourly passes while only two things were genuinely in flight.
  const prs = [
    pr(428, 'tQ1'), pr(426, 'tQ2'), pr(419, 'tQ3'),      // sent back to Queued
    pr(374, 'tL1'), pr(381, 'tL2'),                       // tickets already Live
    pr(373, 'tB1'), pr(422, 'tR1'),                       // genuinely in flight
  ];
  const ticketStatusById = {
    tQ1: 'Queued', tQ2: 'Queued', tQ3: 'Queued',
    tL1: 'Live', tL2: 'Live',
    tB1: 'Building', tR1: 'In review',
  };
  const d = wipDecision({ prs, cap: 5, ticketStatusById });
  assert.equal(d.claim, true, 'the loop must claim: only 2 of the 7 are in flight');
  assert.equal(d.code, 0);
  assert.equal(d.inFlight, 2);
  assert.equal(countOpenPrs(prs), 7, 'and the raw open count is still 7 — that is the whole point');
});

test('the message names the split, never a bare total', () => {
  // A bare "7 open, cap 5" is true and useless: it hid the deadlock for four
  // passes. Whatever the verdict, the uncounted PRs must be itemised.
  const prs = [pr(1, 'a'), pr(2, 'b'), pr(3, 'c'), pr(4, 'd')];
  const byId = { a: 'Building', b: 'Queued', c: 'Live', d: 'Rework' };
  const { message } = wipDecision({ prs, cap: 5, ticketStatusById: byId });
  // Since task 86bbuzzbk the headline carries BOTH limits, because there are
  // two and either can be the one that declined. Naming only the enforced one
  // would put a true number where the deciding one belongs.
  assert.match(message, /1 building or in review \(cap 5\)/);
  assert.match(message, /0 waiting on Dane \(ceiling 10\)/);
  assert.match(message, /1 in rework, waiting to be re-claimed \(#4\)/);
  assert.match(message, /1 queued with a PR already open \(#2\)/);
  assert.match(message, /already live \(#3\)/);
  assert.doesNotMatch(message, /4 PR\(s\) open/, 'the old bare-total phrasing must be gone');
  assert.doesNotMatch(message, /\d+ in flight, cap/,
    'the merged "in flight" total must not stand where the build cap is enforced — it counted work parked on Dane');
});

test('the rework count is in the headline of BOTH messages, and zero is stated', () => {
  // Acceptance criterion 3 of task 86bbr1u9v. "1 in flight, cap 5" while five
  // real branches sat open is the statement the Rework status exists to end,
  // and a number that only ever appears in a trailing clause is a number that
  // gets skimmed past. The headline is the sentence a log line quotes.
  const rework = [pr(10, 'r1'), pr(11, 'r2')];

  const roomy = wipDecision({
    prs: [pr(1, 'a'), ...rework],
    cap: 5,
    ticketStatusById: { a: 'Building', r1: 'Rework', r2: 'Rework' },
  });
  assert.match(roomy.message.split('\n')[0], /2 in rework/, 'the uncapped headline must carry it');
  assert.equal(roomy.rework, 2);
  assert.equal(roomy.claim, true, 'rework must never count against the cap');

  const capped = wipDecision({
    prs: [...[1, 2, 3, 4, 5].map((n) => pr(n, `t${n}`)), ...rework],
    cap: 5,
    ticketStatusById: {
      ...Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`t${n}`, 'In review'])),
      r1: 'Rework', r2: 'Rework',
    },
  });
  assert.equal(capped.claim, false);
  assert.match(capped.message.split('\n')[0], /2 in rework/, 'the capped headline must carry it too');

  // Zero is stated rather than omitted: a clause that vanishes when it is zero
  // tells the reader nothing about whether it was checked at all.
  const none = wipDecision({ prs: [pr(1, 'a')], cap: 5, ticketStatusById: { a: 'Building' } });
  assert.match(none.message, /0 in rework/);
});

test('rework is read from the real status, never inferred from queued', () => {
  // The bug this ticket closes: before `Rework` existed, "queued with an open
  // PR" was the ONLY way to spot a send-back, so a send-back and work nobody
  // had started were the same reading. They are two buckets now, and they must
  // not collapse back into one.
  const prs = [pr(1, 'r'), pr(2, 'q')];
  const g = classifyPrs({ prs, ticketStatusById: { r: 'Rework', q: 'Queued' } });
  assert.deepEqual(g.rework, [1]);
  assert.deepEqual(g.queued, [2]);
  assert.deepEqual(g.inFlight, [], 'neither may count against the cap');
});

test('a genuinely full pipeline still caps', () => {
  // The cap is right and must keep working — this ticket changed WHAT it
  // counts, not whether it counts.
  const prs = [1, 2, 3, 4, 5].map((n) => pr(n, `t${n}`));
  const byId = Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`t${n}`, 'In review']));
  const d = wipDecision({ prs, cap: 5, ticketStatusById: byId });
  assert.equal(d.claim, false);
  assert.equal(d.code, 3);
  assert.equal(d.limitHit, 'wip', 'five machine-held PRs is the BUILD cap, not the operator ceiling');
  assert.match(d.message, /5 building or in review \(cap 5\)/);
  // IT NAMES WHAT IT MEASURED, not a cause (task 86bbvh285). All five are in
  // review here, so a message blaming the merge side would send the reader to
  // the one lane that is not involved — which is exactly what happened on
  // 2026-09-05, when merges were landing in nine minutes and review was the
  // stage that had stalled.
  assert.match(d.message, /the slots are held by 0 building, 5 in review/);
  assert.doesNotMatch(d.message, /bottleneck/);
});

test('the decline names the SPLIT of the slots, not just the total', () => {
  // Two builds and three reviews. A reader has to be able to tell which stage
  // to go and look at; "5 building or in review" alone cannot say.
  const prs = [1, 2, 3, 4, 5].map((n) => pr(n, `t${n}`));
  const byId = {
    t1: 'Building', t2: 'Building', t3: 'In review', t4: 'In review', t5: 'In review',
  };
  const d = wipDecision({
    prs, cap: 5, ticketStatusById: byId,
    // Keep the two builds FRESH, or the stranded discount takes them out of
    // the count and this measures something else entirely.
    nowMs: Date.now(), strandedAfterMs: 60 * 60 * 1000,
  });
  assert.equal(d.limitHit, 'wip');
  assert.equal(d.building, 2);
  assert.equal(d.reviewing, 3);
  assert.match(d.message, /the slots are held by 2 building, 3 in review/);
});

test('BREAK-TEST: the split is a PARTITION of the in-progress count', () => {
  // building + reviewing must equal inProgress. If a third in-progress status
  // is ever added to the taxonomy and not handled here, the phrase says so
  // rather than under-reporting — a total that stops adding up to the cap is
  // how a partition quietly stops being one.
  const prs = [1, 2, 3].map((n) => pr(n, `t${n}`));
  const byId = { t1: 'Building', t2: 'In review', t3: 'In review' };
  const d = wipDecision({
    prs, cap: 5, ticketStatusById: byId, nowMs: Date.now(), strandedAfterMs: 60 * 60 * 1000,
  });
  assert.equal(d.building + d.reviewing, d.inProgress, 'the split lost a pull request');
});

test('no ticket statuses at all falls back to the OLD, stricter counting', () => {
  // If ClickUp cannot be read we must fail TOWARD the cap. Failing away from
  // it would reinstate the churn the cap exists to prevent, silently.
  const prs = [1, 2, 3, 4, 5].map((n) => pr(n, `t${n}`));
  const d = wipDecision({ prs, cap: 5 });
  assert.equal(d.claim, false, 'unreadable queue must not uncap the loop');
  assert.equal(d.code, 3);
  assert.match(d.message, /statuses were NOT available/i);
});

test('an unknown status is not counted AND is not mislabelled as live', () => {
  // A status nobody anticipated must not silently consume cap — and must not
  // be reported as "already live" either. UPDATED after review round 1: the
  // first version bucketed everything unrecognised as live, which is a claim
  // that the work SHIPPED. A wrong claim there is the exact thing this ticket
  // exists to stop.
  const g = classifyPrs({ prs: [pr(9, 'x')], ticketStatusById: { x: 'Some New Status' } });
  assert.deepEqual(g.inFlight, []);
  assert.deepEqual(g.live, []);
  assert.deepEqual(g.queued, []);
  // UPDATED AGAIN after review round 2: it must not be filed as "no ticket
  // found" either. A ticket WAS found — saying otherwise sends the reader
  // hunting for a missing ClickUp link that is not missing, which is round
  // 1's finding 1 in a different bucket.
  assert.deepEqual(g.unknown, [], 'a ticket was found, so this is not "no ticket found"');
  assert.deepEqual(g.unrecognised, [{ number: 9, status: 'Some New Status' }],
    'and the status it did not recognise is carried, so the message can quote it');
});

test('the message says WHICH status it did not recognise, and does not call it missing', () => {
  // The wording is the whole fix: "no ticket found" for a PR whose ticket is
  // right there is a false statement, and it costs the reader a hunt. Naming
  // the status also makes the line actionable — either IN_FLIGHT_STATUSES is
  // out of date, or somebody typed a status by hand.
  const { message } = wipDecision({
    prs: [pr(1, 'a'), pr(2, 'b')], cap: 5,
    ticketStatusById: { a: 'Building', b: 'Parked Indefinitely' },
  });
  assert.match(message, /unrecognised status/);
  assert.match(message, /#2 — "Parked Indefinitely"/, 'quoted verbatim, in ClickUp\'s own casing');
  assert.doesNotMatch(message, /no ticket found/,
    'a ticket WAS found — reporting a missing link that is not missing is the defect');
});

test('a PR with genuinely no ticket still reports as no ticket found', () => {
  // The other side of the split: separating the buckets must not lose the
  // case criterion 4 is about. Reported by number, never counted, exit still 0.
  const d = wipDecision({ prs: [pr(1, 'a'), pr(7, null)], cap: 5, ticketStatusById: { a: 'Building' } });
  assert.deepEqual(d.groups.unknown, [7]);
  assert.deepEqual(d.groups.unrecognised, []);
  assert.equal(d.code, 0, 'an unidentifiable PR must not stop the pass');
  assert.match(d.message, /1 with no ticket found \(#7\)/);
});

test('Needs your input counts as in flight — it is operator-held, like Ready to launch', () => {
  // Review round 1 caught this reported as "already live", which is false.
  // Decided: it counts. A ticket parked on Dane with an open PR is real work
  // occupying the merge pipeline, its branch still needs catching up on every
  // merge, and if his inbox is full the pipeline genuinely IS full. Ready to
  // launch is operator-held and was never in doubt; this is the same category.
  const g = classifyPrs({ prs: [pr(7, 'n')], ticketStatusById: { n: 'Needs your input' } });
  assert.deepEqual(g.inFlight, [7]);
  assert.deepEqual(g.live, []);
});

// ── The wiring, pinned at source ──────────────────────────────────────────
// clickup_direct.mjs has no harness, and review round 1 showed exactly why
// that matters: the include-closed and non-fatal options are invisible to a
// unit test that injects task objects, and BOTH were wrong in ways that made
// the feature silently not work. Breaking either must fail here.

const CD = doorSource() || '';

test('wip-check asks ClickUp for closed tasks, or Live tickets are invisible', (t) => {
  if (skipWithoutDoor(t)) return;
  // Without include_closed the v2 list endpoint drops closed-type statuses:
  // 36 tasks come back where 66 Live ones exist. A zombie PR's ticket is then
  // simply absent, and it reports as "no ticket found" — sending the reader
  // after drift that does not exist.
  assert.match(CD, /fetchAllTasks\(LOOP_QUEUE_LIST, \{ includeClosed: true, fatal: false \}\)/,
    'wip-check must pass includeClosed:true AND fatal:false');
  assert.match(CD, /include_closed=true/, 'and fetchAllTasks must actually send it');
});

test('the failed-read path cannot exit the process — that inverted the safety property', (t) => {
  if (skipWithoutDoor(t)) return;
  // fetchAllTasks calls die() -> process.exit(1) on a bad response. loop-build
  // reads exit 1 as "proceed, unbounded by the cap", so a routine ClickUp 429
  // UNCAPPED the loop instead of capping it. The non-fatal mode must return
  // rather than die.
  assert.match(CD, /if \(!fatal\) return \{ tasks: null, res: out\.res, failed:/,
    'a non-fatal read must RETURN on failure, never die()');
  assert.doesNotMatch(CD, /try \{\s*const \{ tasks \} = await fetchAllTasks\(LOOP_QUEUE_LIST\);/,
    'the old unreachable try/catch around a die()-ing call must be gone');
});

test('a failed read falls back to the STRICTER counting, never to uncapped', () => {
  // The property the inverted fallback broke, asserted on the decision itself.
  const prs = [1, 2, 3, 4, 5, 6].map((n) => pr(n, `t${n}`));
  const d = wipDecision({ prs, cap: 5 });
  assert.equal(d.claim, false, 'no ticket data must mean MORE restrictive, not less');
  assert.equal(d.code, 3, 'and a normal decline, never exit 1 which means "proceed uncapped"');
});

// ── The doc must describe THIS code, not the code it replaced ─────────────
// Review round 2, finding 4: the section added to LOOP_ENGINEERING.md listed
// three counting statuses where the code has four, and described the reconcile
// scan as newest-PR-only after round 1 had already made it check every PR. Both
// were true of an earlier draft. A doc that documents the bug is worse than no
// doc, because the operator has no way to tell — so the claims that can be
// mechanically checked are checked here rather than re-read by hand.

const LOOP_DOC = productScript('loopDoc') || '';

test('the doc names every status that counts, and none that does not', (t) => {
  if (skipWithoutProductScript(t, 'loopDoc')) return;
  const { IN_FLIGHT_STATUSES } = require('./wipCap');
  const start = LOOP_DOC.indexOf('## The work-in-progress cap');
  assert.ok(start > -1, 'the section must exist — a doc nobody can find is not a doc');
  const section = LOOP_DOC.slice(start, LOOP_DOC.indexOf('\n## ', start + 5));

  for (const status of IN_FLIGHT_STATUSES) {
    // Backticked, in the doc's own Title Case, as ClickUp shows it.
    const shown = status.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\bIn Review\b/, 'In review');
    assert.ok(new RegExp(`\`${shown}\``, 'i').test(section),
      `IN_FLIGHT_STATUSES has "${status}" but the doc's cap section never mentions it`);
  }
  // And the reverse: a status that does NOT count must not be listed as one.
  // `Queued` and `Live` appear in the section on purpose — as the things that
  // count zero — so this checks the sentence that enumerates what counts.
  const sentence = /A PR counts only when its ticket is ([^.]+)\./.exec(section);
  assert.ok(sentence, 'the doc must state plainly which statuses count');
  for (const notCounted of ['Queued', 'Live']) {
    assert.ok(!sentence[1].includes(notCounted),
      `"${notCounted}" does not count, so it must not appear in the sentence that says what does`);
  }
});

test('the doc does not describe the reconcile scan as newest-PR-only', (t) => {
  if (skipWithoutProductScript(t, 'loopDoc')) return;
  const start = LOOP_DOC.indexOf('**The matching drift check.**');
  assert.ok(start > -1, 'the reconcile paragraph must exist');
  const para = LOOP_DOC.slice(start, start + 1200);
  assert.doesNotMatch(para, /newest PR is still open/,
    'round 1 replaced newest-only with every-distinct-PR; the doc documented the bug');
  assert.match(para, /any linked PR still open|every distinct PR/i,
    'it must say what the code actually does');
});

// ── One reading, two callers (2026-08-31, task 86bbq8br2) ─────────────────
// `wip-check` and `next-interval` answered "is the cap full?" differently:
// the claim gate said "4 in flight, cap 5 — room to claim another" while the
// sleep timer wrote "the work-in-progress cap is full" into the log and slept
// the maximum hour, with 38 tickets claimable. Neither function was wrong;
// they were two call sites, and only one of them passed ticket statuses.

// Eight open PRs, four of them rework whose tickets went back to `Queued` —
// the exact shape of the queue on the morning this was found.
const EIGHT = {
  prs: [
    pr(419, 'tq1'), pr(446, 'tq2'), pr(447, 'tq3'), pr(449, 'tq4'),
    pr(454, 'tf1'), pr(471, 'tf2'), pr(481, 'tf3'), pr(482, 'tf4'),
  ],
  statuses: {
    tq1: 'Queued', tq2: 'Queued', tq3: 'Queued', tq4: 'Queued',
    tf1: 'In review', tf2: 'Building', tf3: 'In review', tf4: 'Building',
  },
};

test('8 open PRs, 4 queued for rework, cap 5 — the cap is NOT reached', async () => {
  // THE regression. Counting all eight is what made loop-build sleep an hour
  // after every productive pass.
  const out = await probeCap({
    cap: 5,
    listOpenPrs: async () => EIGHT.prs,
    readTicketStatuses: async () => EIGHT.statuses,
  });
  assert.equal(out.determined, true);
  assert.equal(out.statusesAvailable, true);
  assert.equal(out.decision.inFlight, 4, 'the four sent back for rework must not count');
  assert.equal(out.decision.code, 0, 'code 3 here is the bug: a full cap that is not full');
  assert.equal(out.decision.claim, true);
});

test('an unreadable queue still counts every open PR, and says so', async () => {
  // Criterion 3: the conservative fallback is unchanged, and never silent.
  const out = await probeCap({
    cap: 5,
    listOpenPrs: async () => EIGHT.prs,
    readTicketStatuses: async () => { throw new Error('HTTP 429'); },
  });
  assert.equal(out.determined, true);
  assert.equal(out.statusesAvailable, false, 'the caller must be able to say statuses were unavailable');
  assert.match(out.queueFailure, /429/, 'and must be able to say WHY');
  assert.equal(out.decision.code, 3, 'all eight counted — the stricter reading');
  assert.match(out.decision.message, /statuses were NOT available/i);
});

test('an empty queue read is a failed read, not an empty queue', async () => {
  // `[]` back from ClickUp is never true here — the Loop Queue always has
  // tickets — so treating it as "no ticket is in flight" would uncap the loop.
  const out = await probeCap({
    cap: 5,
    listOpenPrs: async () => EIGHT.prs,
    readTicketStatuses: async () => ({}),
  });
  assert.equal(out.statusesAvailable, false);
  assert.equal(out.decision.code, 3, 'must fall back to the strict count, not claim nothing is in flight');
});

test('an unlistable PR set is UNDETERMINED — neither caller gets to guess here', async () => {
  const out = await probeCap({
    cap: 5,
    listOpenPrs: async () => { throw new Error('gh is not installed'); },
    readTicketStatuses: async () => EIGHT.statuses,
  });
  assert.equal(out.determined, false);
  assert.equal(out.decision, null, 'no decision at all, so wip-check can fail open and next-interval closed');
  assert.match(out.why, /gh is not installed/);
});

test('a PR list with no bodies UNCAPS the loop — which is why the field list is pinned at source', () => {
  // Worth stating exactly, because it is the opposite of what it looks like.
  // `--json number,state` omits the body, so classifyPrs matches no PR to a
  // ticket and all eight land in `unknown` — a bucket that deliberately does
  // NOT count, so a hand-made PR never caps the loop. The result is that a
  // body-less list fails OPEN: 0 in flight, claim away.
  //
  // (The old next-interval bug was the other one — it passed no statuses at
  // all, taking the fallback that counts every open PR, and so read as FULL.
  // Same missing field, opposite failure, depending on whether statuses came
  // with it. Neither is acceptable, and no runtime assertion can tell a
  // body-less list from a repo where nobody links tickets — so the guard is
  // the source test below, which requires 'body' in the one field list there
  // is.)
  const g = classifyPrs({
    prs: EIGHT.prs.map(({ number, state }) => ({ number, state })),
    ticketStatusById: EIGHT.statuses,
  });
  assert.equal(g.inFlight.length, 0);
  assert.equal(g.unknown.length, 8, 'every PR unmatched — invisible to the cap');
});

// ── The wiring, pinned at source ─────────────────────────────────────────
// The bug lived in the call sites, not in this module, so unit tests alone
// would pass on the broken code. These are the assertions that fail on it.

test('every cap probe goes through capProbe — no command reads the cap its own way', (t) => {
  if (skipWithoutDoor(t)) return;
  assert.doesNotMatch(CD, /wipCap\.wipDecision\(/,
    'wipDecision must be reached only through wipCap.probeCap, or the two callers can drift apart again');
  const probes = CD.match(/await capProbe\(/g) || [];
  // Three callers since task 86bbr1u9v: `wip-check`, `next-interval` and
  // `migrate-rework`, which asks the SAME probe which queued tickets have an
  // open PR rather than re-deriving "this one is really a send-back". The
  // count is pinned so a FOURTH reader has to come here and justify itself —
  // the failure this guards is a caller that answers the cap question its own
  // way, which is what took a morning to spot on 2026-08-31.
  assert.equal(probes.length, 3, 'exactly three callers: wip-check, next-interval and migrate-rework');
});

test('the PR list asks for the body, or every PR counts as having no ticket', (t) => {
  if (skipWithoutDoor(t)) return;
  // `--json number,state` is what next-interval used, and it is why the cap
  // read as full: classifyPrs finds a PR's ticket through its body.
  assert.doesNotMatch(CD, /'--json', 'number,state'/,
    "a PR list without 'body' makes classifyPrs blind");
  assert.match(CD, /'--json', 'number,state,body'/);
  const lists = CD.match(/'pr', 'list'/g) || [];
  assert.equal(lists.length, 1, 'one place builds the PR list, so the field list cannot diverge');
});

test('next-interval logs the cap sentence itself, not just its effect', (t) => {
  if (skipWithoutDoor(t)) return;
  // A disagreement with wip-check took a morning to spot because the interval
  // log said only "the cap is full". Printing the decision makes the two
  // comparable at a glance.
  assert.match(CD, /\(cap: \$\{String\(probe\.decision\.message\)/,
    'the interval log must quote the same sentence wip-check prints');
});

// ---------------------------------------------------------------------------
// A stranded build must not count against the cap (2026-09-02, task 86bbtmbum).
//
// On the night of 2026-09-01 the cap sat full for five consecutive passes with
// 48 tickets queued. Two of its five slots were builds whose pass had died —
// #447 and #449, both with finished green PRs, both in "Building" where no
// loop can claim them. They were not a queue, they were a deadlock.
// ---------------------------------------------------------------------------

const NOW = Date.parse('2026-09-02T14:17:00.000Z');
const STALE = NOW - 8 * 60 * 60 * 1000;
const FRESH = NOW - 5 * 60 * 1000;
const prOf = (n, id) => ({ number: n, state: 'OPEN', body: `ClickUp: https://app.clickup.com/t/${id}` });

test('the night of 2026-09-01, replayed: the loop keeps claiming', () => {
  // The five real PRs, their real statuses, at the real moment the loop said
  // "WIP cap reached" for the fifth time.
  const prs = [prOf(524, 'aaa'), prOf(525, 'bbb'), prOf(499, 'ccc'), prOf(449, 'ddd'), prOf(447, 'eee')];
  const ticketStatusById = {
    aaa: { status: 'in review', dateUpdated: FRESH },
    bbb: { status: 'in review', dateUpdated: FRESH },
    ccc: { status: 'ready to launch', dateUpdated: STALE },
    ddd: { status: 'Building', dateUpdated: STALE, loopNote: 'building — claimed 12:10am' },
    eee: { status: 'Building', dateUpdated: STALE, loopNote: 'PR #447 open — waiting for a review pass' },
  };
  const d = wipDecision({ prs, cap: 5, ticketStatusById, nowMs: NOW });
  assert.equal(d.claim, true, 'the loop must be free to claim — this is the whole ticket');
  assert.equal(d.code, 0);
  assert.equal(d.inFlight, 3, 'three genuinely in flight, not five');
  assert.equal(d.stranded, 2);
  assert.deepEqual(d.groups.strandedBuilds, [449, 447]);
});

test('an operator-held ticket keeps counting however old it gets', () => {
  // The load-bearing limit on this discount. "Ready to launch" and "Needs your
  // input" are MOVING — Dane or Lane A will merge them — and the file is right
  // that if his inbox is full the pipeline genuinely is full. Discounting them
  // would uncap the loop against work that is really there.
  for (const status of ['ready to launch', 'needs your input']) {
    const d = wipDecision({
      prs: [prOf(1, 'a')], cap: 5, nowMs: NOW,
      ticketStatusById: { a: { status, dateUpdated: NOW - 30 * 24 * 3600 * 1000 } },
    });
    assert.equal(d.inFlight, 1, `${status} must still count after a month`);
    assert.equal(d.stranded, 0);
  }
});

test('a ticket resting in review keeps counting too', () => {
  // "In review" is a resting status as well as a working one: a ticket waits
  // there for a reviewer, and its PR is real and still needs catching up.
  const d = wipDecision({
    prs: [prOf(1, 'a')], cap: 5, nowMs: NOW,
    ticketStatusById: { a: { status: 'in review', dateUpdated: STALE } },
  });
  assert.equal(d.inFlight, 1);
  assert.equal(d.stranded, 0);
  assert.equal(STRANDABLE_STATUS, 'building', 'only Building may be discounted');
});

test('a review whose pass died still counts — only a BUILD may be discounted', () => {
  // Found by break-testing: removing the status guard changed nothing in any
  // test, because `classifyTicket` already returns null for the operator-held
  // statuses. The one case it does NOT filter is an "In review" ticket
  // carrying a stale review claim note — the sweep treats that as stranded and
  // RELEASES it where it stands, without moving it. Its build is finished and
  // its PR is open, so the work really is in flight and the cap must keep
  // counting it. That is the whole reason the guard names one status instead
  // of trusting the shared classifier's answer.
  const { REVIEW_CLAIM_NOTE } = require('./loopNote.js');
  const d = wipDecision({
    prs: [prOf(1, 'a')], cap: 5, nowMs: NOW,
    ticketStatusById: { a: { status: 'In review', dateUpdated: STALE, loopNote: `${REVIEW_CLAIM_NOTE} — a review pass started 2:00am` } },
  });
  assert.equal(d.stranded, 0, 'a dead review is not a dead build');
  assert.equal(d.inFlight, 1, 'its PR is real and still needs catching up');
  // And the shared classifier really would have called it stranded, so this
  // test is proving the guard rather than restating the classifier.
  const viaSweep = pipelinePause.classifyTicket(
    { id: 'x', status: { status: 'In review' }, date_updated: STALE, loopNote: `${REVIEW_CLAIM_NOTE} — started` },
    { nowMs: NOW },
  );
  assert.equal(viaSweep.stranded, true, 'the sweep does see it — the cap deliberately does not act on it');
});

test('a build in progress still counts — the discount is for DEAD work only', () => {
  const d = wipDecision({
    prs: [prOf(1, 'a')], cap: 5, nowMs: NOW,
    ticketStatusById: { a: { status: 'Building', dateUpdated: FRESH, loopNote: 'building — claimed 5 min ago' } },
  });
  assert.equal(d.inFlight, 1, 'a pass that is genuinely running must not be discounted out from under itself');
  assert.equal(d.stranded, 0);
});

test('freshness unknown means NO discount, and the message says it was not checked', () => {
  // Every caller before this change passed a bare status string, and one still
  // does (loop_throughput.mjs). They must get the old, conservative answer —
  // and must not be told "0 stranded", which is a claim nobody verified.
  const prs = [prOf(1, 'a'), prOf(2, 'b')];
  const d = wipDecision({ prs, cap: 5, nowMs: NOW, ticketStatusById: { a: 'Building', b: 'Building' } });
  assert.equal(d.inFlight, 2, 'unknown freshness counts, as before');
  assert.equal(d.stranded, 0);
  assert.match(d.message, /stranded builds NOT checked/);
  assert.doesNotMatch(d.message, /0 stranded/, '"could not tell" must never render as "none"');
});

test('the cap and the sweep agree about which builds are stranded', () => {
  // Two definitions of "how old is dead" would drift the first time one was
  // tuned, and then the cap would forgive a ticket the sweep will not rescue —
  // the deadlock simply moves. So the rule is imported, not restated.
  const code = fs.readFileSync(path.join(__dirname, 'wipCap.js'), 'utf8');
  assert.match(code, /require\('\.\/pipelinePause\.js'\)/, 'the staleness rule is imported');
  assert.match(code, /pipelinePause\.classifyTicket\(/, 'and applied through the shared classifier');
  assert.match(code, /pipelinePause\.STRANDED_AFTER_MS/, 'and the threshold is the shared constant');
  // And they really do agree, not merely share a file.
  const info = { status: 'Building', dateUpdated: STALE, loopNote: '' };
  const viaCap = isStrandedBuild(info, NOW, pipelinePause.STRANDED_AFTER_MS);
  const viaSweep = pipelinePause.classifyTicket(
    { id: 'x', status: { status: 'Building' }, date_updated: STALE, loopNote: '' }, { nowMs: NOW },
  );
  assert.equal(viaCap, viaSweep.stranded);
});

test('the discounted PRs are named, and the reader is told what to run', () => {
  const d = wipDecision({
    prs: [prOf(447, 'e')], cap: 5, nowMs: NOW,
    ticketStatusById: { e: { status: 'Building', dateUpdated: STALE } },
  });
  assert.match(d.message, /#447/, 'a bare total is what hid the 2026-08-25 deadlock for four passes');
  assert.match(d.message, /build pass died/);
  assert.match(d.message, /pipeline -- sweep/, 'and the repair is named');
});

test('a bad staleness override is ignored, never obeyed', () => {
  // A typo here would discount every in-flight build at once and uncap the
  // loop — the direction this file calls dangerous.
  const base = pipelinePause.STRANDED_AFTER_MS;
  assert.equal(resolveStrandedAfterMs({}), base);
  assert.equal(resolveStrandedAfterMs({ [STRANDED_ENV]: '' }), base);
  assert.equal(resolveStrandedAfterMs({ [STRANDED_ENV]: 'soon' }), base);
  assert.equal(resolveStrandedAfterMs({ [STRANDED_ENV]: '-5' }), base);
  assert.equal(resolveStrandedAfterMs({ [STRANDED_ENV]: '30' }), 30 * 60000);
  assert.equal(resolveStrandedAfterMs({ [STRANDED_ENV]: '0' }), 0, 'zero is a real answer, for a live test');
});

test('a status string and a record are read the same way', () => {
  assert.deepEqual(normalizeTicketInfo('Building').status, 'Building');
  assert.equal(Number.isFinite(normalizeTicketInfo('Building').dateUpdated), false);
  const rec = normalizeTicketInfo({ status: ' Building ', dateUpdated: 12, loopNote: 'n' });
  assert.deepEqual(rec, { status: 'Building', dateUpdated: 12, loopNote: 'n' });
});

test('the cap probe reads freshness from the tasks it already fetched', (t) => {
  if (skipWithoutDoor(t)) return;
  // If the caller keeps sending bare statuses, every rule above is inert in
  // production — which is exactly the defect 86bbtmbnr was about: a fix that
  // is correct in the module and unreachable in the thing that runs.
  const code = doorSource() || '';
  const probe = code.slice(code.indexOf('function capProbe('), code.indexOf('function capProbe(') + 2000);
  assert.match(probe, /dateUpdated: Number\(t\.date_updated\)/, 'the probe must supply freshness');
  assert.match(probe, /loopNote: loopNoteOf\(t\)/, 'and the loop note the shared classifier reads');
});

// ── The operator ceiling (2026-09-04, task 86bbuzzbk) ────────────────────────
//
// THE BUG THESE COVER. Until today `Ready to launch` and `Needs your input`
// counted against the build cap of five, so a ticket that was finished,
// reviewed, green and waiting only on Dane held a build slot for as long as he
// was asleep. Five of them stopped the pipeline outright, however deep the
// queue. On the night of 2026-09-03 that idled loop-build for three separate
// hours with 66-71 tickets claimable, and it put a hard ceiling of five on how
// much finished work could ever be waiting for him at once.

test('work parked on Dane no longer holds a BUILD slot', () => {
  // The headline case, stated as the night of 2026-09-03 actually looked:
  // four finished tickets waiting on Dane and one genuinely building. The old
  // reading called that 5-of-5 and stopped claiming; there is plenty of room.
  const prs = [1, 2, 3, 4, 5].map((n) => pr(n, `t${n}`));
  const byId = {
    t1: 'Ready to launch', t2: 'Ready to launch', t3: 'Ready to launch',
    t4: 'Needs your input', t5: 'Building',
  };
  const d = wipDecision({ prs, cap: 5, ticketStatusById: byId });
  assert.equal(d.claim, true, 'four tickets parked on Dane must not stop the build loop');
  assert.equal(d.code, 0);
  assert.equal(d.inProgress, 1, 'only the one genuinely building counts against the build cap');
  assert.equal(d.operatorHeld, 4);
  assert.equal(d.inFlight, 5, 'the honest total is unchanged — pulse and throughput still want it');
});

test('the operator ceiling still bounds the pile, and says so DIFFERENTLY', () => {
  // Not counting them at all would leave open PRs unbounded, which is the
  // quadratic catch-up cost the cap exists to control. They are bounded at
  // their own larger number instead.
  const prs = Array.from({ length: 10 }, (_, i) => pr(i + 1, `t${i + 1}`));
  const byId = Object.fromEntries(prs.map((_, i) => [`t${i + 1}`, 'Ready to launch']));
  const d = wipDecision({ prs, cap: 5, operatorCap: 10, ticketStatusById: byId });
  assert.equal(d.claim, false, 'ten waiting on Dane is a full inbox and the loop must stop');
  assert.equal(d.code, 3);
  assert.equal(d.limitHit, 'operator', 'the two limits are told apart, not merged');
  assert.match(d.message, /OPERATOR CEILING reached/);
  assert.match(d.message, /his inbox is full/);
  // Naming the build stages would be a LIE here: the machines are idle and the
  // queue is deep. A reader who cannot tell the two declines apart cannot act.
  assert.doesNotMatch(d.message, /the slots are held by/,
    'pointing at the build stages when Dane is the one who must act sends the reader to the wrong place');
  assert.doesNotMatch(d.message, /bottleneck/);
});

test('the two limits are independent — a full inbox does not borrow build slots', () => {
  // Nine parked on Dane (under the ceiling) plus five genuinely building
  // (at the build cap). The build cap is what declines, and it says so.
  const prs = Array.from({ length: 14 }, (_, i) => pr(i + 1, `t${i + 1}`));
  const byId = {};
  for (let i = 1; i <= 9; i += 1) byId[`t${i}`] = 'Ready to launch';
  for (let i = 10; i <= 14; i += 1) byId[`t${i}`] = 'In review';
  const d = wipDecision({ prs, cap: 5, operatorCap: 10, ticketStatusById: byId });
  assert.equal(d.claim, false);
  assert.equal(d.limitHit, 'wip', 'five in review fills the BUILD cap; the inbox is under its own ceiling');
  assert.equal(d.inProgress, 5);
  assert.equal(d.operatorHeld, 9);
});

test('every message names BOTH counts, whichever way it goes', () => {
  // Splitting one cap into two makes it possible to print a number that is no
  // longer the one being enforced. Both are always stated, including zero —
  // a clause that vanishes at zero tells the reader nothing about whether it
  // was checked (the same rule the stranded phrase already follows).
  const cases = [
    [{ t1: 'Building' }, [pr(1, 't1')]],
    [Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`t${n}`, 'Building'])), [1, 2, 3, 4, 5].map((n) => pr(n, `t${n}`))],
    [Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`t${i + 1}`, 'Ready to launch'])),
      Array.from({ length: 10 }, (_, i) => pr(i + 1, `t${i + 1}`))],
  ];
  for (const [byId, prs] of cases) {
    const { message } = wipDecision({ prs, cap: 5, operatorCap: 10, ticketStatusById: byId });
    assert.match(message, /\d+ building or in review \(cap 5\)/, `missing the build count: ${message}`);
    assert.match(message, /\d+ waiting on Dane \(ceiling 10\)/, `missing the operator count: ${message}`);
  }
});

test('the split is a PARTITION of in-flight, so the three counts cannot disagree', () => {
  // inProgress and operatorHeld are derived by splitting inFlight rather than
  // by an independent test, so one pull request can never be in both or
  // neither. Two functions disagreeing about one string is the failure this
  // file already carries two comments about.
  const prs = [1, 2, 3, 4, 5, 6].map((n) => pr(n, `t${n}`));
  const byId = {
    t1: 'Building', t2: 'In review', t3: 'Ready to launch',
    t4: 'Needs your input', t5: 'Queued', t6: 'Live',
  };
  const g = classifyPrs({ prs, ticketStatusById: byId });
  assert.deepEqual(g.inProgress, [1, 2]);
  assert.deepEqual(g.operatorHeld, [3, 4]);
  assert.deepEqual(g.inFlight, [1, 2, 3, 4]);
  assert.deepEqual(
    [...g.inProgress, ...g.operatorHeld].sort((a, b) => a - b), g.inFlight,
    'the two halves must add up to the whole, exactly',
  );
});

test('with no ticket statuses the split is null, never zero', () => {
  // DOCTRINE 3.2. Reporting "0 waiting on Dane" from a pass that could not
  // read a single status is an all-clear nobody established — and it is the
  // conservative path, where operator-held work IS counted against the build
  // cap, so the numbers would also be wrong.
  // Five open against a cap of five, so this really is the CAPPED branch —
  // asserting the capped wording on an uncapped call passes for the wrong
  // reason and proves nothing.
  const prs = [1, 2, 3, 4, 5].map((n) => pr(n, `t${n}`));
  const d = wipDecision({ prs, cap: 5 });
  assert.equal(d.claim, false, 'the unreadable-queue path must still fail TOWARD the cap');
  assert.equal(d.inProgress, null);
  assert.equal(d.operatorHeld, null);
  assert.match(d.message, /work parked on Dane was counted against the build[\s\S]*cap too/,
    'the fallback must say that it counted them, because normally it does not');

  // And the uncapped half of the same path still reports null rather than 0.
  const room = wipDecision({ prs: [pr(1, 't1')], cap: 5 });
  assert.equal(room.claim, true);
  assert.equal(room.inProgress, null);
  assert.equal(room.operatorHeld, null);
});

test('a malformed operator ceiling is ignored, never obeyed', () => {
  // Same discipline as resolveCap. A typo here would either uncap Dane's
  // queue entirely or stop the loop dead, and neither belongs to a mistyped
  // environment variable.
  const { resolveOperatorCap, DEFAULT_OPERATOR_CAP, OPERATOR_CAP_ENV } = require('./wipCap');
  assert.equal(resolveOperatorCap({}), DEFAULT_OPERATOR_CAP);
  assert.equal(resolveOperatorCap({ [OPERATOR_CAP_ENV]: 'lots' }), DEFAULT_OPERATOR_CAP);
  assert.equal(resolveOperatorCap({ [OPERATOR_CAP_ENV]: '-3' }), DEFAULT_OPERATOR_CAP);
  assert.equal(resolveOperatorCap({ [OPERATOR_CAP_ENV]: '2.5' }), DEFAULT_OPERATOR_CAP);
  assert.equal(resolveOperatorCap({ [OPERATOR_CAP_ENV]: '12' }), 12, 'a valid override IS obeyed');
});

test('the probe passes the operator ceiling through — or the ticket ships dead', (t) => {
  if (skipWithoutDoor(t)) return;
  // The whole change is inert if the one live caller never sends the second
  // limit: wipDecision would fall back to its default and the env override
  // would silently do nothing.
  const code = doorSource() || '';
  const at = code.indexOf('function capProbe(');
  assert.ok(at > -1, 'capProbe must still exist');
  const probe = code.slice(at, at + 2000);
  assert.match(probe, /operatorCap:\s*wipCap\.resolveOperatorCap\(process\.env\)/,
    'capProbe must pass the operator ceiling, or the second limit is never enforced');
});
