// The loop's sleep must follow the queue — and must fail toward SLEEPING
// LONGER on every kind of bad input.
//
// The incident behind the floor: `loop-review` was left on a 2-minute
// interval on 2026-08-24 and ran ~360 passes, almost all of them finding
// nothing. Every assertion below that names 900 is guarding against a repeat
// of that, and every assertion that names 3600 is guarding the direction —
// an unknown queue must never be answered with a short interval.
const test = require('node:test');
const assert = require('node:assert');

const li = require('./loopInterval.js');
const { doorSource, skipWithoutDoor } = require('./productScripts.js');

// ---------------------------------------------------------------------------
// The curve (acceptance criteria 1 and 2)
// ---------------------------------------------------------------------------

test('the curve is depth 0 -> 3600, 1-3 -> 1800, 4+ -> 900', () => {
  assert.equal(li.intervalForDepth(0).seconds, 3600);
  assert.equal(li.intervalForDepth(1).seconds, 1800);
  assert.equal(li.intervalForDepth(2).seconds, 1800);
  assert.equal(li.intervalForDepth(3).seconds, 1800);
  assert.equal(li.intervalForDepth(4).seconds, 900);
  assert.equal(li.intervalForDepth(36).seconds, 900);
});

test('the reason names the depth, so the cadence is never a mystery', () => {
  // The WIP cap shipped with a bare total and nobody could tell why it had
  // declined. This is that lesson applied: the number always travels with
  // its reason.
  assert.match(li.intervalForDepth(12).reason, /900s \(12 claimable/);
});

test('BREAK-TEST THE FLOOR: nothing the curve or a config can say goes below 900s', () => {
  // If someone "just tries" 120 in the runner argument, or edits the state
  // file, or adds a faster rung to the curve, this assertion is what stops
  // 2026-08-24 happening twice.
  assert.equal(li.clampToFloor(120), 900, 'a 120s configured interval must be raised to the floor');
  assert.equal(li.clampToFloor(0), 900);
  assert.equal(li.clampToFloor(-99999), 900);
  assert.equal(li.clampToFloor(899), 900);
  assert.equal(li.clampToFloor(901), 901, 'the floor raises, it does not flatten');
  // BREAK-TEST (review round 1, 2026-08-29): Number(null), Number(''),
  // Number([]) and Number(false) are all 0 — finite — so a "total" clamp that
  // only checks isFinite sends every one of them to 900, the SHORT end. Assert
  // the VALUE, not merely >= floor: the old test passed either way.
  for (const notANumber of [null, undefined, '', '   ', [], {}, false, true, NaN, Infinity, 'soon']) {
    assert.equal(li.clampToFloor(notANumber), 3600,
      `clampToFloor(${JSON.stringify(notANumber) ?? String(notANumber)}) must be the LONG fallback, not the floor`);
  }
  assert.equal(li.clampToFloor(' 1800 '), 1800, 'a numeric string with padding is still a number');
  for (const row of li.CURVE) {
    assert.ok(row.seconds >= li.FLOOR_SECONDS, `curve rung ${row.seconds}s is below the ${li.FLOOR_SECONDS}s floor`);
  }
  // And the whole curve, driven with absurd depths.
  for (const absurd of [NaN, Infinity, -Infinity, -1, null, undefined, 'soon', {}, []]) {
    assert.ok(li.intervalForDepth(absurd).seconds >= li.FLOOR_SECONDS,
      `depth ${String(absurd)} produced an interval under the floor`);
  }
});

test('absurd depth reads as 0 and therefore as the LONGEST interval, not the shortest', () => {
  // Infinity is the interesting one: it reads like "infinitely deep, wake
  // often" and is in fact garbage. Garbage must take the cheap direction.
  assert.equal(li.intervalForDepth(Infinity).seconds, 3600);
  assert.equal(li.intervalForDepth(NaN).seconds, 3600);
  assert.equal(li.intervalForDepth(-5).seconds, 3600);
  assert.match(li.intervalForDepth('soon').reason, /not a number of tickets/);
});

// ---------------------------------------------------------------------------
// The fallback (acceptance criterion 3)
// ---------------------------------------------------------------------------

test('an unreadable queue answers with the CONFIGURED fallback and says why', () => {
  const d = li.fallbackInterval({ fallbackSeconds: 3600, why: 'ClickUp returned HTTP 502' });
  assert.equal(d.seconds, 3600);
  assert.match(d.reason, /could not be read/);
  assert.match(d.reason, /HTTP 502/);
});

test('BREAK-TEST THE FALLBACK DIRECTION: an unreadable queue must not answer with the floor', () => {
  // This is the assertion that fails if someone "simplifies" the fallback to
  // FLOOR_SECONDS. A short interval on unknown state is exactly how quota
  // gets burned invisibly — the failure mode is silent, so the test is the
  // only thing watching.
  const d = li.fallbackInterval({ fallbackSeconds: 3600, why: 'network down' });
  assert.notEqual(d.seconds, li.FLOOR_SECONDS,
    'the fallback must be the configured interval (3600), never the 900s floor');
  assert.equal(d.seconds, li.DEFAULT_FALLBACK_SECONDS);
  // ...and it must not sneak below the floor either, if a human configured
  // something silly.
  const silly = li.fallbackInterval({ fallbackSeconds: 120, why: 'network down' });
  assert.equal(silly.seconds, 900);
  assert.match(silly.reason, /raised to the 900s floor/);
  assert.doesNotMatch(silly.reason, /NOT the floor/, "saying \"not the floor\" while reporting a raise TO the floor is a contradiction");
});

test('a failed read is not a reading: it leaves the hysteresis state untouched', () => {
  // Otherwise two consecutive outages would count as "two consecutive
  // readings" and could shorten the interval on no evidence at all.
  assert.equal(li.fallbackInterval({ fallbackSeconds: 3600, why: 'x' }).state, null);
});

// ---------------------------------------------------------------------------
// Hysteresis (acceptance criterion 4)
// ---------------------------------------------------------------------------

// The asymmetry INVERTED on 2026-09-05 (task 86bbvh285): shortening is now
// immediate and lengthening is what waits for two consecutive readings. The
// tests below are written in pairs on purpose — every one that proves the new
// rule fires has a partner proving the guard it replaced still holds in the
// other direction. A version that simply adopted every proposal at once would
// pass half of them and reintroduce the thrash the original rule existed for.

test('SHORTENING IS IMMEDIATE — one deep reading drops the cadence', () => {
  // Four tickets are visibly claimable and the loop is asleep for an hour.
  // Waking sooner than a wrong reading deserved costs one pass; refusing to
  // wake costs an hour of a pipeline that cannot claim past the WIP cap.
  const first = li.decideInterval({ depth: 12, state: null, fallbackSeconds: 3600 });
  assert.equal(first.seconds, 900, 'a deep reading did not shorten the interval');
  assert.equal(first.held, false);
  assert.match(first.reason, /shortening on the first reading that asks for it/);
  assert.equal(first.state.interval, 900);
  assert.equal(first.state.lastProposed, 900);
});

test('BREAK-TEST: ONE quiet reading does NOT lengthen the interval', () => {
  // The partner of the test above, and the anti-thrash property the original
  // hysteresis was written for — moved to the direction where being wrong is
  // expensive. A queue that empties for one pass and refills must not cost an
  // hour of sleep.
  const fast = { interval: 900, lastProposed: 900 };
  const quiet = li.decideInterval({ depth: 0, state: fast, fallbackSeconds: 3600 });
  assert.equal(quiet.seconds, 900, 'one quiet reading lengthened the cadence — the guard is gone');
  assert.equal(quiet.held, true);
  assert.match(quiet.reason, /one quiet reading does not \(two consecutive do\)/);
  // It must REMEMBER the reading, or the second one can never fire.
  assert.equal(quiet.state.interval, 900);
  assert.equal(quiet.state.lastProposed, 3600);
});

test('TWO consecutive quiet readings do lengthen it', () => {
  const fast = { interval: 900, lastProposed: 900 };
  const first = li.decideInterval({ depth: 0, state: fast, fallbackSeconds: 3600 });
  const second = li.decideInterval({ depth: 0, state: first.state, fallbackSeconds: 3600 });
  assert.equal(second.seconds, 3600);
  assert.equal(second.held, false);
  assert.match(second.reason, /second consecutive quiet reading/);
});

test('lengthening adopts the LATEST reading, not the quieter older one', () => {
  // Empty, then two claimable: both want longer than 900, so the cadence
  // moves — but to 1800, the fresher truth, not all the way to the hour.
  const fast = { interval: 900, lastProposed: 900 };
  const first = li.decideInterval({ depth: 0, state: fast, fallbackSeconds: 3600 });
  const second = li.decideInterval({ depth: 2, state: first.state, fallbackSeconds: 3600 });
  assert.equal(second.seconds, 1800);
  assert.equal(second.held, false);
});

test('THE OSCILLATING QUEUE CONVERGES DOWNWARD (acceptance criterion 3)', () => {
  // The stored state named on the ticket: {"interval":3600,"lastProposed":1800}
  // with the next proposal at 900. Each review pass removes a ticket from the
  // claimable set, so the reading drifts between rows of the curve and the
  // proposals alternate.
  //
  // WHY THE OLD RULE COULD NOT COPE, precisely — it is not the "two identical
  // readings" the ticket describes, and the difference matters to anyone
  // editing this. The old comparison was directional too, but against the
  // interval IN FORCE, which a held pass does not move; an intervening reading
  // that is not shorter than that interval is adopted and overwrites
  // `lastProposed` with itself, discarding the short reading entirely. See the
  // measured ratchet in the test below, which is the same defect caught on
  // real log lines.
  //
  // Depths chosen to land on the alternating rows: 2 -> 1800, 12 -> 900.
  let state = { interval: 3600, lastProposed: 1800 };
  const seen = [];
  for (const depth of [12, 2, 12, 2, 12]) {
    const d = li.decideInterval({ depth, state, fallbackSeconds: 3600 });
    seen.push(d.seconds);
    state = d.state;
  }
  // 900 at once; then 1800 wants LONGER, so it holds at 900; then 900 again;
  // and so on. It never returns to the hour, which is the whole point.
  assert.deepEqual(seen, [900, 900, 900, 900, 900]);
  assert.ok(
    seen.every((s) => s <= 1800),
    'the oscillating queue climbed back toward the hour — this is the 2026-09-05 stall',
  );
});

test('THE MEASURED RATCHET: a 4-deep reading must not be discarded', () => {
  // Real log lines, ~/loop-logs/loop-review.log on the Mini, 2026-09-05:
  //
  //   00:26  4 claimable -> 900s proposed, HELD at 1800s
  //   01:05  3 claimable -> 1800s adopted, and the 900 reading thrown away
  //   01:44  2 claimable -> 1800s.   02:24  1 claimable -> 1800s.
  //
  // The queue reached the curve's deepest row and the cadence never went
  // there. Under the new rule the 4-deep reading is acted on at 00:26, which
  // is the only pass that could have used it.
  let state = { interval: 1800, lastProposed: 1800 };
  const seen = [];
  for (const depth of [4, 3, 2, 1]) {
    const d = li.decideInterval({ depth, state, fallbackSeconds: 3600 });
    seen.push(d.seconds);
    state = d.state;
  }
  assert.equal(seen[0], 900, 'the 4-deep reading was held and then discarded — this is the 2026-09-05 ratchet');
  // The queue then genuinely thins out, so lengthening back is correct — but
  // it still takes two consecutive readings to do it.
  assert.deepEqual(seen, [900, 900, 1800, 1800]);
});

test('BREAK-TEST: an oscillation cannot lengthen by accident either', () => {
  // The mirror of the case above. Alternating proposals must not RAISE the
  // cadence one rung at a time while work keeps arriving: 1800 wants longer
  // than 900 and is never seconded, because the 900 reading between them
  // resets the direction.
  let state = { interval: 900, lastProposed: 900 };
  for (const depth of [2, 12, 2, 12, 2, 12]) {
    state = li.decideInterval({ depth, state, fallbackSeconds: 3600 }).state;
  }
  assert.equal(state.interval, 900, 'an alternating queue crept the cadence upward');
});

test('a steady deep queue is stable — the interval does not oscillate', () => {
  let state = null;
  const seen = [];
  for (let i = 0; i < 5; i += 1) {
    const d = li.decideInterval({ depth: 12, state, fallbackSeconds: 3600 });
    seen.push(d.seconds);
    state = d.state;
  }
  assert.deepEqual(seen, [900, 900, 900, 900, 900]);
});

test('a steady EMPTY queue settles at the hour and stays there', () => {
  let state = { interval: 900, lastProposed: 900 };
  const seen = [];
  for (let i = 0; i < 5; i += 1) {
    const d = li.decideInterval({ depth: 0, state, fallbackSeconds: 3600 });
    seen.push(d.seconds);
    state = d.state;
  }
  // One held pass, then the hour, and no drift afterwards.
  assert.deepEqual(seen, [900, 3600, 3600, 3600, 3600]);
});

test('a corrupt or hand-edited state file cannot push the interval below the floor', () => {
  const d = li.decideInterval({ depth: 12, state: { interval: 60, lastProposed: 60 }, fallbackSeconds: 3600 });
  assert.ok(d.seconds >= li.FLOOR_SECONDS, 'a doctored state file got under the floor');
});

test('BREAK-TEST: a state file reading {"interval": null} still reads as the HOUR, not the floor', () => {
  // Review round 1 (2026-08-29) found that `null` clamped to 900, so the
  // cadence in force read as the floor. Under the inverted rule that is no
  // longer a way to sneak a shortening through — shortening is allowed now —
  // but it is still wrong, and now it is wrong in the OTHER direction: a
  // cadence that reads as 900 makes every quiet reading a lengthening, which
  // is the direction that waits. A junk state must read as the fallback hour.
  for (const junk of [{ interval: null }, { interval: '' }, { interval: [] }, { interval: false }]) {
    const d = li.decideInterval({ depth: 0, state: junk, fallbackSeconds: 3600 });
    assert.equal(d.seconds, 3600, `state ${JSON.stringify(junk)} did not read as the configured hour`);
    assert.equal(d.held, false, 'a junk state made a depth-0 reading look like a lengthening');
  }
});

test('with no state, the cadence in force is the runner argument, not the proposal', () => {
  // The first pass must follow the SAME rule as every later pass rather than
  // being a special case. With a deep queue that now means it shortens at
  // once — but only DOWN to the curve's answer, and the runner's configured
  // interval is what it is measured against.
  const deep = li.decideInterval({ depth: 99, state: null, fallbackSeconds: 1800 });
  assert.equal(deep.seconds, 900);
  // And with nothing to do, the configured 1800 is what holds: the proposal
  // (3600) is LONGER, which needs a second reading. If "no state" were read as
  // "no cadence in force", this would jump straight to the hour.
  const empty = li.decideInterval({ depth: 0, state: null, fallbackSeconds: 1800 });
  assert.equal(empty.seconds, 1800);
  assert.equal(empty.held, true);
});

// ---------------------------------------------------------------------------
// "Claimable", not "queued" (acceptance criterion 5)
// ---------------------------------------------------------------------------

// A fixture standing in for the Loop Queue. `resolveRepo` is injected, so no
// test here touches the filesystem or asks which repos this machine has.
const fakeRepo = (tags) => {
  const names = (tags || []).map((t) => String(t.name || t));
  const repo = names.find((n) => n.startsWith('repo:'));
  if (!repo) return { repo: 'starcaster', action: 'build', reason: 'no repo: tag' };
  const name = repo.slice('repo:'.length);
  if (name === 'starcaster') return { repo: name, action: 'build', reason: 'declared' };
  return { repo: name, action: 'escalate', reason: `repo:${name} is not checked out on this machine` };
};

const QUEUE = [
  { id: 'a1', status: { status: 'Queued', type: 'custom' }, tags: [] },
  { id: 'a2', status: { status: 'queued', type: 'custom' }, tags: [{ name: 'repo:starcaster' }] },
  // Wrong repo — real work, but not work THIS loop could claim.
  { id: 'a3', status: { status: 'Queued', type: 'custom' }, tags: [{ name: 'repo:normie' }] },
  // Blocked: waiting on a1, which is still open.
  { id: 'a4', status: { status: 'Queued', type: 'custom' }, tags: [], dependencies: [{ task_id: 'a4', depends_on: 'a1' }] },
  // Blocked by something outside this list — unknowable, so treated as blocking.
  { id: 'a5', status: { status: 'Queued', type: 'custom' }, tags: [], dependencies: [{ task_id: 'a5', depends_on: 'zz' }] },
  // Waiting on a DONE task. NOTE d1 is deliberately NOT in this array: the
  // list endpoint returns open tasks only, so a finished blocker is never in
  // it (review round 1, 2026-08-29). It arrives via `blockers` instead — see
  // RESOLVED below — which is the only shape production can produce.
  { id: 'a6', status: { status: 'Queued', type: 'custom' }, tags: [], dependencies: [{ task_id: 'a6', depends_on: 'd1' }] },
  // The mirror edge: a7 BLOCKS a1. That must not make a7 look blocked.
  { id: 'a7', status: { status: 'Queued', type: 'custom' }, tags: [], dependencies: [{ task_id: 'a1', depends_on: 'a7' }] },
  // Other statuses are not this loop's work.
  { id: 'b1', status: { status: 'Building', type: 'custom' }, tags: [] },
  { id: 'b2', status: { status: 'In review', type: 'custom' }, tags: [] },
];

// What the CLI reads back for the ids `outsideBlockerIds` names. `zz` is
// missing on purpose: an unresolvable blocker must stay blocking.
const RESOLVED = [
  { id: 'd1', status: { status: 'Live', type: 'closed' }, tags: [] },
];

test('"claimable" counts only what loop-build could actually take', () => {
  const r = li.claimableDepth({ loop: 'loop-build', tasks: QUEUE, capReached: false, resolveRepo: fakeRepo, blockers: RESOLVED });
  assert.deepEqual(r.claimable.map((t) => t.id).sort(), ['a1', 'a2', 'a6', 'a7']);
  assert.equal(r.depth, 4);
});

test('the wrong-repo and blocked exclusions are REPORTED, not silently dropped', () => {
  // A sweep that cannot say what it skipped gives a false all-clear
  // (DOCTRINE 3.11). Here the cost of silence is a cadence nobody can explain.
  const r = li.claimableDepth({ loop: 'loop-build', tasks: QUEUE, capReached: false, resolveRepo: fakeRepo, blockers: RESOLVED });
  const byId = Object.fromEntries(r.excluded.map((x) => [x.id, x.why]));
  assert.match(byId.a3, /repo escalates/);
  assert.match(byId.a4, /waiting on a1/);
  assert.match(byId.a5, /not in this list/);
  // ...and tickets that were never candidates are not reported as exclusions.
  assert.ok(!('b1' in byId));
});

test('BREAK-TEST: a FINISHED blocker that is absent from the list must not block forever', () => {
  // The production shape: a6 waits on d1, d1 shipped, so d1 is not in the
  // list read. Without resolving it, a6 reads as blocked on every cycle.
  const without = li.claimableDepth({ loop: 'loop-build', tasks: QUEUE, resolveRepo: fakeRepo });
  assert.ok(without.excluded.some((x) => x.id === 'a6' && /not in this list/.test(x.why)),
    'unresolved, a6 must be reported as blocked (safe direction)');
  const withIt = li.claimableDepth({ loop: 'loop-build', tasks: QUEUE, resolveRepo: fakeRepo, blockers: RESOLVED });
  assert.ok(withIt.claimable.some((t) => t.id === 'a6'), 'resolved as closed, a6 is claimable');
  assert.equal(withIt.depth, without.depth + 1);
  // ...and the resolved blocker is consulted for status ONLY — never counted.
  const openBlocker = [{ id: 'd1', status: { status: 'Queued', type: 'custom' }, tags: [] }];
  const stillOpen = li.claimableDepth({ loop: 'loop-build', tasks: QUEUE, resolveRepo: fakeRepo, blockers: openBlocker });
  assert.ok(!stillOpen.claimable.some((t) => t.id === 'a6'), 'an OPEN blocker read from outside still blocks');
  assert.ok(!stillOpen.claimable.some((t) => t.id === 'd1'), 'a blocker read from outside is never itself claimable');
});

test('outsideBlockerIds names exactly the blockers the list cannot show', () => {
  assert.deepEqual(li.outsideBlockerIds(QUEUE).sort(), ['d1', 'zz']);
  // Mirror edges (a7 blocks a1) and in-list blockers (a1) are not "outside".
  assert.ok(!li.outsideBlockerIds(QUEUE).includes('a1'));
  assert.deepEqual(li.outsideBlockerIds([null, 7, {}]), []);
});

test('BREAK-TEST: a queue of ONLY wrong-repo tickets is depth 0, not depth 3', () => {
  // The whole point of "claimable, not queued". If this ever regresses, the
  // loop wakes every 15 minutes forever for work it can never take.
  const foreign = [
    { id: 'n1', status: { status: 'Queued' }, tags: [{ name: 'repo:normie' }] },
    { id: 'n2', status: { status: 'Queued' }, tags: [{ name: 'repo:pulse' }] },
    { id: 'n3', status: { status: 'Queued' }, tags: [{ name: 'repo:vault' }] },
  ];
  const r = li.claimableDepth({ loop: 'loop-build', tasks: foreign, capReached: false, resolveRepo: fakeRepo });
  assert.equal(r.depth, 0);
  assert.equal(li.intervalForDepth(r.depth).seconds, 3600);
});

test('BREAK-TEST: a full WIP cap makes the queue depth 0 however deep it is', () => {
  const r = li.claimableDepth({ loop: 'loop-build', tasks: QUEUE, capReached: true, resolveRepo: fakeRepo });
  assert.equal(r.depth, 0, 'a capped loop claims nothing, so a deep queue is not a reason to wake sooner');
  assert.match(r.note, /work-in-progress cap is full/);
  assert.equal(li.intervalForDepth(r.depth).seconds, 3600);
});

test('the WIP cap does NOT throttle loop-review — that would deadlock the pipeline', () => {
  // The cap is waiting on exactly the PRs review drains. Pausing review
  // because the cap is full would make the cap permanent.
  const r = li.claimableDepth({ loop: 'loop-review', tasks: QUEUE, capReached: true, resolveRepo: fakeRepo });
  assert.equal(r.depth, 1);
  assert.deepEqual(r.claimable.map((t) => t.id), ['b2']);
});

test('loop-review is paced on "In review" depth, loop-build on "Queued"', () => {
  const build = li.claimableDepth({ loop: 'loop-build', tasks: QUEUE, resolveRepo: fakeRepo, blockers: RESOLVED });
  const review = li.claimableDepth({ loop: 'loop-review', tasks: QUEUE, resolveRepo: fakeRepo, blockers: RESOLVED });
  assert.equal(build.depth, 4);
  assert.equal(review.depth, 1);
});

test('an unknown loop name throws rather than guessing a status', () => {
  assert.throws(
    () => li.claimableDepth({ loop: 'loop-deploy', tasks: QUEUE }),
    /unknown loop "loop-deploy"/,
  );
});

test('a list of junk does not crash and reads as empty', () => {
  const r = li.claimableDepth({ loop: 'loop-build', tasks: [null, 7, 'x', {}], resolveRepo: fakeRepo });
  assert.equal(r.depth, 0);
});

// ---------------------------------------------------------------------------
// The runner must survive the command failing (acceptance criterion 6)
// ---------------------------------------------------------------------------

test('every answer this module gives is a plain positive integer of seconds', () => {
  // The runner validates with ^[0-9]+$ and falls back if it does not match.
  // This checks the producing end: no floats, no strings, no NaN.
  const answers = [
    li.intervalForDepth(0), li.intervalForDepth(7), li.intervalForDepth('x'),
    li.decideInterval({ depth: 4, state: null, fallbackSeconds: 3600 }),
    li.fallbackInterval({ fallbackSeconds: 3600, why: 'x' }),
  ];
  for (const a of answers) {
    assert.ok(Number.isInteger(a.seconds) && a.seconds > 0, `not a positive integer: ${a.seconds}`);
    assert.match(String(a.seconds), /^[0-9]+$/);
    assert.ok(String(a.reason).length > 0, 'an answer with no reason');
  }
});

// ---------------------------------------------------------------------------
// Rework counts toward loop-build's depth (task 86bbr1u9v, criterion 4)
// ---------------------------------------------------------------------------

test('loop-build drains two statuses, loop-review one', () => {
  assert.deepEqual([...li.LOOP_STATUS['loop-build']], ['rework', 'queued']);
  assert.deepEqual([...li.LOOP_STATUS['loop-review']], ['in review']);
});

test('a queue full of rework does not read as empty', () => {
  // The failure this guards is quiet and self-reinforcing: with the depth
  // reading 0 the curve sleeps the maximum hour, so the tickets the Rework
  // status exists to rescue would be the ones the pacing curve stopped waking
  // up for. `intervalForDepth` is asserted alongside, because "the depth is
  // right" and "the sleep is right" are two claims.
  const reworkOnly = [
    { id: 'r1', status: { status: 'Rework', type: 'custom' }, tags: [] },
    { id: 'r2', status: { status: 'rework', type: 'custom' }, tags: [] },
    { id: 'r3', status: { status: 'Rework', type: 'custom' }, tags: [] },
    { id: 'r4', status: { status: 'Rework', type: 'custom' }, tags: [] },
  ];
  const r = li.claimableDepth({ loop: 'loop-build', tasks: reworkOnly, resolveRepo: fakeRepo });
  assert.equal(r.depth, 4, 'four rework tickets are four claimable tickets');
  assert.equal(li.intervalForDepth(r.depth).seconds, 900, 'and the curve must treat that as a deep queue');

  // The control: the same four under the OLD single-status rule read as zero.
  const asQueuedOnly = reworkOnly.filter((t) => t.status.status.toLowerCase() === 'queued');
  assert.equal(asQueuedOnly.length, 0, 'none of them is Queued — this is the reading that used to be taken');
  assert.equal(li.intervalForDepth(0).seconds, 3600, 'which sleeps the maximum hour');
});

test('rework and queued are counted together, and the list comes back in claim order', () => {
  const mixed = [
    { id: 'q-urgent', status: { status: 'Queued', type: 'custom' }, tags: [], priority: { priority: 'urgent' }, date_created: '9000' },
    { id: 'r-old', status: { status: 'Rework', type: 'custom' }, tags: [], priority: { priority: 'normal' }, date_created: '1000' },
  ];
  const r = li.claimableDepth({ loop: 'loop-build', tasks: mixed, resolveRepo: fakeRepo });
  assert.equal(r.depth, 2);
  assert.equal(r.claimable[0].id, 'r-old',
    'the depth reading and the queue listing must name the same next ticket');
});

test('a rework ticket in the wrong repo is excluded and SAID, exactly like a queued one', () => {
  const foreign = [
    { id: 'r1', status: { status: 'Rework', type: 'custom' }, tags: [{ name: 'repo:nope' }] },
  ];
  const r = li.claimableDepth({ loop: 'loop-build', tasks: foreign, resolveRepo: fakeRepo });
  assert.equal(r.depth, 0);
  assert.equal(r.excluded.length, 1, 'a rework ticket must be reportable, not silently dropped');
  assert.equal(r.excluded[0].id, 'r1');
});

test('loop-review is not woken by rework', () => {
  const reworkOnly = [{ id: 'r1', status: { status: 'Rework', type: 'custom' }, tags: [] }];
  assert.equal(li.claimableDepth({ loop: 'loop-review', tasks: reworkOnly, resolveRepo: fakeRepo }).depth, 0);
});

test('wantedStatuses still accepts a bare string, so one status never means none', () => {
  // The failure mode of getting this wrong is a depth of 0, which sleeps the
  // maximum hour and is indistinguishable from an empty queue.
  assert.deepEqual(li.wantedStatuses('Queued'), ['queued']);
  assert.deepEqual(li.wantedStatuses(['Rework', ' QUEUED ']), ['rework', 'queued']);
  assert.deepEqual(li.wantedStatuses([null, '', 'x']), ['x']);
});

// ---------------------------------------------------------------------------
// A blocked queue is not an idle queue (2026-09-02, task 86bbtmbvn).
//
// The NUMBER is deliberately unchanged — backing off on a blocked queue is
// correct, and the module header says why. What was wrong is the SENTENCE:
// at depth 0 the curve's reason is "nothing to do", which is false whenever
// the zero came from a blockage rather than an empty queue. On the morning of
// 2026-09-02 it printed under 48 queued tickets, two lines below
// `claimableDepth`'s own accurate note, and it is the line that got read —
// it is last, and it is the one prefixed `interval:`.
// ---------------------------------------------------------------------------

test('a capped queue does not report "nothing to do"', () => {
  const r = li.claimableDepth({ loop: 'loop-build', tasks: QUEUE, capReached: true, resolveRepo: fakeRepo });
  const d = li.intervalForDepth(r.depth, { blockedNote: r.note });
  assert.equal(d.seconds, 3600, 'the number is unchanged — this ticket does not touch the curve');
  assert.match(d.reason, /work-in-progress cap is full/);
  assert.ok(!/nothing to do/.test(d.reason), 'it must not claim the queue is empty while tickets wait');
});

test('a queue that is entirely blocked says what blocked it', () => {
  // Every ticket the right status, none claimable — a foreign repo here.
  const foreign = [
    { id: 'n1', status: { status: 'Queued' }, tags: [{ name: 'repo:normie' }] },
    { id: 'n2', status: { status: 'Queued' }, tags: [{ name: 'repo:pulse' }] },
    { id: 'n3', status: { status: 'Queued' }, tags: [{ name: 'repo:normie' }] },
  ];
  const r = li.claimableDepth({ loop: 'loop-build', tasks: foreign, capReached: false, resolveRepo: fakeRepo });
  assert.equal(r.depth, 0);
  assert.ok(r.note, 'a zero with tickets behind it must explain itself');
  assert.match(r.note, /3 ticket\(s\) are the right status but none can be claimed/);
  const d = li.intervalForDepth(r.depth, { blockedNote: r.note });
  assert.equal(d.seconds, 3600, 'still backs off — only the sentence changes');
  assert.ok(!/nothing to do/.test(d.reason));
});

test('a genuinely empty queue still says "nothing to do"', () => {
  // The one case where the old sentence was true. It must survive intact, or
  // this change has traded one false statement for another.
  const r = li.claimableDepth({ loop: 'loop-build', tasks: [], capReached: false, resolveRepo: fakeRepo });
  assert.equal(r.depth, 0);
  assert.equal(r.note, null, 'nothing was blocked, so there is nothing to explain');
  const d = li.intervalForDepth(r.depth, { blockedNote: r.note });
  assert.match(d.reason, /nothing to do; do not pay to find that out often/);
});

test('a queue with claimable work never carries a blocked note', () => {
  // The excluded tickets are ordinary background when work IS available, and
  // the caller already prints them one per line.
  const r = li.claimableDepth({ loop: 'loop-build', tasks: QUEUE, capReached: false, resolveRepo: fakeRepo });
  assert.ok(r.depth > 0);
  assert.equal(r.note, null);
});

test('the blocked reasons are grouped and counted, dominant cause first', () => {
  const note = li.blockedSummary([
    { id: '1', why: 'blocked on a dependency' },
    { id: '2', why: 'for another repo' },
    { id: '3', why: 'for another repo' },
    { id: '4', why: 'for another repo' },
  ]);
  assert.match(note, /^4 ticket\(s\)/);
  assert.match(note, /3 for another repo; 1 blocked on a dependency/,
    'the dominant cause leads, so a reader sees the shape of the blockage first');
  assert.equal(li.blockedSummary([]), null);
  assert.equal(li.blockedSummary(null), null);
});

test('the honest reason survives hysteresis, in both of its sentences', () => {
  // decideInterval wraps the proposal's reason into two other strings. If the
  // note only reached the bare proposal, the line the log actually prints on a
  // held or shortening cycle would still say "nothing to do".
  const note = 'the work-in-progress cap is full, so nothing is claimable this pass however deep the queue is';
  const held = li.decideInterval({ depth: 0, state: { interval: 900, lastProposed: 900 }, fallbackSeconds: 3600, blockedNote: note });
  assert.match(held.reason, /work-in-progress cap is full/);
  assert.ok(!/nothing to do/.test(held.reason));
  // And the sentence on the pass that ACTS. A blocked note only ever arrives
  // at depth 0, which proposes the longest interval, so the two wrappers it
  // can reach are the held one above and the second-consecutive lengthening.
  const acted = li.decideInterval({ depth: 0, state: held.state, fallbackSeconds: 3600, blockedNote: note });
  assert.equal(acted.seconds, 3600);
  assert.match(acted.reason, /work-in-progress cap is full/);
  assert.ok(!/nothing to do/.test(acted.reason));
});

test('a blocked note is ignored when there IS claimable work', () => {
  // Defensive: the note only ever applies at depth 0. A caller that passed a
  // stale note must not be able to mislabel a healthy reading.
  const d = li.intervalForDepth(7, { blockedNote: 'the cap is full' });
  assert.match(d.reason, /7 claimable — deep enough/);
  assert.ok(!/cap is full/.test(d.reason));
});

test('the caller feeds the note INTO the decision, not merely alongside it', (t) => {
  if (skipWithoutDoor(t)) return;
  // The whole defect was a true line printed two lines above a false summary.
  const fs = require('node:fs');
  const path = require('node:path');
  const code = doorSource() || '';
  assert.match(code, /decideInterval\(\{ depth, state, fallbackSeconds, blockedNote: note \}\)/,
    'the note must reach the interval reason, or the fix is inert in the thing that runs');
});
