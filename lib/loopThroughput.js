'use strict';

/**
 * Throughput — making "alive but useless" detectable.
 *
 * WHY THIS EXISTS (2026-08-31, ticket 86bbqrw3p)
 * `npm run heartbeat` answers "did this job stop firing?". On 2026-08-31 the
 * build loop fired every hour, exited 0 every time, and did not move the
 * queue: 52 tickets queued, 1 in review, six rework PRs open with the oldest
 * sitting since Aug 25. Every gate was green and every green was honest.
 *
 * A heartbeat structurally cannot detect that. It measures LIVENESS, and the
 * loop was alive. Nothing in the system asked "is the queue getting shorter?"
 *
 * This is the same shape as the silence problem heartbeat was built for, one
 * level up — and worse in one specific way. A job that never fires writes
 * nothing at all, and nothing at least LOOKS like nothing. A loop that runs
 * and achieves nothing writes a full, cheerful log, which reads as health and
 * so stops anybody looking.
 *
 * FOUR STATES, NEVER TWO (docs/DOCTRINE.md 3.11)
 *   MOVING   tickets closed inside the window. The pipeline is delivering.
 *   IDLE     nothing closed, and there was nothing to close. Healthy, and it
 *            says WHY it is healthy rather than presenting a bare zero.
 *   STALLED  nothing closed while open work sat there. This is the finding.
 *   UNKNOWN  a reading needed for the verdict could not be taken. NEVER
 *            rendered as healthy — a monitor that fails quietly is worse than
 *            no monitor, because it converts "nobody is watching" into
 *            "something is watching" and then stops anybody looking.
 *
 * NOTHING HERE TOUCHES THE NETWORK OR THE CLOCK. Every decision is a pure
 * function over data the caller fetched, so `node --test` drives every branch
 * with no token, no ClickUp, no GitHub and no clock of its own. The IO lives
 * in scripts/loop_throughput.mjs.
 */

// Moved from StarCaster (lib/loopThroughput.js, commit 0682572) for SP-268.
// Its helpers come from Spirality's own copies: the status taxonomy and the
// pull-request buckets (lib/loopStatuses.js, lib/wipCap.js), the noticeboard
// list (lib/loopNoticeboards.js) and the repost window (lib/watchdogPosts.js,
// cut from StarCaster's lib/nodeHeartbeat.js). The words a reader sees say
// "the tracker" and "the queue" where StarCaster's said ClickUp and the Loop
// Queue, and the posts start `ALARM:` (a stall) so the tracker texts them.
const wipCap = require('./wipCap.js');
const loopNoticeboards = require('./loopNoticeboards.js');
const loopStatuses = require('./loopStatuses.js');
const { REPOST_EVERY_MS, dueAgain, ageText, mountainTime } = require('./watchdogPosts.js');
const { countsAsFinished } = require('./ticketClass.js');

const DAY_MS = 24 * 60 * 60 * 1000;

/** How far back "nothing has closed" has to reach before it is a stall. */
const STALL_WINDOW_MS = DAY_MS;

/**
 * How long a quiet spell has to run before MOVING mentions it. NOT a
 * threshold for anything — nothing branches on this — purely the point past
 * which "nothing has closed for a while" is worth a reader's attention. Set at
 * the measured p90 gap (3.4h, see `sinceLastClose`), so it stays quiet on the
 * three quarters of gaps that are under an hour and speaks up on the tail.
 */
const QUIET_NOTE_MS = 3.5 * 60 * 60 * 1000;

/** "7.2 hours" / "45 minutes" — a duration in the unit the reader thinks in. */
function hoursText(ms) {
  const h = Number(ms) / 3600000;
  if (!Number.isFinite(h) || h < 0) return 'an unknown time';
  if (h < 1) return `${Math.round(h * 60)} minutes`;
  return `${h.toFixed(1)} hours`;
}

/** How many days the report shows. A week, so a weekend reads as a weekend. */
const REPORT_DAYS = 7;

/**
 * Ticket statuses that mean the work is finished. Borrowed from the ONE
 * taxonomy rather than re-listed — two files disagreeing about what "done"
 * means is precisely the drift that produced task 86bbq8br2, and (until task
 * 86bbtujed) this borrowed wipCap's copy, which itself disagreed with
 * pulse's. All three read loopStatuses now; decision D1 lives there.
 */
const TERMINAL_STATUSES = loopStatuses.TERMINAL_STATUSES;

/**
 * THE TICKETS THIS FILE IS ALLOWED TO COUNT — work, never noticeboards.
 *
 * Every reader below opens with this instead of a bare array guard, because
 * the exclusion has to reach every question at once. The registry and the
 * measurements behind it are `lib/loopNoticeboards.js`; the short version is
 * that three standing tickets live in the Loop Queue in a closed-type status,
 * so ClickUp stamps `date_closed` on them at creation and each one reads here
 * as a ticket that shipped. Saving one alarm during a bus outage was enough to
 * flip STALLED to MOVING for the following 24 hours — the stall detector
 * silenced by the alarm it was trying to save.
 *
 * IT ALSO REPLACES THE ARRAY GUARD, on purpose. A separate filter applied at
 * some call sites and not others is how a report ends up printing two numbers
 * for one queue; folding it into the guard every reader already used means
 * there is no version of these functions that skips it.
 */
function workTickets(tasks) {
  return loopNoticeboards.workTickets(tasks);
}

// --- day buckets ------------------------------------------------------------

/**
 * A CALENDAR. Two paired questions — which day does this instant fall in, and
 * when does that day end — kept in one object so they cannot disagree.
 *
 * INJECTABLE ON PURPOSE. The report is read by a person in a timezone, so the
 * default is the machine's LOCAL day: a ticket closed at 8pm Eastern belongs
 * to that evening, not to the next UTC morning. But a test asserting local
 * days would pass or fail depending on the machine's TZ, which is a flake, so
 * every function here takes `calendar` and the tests hand it the UTC one.
 *
 * THE PAIRING IS THE POINT. The first draft bucketed closures by calendar day
 * and then measured the backlog curve at "this time of day, N days ago" — a
 * rolling 24h boundary wearing a calendar day's label. The two disagreed by up
 * to a day at every row, which is exactly the quiet wrongness this whole file
 * is about, so `end` is derived from the key rather than from an offset.
 */
const LOCAL_DAYS = {
  key(ms) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  },
  /** The first instant of the NEXT day — an exclusive upper bound. */
  end(key) {
    const [y, m, d] = String(key).split('-').map(Number);
    return new Date(y, m - 1, d + 1).getTime();
  },
};

/**
 * MOUNTAIN DAYS, the default (SP-268, review round 1): Dane reads times in
 * Mountain time (CLAUDE.md), and the Mini's own clock zone is not a promise.
 * A UTC day splits at 5 pm MT, so a ticket closed in the evening landed on
 * tomorrow's row. `end` finds the next Mountain midnight by asking the
 * formatter, so daylight-saving changes cannot skew it.
 */
const MOUNTAIN_TZ = 'America/Denver';
const mountainParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: MOUNTAIN_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
function mountainOffsetMs(ms) {
  const p = Object.fromEntries(mountainParts.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
  return asUtc - Math.floor(ms / 60000) * 60000;
}
const MOUNTAIN_DAYS = {
  key(ms) {
    const p = Object.fromEntries(mountainParts.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}`;
  },
  end(key) {
    const [y, m, d] = String(key).split('-').map(Number);
    const nextMidnightUtc = Date.UTC(y, m - 1, d + 1);
    // Mountain midnight = UTC midnight minus the offset in force then. Asked
    // twice so a clock change on that day lands on the right side.
    let guess = nextMidnightUtc - mountainOffsetMs(nextMidnightUtc);
    guess = nextMidnightUtc - mountainOffsetMs(guess);
    return guess;
  },
};

const UTC_DAYS = {
  key(ms) {
    return new Date(ms).toISOString().slice(0, 10);
  },
  end(key) {
    return Date.parse(`${key}T00:00:00.000Z`) + DAY_MS;
  },
};

/**
 * The `days` calendar days ending with the one `now` falls in, oldest first.
 *
 * Walked back through `end()` rather than by subtracting 24h a day at a time,
 * so a clock change cannot skip or repeat a day. `end(K) - DAY_MS` lands within
 * an hour of K's own start whichever way the clocks moved; a further 3 hours
 * back therefore cannot land anywhere but the day before.
 */
function dayWindow({ now, days = REPORT_DAYS, calendar = MOUNTAIN_DAYS }) {
  const out = [calendar.key(now)];
  while (out.length < days) out.unshift(calendar.key(calendar.end(out[0]) - DAY_MS - 3 * 3600000));
  return out;
}

// --- reading the tickets ----------------------------------------------------

/**
 * When a ticket closed, in ms, or null.
 *
 * ClickUp hands `date_closed` back as a STRING of milliseconds, and an open
 * ticket carries `null` — or, on some payloads, the string "0". Both have to
 * read as "not closed": a 0 parsed as an instant is 1 January 1970, which
 * would silently drop off the far end of every window rather than erroring.
 */
function closedAt(task) {
  const raw = Number(task && task.date_closed);
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

/**
 * When a ticket closed as finished work, in ms, or null (SP-347): closedAt,
 * except that a ticket whose ending (`outcome`) is Won't do, Duplicate or
 * Test never counts as a closure (lib/ticketClass.js `countsAsFinished`).
 * Dropping a ticket is not delivery: counted as one, a day the queue only
 * dropped tickets would read MOVING while the real work sat stalled.
 *
 * Only the delivery counts read this (closedPerDay, sinceLastClose,
 * closedSince). The backlog curve and the undated checks keep closedAt: a
 * dropped ticket did leave the open queue when it closed.
 */
function finishedAt(task) {
  return countsAsFinished(task && task.outcome) ? closedAt(task) : null;
}

/** When a ticket was filed, in ms, or null. Same string-of-millis shape. */
function createdAt(task) {
  const raw = Number(task && task.date_created);
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

/**
 * When a ticket was last edited, in ms, or null. Same string-of-millis shape.
 *
 * WHAT THIS DOES AND DOES NOT PROVE. ClickUp bumps `date_updated` on ANY edit
 * — a comment, a priority change, a relay note — so it answers "was this
 * ticket touched?" and nothing narrower. Two callers here need exactly that
 * question and no more: `queueTouched` (see `verdict`) and
 * `recentUndatedClosures` below.
 */
function updatedAt(task) {
  const raw = Number(task && task.date_updated);
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

function statusOf(task) {
  return String(task?.status?.status ?? '').trim().toLowerCase();
}

/**
 * THE HEADLINE NUMBER: how many tickets reached a terminal status on each of
 * the last N days.
 *
 * Counted from `date_closed` rather than from a status field, because a status
 * is a fact about NOW and this question is about the past. The list only holds
 * tickets that still exist, so a deleted one is invisible here — which
 * undercounts, never over, and undercounting is the safe direction for a
 * stall detector.
 */
function closedPerDay({ tasks, now, days = REPORT_DAYS, calendar = MOUNTAIN_DAYS } = {}) {
  const window = dayWindow({ now, days, calendar });
  const counts = new Map(window.map((d) => [d, 0]));
  for (const t of workTickets(tasks)) {
    const at = finishedAt(t);
    if (at === null) continue;
    const key = calendar.key(at);
    if (counts.has(key)) counts.set(key, counts.get(key) + 1);
  }
  return window.map((date) => ({ date, count: counts.get(date) }));
}

/** How many tickets closed in the `windowMs` ending at `now`. The stall test. */
/**
 * HOW LONG SINCE ANYTHING REACHED LIVE — reported as a FACT, never as a verdict.
 *
 * WHY IT IS NOT AN ALARM (2026-09-02, task 86bbtmbwe). The obvious fix for
 * `MOVING`'s blind spot is a recency threshold: if nothing has closed in N
 * hours, call it a stall even when the 24-hour count is healthy. That was the
 * ticket's proposal, and measuring killed it.
 *
 * 189 closures over the fortnight to 2026-09-02, gap between consecutive
 * closures:
 *
 *     p50   0.33h      p90    3.38h      p98   13.23h
 *     p75   1.04h      p95   10.22h      max   52.72h
 *
 * Twenty of 188 gaps exceed three hours, and almost every long one ENDS IN THE
 * MORNING — they are ordinary nights. The overnight gap of 2026-09-01, the one
 * this ticket was opened about, was 7.2h: SHORTER than eleven other gaps in
 * the same fortnight, around the 93rd percentile. A threshold low enough to
 * catch it would have fired on roughly eleven of the last fourteen nights,
 * which is an alarm that goes off nightly and gets ignored — the inversion of
 * the discipline every other check here follows.
 *
 * By this measure that night was not unusual. What distinguished it was
 * STRANDED IN-FLIGHT WORK, which `pipeline -- status` already detects through
 * `pipelinePause.inFlight`. Re-deriving it here would be a second definition
 * of "stranded" — the drift this repo has recorded three times — so it is not
 * done, and the number below is offered to a reader rather than to a rule.
 *
 * Returns null when nothing in the list has ever closed: "no closures on
 * record" is not "closed a very long time ago".
 */
function sinceLastClose({ tasks, now } = {}) {
  let latest = null;
  for (const t of workTickets(tasks)) {
    const at = finishedAt(t);
    if (at === null || at > now) continue;
    if (latest === null || at > latest) latest = at;
  }
  return latest === null ? null : { at: latest, ms: now - latest };
}

function closedSince({ tasks, now, windowMs = STALL_WINDOW_MS } = {}) {
  const floor = now - windowMs;
  return workTickets(tasks).filter((t) => {
    const at = finishedAt(t);
    return at !== null && at >= floor && at <= now;
  }).length;
}

/**
 * The shape of the queue right now.
 *
 * `queued` is the headline depth the ticket asks to print — the work a build
 * loop can actually claim, which since task 86bbr1u9v is `Rework` AND `Queued`
 * (loop-build drains all of the first before any of the second). Counting a
 * rework ticket as "in flight" instead would be the worst possible reading
 * here: nothing is in flight on it, and the stall detector would report a
 * healthy pipeline while the send-backs rotted — which is the precise failure
 * the Rework status was created to end.
 *
 * `openWork` is every ticket that has not finished, and it is what gates the
 * verdict. "Nothing closed" is healthy only when there was NOTHING TO CLOSE,
 * and two tickets parked in review with an empty Queued column is emphatically
 * something to close — it is the exact shape of a merge side that has stopped.
 * Gating on `queued` alone would call that healthy.
 */
/*
 * ONLY WORK A LOOP CAN MOVE GATES THE STALL (SP-268, review round 1). A ticket
 * in `Needs your input` or `Ready to launch` waits on Dane, and one in
 * `Requested` waits on intake's reading of his words; no build or review pass
 * moves either. Counted as open work, a queue that is only waiting on Dane for
 * a day read as STALLED and texted him an ALARM every six hours saying the
 * loops had shipped nothing. So those are counted apart (`waitingOnDane`,
 * `requested`), said on every report, and kept out of `openWork`. `allOpen`
 * is every unfinished ticket, the number the backlog curve's last row matches.
 */
function queueShape(tasks) {
  const shape = {
    queued: 0, inFlight: 0, openWork: 0, waitingOnDane: 0, requested: 0, allOpen: 0,
    closed: 0, total: 0, byStatus: {},
  };
  for (const t of workTickets(tasks)) {
    const status = statusOf(t);
    shape.total += 1;
    shape.byStatus[status || 'unknown'] = (shape.byStatus[status || 'unknown'] || 0) + 1;
    if (TERMINAL_STATUSES.includes(status)) { shape.closed += 1; continue; }
    shape.allOpen += 1;
    if (loopStatuses.OPERATOR_HELD_STATUSES.includes(status)) { shape.waitingOnDane += 1; continue; }
    if (status === loopStatuses.REQUESTED) { shape.requested += 1; continue; }
    shape.openWork += 1;
    if (loopStatuses.isClaimableByBuild(status)) shape.queued += 1;
    else shape.inFlight += 1;
  }
  return shape;
}

/**
 * THE BACKLOG CURVE: how deep the open queue stood at the end of each day.
 *
 * "A queue that is not shrinking over days is the actual signal; a single
 * depth reading is not" — and nothing in this system has ever recorded queue
 * depth over time. Rather than start a new state file that would be empty for
 * a week and lie for a day, the curve is RECONSTRUCTED from the two timestamps
 * every ticket already carries: it was open on day D if it was created on or
 * before D and had not closed by the end of D.
 *
 * WHAT THAT CANNOT SEE, said out loud rather than left to be discovered: a
 * ticket deleted or archived since is not in the list, so early days are
 * undercounted; and closure is the only transition it can reconstruct, so this
 * is the depth of OPEN WORK, not of the Queued column specifically. Both errors
 * point the same way — the real backlog was never smaller than this says.
 */
function depthPerDay({ tasks, now, days = REPORT_DAYS, calendar = MOUNTAIN_DAYS } = {}) {
  const window = dayWindow({ now, days, calendar });
  const list = workTickets(tasks);
  const rows = window.map((date) => {
    // A true calendar boundary from the same object that produced the label,
    // capped at `now` so today's row reads "open right now" rather than
    // reaching into a future that has not happened yet.
    const endOfDay = Math.min(calendar.end(date), now);
    let open = 0;
    for (const t of list) {
      const born = createdAt(t);
      if (born === null || born > endOfDay) continue;
      if (undatedClosure(t)) continue;
      const died = closedAt(t);
      if (died !== null && died <= endOfDay) continue;
      open += 1;
    }
    return { date, open };
  });
  return rows;
}

/**
 * A ticket whose STATUS says it is finished but which carries no closure
 * timestamp. Treated as closed for the whole window.
 *
 * WHY, MEASURED (2026-08-31). The first live run printed "57 open" as the last
 * point of the curve directly above "56 open in total" — two numbers for the
 * same question, one report, disagreeing by one. The cause was a single real
 * ticket, 86bb4uyvp, sitting in `live` with `date_closed` empty. `queueShape`
 * reads the status and calls it closed; the curve read the timestamp, found
 * none, and called it open on every day forever.
 *
 * The status is the authoritative fact about NOW, so it wins — otherwise the
 * headline number and the curve's own last point contradict each other, which
 * is exactly the quiet disagreement this file was written against.
 *
 * The cost is that its history is unknown, so it is missing from EVERY day
 * rather than appearing until whenever it actually closed. That undercounts
 * the past by however many such tickets exist, which is why `undatedClosures`
 * counts them and the report says the number out loud rather than adjusting
 * silently.
 */
function undatedClosure(task) {
  return closedAt(task) === null && TERMINAL_STATUSES.includes(statusOf(task));
}

/** How many tickets the curve had to guess about. Printed, never hidden. */
function undatedClosures(tasks) {
  return workTickets(tasks).filter(undatedClosure).length;
}

/**
 * THE UNDATED CLOSURES THAT COULD EXPLAIN A ZERO — the ones that can turn a
 * good day into a false stall (2026-09-01, task 86bbr2jpq, finding 4).
 *
 * `closedSince` counts `date_closed` and nothing else, so a ticket that ships
 * without one is invisible to the stall test. A day on which everything
 * shipped that way reports STALLED with total confidence.
 *
 * NARROWED TO THE WINDOW ON PURPOSE, and this is the whole design of it. The
 * blunt version — "any undated closure means we cannot tell" — would have
 * switched the stall alarm off PERMANENTLY, because 86bb4uyvp is a real ticket
 * sitting in `live` with no closure date and it is never going to grow one.
 * That trades a rare false alarm for a permanent silent failure, which is the
 * worse of the two by the standard this whole file is written to.
 *
 * So the question asked is narrower: could this ticket have closed inside the
 * window? `date_updated` is the only evidence available, and it is enough in
 * ONE direction — a ticket last edited a week ago certainly did not close in
 * the last 24 hours, whatever else is true of it. A ticket edited inside the
 * window might have. That is the set counted here, and it is the set that
 * makes the verdict UNKNOWN rather than STALLED.
 *
 * A ticket with no readable `date_updated` at all counts: nothing rules it
 * out, and for a stall detector the safe direction is admitting the doubt.
 */
function recentUndatedClosureTasks({ tasks, now, windowMs = STALL_WINDOW_MS } = {}) {
  const floor = now - windowMs;
  return workTickets(tasks).filter((t) => {
    if (!undatedClosure(t)) return false;
    const touched = updatedAt(t);
    return touched === null || touched >= floor;
  });
}

/**
 * The same set as a count, which is all `verdict` branches on.
 *
 * THE TICKETS THEMSELVES ARE WANTED TOO (2026-09-02, review round 1). The
 * repair for this verdict is "give that ticket a closure date", and a message
 * that says so without naming which ticket sends the reader to read a whole
 * column by hand. There are usually one or two.
 */
function recentUndatedClosures(opts) {
  return recentUndatedClosureTasks(opts).length;
}

/**
 * How long the queue has been at or above where it stands now.
 *
 * Reported as a run of days rather than a single number because that is the
 * finding: 51 open today is a fact, and 51-or-more open every day for a week
 * is a diagnosis.
 */
/**
 * WHERE OPEN WORK STARTED THE WINDOW AND WHERE IT ENDED — the tool's own
 * headline question, answered as a number that cannot go quiet.
 *
 * `depthPlateau` next door answers a narrower question, "how long has open
 * work not fallen below today's level", and it is correct at what it does. But
 * it is anchored on TODAY, so the moment the backlog RISES it reports a run of
 * one day and the caller prints nothing at all. On 2026-09-02 open work went
 * 55 → 55 → 56 and the plateau line disappeared — silence on the worse of the
 * two cases (task 86bbtmbwe).
 *
 * This is the blunt version and it always has something to say: first day,
 * last day, and the difference. A backlog that grew is not automatically a
 * fault — work being filed as fast as it ships is what a busy week looks like
 * — so nothing branches on it. It exists so that "35 tickets reached Live"
 * cannot stand alone as an answer to "is the queue getting shorter?".
 */
function depthTrend(curve) {
  const rows = Array.isArray(curve) ? curve.filter((r) => r && Number.isFinite(Number(r.open))) : [];
  if (rows.length < 2) return null;
  const first = Number(rows[0].open);
  const last = Number(rows[rows.length - 1].open);
  return { first, last, delta: last - first, days: rows.length, from: rows[0].date, to: rows[rows.length - 1].date };
}

function depthPlateau(curve) {
  const rows = Array.isArray(curve) ? curve : [];
  if (!rows.length) return { days: 0, since: null, depth: null };
  const depth = rows[rows.length - 1].open;
  let days = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].open < depth) break;
    days += 1;
  }
  return { days, since: rows[rows.length - days].date, depth };
}

// --- the rework bucket ------------------------------------------------------

/**
 * The oldest open pull request whose ticket is waiting to be re-claimed.
 *
 * TWO BUCKETS, ONE POPULATION (2026-08-31, task 86bbr1u9v). A send-back now
 * lands in its own status, `Rework`, so `classifyPrs` reports it there instead
 * of inferring it from the ticket being `Queued`. Both are counted here, and
 * that is not the conflation `wipCap` deliberately undid:
 *
 *   - `rework` is a send-back — the status says so.
 *   - `queued` with an open PR is the SAME shape read the old way, and it is
 *     what every existing ticket looks like until `clickup migrate-rework`
 *     runs after this ships.
 *
 * Reading only one of them would make this report say zero on the day the
 * status shipped, or zero on the day the tickets moved — a silent wrong answer
 * either side of the migration. The question this report asks is "what open
 * branch is nothing finishing", and both buckets answer it.
 *
 * THE BUCKETS ARE READ FROM `wipCap.classifyPrs`, NOT DERIVED A SECOND TIME.
 * That module already decides what counts as rework, and it decides it with
 * a page of reasoning and a test suite behind it. Task 86bbq8br2 is the
 * incident that argues for one reading of a shared question: two call sites
 * asked "is the merge side full?" in their own words and reached opposite
 * answers for a whole morning. Both were correct in isolation. They were
 * simply not the same reading, which is the failure that arrives silently.
 *
 * classifyPrs returns PR NUMBERS, so the ages are looked up against the same
 * list that was handed to it — the numbers are the bucket, the list is only
 * where `createdAt` lives.
 */
function reworkPrs({ prs, ticketStatusById, now } = {}) {
  const groups = wipCap.classifyPrs({ prs, ticketStatusById });
  const byNumber = new Map();
  for (const pr of Array.isArray(prs) ? prs : []) {
    if (pr && typeof pr === 'object') byNumber.set(pr.number, pr);
  }
  const rows = [...groups.rework, ...groups.queued].map((number) => {
    const pr = byNumber.get(number);
    const opened = Date.parse(pr?.createdAt ?? '');
    const ageMs = Number.isFinite(opened) ? now - opened : null;
    return { number, openedAt: Number.isFinite(opened) ? pr.createdAt : null, ageMs };
  });
  // Oldest first, and a PR whose age could not be read sorts LAST rather than
  // being dropped: it is still rework sitting open, and silently omitting it
  // would shrink the very number this report exists to show.
  rows.sort((a, b) => (b.ageMs ?? -1) - (a.ageMs ?? -1));
  const oldest = rows.find((r) => r.ageMs !== null) || null;
  return { rows, oldest, groups };
}

// --- the verdict ------------------------------------------------------------

/** " 3 waiting on Dane and 1 requested, which no loop moves." or "". */
function parkedText(queue) {
  const parts = [];
  if (queue && queue.waitingOnDane > 0) parts.push(`${queue.waitingOnDane} waiting on Dane`);
  if (queue && queue.requested > 0) parts.push(`${queue.requested} requested (not yet specced)`);
  return parts.length ? ` ${parts.join(' and ')}, which no loop moves.` : '';
}

/**
 * MOVING / IDLE / STALLED / UNKNOWN, with the reason in plain English.
 *
 * `queueTouched` is TRI-STATE — true, false, or null for "could not tell" —
 * and it never turns a stall into a pass. What it changes is WHERE the reader
 * is sent, and it is named after the evidence rather than after the
 * conclusion, which is the fix of 2026-09-01 (task 86bbr2jpq, finding 3).
 *
 * IT USED TO BE CALLED `loopsFiring`, AND IT SAID "the loops ARE firing".
 * The only evidence behind it is `date_updated` on a Loop Queue ticket, and
 * ClickUp bumps that on ANY edit — a comment from Dane, a relay note, a
 * priority change. So the sentence asserted something the data cannot support,
 * and it asserted it in the one direction that costs a reader the most: the
 * loop lanes run inside long-lived agent sessions, so "no session is open" is
 * arguably the MOST likely cause of a stall, and that is exactly the case the
 * old wording sent them away from, hunting a pipeline bug.
 *
 * Renaming it made `false` answerable for the first time, which is a gain
 * rather than a cost. The old question ("did a loop pass run?") could not be
 * answered `false`, because a pass that finds the WIP cap full writes nothing
 * and is indistinguishable from a pass that never happened. The new question
 * ("was anything in the Loop Queue edited?") is a plain fact about the list,
 * and `false` — nothing edited at all for 24 hours — is a genuinely useful
 * finding rather than a guess.
 *
 * `undatedRecent` is the other half of the same discipline: a count of
 * finished tickets that carry no closure date and were edited inside the
 * window, so they COULD have closed in it and the zero cannot be trusted.
 * See `recentUndatedClosures`. It turns a stall into an UNKNOWN, never into a
 * pass — a reading nobody can justify is not a clean bill of health.
 */
function verdict({
  closedLast24h, queue, queueTouched = null, windowMs = STALL_WINDOW_MS, unreadable = null,
  trend = null, lastClose = null, undatedRecent = 0, hasHeartbeat = false,
} = {}) {
  if (unreadable) {
    return {
      state: 'UNKNOWN', kind: 'unreadable', exitCode: 2, stalled: false,
      why: `Could not tell whether the queue is moving — ${unreadable}. `
        + 'Reported as unknown rather than healthy on purpose: a green board nobody can justify '
        + 'is the failure this check exists to prevent.',
    };
  }

  const hours = Math.round(windowMs / 3600000);
  if (closedLast24h > 0) {
    // THE HEADLINE QUESTION IS "IS THE QUEUE GETTING SHORTER?", and a count of
    // closures answers a different one. On 2026-09-02 this printed "35 tickets
    // reached Live in the last 24h" — true, and read as an all-clear — while
    // open work had been flat at 55 for three days. A backlog that does not
    // move is not automatically a fault (work is being filed as fast as it
    // ships, which is what a busy week looks like), so it does not change the
    // verdict. It is said because MOVING is the line people stop reading at,
    // and a bare count lets it stand for more than it knows.
    const flat = trend
      ? ` Open work went ${trend.first} → ${trend.last} over ${trend.days} days`
        + `${trend.delta === 0 ? ', level' : trend.delta > 0 ? ` (up ${trend.delta})` : ` (down ${-trend.delta})`}.`
      : '';
    const quiet = lastClose && lastClose.ms > QUIET_NOTE_MS
      ? ` Nothing has closed for ${hoursText(lastClose.ms)}.`
      : '';
    return {
      state: 'MOVING', kind: null, exitCode: 0, stalled: false,
      why: `${closedLast24h} ticket(s) reached Live in the last ${hours}h.${quiet}${flat}`,
    };
  }

  if (!queue || queue.openWork === 0) {
    return {
      state: 'IDLE', kind: null, exitCode: 0, stalled: false,
      why: `Nothing closed in the last ${hours}h, and there was nothing a loop could close — no `
        + `open work a loop moves.${parkedText(queue)} This is healthy: a zero here is correct, not a stall.`,
    };
  }

  // A ZERO THAT MIGHT NOT BE A ZERO. A finished ticket with no closure date is
  // invisible to `closedSince`, so if one of those was edited inside the
  // window it may well have shipped inside it — and the whole stall rests on
  // the count being zero. Reported as UNKNOWN rather than STALLED: the alarm
  // still reaches the bus (loop_throughput.mjs posts UNKNOWN too), but it does
  // not accuse the pipeline of a stall on a number it cannot stand behind.
  if (Number(undatedRecent) > 0) {
    const n = Number(undatedRecent);
    return {
      state: 'UNKNOWN', kind: 'undated-closure', exitCode: 2, stalled: false,
      why: `Nothing DATED reached Live in the last ${hours}h while ${queue.openWork} ticket(s) sat `
        + `open — but ${n} finished ticket(s) carry no closure date and were edited inside that `
        + 'window, so one of them may well have shipped in it. That would make this a false '
        + 'stall, so it is reported as unknown rather than as a stall. Check the queue\'s '
        + '`Live` tickets by hand: one there with no closure date is the cause.',
    };
  }

  const firing = queueTouched === true
    ? 'Something edited a ticket in the queue inside the window, so the tracker is not frozen — '
      + 'but the tracker bumps that timestamp on ANY edit (a comment, a priority change), so it does '
      + 'NOT show that a loop pass ran.'
      + (hasHeartbeat ? ' `npm run heartbeat` covers the schedule half of this.' : '')
    : queueTouched === false
      ? 'Nothing in the queue was edited at all inside the window — not a status, not a '
        + 'comment — so start with whether the lanes are running at all'
        + (hasHeartbeat ? ' (`npm run heartbeat`).' : ' (`scripts/install_loop_runner.sh --status`).')
      : 'Whether anything touched the queue could not be determined from here, so this says '
        + 'nothing about the schedule either way.';

  return {
    state: 'STALLED', kind: null, exitCode: 1, stalled: true,
    why: `Nothing reached Live in the last ${hours}h while ${queue.openWork} ticket(s) sat open `
      + `(${queue.queued} queued, ${queue.inFlight} in flight).${parkedText(queue)} ${firing}`,
  };
}

// --- rendering --------------------------------------------------------------

function bar(count, max, width = 20) {
  if (!max) return '';
  return '█'.repeat(Math.max(count > 0 ? 1 : 0, Math.round((count / max) * width)));
}

/** The whole report, for a person at a terminal. */
function renderReport({ verdict: v, closed, curve, plateau, rework, queue, now, undated = 0, lastClose = null, trend = null }) {
  const max = closed.reduce((m, d) => Math.max(m, d.count), 0);
  const lines = [];
  lines.push(`Throughput — is the queue getting shorter?  (${mountainTime(new Date(now).toISOString())})`);
  lines.push('');
  lines.push(`  ${v.state}`);
  lines.push(`  ${v.why}`);
  lines.push('');
  // Stated on every run, whatever the verdict. It is the one number that
  // would have answered "has anything shipped since I went to bed?" without
  // reading a log by hand, and it costs a line.
  lines.push(lastClose
    ? `Last ticket reached Live ${hoursText(lastClose.ms)} ago.`
    : 'No ticket in the queue carries a closure date, so "last closed" cannot be said.');
  lines.push('');
  lines.push('Tickets closed per day');
  for (const d of closed) {
    lines.push(`  ${d.date}  ${String(d.count).padStart(3)}  ${bar(d.count, max)}`);
  }
  lines.push('');
  lines.push('Open work at the end of each day');
  for (const d of curve) lines.push(`  ${d.date}  ${String(d.open).padStart(3)}`);
  // Printed on every run, unlike the plateau line below it, which is anchored
  // on today's depth and therefore says nothing at all on a RISING backlog.
  if (trend) {
    lines.push(`  → ${trend.first} → ${trend.last} over ${trend.days} days`
      + `${trend.delta === 0 ? ' — level.' : trend.delta > 0 ? ` — UP ${trend.delta}.` : ` — down ${-trend.delta}.`}`);
  }
  if (plateau.days > 1) {
    lines.push(`  → ${plateau.depth} or more open every day since ${plateau.since} (${plateau.days} days).`);
  }
  if (undated > 0) {
    // Said rather than silently absorbed: the curve treats these as closed for
    // the whole window, so the earlier days here read slightly LOW.
    lines.push(`  → ${undated} finished ticket(s) carry no closure date, so the earlier days are `
      + 'a little low. Today\'s row is exact.');
  }
  lines.push('');
  lines.push('Queue now');
  lines.push(`  ${queue.queued} queued, ${queue.inFlight} in flight, ${queue.openWork} a loop can move.`);
  lines.push(`  ${queue.waitingOnDane || 0} waiting on Dane, ${queue.requested || 0} requested (no loop moves these).`);
  lines.push('');
  lines.push('Rework pull requests (open, ticket waiting to be re-claimed)');
  if (!rework.rows.length) {
    lines.push('  none.');
  } else {
    for (const r of rework.rows) {
      lines.push(`  #${r.number}  ${r.ageMs === null ? 'age unknown' : `opened ${ageText(r.ageMs)}`}`);
    }
    if (rework.oldest) {
      lines.push(`  → the oldest was opened ${ageText(rework.oldest.ageMs)}.`);
    }
  }
  return lines.join('\n');
}

/**
 * The bus message for a stall. Written for somebody who was NOT already
 * suspicious — it names the number that is zero, the number that is not, and
 * the one command that says more.
 */
/**
 * THE NUMBERS THAT MAKE AN ALERT ACTIONABLE — one set, shared by two posts.
 *
 * WHY IT IS SHARED (2026-09-02, review round 1 of task 86bbr2jpq, finding 2).
 * `verdict` returns UNKNOWN before it can ever reach STALLED, so a genuine
 * stall that happens to coincide with one recently-edited undated closure
 * announced itself through `renderUnknownPost` — which carried none of these.
 * No queued/in-flight breakdown, no plateau, no oldest rework PR: the alert
 * arrived stripped of every number that makes it worth acting on, in the case
 * where acting on it mattered most. A stall is still the likelier reading on
 * that path, so the evidence travels with it. Built in one place so the two
 * posts cannot drift apart, which is the failure this whole file is about.
 */
function evidenceBullets({
  closed, plateau, rework, queue, reworkUnreadable = null, undated = 0, kind = 'stall',
}) {
  const week = closed.reduce((s, d) => s + d.count, 0);
  const lines = [
    `- ${week} ticket(s) closed across the last ${closed.length} days; **0** dated in the last 24h.`,
    `- ${queue.queued} queued, ${queue.inFlight} in flight; ${queue.waitingOnDane || 0} waiting on Dane (not counted as stuck).`,
  ];
  if (plateau.days > 1) {
    lines.push(`- ${plateau.depth} or more open every day since ${plateau.since} (${plateau.days} days).`);
  }
  // THE MISSING NUMBER HAS TO SAY IT IS MISSING (docs/DOCTRINE.md 3.11, and
  // 2026-09-01 task 86bbr2jpq finding 5). This is the alert's most actionable
  // line — the one that names a branch to go and finish — and when `gh` could
  // not be read it simply was not printed. An absent bullet reads as "no
  // rework PRs", which is the opposite of what is known. The terminal report
  // already handled this correctly; only the bus post did not.
  //
  // THE THIRD CASE IS THE HOLE THE FIRST FIX LEFT (2026-09-02, review round 1,
  // finding 3). `gh` can read perfectly and still yield no age: if no rework
  // PR's `createdAt` parses, `reworkPrs` returns a non-empty `rows` with
  // `oldest` null and no `why` at all — so the caveat above did not fire, and
  // the bullet vanished with nothing said. That is the same silent omission,
  // arriving through the fix for it. `reworkPrs` sorts such a PR LAST rather
  // than dropping it, for exactly this reason; the post keeps that promise.
  if (reworkUnreadable) {
    lines.push(`- Oldest rework PR: **could NOT be read** (${reworkUnreadable}) — that number is `
      + 'missing here, not zero.');
  } else if (rework.oldest) {
    lines.push(`- Oldest rework PR **#${rework.oldest.number}** was opened ${ageText(rework.oldest.ageMs)}.`);
  } else if (Array.isArray(rework.rows) && rework.rows.length) {
    lines.push(`- ${rework.rows.length} rework PR(s) open, **none with a readable open date** `
      + `(${rework.rows.map((r) => `#${r.number}`).join(', ')}) — that age is missing here, not zero.`);
  }
  // The same caveat the terminal report carries. The per-day counts are read
  // off `date_closed`, so a finished ticket without one is missing from every
  // day of the week total above — said out loud rather than absorbed.
  if (Number(undated) > 0) {
    lines.push(`- ${Number(undated)} finished ticket(s) carry no closure date, so the `
      + `${closed.length}-day count above reads a little low. `
      + (kind === 'undated'
        ? 'One of them was edited inside the last 24h, which is what makes this UNKNOWN.'
        : 'The last 24h is unaffected — an undated closure inside the window makes this UNKNOWN '
          + 'rather than a stall.'));
  }
  return lines;
}

/**
 * The "did anything stop firing?" line, only where the project has the
 * `heartbeat` script (SP-266 brings it). Before that it would be a dead
 * command as an alarm's first step, so the lane status names it instead.
 */
function heartbeatLines(hasHeartbeat) {
  return hasHeartbeat
    ? ['npm run heartbeat             # did anything stop firing?']
    : ['scripts/install_loop_runner.sh --status   # are the lanes loaded and running?'];
}

function renderStallPost({
  verdict: v, closed, plateau, rework, queue, now, node = '', lastClose = null,
  reworkUnreadable = null, undated = 0, hasHeartbeat = false,
}) {
  const lines = [
    'ALARM: 🐌 **The queue is not getting shorter.**',
    '',
    v.why,
    '',
    ...evidenceBullets({ closed, plateau, rework, queue, reworkUnreadable, undated, kind: 'stall' }),
  ];
  lines.push(
    '',
    'Nothing failed and nothing went quiet — those alarms would have fired on their own. This is the',
    'other half: the loops ran, exited 0, and shipped nothing, which writes a cheerful log and reads',
    'as health.',
    '',
    'Look with:',
    '```',
    'npm run throughput            # this report in full',
    'npm run clickup -- wip-check  # is the merge side full?',
    ...heartbeatLines(hasHeartbeat),
    '```',
    '',
    `_Noticed at ${mountainTime(new Date(now).toISOString())}${node ? ` by ${node}` : ''}. `
      + `Repeated at most once every ${Math.round(REPOST_EVERY_MS / 3600000)} hours until the queue moves._`,
  );
  return lines.join('\n');
}

/**
 * THE OTHER UNKNOWN, WHICH IS NOT AN OUTAGE AT ALL (2026-09-02, review round 1
 * of task 86bbr2jpq, finding 1).
 *
 * `renderUnknownPost` was shared by both UNKNOWN verdicts and its fixed text
 * only described one of them. Rendered on THIS path it headlined "the stall
 * detector could not take a reading", said "nothing in the system is watching
 * whether the queue is getting shorter", and sent the reader off to check
 * whether ClickUp was reachable at all — when the reading had SUCCEEDED, every
 * number existed, and the repair was one ticket in `Live` missing a closure
 * date. Only the middle paragraph, `v.why`, was true.
 *
 * That is the same shape as finding 3 on this very ticket: a message asserting
 * something its evidence does not support, in the direction that costs the
 * reader the most. Two verdicts, two messages.
 *
 * It carries the stall evidence because a stall is still the likelier reading
 * here — see `evidenceBullets`.
 */
function renderUndatedPost({ verdict: v, now, node = '', evidence = null }) {
  const ids = Array.isArray(evidence && evidence.undatedIds)
    ? evidence.undatedIds.filter(Boolean).map(String) : [];
  const lines = [
    '\u2753 **The last 24 hours cannot be read as a zero.**',
    '',
    v.why,
    '',
  ];
  if (evidence && evidence.closed && evidence.queue && evidence.plateau && evidence.rework) {
    lines.push(...evidenceBullets({
      closed: evidence.closed,
      plateau: evidence.plateau,
      rework: evidence.rework,
      queue: evidence.queue,
      reworkUnreadable: evidence.reworkUnreadable || null,
      undated: evidence.undated || 0,
      kind: 'undated',
    }));
    lines.push('');
  }
  lines.push(
    'The reading itself SUCCEEDED — the tracker answered and the numbers above are real. What cannot',
    'be trusted is the single zero the stall test rests on, because a finished ticket carrying no',
    'closure date is invisible to it. A stall is still the likelier reading, so treat this as a',
    'stall alert with an asterisk rather than as an outage.',
    '',
    'The repair is one field: give that ticket a closure date. Until it has one, any further edit',
    'to it re-arms the 24h window and this message will keep saying the same thing.',
    '',
    'Look with:',
    '```',
    'npm run throughput            # this report in full, unthrottled',
  );
  if (ids.length) {
    for (const id of ids.slice(0, 5)) {
      lines.push(`npm run clickup -- get --task ${id}   # the ticket with no closure date`);
    }
    if (ids.length > 5) lines.push(`# ...and ${ids.length - 5} more like it`);
  } else {
    lines.push("# the queue's `Live` tickets — one there with no closure date is the cause");
  }
  lines.push(
    'npm run clickup -- wip-check  # is the merge side full?',
    '```',
    '',
    `_Noticed at ${mountainTime(new Date(now).toISOString())}${node ? ` by ${node}` : ''}. `
      + `Repeated at most once every ${Math.round(REPOST_EVERY_MS / 3600000)} hours until that `
      + 'ticket carries a closure date._',
  );
  return lines.join('\n');
}

/**
 * The bus message for an UNKNOWN verdict — the alarm that never had one.
 *
 * WHY IT EXISTS (2026-09-01, task 86bbr2jpq, finding 1). `verdict` has always
 * had four states and `loop_throughput.mjs` has always exited 2 on UNKNOWN,
 * but `run_bus_relay.sh` discards that exit code with `|| true` and nothing
 * else looked at it. So the one state whose whole purpose is "a monitor must
 * not fail quietly" was the one state that failed quietly: a rotated ClickUp
 * token or a sustained rate limit left the stall alarm permanently dead, with
 * a line in a launchd log nobody reads and every other job looking fine.
 *
 * NOT ROUTED THROUGH scripts/report_job_failure.mjs, which was the ticket's
 * suggested fix, and the reason is worth keeping. That reporter renders "a
 * scheduled job FAILED" and carries a log tail; it has nowhere to put a
 * REASON. The throughput check did not fail — it ran perfectly and could not
 * take a reading, which is a different finding with a different repair, and
 * the acceptance criterion is explicit that the reason has to reach the bus.
 * The suppression discipline IS shared: the same `dueAgain`, the same six
 * hours, a stamp in the same folder, cleared by the next readable pass.
 */
function renderUnknownPost({ verdict: v, now, node = '', evidence = null, hasHeartbeat = false }) {
  // TWO UNKNOWNS, TWO MESSAGES. The wording below describes an unreadable
  // queue and nothing else; the undated-closure verdict gets its own, because
  // on that path the reading worked perfectly. See `renderUndatedPost`.
  if (v && v.kind === 'undated-closure') return renderUndatedPost({ verdict: v, now, node, evidence });
  return [
    '\u2753 **The stall detector could not take a reading.**',
    '',
    v.why,
    '',
    'This is NOT a stall and NOT an all-clear — it is the check saying it cannot see. While it',
    'reads this way, nothing in the system is watching whether the queue is getting shorter, so a',
    'real stall would go unannounced.',
    '',
    'Look with:',
    '```',
    'npm run throughput            # take a reading by hand, unthrottled',
    'npm run clickup -- queue      # can the tracker be read at all?',
    ...heartbeatLines(hasHeartbeat),
    '```',
    '',
    `_Noticed at ${mountainTime(new Date(now).toISOString())}${node ? ` by ${node}` : ''}. `
      + `Repeated at most once every ${Math.round(REPOST_EVERY_MS / 3600000)} hours until a `
      + 'reading succeeds._',
  ].join('\n');
}

/**
 * The door's `tickets --json --include-closed` objects (lib/ticketsJson.js) in
 * the ClickUp-style shape every reader above was written against (SP-268):
 * `status.status`, and millisecond strings in `date_created`, `date_updated`
 * and `date_closed`.
 *
 * The tracker records no closure time of its own, so a finished ticket's
 * `date_closed` is the time it entered its finished status (`statusSince`,
 * from the ticket's own history). A finished ticket whose `statusSince`
 * cannot be read gets none, and is then an undated closure: counted and said
 * out loud, never guessed (`undatedClosure`). An open ticket gets none.
 * Anything not a list is no tickets.
 */
function fromTicketsJson(rows) {
  const millis = (iso) => {
    const t = Date.parse(iso || '');
    return Number.isFinite(t) ? String(t) : null;
  };
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r && typeof r === 'object')
    .map((r) => {
      const status = String(r.status ?? '').trim().toLowerCase();
      return {
        id: String(r.id),
        name: r.name,
        status: { status },
        date_created: millis(r.created),
        date_updated: millis(r.updated),
        date_closed: TERMINAL_STATUSES.includes(status) ? millis(r.statusSince) : null,
        // How it ended (SP-347): a Won't do, Duplicate or Test ending is no closure (finishedAt).
        outcome: r.outcome ?? null,
      };
    });
}

module.exports = {
  fromTicketsJson,
  DAY_MS,
  REPORT_DAYS,
  STALL_WINDOW_MS,
  QUIET_NOTE_MS,
  depthTrend,
  hoursText,
  sinceLastClose,
  TERMINAL_STATUSES,
  workTickets,
  ageText,
  closedAt,
  finishedAt,
  closedPerDay,
  closedSince,
  createdAt,
  depthPerDay,
  depthPlateau,
  dueAgain,
  evidenceBullets,
  recentUndatedClosures,
  recentUndatedClosureTasks,
  renderUnknownPost,
  updatedAt,
  LOCAL_DAYS,
  MOUNTAIN_DAYS,
  UTC_DAYS,
  dayWindow,
  queueShape,
  undatedClosures,
  renderReport,
  renderStallPost,
  reworkPrs,
  verdict,
};
