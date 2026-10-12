'use strict';

/**
 * How long should a loop sleep before its next pass?
 *
 * WHY THIS EXISTS (2026-08-25, task 86bbmg2fb). The build loop works about 14
 * minutes and then slept a flat 60 — a 23% duty cycle. Nothing was recovering
 * or waiting during that gap; the hour was a QUOTA THROTTLE, chosen as a
 * conservative default when the loops first ran unattended and never
 * revisited.
 *
 * The trade inverts on exactly one thing, the depth of the queue:
 *
 *   - Queue deep: a short interval is nearly free PER UNIT OF WORK. The
 *     session overhead is noise against a 14-minute build, and you pay for
 *     builds you wanted anyway, minus the idling.
 *   - Queue empty: a short interval is pure waste — a whole Claude session
 *     every few minutes to discover there is nothing to do.
 *
 * That is not hypothetical. `loop-review` was left at a TWO-MINUTE interval on
 * 2026-08-24 and ran about 360 passes, almost all of them finding nothing. A
 * fixed number is right at the moment it is chosen and wrong an hour later.
 *
 * So the runner asks for its next sleep each cycle instead of being told once
 * at startup, and the whole decision lives here — pure, injected, and tested —
 * rather than in `~/bin/loop-runner.sh`, which exists on one machine and is in
 * no repository. (Bringing that wrapper under version control is NODES Slice
 * B, task 86bbh9kh2, not this module's job.)
 *
 * Two biases are deliberate and run through every function below:
 *
 *   1. WHEN IN DOUBT, SLEEP LONGER. Every unreadable, absurd or ambiguous
 *      input resolves toward a longer interval, never a shorter one. Guessing
 *      long costs response time, which is visible. Guessing short costs quota,
 *      which is invisible until the month's bill.
 *
 *      DOUBT IS NOT THE SAME AS A READING (2026-09-05, task 86bbvh285). This
 *      bias governs inputs that could not be understood — an unreadable state
 *      file, a depth of `Infinity`, a queue that would not answer. It does NOT
 *      govern a clean reading of a deep queue, and `decideInterval` no longer
 *      treats one as if it did: see the asymmetry documented there.
 *   2. NOTHING IS SILENT. Every answer carries a reason the log can print, so
 *      the cadence is never a mystery the way the WIP cap's bare total was.
 */

const loopStatuses = require('./loopStatuses.js');

/**
 * The floor, in seconds. NOT to be lowered without recording the decision on
 * task 86bbmg2fb and in docs/LOOP_ENGINEERING.md.
 *
 * This is not a round number picked for tidiness. It is the scar from the
 * 2026-08-24 incident above: at a 2-minute interval the review loop burned a
 * night of quota discovering an empty queue. 900s is the shortest cadence at
 * which the session overhead is still small against the ~14 minutes of real
 * work a pass does — below it, the loop spends more on starting than on
 * building. A number with no derivation gets tuned by whoever is annoyed that
 * day, so the derivation lives here, next to the number.
 */
const FLOOR_SECONDS = 900;

/**
 * What to sleep when the queue could not be read at all. The OLD default — an
 * hour — and specifically NOT the floor: a short interval on unknown state is
 * exactly how quota gets burned invisibly.
 */
const DEFAULT_FALLBACK_SECONDS = 3600;

/**
 * The starting curve, to be tuned with real data rather than defended as
 * correct. Ordered deepest-first; the first row whose `minDepth` is met wins.
 */
const CURVE = [
  { minDepth: 4, seconds: 900, why: 'deep enough that idling is the dominant cost' },
  { minDepth: 1, seconds: 1800, why: 'shallow, and the work will be gone soon anyway' },
  { minDepth: 0, seconds: 3600, why: 'nothing to do; do not pay to find that out often' },
];

/**
 * Which ClickUp statuses each loop drains. `loop-build` is paced by how much
 * work is waiting to be BUILT; `loop-review` by how much is waiting to be
 * CHECKED. Pacing review on build depth would wake it for work it cannot
 * touch.
 *
 * A LIST, NOT A STRING, since 2026-08-31 (task 86bbr1u9v). `loop-build` drains
 * two statuses now — `Rework` before `Queued` — and a queue full of rework
 * must not read as empty. That is not a cosmetic worry: with the depth reading
 * 0 the curve sleeps the maximum hour, so the tickets the new status exists to
 * rescue would be the ones the pacing curve stopped waking up for.
 */
const LOOP_STATUS = {
  'loop-build': loopStatuses.CLAIMABLE_BY_BUILD,
  'loop-review': ['in review'],
};

/** The loops this module knows how to pace, for error messages. */
const KNOWN_LOOPS = Object.keys(LOOP_STATUS);

/**
 * Raise anything to the floor, and turn anything unusable into the fallback.
 *
 * Deliberately total: it is called on the curve's own output, on the state
 * file (which a human may have edited), and on the runner's `$INTERVAL`
 * argument (which a human definitely typed). "Never below the floor, whatever
 * the input" has to mean whatever the input.
 */
function clampToFloor(seconds, { fallback = DEFAULT_FALLBACK_SECONDS } = {}) {
  const long = Math.max(FLOOR_SECONDS, Math.trunc(Number(fallback)) || DEFAULT_FALLBACK_SECONDS);
  // `Number(null)`, `Number('')`, `Number([])` and `Number(false)` are all 0 —
  // finite, and therefore "raise 0 to the floor", the SHORT end. Review round
  // 1 (2026-08-29) found exactly that: a state file reading
  // `{"interval": null}` made the cadence in force 900s, every proposal was
  // then >= it, and ONE deep reading dropped the interval with no hysteresis
  // at all. So the test is "is this actually a number", not "does Number()
  // manage to make one" — anything that is not a number or a non-blank
  // numeric string resolves to the long fallback (bias 1).
  const usable = typeof seconds === 'number'
    || (typeof seconds === 'string' && seconds.trim() !== '');
  if (!usable) return long;
  const n = Number(seconds);
  // NaN, Infinity, 'soon' — none of these is a number of seconds either.
  if (!Number.isFinite(n)) return long;
  return Math.max(FLOOR_SECONDS, Math.trunc(n));
}

/**
 * Normalise a claimable-depth reading.
 *
 * Absurd input resolves to 0, which the curve maps to the LONGEST interval.
 * That includes `Infinity`, which reads like "infinitely deep, wake often" but
 * is not a depth at all — it is garbage, and garbage takes the safe direction
 * (bias 1).
 */
function normalizeDepth(depth) {
  const n = Number(depth);
  if (!Number.isFinite(n) || n < 0) return { depth: 0, absurd: true };
  return { depth: Math.floor(n), absurd: false };
}

/**
 * The curve itself: claimable depth in, seconds and a reason out.
 * Pure, and the only place the table above is consulted.
 */
function intervalForDepth(depth, { blockedNote = '' } = {}) {
  const { depth: d, absurd } = normalizeDepth(depth);
  const row = CURVE.find((r) => d >= r.minDepth) || CURVE[CURVE.length - 1];
  const seconds = clampToFloor(row.seconds);

  // "NOTHING TO DO" IS A CLAIM ABOUT THE QUEUE, AND AT DEPTH 0 IT IS OFTEN
  // FALSE (2026-09-02, task 86bbtmbvn).
  //
  // The curve's `why` for depth 0 is "nothing to do; do not pay to find that
  // out often". That is right when the queue is empty and wrong every other
  // way of reaching zero — a full work-in-progress cap, a queue of foreign-repo
  // tickets, a queue blocked on dependencies. On the morning of 2026-09-02 it
  // printed under 48 queued tickets, two lines below `claimableDepth`'s own
  // accurate note, and it was the line that got read: it is last, and it is
  // the one prefixed `interval:`.
  //
  // That is the contradicting-pair shape this codebase has written down twice
  // already (see `sweptSummary` in pipelinePause.js, whose comment describes a
  // summary printing an all-clear one line under "it is still stranded" and
  // calls the summary "again the false half"). Same defect, different file.
  //
  // THE NUMBER DOES NOT CHANGE. Backing off on a blocked queue is deliberate
  // and correct — a capped `loop-build` is bounded by the merge rate, not by
  // how often it wakes, and `loop-review` (which drains the very PRs the cap
  // waits on) is never throttled by it. Only the sentence changes, and only
  // where it would otherwise be false.
  const why = d === 0 && blockedNote ? blockedNote : row.why;

  const reason = absurd
    ? `${seconds}s — depth reading "${String(depth)}" is not a number of tickets, so it was read as 0 (${why})`
    : `${seconds}s (${d} claimable — ${why})`;
  return { seconds, reason, depth: d, absurd };
}

/**
 * Normalise the "which statuses does this loop drain" argument to a list of
 * lower-cased names. A bare string is accepted because one caller passing a
 * single status must not silently match nothing — the failure mode there is a
 * depth of 0, which sleeps the maximum hour and looks exactly like an empty
 * queue.
 */
function wantedStatuses(wantStatus) {
  const raw = Array.isArray(wantStatus) ? wantStatus : [wantStatus];
  return raw
    .map((s) => String(s ?? '').trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Is this task actually claimable by this loop right now?
 *
 * "Claimable", not "queued" — a queue full of tickets the loop CANNOT take is
 * not a reason to wake more often. Returns null when it is claimable, or a
 * short human reason when it is not, so the caller can log what it excluded
 * rather than just a smaller number.
 *
 * @param {object} task            a ClickUp task as the list endpoint returns it
 * @param {object} opts
 * @param {string|string[]} opts.wantStatus the status(es) this loop drains.
 *   A LIST since task 86bbr1u9v — `loop-build` drains `Rework` and `Queued`.
 *   A bare string is still accepted so a caller passing one status is not a
 *   silent no-match.
 * @param {(tags:any)=>{action:string}} opts.resolveRepo  taskRepo.resolveTaskRepo
 * @param {Map<string,object>} opts.byId  every task in the list, for blockers
 * @param {Map<string,object>} [opts.blockers]  blockers read from OUTSIDE the
 *   list (finished tickets never appear in it), consulted for status only
 */
function unclaimableReason(task, { wantStatus, resolveRepo, byId, blockers } = {}) {
  if (!task || typeof task !== 'object') return 'not a task';

  const wanted = wantedStatuses(wantStatus);
  const status = String(task.status?.status ?? '').toLowerCase();
  if (!wanted.includes(status)) return `status is "${status || '?'}"`;

  // Wrong repo, unknown repo, two repo tags, or a repo not checked out on this
  // machine. Every one of those makes the loop ESCALATE rather than build
  // (see scripts/builder/taskRepo.js), so none of them is work this pass would
  // take, and none of them should shorten the cadence.
  if (typeof resolveRepo === 'function') {
    const r = resolveRepo(task.tags);
    if (r && r.action === 'escalate') return `repo escalates — ${r.reason}`;
  }

  // Blocked by an unfinished dependency. ClickUp records a "waiting on" edge
  // as an entry whose `task_id` is THIS task and whose `depends_on` is the
  // blocker; the mirror entry (this task blocking another) has them the other
  // way round and must not count.
  for (const dep of Array.isArray(task.dependencies) ? task.dependencies : []) {
    if (!dep || String(dep.task_id) !== String(task.id)) continue;
    const key = String(dep.depends_on);
    const blocker = (byId instanceof Map ? byId.get(key) : null)
      || (blockers instanceof Map ? blockers.get(key) : null)
      || null;
    // A blocker we cannot see is treated as still blocking. That is the safe
    // direction: it can only make the queue look shallower and the interval
    // longer (bias 1).
    //
    // BUT A FINISHED BLOCKER IS NEVER IN THE LIST (review round 1,
    // 2026-08-29). The list read returns open tasks only — ClickUp's
    // `include_closed` defaults to false — so a ticket waiting on work that
    // has already shipped would read as blocked on every cycle, forever. The
    // caller resolves those ids separately (`outsideBlockerIds` says which)
    // and hands them in as `blockers`; one that could not be resolved stays
    // unseen, and stays blocking.
    const type = String(blocker?.status?.type ?? '').toLowerCase();
    const done = type === 'closed' || type === 'done';
    if (!done) return `waiting on ${key}${blocker ? ` (${blocker.status?.status})` : ' (not in this list and not resolvable — treated as still open)'}`;
  }

  return null;
}

/**
 * The ids of every blocker a "waiting on" edge points at that is NOT in the
 * list itself. Pure; the caller decides whether to fetch them.
 *
 * Why the caller needs this at all: the list endpoint returns open tasks
 * only, so a blocker that has FINISHED is exactly the one that is missing —
 * and the one that must not keep its dependant looking blocked. Nothing is
 * fetched here; a cadence hint should not cost a network call per ticket, so
 * only the ids actually pointing outside the list are handed back.
 */
function outsideBlockerIds(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const present = new Set(list.filter((t) => t && t.id != null).map((t) => String(t.id)));
  const out = new Set();
  for (const t of list) {
    if (!t || typeof t !== 'object') continue;
    for (const dep of Array.isArray(t.dependencies) ? t.dependencies : []) {
      if (!dep || String(dep.task_id) !== String(t.id)) continue;
      const id = String(dep.depends_on ?? '').trim();
      if (id && !present.has(id)) out.add(id);
    }
  }
  return [...out];
}

/**
 * How many tickets this loop could actually claim on its next pass.
 *
 * @param {object} opts
 * @param {string} opts.loop        'loop-build' | 'loop-review'
 * @param {object[]} opts.tasks     every task in the Loop Queue list
 * @param {boolean} opts.capReached is the work-in-progress cap already full?
 * @param {Function} opts.resolveRepo
 * @param {object[]|Map<string,object>} [opts.blockers]  tasks read from outside
 *   the list because a dependency pointed at them (see outsideBlockerIds).
 *   They are consulted for a blocker's status only — never counted as
 *   claimable themselves, whatever status they carry.
 * @returns {{ depth:number, claimable:object[], excluded:Array<{id:string,why:string}>, note:string|null }}
 */
/**
 * "3 ticket(s) are the right status but none can be claimed: 2 for another
 * repo; 1 blocked on a dependency."
 *
 * Grouped by reason and counted rather than listed by id: the ids are already
 * printed one per line by the caller, and what the interval line needs is the
 * SHAPE of the blockage — a reader deciding whether this is normal or wrong.
 * Reasons are ordered by how many tickets share them, so the dominant cause
 * leads.
 */
function blockedSummary(excluded) {
  const rows = Array.isArray(excluded) ? excluded : [];
  if (!rows.length) return null;
  const counts = new Map();
  for (const x of rows) {
    const why = String(x?.why || 'no reason given').trim();
    counts.set(why, (counts.get(why) || 0) + 1);
  }
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([why, n]) => `${n} ${why}`);
  return `${rows.length} ticket(s) are the right status but none can be claimed: ${parts.join('; ')}`;
}

function claimableDepth({ loop, tasks, capReached = false, resolveRepo, blockers } = {}) {
  const wantStatus = LOOP_STATUS[String(loop || '').trim()];
  if (!wantStatus) {
    throw new Error(`unknown loop "${loop}" — known: ${KNOWN_LOOPS.join(', ')}`);
  }
  const wanted = wantedStatuses(wantStatus);

  // The work-in-progress cap zeroes the whole reading rather than filtering
  // ticket by ticket: when the merge side is full, `loop-build` claims NOTHING
  // this pass, however many tickets are queued, so waking sooner cannot help.
  //
  // It applies to `loop-build` only. `loop-review` does not claim new build
  // work — it drains PRs that are already open, which is the very thing the
  // cap is waiting on. Pausing review because the cap is full would deadlock
  // the pipeline against itself.
  if (capReached && loop === 'loop-build') {
    return {
      depth: 0,
      claimable: [],
      excluded: [],
      note: 'the work-in-progress cap is full, so nothing is claimable this pass however deep the queue is',
    };
  }

  const list = Array.isArray(tasks) ? tasks : [];
  const byId = new Map(list.filter((t) => t && t.id != null).map((t) => [String(t.id), t]));
  const seen = blockers instanceof Map
    ? blockers
    : new Map((Array.isArray(blockers) ? blockers : []).filter((t) => t && t.id != null).map((t) => [String(t.id), t]));

  const claimable = [];
  const excluded = [];
  for (const t of list) {
    const why = unclaimableReason(t, { wantStatus, resolveRepo, byId, blockers: seen });
    if (why === null) claimable.push(t);
    // Only worth reporting the ones that are the RIGHT status but still
    // unclaimable. Every other ticket in the list has a different status and
    // was never a candidate; listing those is noise.
    else if (wanted.includes(String(t?.status?.status ?? '').toLowerCase())) {
      excluded.push({ id: String(t.id), why });
    }
  }

  // In CLAIM ORDER for loop-build — rework before queued — so a caller that
  // reads `claimable[0]` gets the ticket the claim rule actually names rather
  // than whichever one ClickUp's paging happened to return first.
  const ordered = loop === 'loop-build' ? loopStatuses.claimOrder(claimable) : claimable;

  // A ZERO WITH TICKETS BEHIND IT IS NOT AN EMPTY QUEUE, and the difference is
  // the whole of task 86bbtmbvn. `excluded` holds every ticket that was the
  // RIGHT status and still could not be claimed — a foreign repo, an unmet
  // dependency. Reaching depth 0 that way is a blocked queue, not an idle one,
  // and the interval line must not call it "nothing to do".
  //
  // Said only when the depth is actually 0. With work claimable, the excluded
  // ones are ordinary background and already listed line by line.
  const note = ordered.length === 0 && excluded.length ? blockedSummary(excluded) : null;
  return { depth: ordered.length, claimable: ordered, excluded, note };
}

/**
 * Apply the curve to a reading, with hysteresis.
 *
 * SHORTENING IS IMMEDIATE. LENGTHENING NEEDS TWO CONSECUTIVE READINGS THAT
 * BOTH WANT IT.
 *
 * THAT IS THE OPPOSITE OF WHAT THIS FUNCTION DID UNTIL 2026-09-05, and the
 * inversion is the whole of task 86bbvh285. The original reasoning is kept
 * here because it was not silly — it was measured against the wrong cost.
 *
 *   The original rule: shortening waits for two consecutive readings, because
 *   one burst of tickets must not flip the cadence for the night; lengthening
 *   never waits, because the expensive mistake is staying fast and burning
 *   quota invisibly.
 *
 * WHAT THAT MISSED. The two errors are not the same size. Waking sooner than a
 * wrong reading deserved costs ONE extra pass against a shallow queue. But the
 * hold is paid AT THE CADENCE THAT IS ALREADY TOO LONG — the loop sleeps the
 * old interval to earn the right to shorten it — so refusing to shorten from
 * an hour costs an hour, of the WHOLE pipeline, because the work-in-progress
 * cap counts `In review` and a slow review lane fills it until `loop-build`
 * stops claiming at all.
 *
 * AND ON A DRIFTING QUEUE THE GUARD WAS EFFECTIVELY UNREACHABLE. This is the
 * part worth reading slowly, because it is not what it looks like. The rule
 * compares DIRECTION, not exact values — `lastProposed < current` — so on the
 * face of it two different short proposals should second each other. They
 * cannot, because a HELD pass does not move `current`, and an intervening
 * reading that is not shorter than `current` overwrites `lastProposed` with
 * itself. So the second reading has to be shorter than the interval in force,
 * and on a queue drifting across the curve's rows it usually is not.
 *
 * MEASURED, from `~/loop-logs/loop-review.log` on the Mini:
 *
 *   00:26  4 claimable -> 900s proposed, HELD at 1800s   (lastProposed = 900)
 *   01:05  3 claimable -> 1800s, which is not < 1800s, so it is adopted as-is
 *          and lastProposed is reset to 1800 — the 900 reading is discarded
 *   01:44  2 claimable -> 1800s.  02:24  1 claimable -> 1800s.
 *
 * The queue reached the curve's deepest row and the cadence never went there.
 * That is a ratchet, not hysteresis: alternating readings settle on the SLOWER
 * rung and stay.
 *
 * WHAT THE TICKET GOT WRONG, recorded so the next reader is not misled by it:
 * it reported the guard as comparing exact seconds ("two readings of the same
 * value"), and reported `loop-review` as pinned at 3600s for over three hours.
 * Neither is quite right. The comparison is directional, as above; and of the
 * three hours at 3600s on 2026-09-05, two passes genuinely read ZERO claimable
 * — correct behaviour — and only the 14:05 pass was a hold. One hour was lost
 * to hysteresis that day, not three. The ticket's CONCLUSION survives its
 * arithmetic: the ratchet above is real, and it is worse than the version
 * reported, because it can strand the cadence one rung short indefinitely.
 *
 * SO BOTH DIRECTIONS NOW COMPARE DIRECTION AGAINST THE INTERVAL IN FORCE, and
 * the direction that waits is the one where being wrong is cheap. The
 * anti-thrash property the original rule was written for is NOT lost — it has
 * moved: a single quiet reading no longer lengthens the cadence, so a queue
 * that empties for one pass and refills does not cost an hour of sleep. The
 * ratchet cannot form in that direction either, because a reading that wants
 * SHORTER is adopted outright rather than merely resetting a counter.
 *
 * With no state at all, the interval in force is taken to be the runner's
 * CONFIGURED fallback, not the proposal. A first pass against a deep queue
 * therefore shortens at once — which is the same rule every later pass
 * follows, rather than a special case.
 *
 * @param {object} opts
 * @param {number} opts.depth
 * @param {{interval?:number,lastProposed?:number}|null} opts.state  previous cycle's state
 * @param {number} opts.fallbackSeconds  the runner's configured interval
 * @returns {{ seconds:number, reason:string, state:object, held:boolean }}
 */
function decideInterval({ depth, state, fallbackSeconds, blockedNote = '' } = {}) {
  const configured = clampToFloor(fallbackSeconds ?? DEFAULT_FALLBACK_SECONDS);
  const proposal = intervalForDepth(depth, { blockedNote });
  const proposed = proposal.seconds;

  const prev = Number.isFinite(Number(state?.interval)) ? clampToFloor(state.interval) : null;
  const current = prev ?? configured;
  const lastProposed = Number.isFinite(Number(state?.lastProposed)) ? Number(state.lastProposed) : null;

  // Unchanged — nothing to decide.
  if (proposed === current) {
    return {
      seconds: proposed,
      reason: proposal.reason,
      state: { interval: proposed, lastProposed: proposed },
      held: false,
    };
  }

  // SHORTER — take it now, on this one reading. Work is claimable and the loop
  // is asleep; the cost of being wrong is one extra pass, and the cost of
  // waiting is an hour of a pipeline that cannot claim past the cap.
  if (proposed < current) {
    return {
      seconds: proposed,
      reason: `${proposal.reason}; shortening on the first reading that asks for it — waking sooner costs one pass, refusing costs an hour`,
      state: { interval: proposed, lastProposed: proposed },
      held: false,
    };
  }

  // LONGER, and the previous reading also wanted longer: two consecutive, so
  // lengthen — to the LATEST proposal, which is the freshest reading of the
  // queue rather than the quieter older one.
  //
  // DIRECTION, NOT VALUE. `lastProposed > current` asks "did the last reading
  // want longer too", which stays answerable while the queue drifts between
  // rows of the curve. Asking whether it proposed this exact number is the
  // defect this rule was rewritten to remove.
  if (lastProposed !== null && lastProposed > current) {
    return {
      seconds: proposed,
      reason: `${proposal.reason}; second consecutive quiet reading, so the cadence lengthens from ${current}s`,
      state: { interval: proposed, lastProposed: proposed },
      held: false,
    };
  }

  // Longer, but this is the first such reading. Hold, and remember it — a
  // queue that empties for one pass and refills must not cost an hour.
  return {
    seconds: current,
    reason: `${current}s — holding. ${proposal.reason} would lengthen it, but one quiet reading does not (two consecutive do)`,
    state: { interval: current, lastProposed: proposed },
    held: true,
  };
}

/**
 * What to answer when the queue could not be read.
 *
 * Exits 0 on purpose — this is not the loop's problem to solve, and a non-zero
 * exit would make the runner fall back to the SAME number by a noisier route.
 * The state is left untouched: a failed read is not a reading, and must not
 * count as one of hysteresis' two consecutive readings.
 */
function fallbackInterval({ fallbackSeconds, why } = {}) {
  const raw = Number(fallbackSeconds);
  const seconds = clampToFloor(fallbackSeconds ?? DEFAULT_FALLBACK_SECONDS);
  // Two different endings, because one sentence cannot honestly cover both.
  // Normally the point worth making is that this is NOT the floor. But when
  // the configured value was itself under the floor, it HAS been raised to it,
  // and saying "not the floor" in that breath would be a contradiction the
  // reader has to untangle at exactly the wrong moment.
  const tail = Number.isFinite(raw) && Math.trunc(raw) < seconds
    ? `, and the configured ${Math.trunc(raw)}s was raised to the ${FLOOR_SECONDS}s floor.`
    : '. NOT the floor: a short interval on unknown state is how quota gets burned invisibly.';
  return {
    seconds,
    reason: `${seconds}s — the queue could not be read (${why || 'reason not given'}), so the configured fallback is in force${tail}`,
    state: null,
    held: false,
  };
}

module.exports = {
  FLOOR_SECONDS,
  DEFAULT_FALLBACK_SECONDS,
  CURVE,
  LOOP_STATUS,
  KNOWN_LOOPS,
  clampToFloor,
  normalizeDepth,
  intervalForDepth,
  wantedStatuses,
  unclaimableReason,
  outsideBlockerIds,
  blockedSummary,
  claimableDepth,
  decideInterval,
  fallbackInterval,
};
