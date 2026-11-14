'use strict';

/**
 * SP-202 and SP-203: the relay runs the auto-merge lanes, and at the end of
 * an unopposed hour merges through the same GitHub gate a merge phrase uses,
 * inside the merge window. Every read and write is a fake here, and each fake
 * counts its calls, so a test can say not only what was written but that
 * nothing else was.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runLanePass, rehearsalNotice, parseRehearsalMarker, rehearsalAlreadySaid, ledgerAfterRehearsal,
  rehearsalDigestBody, REHEARSAL_ANNOUNCEMENT_LINE, isRehearsalAnnouncement,
} = require('./relayAutoMerge');
const {
  WINDOW_MS, CAP_PER_HOUR, CAP_PER_DAY, asLedger, isLaneNotice, parseAutoMergeMarker, announcementNotice,
  latestAutoMergeMarker,
} = require('./autoMergeLane');
const { asLease } = require('./mergeWindowLease');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const OPERATOR = 1;
const MACHINE = 4;
const REPO = 'acme/widgets';
const T0 = 1_790_000_000_000;

const DOCS = ['docs/GUIDE.md', 'lib/thing.test.js'];
const TOOLING = ['scripts/tool.mjs', 'docs/GUIDE.md'];
const GOVERNED = ['docs/GUIDE.md', 'CLAUDE.md'];

let nextId = 1;
// Each comment says its author's kind, as the door does (SP-26).
const comment = (text, { at = T0, user = MACHINE, kind = user === MACHINE ? 'machine' : 'human' } = {}) => ({ id: String(nextId++), date: String(at), comment_text: text, user: { id: user, kind } });
const machine = (text, at) => comment(text, { at, user: MACHINE });
const fromDane = (text, at) => comment(text, { at, user: OPERATOR });
const prOpened = (n, at = T0 - 2000) => machine(`PR opened: https://github.com/${REPO}/pull/${n}`, at);
const pass = (at = T0 - 1000) => machine('REVIEW: PASSED — every gate re-run', at);

const ticket = (id, n = 42) => ({ id, name: `Ticket ${id}`, status: { status: 'ready to launch' } });

/**
 * A fake world: one tracker (comments by ticket), one GitHub (files and PR
 * state by number), one bus, one ledger file, one clock.
 */
function world({
  files = { 42: DOCS }, prState = {}, bus = [], busOk = true, ledger = null, ledgerOk = true,
  postFails = false, busPostFails = false, start = T0,
  lease = null, windowOk = true, mergeResult = null, updateFails = false,
} = {}) {
  const w = {
    clock: start,
    comments: {},
    bus: bus.slice(),
    busPosts: [],
    ledgerFile: ledger ? asLedger(ledger) : asLedger(null),
    ledgerOk,
    saves: 0,
    calls: {
      readLedger: 0, saveLedger: 0, readBus: 0, postBus: 0, prFiles: 0, prView: 0, postNotice: 0, mainBuildIsRed: 0,
      readWindow: 0, saveWindow: 0, updateBranch: 0, merge: 0, recordMerge: 0,
    },
    posted: [],
    lease: asLease(lease),
    windowOk,
    merged: new Set(),
    mergedCalls: [],
    recorded: [],
    windowAtMerge: [],
  };
  w.io = {
    readLedger: () => { w.calls.readLedger++; return w.ledgerOk ? { ok: true, ledger: asLedger(w.ledgerFile), file: '/x' } : { ok: false, ledger: asLedger(null), file: '/x', why: 'the auto-merge ledger could not be read (bad JSON)' }; },
    saveLedger: (read, l) => { w.calls.saveLedger++; if (!read.ok) return { ok: false, skipped: true, why: 'not read cleanly' }; w.ledgerFile = asLedger(l); w.saves++; return { ok: true }; },
    readBus: async () => { w.calls.readBus++; return busOk ? { ok: true, messages: w.bus } : { ok: false, why: 'HTTP 503' }; },
    postBus: async (text) => { w.calls.postBus++; if (busPostFails) return { ok: false, why: 'HTTP 500' }; w.busPosts.push(text); return { ok: true }; },
    prFiles: (n) => { w.calls.prFiles++; return files[n] ? { ok: true, files: files[n] } : { ok: false, why: 'no such PR' }; },
    prView: (n) => {
      w.calls.prView++;
      if (w.merged.has(Number(n))) return { ok: true, pr: { number: n, state: 'MERGED', mergedAt: '2026-11-10T12:00:00Z' } };
      return { ok: true, pr: { number: n, state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', headRefName: `b-${n}`, headRefOid: `sha-${n}`, baseRefName: 'main', statusCheckRollup: [{ name: 'verify', status: 'COMPLETED', conclusion: 'SUCCESS' }], ...(prState[n] || {}) } };
    },
    readWindow: () => { w.calls.readWindow++; return w.windowOk ? { ok: true, lease: asLease(w.lease), file: '/lease' } : { ok: false, lease: asLease(null), file: '/lease', why: 'bad JSON' }; },
    saveWindow: (read, l) => { w.calls.saveWindow++; if (!read.ok) return { ok: false, skipped: true, why: 'not read cleanly' }; w.lease = asLease(l); return { ok: true }; },
    updateBranch: (n) => { w.calls.updateBranch++; if (updateFails) return { ok: false, why: 'merge conflict' }; prState[n] = { ...(prState[n] || {}), mergeStateStatus: 'CLEAN', statusCheckRollup: [{ name: 'verify', status: 'IN_PROGRESS', conclusion: '' }] }; return { ok: true }; },
    merge: async ({ task, pr }) => {
      w.calls.merge++;
      w.mergedCalls.push({ task: task.id, pr: pr.number });
      w.windowAtMerge.push(asLease(w.lease).windows[REPO] || null);
      const r = mergeResult || { outcome: 'merged', mergedAt: '2026-11-10T12:00:00Z', base: 'main' };
      if (r.outcome === 'merged') w.merged.add(Number(pr.number));
      return r;
    },
    recordMerge: async (o) => { w.calls.recordMerge++; w.recorded.push({ task: o.task.id, pr: o.pr.number, lane: o.laneName, alreadyMerged: Boolean(o.alreadyMerged) }); return { ok: true, dest: { status: 'Live', why: 'no Next slice line' }, problems: [] }; },
    postNotice: async (taskId, body) => {
      w.calls.postNotice++;
      if (postFails) return { ok: false, why: 'HTTP 500' };
      const c = machine(body, w.clock);
      (w.comments[taskId] = w.comments[taskId] || []).push(c);
      w.posted.push({ taskId, body });
      return { ok: true, at: w.clock, commentId: c.id };
    },
    mainBuildIsRed: () => { w.calls.mainBuildIsRed++; return { known: true, red: false }; },
  };
  w.seed = (taskId, list) => { w.comments[taskId] = list; };
  w.pass = (opts = {}) => {
    const tickets = opts.tickets || Object.keys(w.comments).map((id) => ticket(id));
    const read = tickets.map((t) => ({ task: t, comments: (w.comments[t.id] || []).slice() }));
    return runLanePass({
      lanes: ['A', 'B'],
      governancePaths: [],
      candidates: read,
      switchTickets: read,
      operatorId: OPERATOR,
      operatorName: 'Dane',
      repo: REPO,
      unchecked: opts.unchecked || [],
      dryRun: false,
      now: () => w.clock,
      clock: (ms) => `t+${Math.round((ms - T0) / 60000)}m`,
      tag: '[CC-test relay]',
      io: w.io,
      ...opts,
    });
  };
  return w;
}

const noWrites = (w) => {
  assert.equal(w.calls.postNotice, 0, 'nothing posted on a ticket');
  assert.equal(w.calls.postBus, 0, 'nothing posted to the bus');
  assert.equal(w.calls.saveLedger, 0, 'no ledger written');
  assert.equal(w.calls.saveWindow, 0, 'no merge window taken or freed');
  assert.equal(w.calls.merge, 0, 'nothing merged');
  assert.equal(w.calls.updateBranch, 0, 'no branch caught up');
  assert.equal(w.calls.recordMerge, 0, 'no ticket moved');
};

// ── 1. No lanes listed: nothing read, nothing written ───────────────────────

test('with autoMergeLanes [] the pass reads nothing, writes nothing and prints nothing', async () => {
  const w = world();
  w.seed('SP-1', [prOpened(42), pass()]);
  const out = await w.pass({ lanes: [] });
  assert.equal(out.ran, false);
  assert.equal(out.line, '');
  for (const [name, n] of Object.entries(w.calls)) assert.equal(n, 0, `${name} was called`);
});

test('a missing autoMergeLanes is the same as none', async () => {
  const w = world();
  w.seed('SP-1', [prOpened(42), pass()]);
  const out = await w.pass({ lanes: undefined });
  assert.equal(out.ran, false);
  for (const n of Object.values(w.calls)) assert.equal(n, 0);
});

test('lanes listed but no protected list: refused, said, and nothing read', async () => {
  const w = world();
  w.seed('SP-1', [prOpened(42), pass()]);
  const unchecked = [];
  const out = await w.pass({ governancePaths: null, unchecked });
  assert.equal(out.ran, true);
  assert.match(out.counts.halted, /governancePaths/);
  assert.equal(unchecked.length, 1);
  for (const n of Object.values(w.calls)) assert.equal(n, 0);
});

// ── 2. Lane A: announced, then merged after an unopposed hour ───────────────

test('a Lane A ticket is announced, merged after the hour with no comment, and moved on', async () => {
  const w = world();
  w.seed('SP-1', [prOpened(42), pass()]);

  const first = await w.pass();
  assert.equal(first.counts.announced, 1);
  assert.equal(w.posted.length, 1);
  const announcement = w.posted[0].body;
  assert.equal(parseAutoMergeMarker(announcement).kind, 'armed');
  assert.ok(!announcement.includes(REHEARSAL_ANNOUNCEMENT_LINE), 'a real announcement does not say it will not merge');
  assert.ok(w.busPosts.some((p) => /Lane A armed/.test(p) && /merges at/.test(p) && !/rehearsal/.test(p)));

  // Inside the hour: nothing.
  w.clock = T0 + 30 * 60 * 1000;
  const mid = await w.pass();
  assert.equal(mid.counts.waiting, 1);
  assert.equal(w.calls.merge, 0);
  assert.equal(w.posted.length, 1);

  // The hour is up, no comment: merged, inside the window, then moved on.
  w.clock = T0 + WINDOW_MS + 60 * 1000;
  const end = await w.pass();
  assert.equal(end.counts.merged, 1);
  assert.deepEqual(w.mergedCalls, [{ task: 'SP-1', pr: 42 }]);
  assert.equal(w.windowAtMerge[0].pr, 42, 'the merge window was held by this PR when it merged');
  assert.deepEqual(w.recorded, [{ task: 'SP-1', pr: 42, lane: 'A', alreadyMerged: false }], 'the ticket is moved on (Live or Queued) and main-moved runs, in the door');
  assert.equal(asLease(w.lease).windows[REPO], undefined, 'the window is free again');
  assert.ok(w.busPosts.some((p) => /MERGED by Lane A/.test(p) && /PR #42/.test(p) && /Live/.test(p)));
  assert.match(end.line, /1 merged/);
  // The ledger records it as a real merge, for the caps and the digest.
  const led = asLedger(w.ledgerFile);
  assert.equal(led.merges.length, 1);
  assert.ok(!led.merges[0].rehearsal);
  assert.equal(led.everMerged.count, 1);
  assert.equal(led.everMerged.lastPr, 42);
  assert.equal(w.posted.length, 1, 'no "would merge" note: the merge note is the door\'s');
});

test('the ledger is written the moment a lane merges, before the ticket is moved', async () => {
  const w = world();
  w.seed('SP-1', [prOpened(42), pass()]);
  await w.pass();
  w.clock = T0 + WINDOW_MS + 60 * 1000;
  let ledgerAtRecord = null;
  const record = w.io.recordMerge;
  w.io.recordMerge = async (o) => { ledgerAtRecord = asLedger(w.ledgerFile); return record(o); };
  await w.pass();
  assert.equal(ledgerAtRecord.everMerged.count, 1);
});

test('a merge whose ledger cannot be written says the rate cap lost it', async () => {
  const w = world();
  w.seed('SP-1', [prOpened(42), pass()]);
  await w.pass();
  w.clock = T0 + WINDOW_MS + 60 * 1000;
  w.io.saveLedger = () => ({ ok: false, why: 'disk full' });
  const unchecked = [];
  const out = await w.pass({ unchecked });
  assert.equal(out.counts.merged, 1);
  assert.ok(unchecked.some((l) => /rate cap has lost this merge/.test(l)));
});

// An announcement posted while the lane only rehearsed (SP-202) said nothing
// would merge. That promise is kept.
const rehearsalAnn = (n, at) => machine(announcementNotice({
  pr: { number: n, url: `https://github.com/${REPO}/pull/${n}` }, files: DOCS, deadlineLabel: 'x', at: 'iso', rehearsal: REHEARSAL_ANNOUNCEMENT_LINE,
}).body, at);

async function afterTheNote() {
  const w = world();
  w.seed('SP-1', [prOpened(42), pass(), rehearsalAnn(42, T0)]);
  w.clock = T0 + WINDOW_MS + 60 * 1000;
  const end = await w.pass();
  assert.equal(end.counts.wouldMerge, 1);
  assert.equal(end.counts.merged, 0);
  assert.equal(w.calls.merge, 0, 'a rehearsal announcement is never merged');
  assert.equal(w.posted.length, 1);
  const note = w.posted[0].body;
  assert.match(note, /^\*\*Would merge PR #42 now\. Nothing was merged\.\*\*/);
  assert.equal(parseRehearsalMarker(note).pr, 42);
  const led = asLedger(w.ledgerFile);
  assert.equal(led.merges[0].rehearsal, true);
  assert.equal(led.everMerged, null, 'a rehearsal is not a merge');
  return w;
}

test('an announcement made as a rehearsal ends in one "would merge" note, never a merge', async () => {
  const w = await afterTheNote();
  w.clock += 10 * 60 * 1000;
  const again = await w.pass();
  assert.equal(again.counts.wouldMerge, 0);
  assert.equal(again.counts.waiting, 1);
  assert.equal(w.posted.length, 1);
  assert.equal(w.calls.merge, 0);
});

test('a comment from Dane after the "would merge" note posts no cancel card', async () => {
  const w = await afterTheNote();
  w.comments['SP-1'].push(fromDane('what does this change exactly?', w.clock + 30 * 60 * 1000));
  w.clock += 31 * 60 * 1000;
  const out = await w.pass();
  assert.equal(out.counts.cancelled, 0, 'the window closed before he spoke');
  assert.equal(out.counts.waiting, 1, 'it is waiting on his word');
  assert.equal(w.posted.length, 1, 'nothing more said on the ticket');
  assert.ok(!w.busPosts.some((p) => /cancel|stopped/i.test(p)));
});

test('a day after the "would merge" note posts no stale cancel card', async () => {
  const w = await afterTheNote();
  w.clock = T0 + 25 * HOUR;
  const out = await w.pass();
  assert.equal(out.counts.cancelled, 0);
  assert.equal(out.counts.waiting, 1);
  assert.equal(w.posted.length, 1);
  w.comments['SP-1'].push(fromDane('still thinking', T0 + 6 * DAY));
  w.clock = T0 + 7 * DAY;
  const week = await w.pass();
  assert.equal(week.counts.cancelled, 0);
  assert.equal(w.posted.length, 1);
});

test('a Dane comment quoting the rehearsal line does not make a real announcement a rehearsal', () => {
  const ann = machine(announcementNotice({ pr: { number: 42, url: 'u' }, files: DOCS, deadlineLabel: 'x', at: 'iso' }).body, T0);
  assert.equal(isRehearsalAnnouncement([ann, fromDane(REHEARSAL_ANNOUNCEMENT_LINE, T0 + 1)], ann.id), false);
  const old = rehearsalAnn(42, T0);
  assert.equal(isRehearsalAnnouncement([old], old.id), true);
});

test('with checks running all day, a stale announcement is cancelled and never merged', async () => {
  const w = world({ prState: { 42: { statusCheckRollup: [{ name: 'verify', status: 'IN_PROGRESS', conclusion: '' }] } } });
  w.seed('SP-1', [prOpened(42), pass()]);
  await w.pass();
  w.clock = T0 + 25 * HOUR;
  const out = await w.pass();
  assert.equal(out.counts.cancelled, 1);
  assert.equal(parseAutoMergeMarker(w.posted[1].body).kind, 'cancelled');
  assert.equal(w.calls.merge, 0);
});

test('the module merges only through io.merge, and the door moves the ticket through io.recordMerge', () => {
  const w = world();
  assert.deepEqual(Object.keys(w.io).sort(), [
    'mainBuildIsRed', 'merge', 'postBus', 'postNotice', 'prFiles', 'prView', 'readBus', 'readLedger', 'readWindow',
    'recordMerge', 'saveLedger', 'saveWindow', 'updateBranch',
  ]);
});

test('a Lane B ticket runs too when B is listed, and not when only A is', async () => {
  const w = world({ files: { 7: TOOLING } });
  w.seed('SP-2', [prOpened(7), pass()]);
  const onlyA = await w.pass({ lanes: ['A'] });
  assert.equal(onlyA.counts.announced, 0);
  assert.equal(onlyA.counts.ineligible, 1);
  assert.equal(w.posted.length, 0);
  const both = await w.pass();
  assert.equal(both.counts.announced, 1);
  assert.equal(parseAutoMergeMarker(w.posted[0].body).lane, 'B');
});

test('at the end of the hour, checks still running: says nothing yet', async () => {
  const w = world({ prState: { 42: { statusCheckRollup: [{ name: 'verify', status: 'IN_PROGRESS', conclusion: '' }] } } });
  w.seed('SP-1', [prOpened(42), pass()]);
  await w.pass();
  w.clock = T0 + WINDOW_MS + 60 * 1000;
  const out = await w.pass();
  assert.equal(out.counts.waiting, 1);
  assert.equal(w.posted.length, 1);
});

test('at the end of the hour, red checks: cancelled, as a real merge would be', async () => {
  const w = world({ prState: { 42: { statusCheckRollup: [{ name: 'verify', status: 'COMPLETED', conclusion: 'FAILURE' }] } } });
  w.seed('SP-1', [prOpened(42), pass()]);
  await w.pass();
  w.clock = T0 + WINDOW_MS + 60 * 1000;
  const out = await w.pass();
  assert.equal(out.counts.cancelled, 1);
  assert.equal(parseAutoMergeMarker(w.posted[1].body).kind, 'cancelled');
  assert.equal(w.calls.merge, 0);
});

// ── 3. The objection ─────────────────────────────────────────────────────────

test('a comment from Dane in the hour cancels it', async () => {
  const w = world();
  w.seed('SP-1', [prOpened(42), pass()]);
  await w.pass();
  w.comments['SP-1'].push(fromDane('hold on, not this one', T0 + 5 * 60 * 1000));
  w.clock = T0 + 10 * 60 * 1000;
  const out = await w.pass();
  assert.equal(out.counts.cancelled, 1);
  assert.equal(parseAutoMergeMarker(w.posted[1].body).kind, 'cancelled');
  // And it stays cancelled: not merged after the hour.
  w.clock = T0 + 2 * WINDOW_MS;
  const later = await w.pass();
  assert.equal(later.counts.merged, 0);
  assert.equal(w.calls.merge, 0);
  assert.equal(later.counts.announced, 0);
  assert.equal(w.posted.length, 2);
});

test('a machine actor\'s comment in the hour does not cancel it, even under his id', async () => {
  const w = world();
  w.seed('SP-1', [prOpened(42), pass()]);
  await w.pass();
  // Even one carrying Dane's id, which is how a loop posting under his token reads back.
  w.comments['SP-1'].push(comment('MAIN MOVED: PR #40 merged into main — no-overlap', { at: T0 + 5 * 60 * 1000, user: OPERATOR, kind: 'machine' }));
  w.comments['SP-1'].push(machine('MAIN MOVED: PR #41 merged into main — no-overlap', T0 + 6 * 60 * 1000));
  w.clock = T0 + WINDOW_MS + 60 * 1000;
  const out = await w.pass();
  assert.equal(out.counts.cancelled, 0);
  assert.equal(out.counts.merged, 1);
});

// ── 4. Governance ────────────────────────────────────────────────────────────

test('a PR touching a floor governance path is never announced', async () => {
  const w = world({ files: { 42: GOVERNED } });
  w.seed('SP-1', [prOpened(42), pass()]);
  const out = await w.pass();
  assert.equal(out.counts.announced, 0);
  assert.equal(out.counts.ineligible, 1);
  assert.equal(w.posted.length, 0);
});

test('a PR touching one of the project\'s own governancePaths is never announced', async () => {
  const w = world({ files: { 42: ['docs/DOCTRINE.md'] } });
  w.seed('SP-1', [prOpened(42), pass()]);
  const out = await w.pass({ governancePaths: ['docs/DOCTRINE.md'] });
  assert.equal(out.counts.announced, 0);
  assert.equal(w.posted.length, 0);
  // The same file with an empty project list is plain documentation.
  const open = await w.pass({ governancePaths: [] });
  assert.equal(open.counts.announced, 1);
});

test('a PR that gains a governance file during the hour is cancelled, not merged', async () => {
  const files = { 42: DOCS };
  const w = world({ files });
  w.seed('SP-1', [prOpened(42), pass()]);
  await w.pass();
  files[42] = GOVERNED;
  w.clock = T0 + WINDOW_MS + 60 * 1000;
  const out = await w.pass();
  assert.equal(out.counts.cancelled, 1);
  assert.equal(out.counts.merged, 0);
  assert.equal(w.calls.merge, 0);
});

test('a PR in another repository is never a candidate', async () => {
  const w = world();
  w.seed('SP-1', [machine('PR opened: https://github.com/other/repo/pull/42', T0 - 2000), pass()]);
  const out = await w.pass();
  assert.equal(out.counts.announced, 0);
  assert.equal(w.calls.prFiles, 0);
});

// ── 5. The stop switch ───────────────────────────────────────────────────────

const busMsg = (text, at, authorId = OPERATOR, authorKind = 'human') => ({ id: String(nextId++), at, authorId, authorKind, ticket: 'BUS-1', text });

test('the stop phrase on the bus stops every announcement until the resume phrase', async () => {
  const w = world({ bus: [busMsg('please stop auto-merging for tonight', T0 - HOUR)] });
  w.seed('SP-1', [prOpened(42), pass()]);
  const stopped = await w.pass();
  assert.equal(stopped.counts.announced, 0);
  assert.match(stopped.counts.halted, /stopped/);
  assert.equal(w.posted.length, 0);

  // The stop is remembered even after the message leaves the bus's view.
  w.bus.length = 0;
  w.clock += 10 * 60 * 1000;
  const stillStopped = await w.pass();
  assert.equal(stillStopped.counts.announced, 0);
  assert.equal(w.posted.length, 0);

  w.bus.push(busMsg('resume auto-merging', w.clock - 1000));
  const resumed = await w.pass();
  assert.equal(resumed.counts.announced, 1);
});

test('the stop phrase on any ticket the relay read stops it too', async () => {
  const w = world();
  w.seed('SP-1', [prOpened(42), pass()]);
  w.seed('SP-9', [fromDane('stop auto-merging', T0 - HOUR)]);
  const out = await w.pass({
    tickets: [ticket('SP-1')],
    switchTickets: [{ task: ticket('SP-9'), comments: w.comments['SP-9'] }],
  });
  assert.equal(out.counts.announced, 0);
  assert.match(out.counts.halted, /ticket SP-9/);
});

test('a machine quoting the stop phrase on the bus does not stop it', async () => {
  const w = world({ bus: [busMsg('Reminder: say stop auto-merging to halt it', T0 - HOUR, OPERATOR, 'machine')] });
  w.seed('SP-1', [prOpened(42), pass()]);
  const out = await w.pass();
  assert.equal(out.counts.announced, 1);
});

test('an unreadable bus counts as stopped', async () => {
  const w = world({ busOk: false });
  w.seed('SP-1', [prOpened(42), pass()]);
  const out = await w.pass();
  assert.equal(out.counts.announced, 0);
  assert.match(out.counts.halted, /could not be read/);
  assert.ok(out.busSkipped.some((l) => /stop switch could not be read/.test(l)));
  assert.equal(w.posted.length, 0);
});

test('an unreadable ledger counts as stopped, and is never written over', async () => {
  const w = world({ ledgerOk: false });
  w.seed('SP-1', [prOpened(42), pass()]);
  const unchecked = [];
  const out = await w.pass({ unchecked });
  assert.equal(out.counts.announced, 0);
  assert.ok(unchecked.some((l) => /ledger could not be read/.test(l)));
  assert.equal(w.saves, 0, 'the unreadable ledger was not overwritten');
  assert.equal(w.posted.length, 0);
});

test('"resume auto-merging" with words around it is a near miss: answered once, and the lane stays stopped', async () => {
  const w = world({ bus: [busMsg('stop auto-merging', T0 - 2 * HOUR), busMsg('ok, resume auto-merging please', T0 - HOUR)] });
  w.seed('SP-1', [prOpened(42), pass()]);
  const out = await w.pass();
  assert.equal(out.counts.announced, 0);
  assert.equal(w.busPosts.filter((p) => /THAT DID NOT TAKE/.test(p)).length, 1);
  w.clock += 10 * 60 * 1000;
  await w.pass();
  assert.equal(w.busPosts.filter((p) => /THAT DID NOT TAKE/.test(p)).length, 1, 'answered once, not every pass');
});

// ── 6. Self-disable ──────────────────────────────────────────────────────────

test('a pass that could not verify something disables the lane, says so on the bus, and stays off until resumed', async () => {
  const w = world();
  w.seed('SP-1', [prOpened(42), pass()]);
  const out = await w.pass({ unchecked: ['SP-7: could not read its replies'] });
  assert.equal(out.counts.announced, 0);
  assert.ok(w.busPosts.some((p) => /AUTO-MERGE DISABLED ITSELF/.test(p) && /SP-7/.test(p)));
  w.clock += 10 * 60 * 1000;
  const next = await w.pass();
  assert.equal(next.counts.announced, 0, 'the latch holds on a clean pass');
  w.bus.push(busMsg('resume auto-merging', w.clock - 1000));
  const resumed = await w.pass();
  assert.equal(resumed.counts.announced, 1);
});

// ── 7. The caps ──────────────────────────────────────────────────────────────

test('the hourly cap holds, counting rehearsed merges', async () => {
  let l = asLedger(null);
  for (let i = 0; i < CAP_PER_HOUR; i++) l = ledgerAfterRehearsal(l, { at: T0 - (i + 1) * 60 * 1000, pr: 100 + i, lane: 'A' }, T0);
  const w = world({ ledger: { ...l, lastDigestAt: T0 } });
  w.seed('SP-1', [prOpened(42), pass()]);
  const out = await w.pass();
  assert.equal(out.counts.announced, 0);
  assert.match(out.counts.halted, /hourly auto-merge cap/);
});

test('the daily cap holds', async () => {
  let l = asLedger(null);
  for (let i = 0; i < CAP_PER_DAY; i++) l = ledgerAfterRehearsal(l, { at: T0 - (i + 2) * HOUR, pr: 100 + i, lane: 'A' }, T0);
  const w = world({ ledger: { ...l, lastDigestAt: T0 } });
  w.seed('SP-1', [prOpened(42), pass()]);
  const out = await w.pass();
  assert.equal(out.counts.announced, 0);
  assert.match(out.counts.halted, /daily auto-merge cap/);
});

test('the cap is re-checked per ticket inside a pass', async () => {
  let l = asLedger(null);
  for (let i = 0; i < CAP_PER_HOUR - 1; i++) l = ledgerAfterRehearsal(l, { at: T0 - (i + 1) * 60 * 1000, pr: 100 + i, lane: 'A' }, T0);
  const w = world({ ledger: { ...l, lastDigestAt: T0 }, files: { 42: DOCS, 43: DOCS } });
  // Two tickets whose hour is already up, so each would add a rehearsed merge.
  const ann = (n, at) => machine(announcementNotice({ pr: { number: n, url: `https://github.com/${REPO}/pull/${n}` }, files: DOCS, deadlineLabel: 'x', at: 'iso' }).body, at);
  w.seed('SP-1', [prOpened(42), pass(), ann(42, T0 - WINDOW_MS - 1000)]);
  w.seed('SP-2', [prOpened(43), pass(), ann(43, T0 - WINDOW_MS - 1000)]);
  assert.equal(latestAutoMergeMarker(w.comments['SP-1']).kind, 'armed');
  const out = await w.pass();
  assert.equal(out.counts.merged, 1);
  assert.equal(w.calls.merge, 1, 'the second ticket is not merged past the cap');
  assert.match(out.counts.halted, /hourly auto-merge cap/);
});

// ── 8. The digest ────────────────────────────────────────────────────────────

test('the digest posts to the bus once a day, "none" included', async () => {
  const w = world();
  const first = await w.pass({ tickets: [] });
  assert.equal(first.ran, true);
  const digests = () => w.busPosts.filter((p) => /Auto-merge digest/.test(p));
  assert.equal(digests().length, 1);
  assert.match(digests()[0], /\*\*none\*\*/);
  w.clock += 10 * 60 * 1000;
  await w.pass({ tickets: [] });
  assert.equal(digests().length, 1, 'not again ten minutes later');
  w.clock += DAY;
  await w.pass({ tickets: [] });
  assert.equal(digests().length, 2, 'again the next day');
});

test('the digest lists a rehearsed merge as would-have-merged, never as merged', () => {
  const l = ledgerAfterRehearsal(asLedger(null), { at: T0, pr: 42, lane: 'A', task: 'SP-1', files: DOCS }, T0);
  const body = rehearsalDigestBody({ ledger: l, since: T0 - DAY, sinceLabel: 'the last 24 hours', clockLabel: 'now' });
  assert.match(body, /\*\*none\*\*/);
  assert.match(body, /Would have merged/);
  assert.match(body, /PR #42/);
});

test('a digest that does not post is retried and said', async () => {
  const w = world({ busPostFails: true });
  const unchecked = [];
  await w.pass({ tickets: [], unchecked });
  assert.ok(unchecked.some((l) => /digest could not be posted/.test(l)));
  assert.equal(asLedger(w.ledgerFile).lastDigestAt, 0, 'the clock is not stamped on a failed post');
});

// ── 9. Failures say so ───────────────────────────────────────────────────────

test('an announcement that does not post arms nothing and says so', async () => {
  const w = world({ postFails: true });
  w.seed('SP-1', [prOpened(42), pass()]);
  const unchecked = [];
  const out = await w.pass({ unchecked });
  assert.equal(out.counts.announced, 0);
  assert.ok(unchecked.some((l) => /nothing is armed and nothing will merge/.test(l)));
});

test('an unreadable file list is said, not judged', async () => {
  const w = world({ files: {} });
  w.seed('SP-1', [prOpened(42), pass()]);
  const unchecked = [];
  await w.pass({ unchecked });
  assert.ok(unchecked.some((l) => /could not read PR #42's changed files/.test(l)));
  assert.equal(w.posted.length, 0);
});

test('a dry run posts nothing and writes no ledger', async () => {
  const w = world();
  w.seed('SP-1', [prOpened(42), pass()]);
  const out = await w.pass({ dryRun: true });
  assert.equal(out.counts.announced, 1);
  noWrites(w);
});

// ── The note itself ──────────────────────────────────────────────────────────

test('the rehearsal note is recognised only when a machine wrote it', () => {
  const n = rehearsalNotice({ pr: { number: 9, url: 'u' }, laneName: 'A', announcementId: '77', why: 'w', gateReason: 'g' });
  assert.equal(rehearsalAlreadySaid([machine(n.body)], 9, '77'), true);
  assert.equal(rehearsalAlreadySaid([fromDane(n.body)], 9, '77'), false);
  assert.equal(rehearsalAlreadySaid([machine(n.body)], 9, '78'), false, 'a new announcement gets its own note');
});

// ── 10. SP-203: the merge goes through every gate a merge phrase does ────────

/** A ticket whose hour is already up, announced by a real (not rehearsal) notice. */
const armedAnn = (n, at, files = DOCS) => machine(announcementNotice({
  pr: { number: n, url: `https://github.com/${REPO}/pull/${n}` }, files, deadlineLabel: 'x', at: 'iso',
}).body, at);
const hourUp = (opts = {}) => {
  const w = world(opts);
  w.seed('SP-1', [prOpened(42), pass(), armedAnn(42, T0 - WINDOW_MS - 60 * 1000, (opts.files && opts.files[42]) || DOCS)]);
  return w;
};

for (const [name, prState, why] of [
  ['red checks', { statusCheckRollup: [{ name: 'verify', status: 'COMPLETED', conclusion: 'FAILURE' }] }, /checks are red/],
  ['a conflict', { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }, /conflict/i],
  ['a closed PR', { state: 'CLOSED' }, /not open/],
  ['a draft', { isDraft: true }, /draft/],
]) {
  test(`a lane merge is refused on ${name}, as a phrase merge is: cancelled, never merged`, async () => {
    const w = hourUp({ prState: { 42: prState } });
    const out = await w.pass();
    assert.equal(w.calls.merge, 0);
    assert.equal(out.counts.cancelled, 1);
    assert.equal(parseAutoMergeMarker(w.posted[0].body).kind, 'cancelled');
    assert.match(w.posted[0].body, why);
    assert.equal(w.calls.saveWindow, 0, 'a refusal never takes the window');
  });
}

test('a lane merge is never made without a PASS: a send-back after the announcement stops it', async () => {
  const w = hourUp();
  w.comments['SP-1'].push(machine('REVIEW: sent back to Rework — the test does not fail when broken', T0 - 500));
  const out = await w.pass();
  assert.equal(w.calls.merge, 0);
  assert.equal(out.counts.merged, 0);
});

test('a ticket with no PASS is never announced, so never merged', async () => {
  const w = world();
  w.seed('SP-1', [prOpened(42)]);
  await w.pass();
  w.clock = T0 + 2 * WINDOW_MS;
  await w.pass();
  assert.equal(w.posted.length, 0);
  assert.equal(w.calls.merge, 0);
});

test('behind main: caught up inside the window, merged on a later pass once its checks are green', async () => {
  const prState = { 42: { mergeStateStatus: 'BEHIND' } };
  const w = hourUp({ prState });
  const first = await w.pass();
  assert.equal(w.calls.updateBranch, 1);
  assert.equal(w.calls.merge, 0, 'never merged on a green that described an older branch');
  assert.equal(first.counts.waiting, 1);
  assert.equal(asLease(w.lease).windows[REPO].pr, 42, 'the window is held while its checks re-run');

  // Checks still running on the caught-up branch: waits, holding the window.
  w.clock += 5 * 60 * 1000;
  await w.pass();
  assert.equal(w.calls.merge, 0);
  assert.equal(asLease(w.lease).windows[REPO].pr, 42);

  // Green: merged, window freed.
  prState[42].statusCheckRollup = [{ name: 'verify', status: 'COMPLETED', conclusion: 'SUCCESS' }];
  w.clock += 5 * 60 * 1000;
  const done = await w.pass();
  assert.equal(done.counts.merged, 1);
  assert.equal(asLease(w.lease).windows[REPO], undefined);
});

test('behind main and the catch-up fails: cancelled and the window freed', async () => {
  const w = hourUp({ prState: { 42: { mergeStateStatus: 'BEHIND' } }, updateFails: true });
  const out = await w.pass();
  assert.equal(out.counts.cancelled, 1);
  assert.match(w.posted[0].body, /could not be caught up/);
  assert.equal(asLease(w.lease).windows[REPO], undefined);
});

// ── 11. The merge window ─────────────────────────────────────────────────────

test('two lane tickets in one pass: one merges, the other waits for the window', async () => {
  const w = world({ files: { 42: DOCS, 43: DOCS }, prState: { 42: { mergeStateStatus: 'BEHIND' } } });
  w.seed('SP-1', [prOpened(42), pass(), armedAnn(42, T0 - WINDOW_MS - 60 * 1000)]);
  w.seed('SP-2', [prOpened(43), pass(), armedAnn(43, T0 - WINDOW_MS - 60 * 1000)]);
  const out = await w.pass();
  assert.equal(w.calls.updateBranch, 1, 'SP-1 is caught up and holds the window');
  assert.equal(w.calls.merge, 0, 'SP-2 does not move main under it');
  assert.equal(out.counts.waiting, 2);
});

test('a window held by another open PR blocks the lane merge; nothing is posted', async () => {
  const w = hourUp({ lease: { windows: { [REPO]: { pr: 99, takenAt: new Date(T0 - 5 * 60 * 1000).toISOString() } } } });
  const out = await w.pass();
  assert.equal(w.calls.merge, 0);
  assert.equal(out.counts.waiting, 1);
  assert.equal(w.posted.length, 0);
});

test('a window held by a PR that has since merged is freed first, and the lane merges', async () => {
  const w = hourUp({ lease: { windows: { [REPO]: { pr: 99, takenAt: new Date(T0 - 5 * 60 * 1000).toISOString() } } } });
  w.merged.add(99);
  const out = await w.pass();
  assert.equal(out.counts.merged, 1);
});

test('an unreadable merge window: nothing merges, and it is said', async () => {
  const w = hourUp({ windowOk: false });
  const unchecked = [];
  await w.pass({ unchecked });
  assert.equal(w.calls.merge, 0);
  assert.ok(unchecked.some((l) => /merge window could not be read/.test(l)));
});

// ── 12. The stop switch reaches the merge ────────────────────────────────────

test('the stop phrase on the bus after the announcement stops the merge until resumed', async () => {
  const w = hourUp();
  w.bus.push(busMsg('stop auto-merging', T0 - 10 * 60 * 1000));
  const stopped = await w.pass();
  assert.equal(w.calls.merge, 0);
  assert.match(stopped.counts.halted, /stopped/);
  w.bus.push(busMsg('resume auto-merging', T0 + 1000));
  w.clock = T0 + 2000;
  const resumed = await w.pass();
  assert.equal(resumed.counts.merged, 1);
});

// ── 13. A merge that cannot be confirmed turns the lanes off ─────────────────

test('a merge that ran and is not seen as MERGED latches the lanes off and says so on the bus', async () => {
  const w = world({ files: { 42: DOCS, 43: DOCS }, mergeResult: { outcome: 'not-observed', why: 'reads back as "OPEN", not MERGED' } });
  w.seed('SP-1', [prOpened(42), pass(), armedAnn(42, T0 - WINDOW_MS - 60 * 1000)]);
  w.seed('SP-2', [prOpened(43), pass(), armedAnn(43, T0 - WINDOW_MS - 60 * 1000)]);
  const unchecked = [];
  const out = await w.pass({ unchecked });
  assert.equal(w.calls.merge, 1, 'the second ticket is not tried');
  assert.equal(w.calls.recordMerge, 0, 'an unconfirmed merge moves no ticket');
  assert.match(out.counts.halted, /could not be confirmed/);
  assert.ok(w.busPosts.some((p) => /AUTO-MERGE DISABLED ITSELF/.test(p) && /PR #42/.test(p)));
  assert.ok(unchecked.some((l) => /could not be confirmed/.test(l)));
  const led = asLedger(w.ledgerFile);
  assert.equal(led.disabled.trigger, 'unconfirmed-merge');
  assert.equal(led.everMerged, null, 'not counted as a merge');

  // The next pass stays off, and so does the one after, until resumed.
  w.clock += 10 * 60 * 1000;
  const next = await w.pass();
  assert.equal(w.calls.merge, 1);
  assert.match(next.counts.halted, /latched off/);
});

test('a merge the merge step refuses (a failed pre-merge step) is cancelled and the window freed', async () => {
  const w = hourUp({ mergeResult: { outcome: 'refused', why: 'the project\'s pre-merge step failed' } });
  const out = await w.pass();
  assert.equal(out.counts.cancelled, 1);
  assert.match(w.posted[0].body, /pre-merge step failed/);
  assert.equal(asLease(w.lease).windows[REPO], undefined);
  assert.equal(asLedger(w.ledgerFile).everMerged, null);
});

test('a PR already merged at the end of the hour is moved on, not merged again and not counted', async () => {
  const w = hourUp();
  w.merged.add(42);
  const out = await w.pass();
  assert.equal(w.calls.merge, 0);
  assert.deepEqual(w.recorded, [{ task: 'SP-1', pr: 42, lane: 'A', alreadyMerged: true }]);
  assert.equal(out.counts.merged, 0);
  assert.equal(asLedger(w.ledgerFile).everMerged, null);
});

// ── 14. Governance, in both lanes, at merge time ─────────────────────────────

test('a PR touching a governance path is refused in both lanes', async () => {
  for (const files of [['docs/GUIDE.md', 'docs/DOCTRINE.md'], ['scripts/tool.mjs', 'docs/DOCTRINE.md'], ['scripts/tool.mjs', 'CLAUDE.md']]) {
    const w = world({ files: { 42: files } });
    w.seed('SP-1', [prOpened(42), pass()]);
    await w.pass({ governancePaths: ['docs/DOCTRINE.md'] });
    w.clock = T0 + 2 * WINDOW_MS;
    await w.pass({ governancePaths: ['docs/DOCTRINE.md'] });
    assert.equal(w.posted.length, 0, `${files.join(', ')} was announced`);
    assert.equal(w.calls.merge, 0, `${files.join(', ')} was merged`);
  }
});

test('a Lane B PR that gains a governance file after the announcement is cancelled at merge time', async () => {
  const files = { 7: TOOLING };
  const w = world({ files });
  w.seed('SP-2', [prOpened(7), pass()]);
  await w.pass();
  assert.equal(parseAutoMergeMarker(w.posted[0].body).lane, 'B');
  files[7] = [...TOOLING, '.github/workflows/ci.yml'];
  w.clock = T0 + WINDOW_MS + 60 * 1000;
  const out = await w.pass();
  assert.equal(out.counts.cancelled, 1);
  assert.equal(w.calls.merge, 0);
});

// ── 15. Dry run ──────────────────────────────────────────────────────────────

test('a dry run at the end of the hour says it would merge and merges, takes and moves nothing', async () => {
  const w = hourUp();
  const out = await w.pass({ dryRun: true });
  assert.equal(out.counts.merged, 1);
  noWrites(w);
});
