/**
 * The Reporting page's figures (SP-364 split them out of pageData.mjs,
 * which re-exports them): the time ranges, growth, the time split and
 * reportsOf.
 */
import loopStatuses from '../lib/loopStatuses.js';
import mergeOnComment from '../lib/mergeOnComment.js';
import humanHours from '../lib/humanHours.js';
import ticketClass from '../lib/ticketClass.js';
import loopNoticeboards from '../lib/loopNoticeboards.js';
import { conflictReportOf } from './conflictReport.mjs';
import { visibleProjects, trailComments } from './pageData-common.mjs';

const { STAGE_ORDER, LIVE, QUEUED, BUILDING, REWORK, OPERATOR_HELD_STATUSES, TERMINAL_STATUSES, statusOf } = loopStatuses;
const { isMergeCommand, isReviewVerdict, isReviewPassed } = mergeOnComment;
const { findHumanHours } = humanHours;
const { workTickets } = loopNoticeboards;
const { KINDS, KIND_LABELS, STARTERS, STARTER_LABELS, NOT_FINISHED_OUTCOMES, OUTCOME_LABELS, countsAsFinished } = ticketClass;

/**
 * The kinds the Reporting page splits by (SP-347): lib/ticketClass.js's four,
 * in its order, then `none`, a ticket not given one yet, counted as such and
 * never guessed.
 */
export const REPORT_KINDS = Object.freeze([
  ...KINDS.map((key) => Object.freeze({ key, label: KIND_LABELS[key] })),
  Object.freeze({ key: 'none', label: 'No Kind Yet' }),
]);

/** Who started a ticket, the same way: the three starters, then `none`. */
export const REPORT_STARTERS = Object.freeze([
  ...STARTERS.map((key) => Object.freeze({ key, label: STARTER_LABELS[key] })),
  Object.freeze({ key: 'none', label: 'Not Recorded' }),
]);

/** The endings that close a ticket without finishing it, as the page lists them. */
export const REPORT_NOT_FINISHED = Object.freeze(NOT_FINISHED_OUTCOMES.map((key) => Object.freeze({ key, label: OUTCOME_LABELS[key] })));

/** A ticket's kind as REPORT_KINDS keys it: its kind, or `none`. */
function kindKey(ticket) {
  return KINDS.includes(ticket.kind) ? ticket.kind : 'none';
}

/** Who started it, as REPORT_STARTERS keys it. */
function starterKey(ticket) {
  return STARTERS.includes(ticket.startedBy) ? ticket.startedBy : 'none';
}

/**
 * A project's tickets the Reporting page counts: every one but its
 * noticeboards (the Team chat and anything tagged `noticeboard`), which sit
 * in Live as standing boards and would read as finished work, and every post
 * to them as time spent. lib/loopNoticeboards.js alone decides which they
 * are.
 */
function reportedTickets(store, slug) {
  return workTickets(store.listTickets(slug));
}

/** The Reporting page's time ranges, newest first; `days: null` is all time. */
export const REPORT_RANGES = Object.freeze([
  Object.freeze({ key: 'week', label: 'Last 7 Days', days: 7 }),
  Object.freeze({ key: 'month', label: 'Last 30 Days', days: 30 }),
  Object.freeze({ key: 'all', label: 'All Time', days: null }),
]);

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The custom range's days (SP-368), oldest first, each `{ day, started:
 * 0, finished: 0 }` with `day` the ISO time it starts. A day is 24 hours
 * from the range's start forward; the range from the start of one date to
 * the end of another is a whole number of them, give or take the hour a
 * clock change adds or takes away, which the last day absorbs. So every
 * moment in the range falls in exactly one day, and the days add up to the
 * range's totals. At least one day.
 */
export function customDaysOf({ from, to }) {
  const count = Math.max(1, Math.round((to - from + 1) / DAY_MS));
  return Array.from({ length: count }, (_, i) => ({ day: new Date(from + i * DAY_MS).toISOString(), started: 0, finished: 0 }));
}

/**
 * The Task Productivity table's Growth Rate timeframes (SP-241): each
 * compares the last `days` days before now with the `days` days before
 * those.
 */
export const GROWTH_PERIODS = Object.freeze([
  Object.freeze({ key: 'week', label: 'Weekly', days: 7 }),
  Object.freeze({ key: 'month', label: 'Monthly', days: 30 }),
  Object.freeze({ key: 'year', label: 'Annual', days: 365 }),
]);

/**
 * One growth figure: `current` and `previous` counts, and `change`, the
 * percentage change from previous to current rounded to a whole number, or
 * null with `reason`: 'too-young' when the first ticket in scope was filed
 * after the earlier period began (not a whole period to compare), else
 * 'none-before' when the earlier period had no tasks. `reason` is null
 * whenever `change` is a number.
 */
export function growthFigure(current, previous, { firstFiled, start }) {
  if (firstFiled == null || firstFiled > start) return { current, previous, change: null, reason: 'too-young' };
  if (previous === 0) return { current, previous, change: null, reason: 'none-before' };
  return { current, previous, change: Math.round(((current - previous) / previous) * 100), reason: null };
}

/**
 * When a ticket last entered Live, from its history: the newest event that
 * moved its status to Live (or filed it there). Null when it is not Live
 * now, so a ticket moved to Live and back out counts nowhere, and one moved
 * there twice counts once, at its latest move. A ticket that arrived already
 * Live (an import from ClickUp) has only its filing event, at its original
 * time, to go by.
 */
function closedLiveAt(store, ticket) {
  if (ticket.status !== LIVE) return null;
  let at = null;
  for (const e of store.listEvents(ticket.id)) {
    if ((e.field === 'status' || e.field === 'created') && e.to === LIVE) at = e.at;
  }
  return at;
}

/**
 * When a ticket finished: when it last entered Live (closedLiveAt), unless
 * it ended Won't do, Duplicate or Test (lib/ticketClass.js
 * `countsAsFinished`), which closes it without finishing anything.
 */
function finishedAt(store, ticket) {
  return countsAsFinished(ticket.outcome) ? closedLiveAt(store, ticket) : null;
}

/**
 * A ticket's status history as [time in ms, status] steps, oldest first: its
 * filing, then every status change. Steps whose time cannot be read are
 * left out.
 */
function statusSteps(store, ticket) {
  const steps = [];
  for (const e of store.listEvents(ticket.id)) {
    if (e.field !== 'status' && e.field !== 'created') continue;
    const at = Date.parse(e.at);
    if (!Number.isNaN(at)) steps.push([at, e.to]);
  }
  return steps;
}

/**
 * How a finished ticket's work flowed, from its status steps up to `doneAt`
 * (ms, when it last entered Live):
 *  - toFinish: ms from first entering Queued to doneAt, or null when it
 *    never entered Queued (an import, or a ticket filed straight past it);
 *  - sentBack: whether it ever entered Rework;
 *  - waited: ms spent in the operator's two stages (Needs your input,
 *    Ready to launch) before doneAt.
 */
function flowOf(steps, doneAt) {
  const queued = steps.find(([, status]) => status === QUEUED);
  let waited = 0;
  steps.forEach(([at, status], i) => {
    if (at >= doneAt || !OPERATOR_HELD_STATUSES.includes(status)) return;
    const until = i + 1 < steps.length ? Math.min(steps[i + 1][0], doneAt) : doneAt;
    waited += Math.max(0, until - at);
  });
  return {
    toFinish: queued && queued[0] <= doneAt ? doneAt - queued[0] : null,
    sentBack: steps.some(([at, status]) => status === REWORK && at <= doneAt),
    waited,
  };
}

/**
 * The four buckets a ticket's time goes into (SP-220), in the order the
 * Reporting page lists them: a loop working on it (Building), waiting for
 * the next lane to wake, waiting on the operator, and broken (a lane's
 * failure note sits on it).
 */
export const TIME_BUCKETS = Object.freeze(['working', 'lane', 'operator', 'broken']);

/**
 * A lane's failure note: a line that starts `FAILED:`, `<lane> FAILED:` or
 * `<lane> GAVE UP:` (an optional `**` in front, for one written in bold).
 * Line-anchored on purpose: a note that mentions "FAILED:" mid-sentence is
 * talking about a failure, not reporting one.
 */
const FAILURE_NOTE = /^[ \t]*(?:\*\*)?(?:FAILED:|[a-z][\w-]* (?:FAILED|GAVE UP):)/m;

/** Does this text carry a lane's failure note? */
export function isFailureNote(text) {
  return FAILURE_NOTE.test(String(text ?? ''));
}

/**
 * Cut one ticket's life into stretches and put each in exactly one of the
 * TIME_BUCKETS, by these rules, in order:
 *  1. broken: from a machine comment carrying a failure note until the next
 *     status change or the next comment from the operator, whichever first;
 *  2. operator: in Needs your input or Ready to launch while the newest
 *     comment is not the operator's own (the contract's "Is this waiting on
 *     Dane?" rule, operatorSpokeLast), and, in Ready to launch, his merge
 *     word does not still stand (SP-285: said since the newest review PASS;
 *     the relay holds it while a conflict is worked, standingMergeWord);
 *  3. working: in Building;
 *  4. lane: every other stage but Live (Requested, Queued, Rework, In
 *     review, and the operator's two once his reply is the newest word).
 * Live time is not counted; an open ticket counts up to `now`.
 *
 * `steps` are the ticket's [ms, status] steps oldest first (statusSteps);
 * `comments` are `{ at, byMachine, byOperator }`, `at` in ms, and
 * `failure` when it is a machine's failure note, `verdict` ('pass' or
 * 'fail') when it is a review verdict, `mergeWord` when it is his merge
 * phrase. Answers the stretches as
 * `{ from, to, bucket }`, oldest first, touching end to end; none before the
 * ticket's first step.
 */
export function timeSplitOf(steps, comments, { now }) {
  if (!steps.length) return [];
  const events = [
    ...steps.map(([at, status]) => ({ at, status })),
    ...comments.filter((c) => Number.isFinite(c.at)).map((c) => ({ at: c.at, comment: c })),
  ].filter((e) => e.at <= now);
  // Same moment: the status change first, so a failure note written with a move counts from it.
  const rank = (e) => (e.status !== undefined ? 0 : 1);
  events.sort((a, b) => a.at - b.at || rank(a) - rank(b));
  const stretches = [];
  let status = null;
  let broken = false;
  let operatorLast = false;
  let passed = false;
  let mergeStanding = false;
  const bucketNow = () => {
    if (status == null || status === LIVE) return null;
    if (broken) return 'broken';
    const merging = status === 'ready to launch' && mergeStanding;
    if (OPERATOR_HELD_STATUSES.includes(status) && !operatorLast && !merging) return 'operator';
    if (status === BUILDING) return 'working';
    return 'lane';
  };
  let from = null;
  let bucket = null;
  const close = (at) => {
    if (bucket != null && at > from) {
      const last = stretches[stretches.length - 1];
      if (last && last.bucket === bucket && last.to === from) last.to = at;
      else stretches.push({ from, to: at, bucket });
    }
    from = at;
    bucket = bucketNow();
  };
  for (const e of events) {
    close(e.at);
    if (e.status !== undefined) {
      status = e.status;
      broken = false;
    } else {
      const c = e.comment;
      operatorLast = Boolean(c.byOperator);
      if (c.verdict) {
        passed = c.verdict === 'pass';
        mergeStanding = false;
      }
      if (c.byOperator && c.mergeWord && passed) mergeStanding = true;
      if (c.byOperator) broken = false;
      else if (c.byMachine && c.failure) broken = true;
    }
    bucket = bucketNow();
  }
  close(now);
  return stretches;
}

/** How many ms of `stretches` fall in each bucket between `start` (or the beginning, null) and `end`. */
function bucketTotals(stretches, start, end) {
  const totals = Object.fromEntries(TIME_BUCKETS.map((b) => [b, 0]));
  for (const s of stretches) {
    const from = start == null ? s.from : Math.max(s.from, start);
    const to = Math.min(s.to, end);
    if (to > from) totals[s.bucket] += to - from;
  }
  return totals;
}

/** How many tickets the Where the Time Goes section lists per range, most time first. */
export const TIME_SPLIT_TICKETS = 10;

/** The middle of a list of numbers (the mean of the middle two when even); null when empty. */
function median(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * One range's flow figures from the flows of the tickets finished in it.
 * Durations are in ms; a figure with nothing to count is null, never 0.
 */
function flowFigures(flows) {
  const timed = flows.map((f) => f.toFinish).filter((ms) => ms != null);
  const waits = flows.map((f) => f.waited);
  const sentBack = flows.filter((f) => f.sentBack).length;
  return {
    finished: flows.length,
    timeToFinish: {
      counted: timed.length,
      leftOut: flows.length - timed.length,
      median: median(timed),
      longest: timed.length ? Math.max(...timed) : null,
    },
    sentBack: { count: sentBack, share: flows.length ? sentBack / flows.length : null },
    waiting: { total: flows.length ? waits.reduce((a, b) => a + b, 0) : null, median: median(waits) },
  };
}

/**
 * One range's human-hours figures from the estimates (null where a finished
 * ticket has none) of the tickets finished in it, over `days` days. With no
 * estimate in the range the hours and the per-day figure are null, never 0:
 * "no estimates yet" is not "no work". Per day is rounded to one decimal.
 */
function humanHoursFigures(estimates, days) {
  const known = estimates.filter((h) => h != null);
  const hours = known.length ? known.reduce((a, b) => a + b, 0) : null;
  return {
    finished: estimates.length,
    estimated: known.length,
    notEstimated: estimates.length - known.length,
    hours,
    days,
    perDay: hours == null ? null : Math.round((hours / days) * 10) / 10,
  };
}

/**
 * Merge Conflicts (SP-295): every merge conflict in these projects, with the
 * pipeline settings in force at the time, and conflicts per merged pull
 * request by those settings. conflictReport.mjs works it out from plain
 * rows; this reads them: each ticket's status steps and comments, and each
 * project's settings changes and current values. All time, not by range:
 * the comparison is between settings, and each setting has its own dates.
 */
function conflictsOf(store, projects) {
  const tickets = [];
  const settings = {};
  for (const p of projects) {
    settings[p.slug] = {
      changes: store.pipelineSettingChanges(p.slug, { limit: 100000 }),
      current: Object.fromEntries(store.pipelineSettings(p.slug).map((c) => [c.key, c.value])),
    };
    for (const ticket of reportedTickets(store, p.slug)) {
      tickets.push({
        id: ticket.id,
        name: ticket.name,
        project: p.slug,
        description: ticket.description ?? '',
        steps: statusSteps(store, ticket),
        comments: store.listComments(ticket.id)
          .map((c) => ({ at: Date.parse(c.createdAt), body: c.body }))
          .filter((c) => !Number.isNaN(c.at)),
      });
    }
  }
  return conflictReportOf({ tickets, settings });
}

/**
 * The Reporting page's figures for one project (`project`, a slug) or, with
 * none, every project:
 *  - finished: how many tickets entered Live in each REPORT_RANGES range,
 *    by their latest move there (finishedAt);
 *  - started: how many tickets were filed in each range;
 *  - open: a count for every stage that is not terminal (not Live), in the
 *    contract's STAGE_ORDER, with the colour chosen for it in Settings (or
 *    null);
 *  - flow: per range, for the tickets finished in it (flowOf, flowFigures):
 *    time from first Queued to Live (median and longest, leaving out and
 *    counting those never Queued), how many went to Rework at least once
 *    and their share, and total and median time in the operator's stages;
 *  - humanHours: per range (humanHoursFigures), the build loop's
 *    human-hours estimates (lib/humanHours.js, the newest `PR opened:`
 *    comment's) of the tickets finished in it added up, how many had one
 *    and how many did not, and the total per day of the range; all time
 *    runs from the first ticket filed in scope, at least one day;
 *  - waitingNow: how many tickets sit in the operator's stages now;
 *  - timeSplit: per range, where every ticket's time in it went (open ones
 *    too, timeSplitOf), as `total` ms and, per TIME_BUCKETS bucket, its `ms`
 *    and `share` of the total (null when the total is 0), and `tickets`: the
 *    TIME_SPLIT_TICKETS with the most time in the range, each with its id,
 *    exact name, project, `total` and its ms per bucket. A stretch that
 *    starts before the range counts only its part inside it.
 * A range counts what happened in the last `days` days before `now`.
 * Noticeboards are left out of every figure (reportedTickets).
 * Null when `project` names no project. `only` narrows "every project" to
 * the ones the reader may see (visibleProjects), and a `project` outside it
 * is answered as no project, the same as one that does not exist.
 *
 * `custom` (SP-240), `{ from, to }` in ms, is the Task Productivity table's
 * own date range: the answer then carries `custom: { from, to, started,
 * finished }` (times as ISO strings), counted the same way as the fixed
 * ranges, with both ends included. Without it the answer has no `custom`.
 * `custom.days` (SP-368) splits those two counts by day for the Task
 * Productivity chart (customDaysOf), so the days add up to the totals.
 *
 * `growth` (SP-241): per GROWTH_PERIODS key, `{ started, finished }`, each a
 * growthFigure comparing the last `days` days before `now` with the `days`
 * before those, counted the same way as the fixed ranges; `growthPeriods`
 * names them for the page's picker, Weekly first.
 *
 * By kind (SP-347). A ticket finished only when it entered Live and did not
 * end Won't do, Duplicate or Test (finishedAt); those three are counted
 * apart, per range, by when they last entered Live, in `notFinished` (keyed
 * by ending, `endings` names them). `kind`, a REPORT_KINDS key ('none' for a
 * ticket with no kind yet), narrows every figure above to that kind's
 * tickets, all but `conflicts`, which stays every conflict; null is every
 * kind. Whatever `kind` is, the answer also carries, over every kind:
 *  - kinds: REPORT_KINDS, for the page's picker and rows;
 *  - byKind: per kind, `{ started, finished }` per range, counted as above;
 *  - efficiency: per range, the operational and feature tickets finished,
 *    `operationalPerFeature` (null when no feature finished) and
 *    `operationalTime`, the ms of the time split (timeSplitOf, every
 *    bucket) spent on operational tickets, the `total` over all tickets and
 *    its `share` (null when the total is 0).
 * And, for the tickets `kind` picks: `startedBy`, per REPORT_STARTERS key
 * (`starters` names them), how many of those finished in each range were
 * started by each.
 */
export function reportsOf(store, { project = null, now = Date.now(), only = null, custom = null, kind = null } = {}) {
  let projects = visibleProjects(store, only);
  if (project != null) {
    projects = projects.filter((p) => p.slug === project);
    if (!projects.length) return null;
  }
  const zero = () => Object.fromEntries(REPORT_RANGES.map((r) => [r.key, 0]));
  const finished = zero();
  const started = zero();
  const inRange = (r, when) => r.days == null || (when > now - r.days * DAY_MS && when <= now);
  const customCounts = { started: 0, finished: 0 };
  const customDays = custom ? customDaysOf(custom) : [];
  const growthCounts = Object.fromEntries(GROWTH_PERIODS.map((g) => [g.key, {
    started: { current: 0, previous: 0 }, finished: { current: 0, previous: 0 },
  }]));
  const tally = (counts, at, kind) => {
    const when = Date.parse(at);
    if (Number.isNaN(when)) return;
    for (const r of REPORT_RANGES) {
      if (inRange(r, when)) counts[r.key] += 1;
    }
    if (custom && when >= custom.from && when <= custom.to) {
      customCounts[kind] += 1;
      customDays[Math.min(Math.floor((when - custom.from) / DAY_MS), customDays.length - 1)][kind] += 1;
    }
    for (const g of GROWTH_PERIODS) {
      const span = g.days * DAY_MS;
      if (when > now - span && when <= now) growthCounts[g.key][kind].current += 1;
      else if (when > now - 2 * span && when <= now - span) growthCounts[g.key][kind].previous += 1;
    }
  };
  const flows = Object.fromEntries(REPORT_RANGES.map((r) => [r.key, []]));
  const estimates = Object.fromEntries(REPORT_RANGES.map((r) => [r.key, []]));
  let firstFiled = null;
  let waitingNow = 0;
  const colours = store.stageColours();
  const openStages = STAGE_ORDER.filter((name) => !TERMINAL_STATUSES.includes(statusOf(name)));
  const open = new Map(openStages.map((name) => [statusOf(name), 0]));
  const split = Object.fromEntries(REPORT_RANGES.map((r) => [r.key, []]));
  const byKind = Object.fromEntries(REPORT_KINDS.map((k) => [k.key, { started: zero(), finished: zero() }]));
  const startedBy = Object.fromEntries(REPORT_STARTERS.map((k) => [k.key, zero()]));
  const notFinished = Object.fromEntries(REPORT_NOT_FINISHED.map((k) => [k.key, zero()]));
  const kindTime = Object.fromEntries(REPORT_RANGES.map((r) => [r.key, { operational: 0, total: 0 }]));
  /** Add one to `counts` for every fixed range `at` (ISO) falls in. */
  const inRanges = (counts, at) => {
    const when = Date.parse(at);
    if (Number.isNaN(when)) return;
    for (const r of REPORT_RANGES) if (inRange(r, when)) counts[r.key] += 1;
  };
  const machineActor = new Map();
  const isMachineActor = (id) => {
    if (!machineActor.has(id)) machineActor.set(id, store.getActor(id)?.kind === 'machine');
    return machineActor.get(id);
  };
  for (const p of projects) {
    for (const ticket of reportedTickets(store, p.slug)) {
      const comments = store.listComments(ticket.id).map((c) => {
        const byMachine = isMachineActor(c.author);
        const byOperator = p.operator != null && c.author === p.operator && !byMachine;
        return {
          at: Date.parse(c.createdAt),
          byMachine,
          byOperator,
          failure: byMachine && isFailureNote(c.body),
          verdict: isReviewVerdict(c.body) ? (isReviewPassed(c.body) ? 'pass' : 'fail') : null,
          mergeWord: byOperator && isMergeCommand(c.body),
        };
      });
      const ofKind = kindKey(ticket);
      const picked = kind == null || ofKind === kind;
      const stretches = timeSplitOf(statusSteps(store, ticket), comments, { now });
      for (const r of REPORT_RANGES) {
        const totals = bucketTotals(stretches, r.days == null ? null : now - r.days * DAY_MS, now);
        const total = TIME_BUCKETS.reduce((n, b) => n + totals[b], 0);
        kindTime[r.key].total += total;
        if (ofKind === 'operational') kindTime[r.key].operational += total;
        if (total > 0 && picked) split[r.key].push({ id: ticket.id, name: ticket.name, project: p.slug, total, ...totals });
      }
      const done = finishedAt(store, ticket);
      inRanges(byKind[ofKind].started, ticket.createdAt);
      if (done) inRanges(byKind[ofKind].finished, done);
      if (!picked) continue;
      if (!done && ticket.status === LIVE) {
        const closed = closedLiveAt(store, ticket);
        if (closed && notFinished[ticket.outcome]) inRanges(notFinished[ticket.outcome], closed);
      }
      tally(started, ticket.createdAt, 'started');
      const filed = Date.parse(ticket.createdAt);
      if (!Number.isNaN(filed) && (firstFiled == null || filed < firstFiled)) firstFiled = filed;
      if (done) {
        tally(finished, done, 'finished');
        inRanges(startedBy[starterKey(ticket)], done);
        const doneAt = Date.parse(done);
        if (!Number.isNaN(doneAt)) {
          const flow = flowOf(statusSteps(store, ticket), doneAt);
          const hours = findHumanHours(trailComments(store, ticket.id));
          for (const r of REPORT_RANGES) {
            if (!inRange(r, doneAt)) continue;
            flows[r.key].push(flow);
            estimates[r.key].push(hours);
          }
        }
      }
      if (open.has(ticket.status)) open.set(ticket.status, open.get(ticket.status) + 1);
      if (OPERATOR_HELD_STATUSES.includes(ticket.status)) waitingNow += 1;
    }
  }
  return {
    project: project == null ? null : projects[0].slug,
    projectName: project == null ? null : projects[0].name,
    ranges: REPORT_RANGES.map(({ key, label }) => ({ key, label })),
    finished,
    started,
    open: openStages.map((name) => ({ status: name, count: open.get(statusOf(name)), colour: colours[statusOf(name)] ?? null })),
    flow: Object.fromEntries(REPORT_RANGES.map((r) => [r.key, flowFigures(flows[r.key])])),
    humanHours: Object.fromEntries(REPORT_RANGES.map((r) => {
      const days = r.days ?? (firstFiled == null ? 1 : Math.max(1, Math.ceil((now - firstFiled) / DAY_MS)));
      return [r.key, humanHoursFigures(estimates[r.key], days)];
    })),
    waitingNow,
    kind,
    kinds: REPORT_KINDS.map(({ key, label }) => ({ key, label })),
    byKind,
    efficiency: Object.fromEntries(REPORT_RANGES.map((r) => {
      const features = byKind.feature.finished[r.key];
      const operational = byKind.operational.finished[r.key];
      const t = kindTime[r.key];
      return [r.key, {
        features,
        operational,
        operationalPerFeature: features ? Math.round((operational / features) * 100) / 100 : null,
        operationalTime: { ms: t.operational, total: t.total, share: t.total > 0 ? t.operational / t.total : null },
      }];
    })),
    starters: REPORT_STARTERS.map(({ key, label }) => ({ key, label })),
    startedBy,
    endings: REPORT_NOT_FINISHED.map(({ key, label }) => ({ key, label })),
    notFinished,
    conflicts: conflictsOf(store, projects),
    ...(custom ? { custom: { from: new Date(custom.from).toISOString(), to: new Date(custom.to).toISOString(), ...customCounts, days: customDays } } : {}),
    growthPeriods: GROWTH_PERIODS.map(({ key, label }) => ({ key, label })),
    growth: Object.fromEntries(GROWTH_PERIODS.map((g) => {
      const start = now - 2 * g.days * DAY_MS;
      const figure = (kind) => growthFigure(growthCounts[g.key][kind].current, growthCounts[g.key][kind].previous, { firstFiled, start });
      return [g.key, { started: figure('started'), finished: figure('finished') }];
    })),
    timeSplit: Object.fromEntries(REPORT_RANGES.map((r) => {
      const rows = split[r.key];
      const total = rows.reduce((n, t) => n + t.total, 0);
      const buckets = Object.fromEntries(TIME_BUCKETS.map((b) => {
        const ms = rows.reduce((n, t) => n + t[b], 0);
        return [b, { ms, share: total > 0 ? ms / total : null }];
      }));
      const tickets = rows.slice()
        .sort((a, b) => b.total - a.total || a.id.localeCompare(b.id, undefined, { numeric: true }))
        .slice(0, TIME_SPLIT_TICKETS);
      return [r.key, { total, buckets, tickets }];
    })),
  };
}
