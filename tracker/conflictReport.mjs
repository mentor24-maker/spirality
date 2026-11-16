/**
 * Merge conflicts, and the pipeline settings in force when each happened
 * (SP-295), for the Reporting page's Merge Conflicts section.
 *
 * WHY THIS EXISTS. Dane is shortening the wake times (Settings page, SP-236)
 * and wants to see what that costs in merge conflicts rather than guess:
 * "set up diagnostics where we can identify the points where the timer
 * settings resulted in merge conflicts." More work at once means more pull
 * requests open against the same `main`, so the figure that compares fairly
 * across settings is conflicts per merged pull request, by the settings in
 * force, not a raw count.
 *
 * NOTHING NEW IS WRITTEN. Every fact is already in the tracker: the loops'
 * conflict notes, the status history, the `PR opened:` lines and every
 * settings change (`pipeline_setting_changes`). Working it out on each read
 * means the report covers the whole history, the baseline before any change
 * included, and cannot drift from what the notes say.
 *
 * WHAT COUNTS AS A CONFLICT. Three notes say a ticket's pull request no
 * longer merges into `main`:
 *
 *   MAIN MOVED: PR #<merged> -> PR #<pr> — conflict   lib/mainMoved.js, after every merge
 *   MERGE NOT DONE (authorization <id>, reason conflict)
 *                                                       a relay refusing Dane's merge word
 *                                                       (WaveCenter's relay writes it; the
 *                                                       shape is read here, not built)
 *   CONFLICT TICKET FILED: PR #<pr> — <url>            lib/conflictWork.js, a catch-up ticket
 *
 * One conflict (an "episode") can produce several notes: every later merge
 * writes another MAIN MOVED on a pull request that still conflicts, a retried
 * merge word another MERGE NOT DONE. So notes on the same ticket and pull
 * request join one conflict until it is over, and it is over when:
 *   - a later MAIN MOVED on that pull request is not a conflict (it merges
 *     cleanly now);
 *   - the ticket moves into In review or Live (a build pass merged `main` in
 *     before handing over, or the pull request merged);
 *   - a second CONFLICT TICKET FILED arrives (the first catch-up landed and
 *     `main` moved again: conflictWork.js calls that new work, so it is a new
 *     conflict).
 *
 * WHAT IS WORKED OUT, NOT RECORDED, and so is an estimate:
 *   - open pull requests at the time: tickets in the same project whose first
 *     `PR opened:` line is before it and which had not yet reached Live (or
 *     another closed status);
 *   - the merge that caused it, for a conflict that opened without a MAIN
 *     MOVED note: the newest merge in the project before it, marked
 *     `causeInferred`;
 *   - siblings: the two tickets came from one request when one says
 *     `Sliced from` the other, both say `Sliced from` the same ticket, or
 *     both carry the same `## Asked` words (loop-intake copies Dane's words
 *     onto every slice).
 *
 * Pure: the caller (pageData.mjs, conflictsOf) reads the store and passes
 * plain rows in, so every rule here is tested without a database.
 */
import loopStatuses from '../lib/loopStatuses.js';

/** The settings shown beside each conflict: the wake times of the lanes that open and merge pull requests, and the cap. */
export const CONFLICT_SETTINGS = Object.freeze([
  Object.freeze({ key: 'wake.loop-build', short: 'build' }),
  Object.freeze({ key: 'wake.loop-review', short: 'review' }),
  Object.freeze({ key: 'wake.relay', short: 'relay' }),
  Object.freeze({ key: 'wip-cap', short: 'cap' }),
]);

/** How many conflicts the page lists, newest first; the counts always cover every one. */
export const CONFLICT_LIST_LIMIT = 200;

/** How many of the most-conflicted files the page names. */
export const TOP_FILES = 10;

const MAIN_MOVED_RE = /^MAIN MOVED:\s*PR\s*#(\d+)\s*->\s*PR\s*#(\d+)\s*—\s*(no-overlap|same-files|conflict|cannot-tell)\b/im;
const MERGE_REFUSED_RE = /^MERGE NOT DONE\s*\([^)]*\breason conflict\)/im;
const MERGE_REFUSED_PR_RE = /\bPR\s*#(\d+)\s+conflicts\b/i;
const CATCH_UP_RE = /^CONFLICT TICKET FILED:\s*PR\s*#(\d+)\s*—\s*(\S+)/im;
const PR_OPENED_RE = /^PR opened:\s*https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/im;
const FILES_RE = /conflicts in:\s*((?:`[^`\n]+`(?:,\s*)?)+)/i;
/** A merge, as the relays record it: Spirality's (mergeOnComment.js, clickup.mjs) and WaveCenter's own relay. */
const MERGED_RES = Object.freeze([
  /^Merged(?: by Lane [^:\n]+)?:\s*PR\s*#(\d+)\b/m,
  /^MERGED:\s*https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/m,
]);
/** WaveCenter's relay, after a build pass settled a conflict on a ticket in Ready to launch. */
const SETTLED_RE = /^CONFLICT SETTLED\b/m;
const SLICED_FROM_RE = /^Sliced from\s+([A-Za-z]+-\d+)\b/im;
const ASKED_RE = /^##\s*Asked\s*\n+```[^\n]*\n([\s\S]*?)\n```/m;

const { LIVE, IN_REVIEW, TERMINAL_STATUSES } = loopStatuses;

/** The statuses that end a pull request's time open. */
const CLOSED_STATUSES = new Set(TERMINAL_STATUSES);
/** The statuses a build pass hands over in after merging `main` in: a conflict before it is settled. */
const SETTLED_STATUSES = new Set([IN_REVIEW, LIVE]);

/**
 * One comment read as a conflict signal, or null when it is not one.
 * `{ kind: 'main-moved' | 'merge-refused' | 'catch-up', pr, merged?, clean?, files }`
 */
export function readSignal(body) {
  const text = String(body ?? '');
  const moved = MAIN_MOVED_RE.exec(text);
  if (moved) {
    const clean = moved[3] === 'no-overlap' || moved[3] === 'same-files';
    const files = moved[3] === 'conflict' ? filesOf(text) : [];
    return { kind: 'main-moved', merged: Number(moved[1]), pr: Number(moved[2]), clean, conflict: moved[3] === 'conflict', files };
  }
  if (MERGE_REFUSED_RE.test(text)) {
    const pr = MERGE_REFUSED_PR_RE.exec(text);
    return { kind: 'merge-refused', pr: pr ? Number(pr[1]) : null, files: [] };
  }
  const filed = CATCH_UP_RE.exec(text);
  if (filed) return { kind: 'catch-up', pr: Number(filed[1]), files: [] };
  return null;
}

/** The files a MAIN MOVED conflict note names, in its order. */
function filesOf(text) {
  const m = FILES_RE.exec(text);
  if (!m) return [];
  return [...m[1].matchAll(/`([^`]+)`/g)].map((x) => x[1]);
}

/** The pull request number a relay's merge note records, or null. */
export function mergedNumber(body) {
  const text = String(body ?? '');
  for (const re of MERGED_RES) {
    const m = re.exec(text);
    if (m) return Number(m[1]);
  }
  return null;
}

/** The pull request number a `PR opened:` comment records, or null. */
export function prOpenedNumber(body) {
  const m = PR_OPENED_RE.exec(String(body ?? ''));
  return m ? Number(m[1]) : null;
}

/** The keys that tie a ticket to the request it was split from (see the header). */
export function familyKeys(ticket, slicedFromIds = new Set()) {
  const keys = new Set();
  const text = String(ticket.description ?? '');
  const from = SLICED_FROM_RE.exec(text);
  if (from) keys.add(`id:${from[1].toUpperCase()}`);
  if (slicedFromIds.has(String(ticket.id).toUpperCase())) keys.add(`id:${String(ticket.id).toUpperCase()}`);
  const asked = ASKED_RE.exec(text);
  const words = asked ? asked[1].replace(/\s+/g, ' ').trim() : '';
  if (words) keys.add(`asked:${words}`);
  return keys;
}

/** The status a ticket was in at `at` (ms), from its steps, or null before its first. */
function statusAt(steps, at) {
  let status = null;
  for (const [when, to] of steps) {
    if (when > at) break;
    status = to;
  }
  return status;
}

/** The newest pull request a ticket recorded, or null: the one a note without a number is about. */
function newestPrOf(window) {
  if (!window) return null;
  return [...window.opened.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

/** "5m", "1h", "90s": a wake time in seconds, short. */
export function shortSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  if (n % 3600 === 0) return `${n / 3600}h`;
  if (n % 60 === 0) return `${n / 60}m`;
  return `${n}s`;
}

/** One line naming a set of settings: "build 5m · review 10m · relay 1m · cap 5". */
export function settingsLabel(values) {
  return CONFLICT_SETTINGS.map(({ key, short }) => {
    const v = values?.[key];
    if (v == null) return `${short} ?`;
    return `${short} ${key === 'wip-cap' ? String(v) : shortSeconds(v)}`;
  }).join(' · ');
}

/**
 * The value each setting had at `at` (ms), from a project's changes and its
 * current values. A change at or before `at` gives its new value; none, and
 * the first change after `at` gives the value it replaced; no change at all,
 * and the value now is the value then.
 *
 * @param changes  `[{ setting, from, to, at }]`, any order
 * @param current  `{ [setting]: value }` now
 */
export function settingsAt(changes, current, at) {
  const out = {};
  const sorted = [...(changes ?? [])]
    .map((c) => ({ ...c, ms: Date.parse(c.at) }))
    .filter((c) => !Number.isNaN(c.ms))
    .sort((a, b) => a.ms - b.ms);
  for (const { key } of CONFLICT_SETTINGS) {
    const mine = sorted.filter((c) => c.setting === key);
    const before = mine.filter((c) => c.ms <= at).pop();
    const after = mine.find((c) => c.ms > at);
    out[key] = before ? before.to : after ? after.from : current?.[key] ?? null;
  }
  return out;
}

/**
 * Every conflict, and conflicts per merged pull request by the settings in
 * force.
 *
 * @param tickets `[{ id, name, project, description, steps: [[ms, status]],
 *                 comments: [{ at: ms, body }] }]`, every ticket in scope
 * @param settings `{ [project]: { changes, current } }` (store rows)
 * @returns {{ total, merged, rate, bySetting, conflicts, listed, topFiles, siblings }}
 */
export function conflictReportOf({ tickets, settings = {} }) {
  const slicedFrom = new Set();
  for (const t of tickets) {
    const m = SLICED_FROM_RE.exec(String(t.description ?? ''));
    if (m) slicedFrom.add(m[1].toUpperCase());
  }
  const families = new Map(tickets.map((t) => [t.id, familyKeys(t, slicedFrom)]));
  const settingsFor = (project, at) => {
    const s = settings[project] ?? {};
    return settingsAt(s.changes, s.current, at);
  };

  // Each ticket's pull requests (number -> first opened, ms), when its time
  // open ended, and its merges: the relay's merge note, else (no note) its
  // status change into Live after the pull request opened. A ticket imported
  // already Live has neither, and is counted as no merge rather than a guess.
  const prWindows = new Map();
  const merges = [];
  const mergeByPr = new Map();
  const addMerge = (m) => {
    const key = `${m.project}#${m.pr}`;
    if (mergeByPr.has(key)) return;
    mergeByPr.set(key, m);
    merges.push(m);
  };
  for (const t of tickets) {
    const opened = new Map();
    let mergedAt = null;
    for (const c of [...t.comments].sort((a, b) => a.at - b.at)) {
      const n = prOpenedNumber(c.body);
      if (n != null && !opened.has(n)) opened.set(n, c.at);
      const m = mergedNumber(c.body);
      if (m != null) {
        addMerge({ ticket: t.id, project: t.project, pr: m, at: c.at });
        if (mergedAt == null) mergedAt = c.at;
      }
    }
    if (!opened.size) continue;
    const first = Math.min(...opened.values());
    const closedStep = t.steps.find(([when, to]) => when >= first && CLOSED_STATUSES.has(to));
    const nowClosed = CLOSED_STATUSES.has(t.steps[t.steps.length - 1]?.[1]);
    const end = mergedAt != null && mergedAt >= first ? mergedAt
      : closedStep ? closedStep[0]
        : nowClosed ? first // closed, but nothing says when: not counted as open
          : Infinity;
    prWindows.set(t.id, { opened, start: first, end });
    const live = [...t.steps].reverse().find(([when, to]) => to === LIVE && when >= first);
    if (mergedAt == null && live && t.steps[t.steps.length - 1]?.[1] === LIVE) {
      addMerge({ ticket: t.id, project: t.project, pr: newestPrOf({ opened }), at: live[0] });
    }
  }
  merges.sort((a, b) => a.at - b.at);

  const openPrsAt = (project, at) => {
    let n = 0;
    for (const t of tickets) {
      if (t.project !== project) continue;
      const w = prWindows.get(t.id);
      if (w && w.start <= at && at < w.end) n += 1;
    }
    return n;
  };

  const conflicts = [];
  for (const t of tickets) {
    const events = [];
    for (const c of t.comments) {
      const s = readSignal(c.body);
      if (s) events.push({ at: c.at, signal: s });
      else if (SETTLED_RE.test(c.body) || mergedNumber(c.body) != null) events.push({ at: c.at, settled: true });
    }
    if (!events.length) continue;
    for (const [when, to] of t.steps) {
      if (SETTLED_STATUSES.has(to)) events.push({ at: when, settled: true });
    }
    events.sort((a, b) => a.at - b.at || (a.settled ? -1 : 1));
    const open = new Map(); // pr -> episode
    const close = (pr) => open.delete(pr);
    for (const e of events) {
      if (e.settled) { open.clear(); continue; }
      const s = e.signal;
      const pr = s.pr ?? newestPrOf(prWindows.get(t.id));
      if (s.kind === 'main-moved' && !s.conflict) {
        if (s.clean) close(pr);
        continue;
      }
      let ep = open.get(pr);
      if (ep && s.kind === 'catch-up' && ep.kinds.includes('catch-up')) { close(pr); ep = null; }
      if (!ep) {
        ep = { ticket: t, pr, at: e.at, kinds: [], merged: null, files: new Set() };
        open.set(pr, ep);
        conflicts.push(ep);
      }
      if (!ep.kinds.includes(s.kind)) ep.kinds.push(s.kind);
      if (s.kind === 'main-moved' && ep.merged == null) ep.merged = s.merged;
      for (const f of s.files) ep.files.add(f);
    }
  }

  const rows = conflicts.map((ep) => {
    const t = ep.ticket;
    let causeInferred = false;
    let merged = ep.merged;
    if (merged == null) {
      const before = merges.filter((m) => m.project === t.project && m.at <= ep.at && m.ticket !== t.id).pop();
      merged = before ? before.pr : null;
      causeInferred = merged != null;
    }
    const cause = merged == null ? null : mergeByPr.get(`${t.project}#${merged}`) ?? null;
    const mine = families.get(t.id) ?? new Set();
    const theirs = cause ? families.get(cause.ticket) ?? new Set() : new Set();
    const sibling = cause ? [...mine].some((k) => theirs.has(k)) : null;
    const opened = ep.pr != null ? prWindows.get(t.id)?.opened.get(ep.pr) : undefined;
    const values = settingsFor(t.project, ep.at);
    return {
      ticket: t.id,
      name: t.name,
      project: t.project,
      pr: ep.pr,
      at: new Date(ep.at).toISOString(),
      kinds: ep.kinds,
      status: statusAt(t.steps, ep.at),
      prOpenMs: opened != null && opened <= ep.at ? ep.at - opened : null,
      openPrs: openPrsAt(t.project, ep.at),
      causedBy: merged == null ? null : { pr: merged, ticket: cause?.ticket ?? null, inferred: causeInferred },
      sibling,
      files: [...ep.files],
      settings: values,
      setting: settingsLabel(values),
    };
  }).sort((a, b) => b.at.localeCompare(a.at));

  // Conflicts per merged pull request, by the settings in force at each.
  const groups = new Map();
  const group = (label) => {
    if (!groups.has(label)) groups.set(label, { setting: label, merged: 0, conflicts: 0, since: null, until: null });
    return groups.get(label);
  };
  const stretch = (g, iso) => {
    if (g.since == null || iso < g.since) g.since = iso;
    if (g.until == null || iso > g.until) g.until = iso;
  };
  for (const m of merges) {
    const g = group(settingsLabel(settingsFor(m.project, m.at)));
    g.merged += 1;
    stretch(g, new Date(m.at).toISOString());
  }
  for (const r of rows) {
    const g = group(r.setting);
    g.conflicts += 1;
    stretch(g, r.at);
  }
  const rate = (c, m) => (m > 0 ? c / m : null);
  const bySetting = [...groups.values()]
    .map((g) => ({ ...g, rate: rate(g.conflicts, g.merged) }))
    .sort((a, b) => String(b.until).localeCompare(String(a.until)));

  const fileCounts = new Map();
  for (const r of rows) for (const f of r.files) fileCounts.set(f, (fileCounts.get(f) ?? 0) + 1);
  const topFiles = [...fileCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_FILES)
    .map(([file, count]) => ({ file, count }));

  const known = rows.filter((r) => r.sibling != null);
  return {
    total: rows.length,
    merged: merges.length,
    rate: rate(rows.length, merges.length),
    bySetting,
    conflicts: rows.slice(0, CONFLICT_LIST_LIMIT),
    listed: Math.min(rows.length, CONFLICT_LIST_LIMIT),
    withFiles: rows.filter((r) => r.files.length).length,
    topFiles,
    siblings: { known: known.length, count: known.filter((r) => r.sibling).length },
  };
}
