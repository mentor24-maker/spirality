'use strict';

// The reconcile check (SP-354): the pure rules in lib/reconcile.js, then the
// pass in scripts/reconcile.mjs driven end to end with every read and write
// handed in (no tracker, no GitHub, no bus).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const reconcile = require('./reconcile.js');

const REPO = path.join(__dirname, '..');
const HOUR = 3600 * 1000;
const NOW = Date.parse('2026-11-16T18:00:00Z');
const CONFIG = { projectSlug: 'example', busProject: 'example-bus', githubRepo: 'owner/example' };

function task(id, status, name = `Ticket ${id}`) {
  return { id, name, status: { status }, url: `http://t/t/${id}` };
}
function prComment(n, { repo = 'owner/example', at = NOW - 10 * HOUR, id = `c${n}` } = {}) {
  return { id, comment_text: `PR opened: https://github.com/${repo}/pull/${n}`, user: { id: 2, kind: 'machine' }, date: String(at) };
}

// Five open tickets, one of each shape, and one Live ticket that is never looked at.
const TASKS = [
  task('EX-1', 'ready to launch'),
  task('EX-2', 'in review'),
  task('EX-3', 'building'),
  task('EX-4', 'queued'),
  task('EX-5', 'rework'),
  task('EX-6', 'live'),
];
const COMMENTS = new Map([
  ['EX-1', [prComment(11)]],
  ['EX-2', [prComment(12)]],
  ['EX-3', [prComment(13)]],
  ['EX-4', []],
  ['EX-5', [prComment(15)]],
  ['EX-6', [prComment(16)]],
]);
const STATES = {
  11: { state: 'MERGED', at: '2026-11-16T15:00:00Z', why: null },
  12: { state: 'CLOSED', at: '2026-11-16T14:00:00Z', why: null },
  13: { state: 'OPEN', at: '', why: null },
  15: { state: null, why: 'HTTP 502 from GitHub' },
  16: { state: 'MERGED', at: '2026-11-15T15:00:00Z', why: null },
};

function findingsFor(tasks, comments, states = STATES) {
  const plan = reconcile.planChecks({ tasks, commentsById: comments, githubRepo: CONFIG.githubRepo });
  const found = [...plan.unchecked];
  for (const { task: t, pr } of plan.toAsk) {
    const f = reconcile.classify({ task: t, pr, snap: states[pr.number] });
    if (f) found.push(f);
  }
  return { plan, found };
}

test('merged and closed pull requests are named; an open one, or none, is not; Live is never looked at', () => {
  const { plan, found } = findingsFor(TASKS, COMMENTS);
  assert.deepEqual(plan.checked.map((t) => t.id), ['EX-1', 'EX-2', 'EX-3', 'EX-4', 'EX-5']);
  assert.deepEqual(plan.noPr, ['EX-4']);
  const byId = Object.fromEntries(found.map((f) => [f.taskId, f]));
  assert.equal(byId['EX-1'].kind, reconcile.MERGED);
  assert.equal(byId['EX-1'].pr.number, 11);
  assert.equal(byId['EX-2'].kind, reconcile.CLOSED);
  assert.ok(!byId['EX-3'], 'an open pull request is not a finding');
  assert.ok(!byId['EX-4'], 'no pull request is not a finding');
  assert.ok(!byId['EX-6'], 'a Live ticket is not open');
});

test('a pull request GitHub could not read is "could not check" with its reason, never clean (DOCTRINE 3.11)', () => {
  const { found } = findingsFor(TASKS, COMMENTS);
  const f = found.find((x) => x.taskId === 'EX-5');
  assert.equal(f.kind, reconcile.UNCHECKED);
  assert.match(f.why, /HTTP 502 from GitHub/);
  assert.equal(reconcile.exitCodeFor(found), 2, 'a missing part of the answer is CANNOT TELL');
  assert.match(reconcile.findingLine(f), /could not check: its pull request could not be read: HTTP 502/);
});

test('unreadable comments, and a pull request in another repository, are "could not check" too', () => {
  const tasks = [task('EX-1', 'in review'), task('EX-2', 'in review')];
  const comments = new Map([['EX-2', [prComment(40, { repo: 'someone/else' })]]]);
  const { plan, found } = findingsFor(tasks, comments);
  assert.equal(plan.toAsk.length, 0, 'GitHub is never asked for another repository\'s number in ours');
  assert.deepEqual(found.map((f) => [f.taskId, f.kind]), [['EX-1', 'unchecked'], ['EX-2', 'unchecked']]);
  assert.match(found[0].why, /comments could not be read/);
  assert.match(found[1].why, /someone\/else/);
});

test('the newest PR opened: comment is the ticket\'s pull request (findPullRequest, no second reading)', () => {
  const tasks = [task('EX-1', 'in review')];
  const comments = new Map([['EX-1', [prComment(20, { at: NOW - 2 * HOUR }), prComment(19, { at: NOW - 20 * HOUR })]]]);
  const { found } = findingsFor(tasks, comments, { 19: { state: 'MERGED' }, 20: { state: 'OPEN' } });
  assert.equal(found.length, 0, 'the older, merged pull request is not this ticket\'s any more');
});

test('exit codes without --check: 0 nothing, 1 a finding, 2 could not tell', () => {
  assert.equal(reconcile.exitCodeFor([]), 0);
  assert.equal(reconcile.exitCodeFor([{ kind: 'merged' }]), 1);
  assert.equal(reconcile.exitCodeFor([{ kind: 'merged' }, { kind: 'unchecked' }]), 2);
});

test('stamp keys: one per ticket and finding, and a finding that goes away is cleared', () => {
  const f = { taskId: 'EX-1', kind: 'merged' };
  assert.equal(reconcile.postKey(f), 'EX-1:merged');
  assert.deepEqual(reconcile.parseKey('EX-1:merged'), { taskId: 'EX-1', kind: 'merged' });
  assert.deepEqual(reconcile.staleKeys({ stampKeys: ['EX-1:merged', 'EX-2:closed'], findings: [f] }), ['EX-2:closed']);
});

// ── the pass, scripts/reconcile.mjs ──────────────────────────────────────

async function pass() {
  return import(path.join(REPO, 'scripts', 'reconcile.mjs'));
}
async function scratch() {
  const { folderStamps, fileClock } = await import(path.join(REPO, 'scripts', 'stale_ready.mjs'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-'));
  return { stamps: folderStamps(path.join(dir, 'stamps')), readClock: fileClock(path.join(dir, 'read.stamp')), dir };
}
function harness({ tasks = TASKS, comments = COMMENTS, states = STATES, postOk = true, paused = false, now = NOW } = {}) {
  const posts = [];
  const lines = [];
  const asked = [];
  return {
    posts,
    lines,
    asked,
    deps: {
      config: CONFIG,
      now,
      readTickets: () => ({ tasks, commentsById: comments }),
      prState: (n) => { asked.push(n); return states[n] || { state: null, why: 'no such pull request' }; },
      paused: () => ({ paused, why: paused ? 'relay paused' : '' }),
      post: (text) => { posts.push(text); return postOk ? { ok: true } : { ok: false, why: 'bus-post exited 1: tracker down' }; },
      out: (l) => lines.push(String(l)),
      node: 'test-machine',
      when: (iso) => iso,
    },
  };
}

test('npm run reconcile (no --check) prints a line per open ticket and the findings, and posts nothing', async () => {
  const { runReconcile } = await pass();
  const s = await scratch();
  const h = harness();
  const code = runReconcile({ ...h.deps, ...s, argv: [] });
  assert.equal(code, 2, 'EX-5 could not be checked');
  assert.equal(h.posts.length, 0);
  const report = h.lines.join('\n');
  for (const id of ['EX-1', 'EX-2', 'EX-3', 'EX-4', 'EX-5']) assert.match(report, new RegExp(`  ${id} \\(`));
  assert.doesNotMatch(report, /EX-6/);
  assert.match(report, /EX-1 "Ticket EX-1" \(ready to launch\): pull request #11 was merged/);
  assert.match(report, /EX-2 "Ticket EX-2" \(in review\): pull request #12 was closed without merging/);
  assert.deepEqual(h.asked.sort(), [11, 12, 13, 15], 'one gh read per open ticket with a pull request');
  assert.equal(s.stamps.readAll().size, 0, 'a reading by hand writes nothing');
});

test('nothing found says so and exits 0', async () => {
  const { runReconcile } = await pass();
  const s = await scratch();
  const h = harness({ tasks: [task('EX-3', 'building')] });
  assert.equal(runReconcile({ ...h.deps, ...s, argv: [] }), 0);
  assert.match(h.lines.join('\n'), /Nothing found/);
});

test('--check posts each finding once, then not again for 6 hours; a finding that goes away clears its stamp', async () => {
  const { runReconcile } = await pass();
  const s = await scratch();
  const first = harness();
  assert.equal(runReconcile({ ...first.deps, ...s, argv: ['--check'] }), 0);
  assert.equal(first.posts.length, 1);
  assert.match(first.posts[0], /EX-1/);
  assert.match(first.posts[0], /EX-2/);
  assert.match(first.posts[0], /Nothing was moved/);
  assert.deepEqual([...s.stamps.readAll().keys()].sort(), ['EX-1:merged', 'EX-2:closed', 'EX-5:unchecked']);

  const second = harness({ now: NOW + 2 * HOUR });
  assert.equal(runReconcile({ ...second.deps, ...s, argv: ['--check', '--force'] }), 0);
  assert.equal(second.posts.length, 0, 'already said within 6 hours');
  assert.match(second.lines.join('\n'), /already said on the bus/);

  const later = harness({ now: NOW + 7 * HOUR });
  assert.equal(runReconcile({ ...later.deps, ...s, argv: ['--check', '--force'] }), 0);
  assert.equal(later.posts.length, 1, 'said again once the 6 hours are up');

  // EX-1 moved to Live and EX-5's read came back: their stamps go.
  const moved = harness({ tasks: [task('EX-2', 'in review'), task('EX-5', 'rework')], states: { ...STATES, 15: { state: 'OPEN' } }, now: NOW + 8 * HOUR });
  runReconcile({ ...moved.deps, ...s, argv: ['--check', '--force'] });
  assert.deepEqual([...s.stamps.readAll().keys()], ['EX-2:closed']);
});

test('--check: a post that does not land exits 1 and stamps nothing, so the next pass tries again', async () => {
  const { runReconcile } = await pass();
  const s = await scratch();
  const h = harness({ postOk: false });
  assert.equal(runReconcile({ ...h.deps, ...s, argv: ['--check'] }), 1);
  assert.match(h.lines.join('\n'), /Could NOT post to the bus \(bus-post exited 1: tracker down\)/);
  assert.equal(s.stamps.readAll().size, 0);
  const retry = harness();
  runReconcile({ ...retry.deps, ...s, argv: ['--check', '--force'] });
  assert.equal(retry.posts.length, 1);
});

test('--check reads at most once an hour unless --force', async () => {
  const { runReconcile } = await pass();
  const s = await scratch();
  runReconcile({ ...harness({ tasks: [] }).deps, ...s, argv: ['--check'] });
  const again = harness({ now: NOW + 30 * 60 * 1000 });
  assert.equal(runReconcile({ ...again.deps, ...s, argv: ['--check'] }), 0);
  assert.equal(again.asked.length, 0);
  assert.equal(again.posts.length, 0);
  assert.match(again.lines.join('\n'), /read within the last hour/);
  const forced = harness({ now: NOW + 30 * 60 * 1000 });
  runReconcile({ ...forced.deps, ...s, argv: ['--check', '--force'] });
  assert.equal(forced.posts.length, 1);
});

test('--check --dry-run prints the post and sends and writes nothing; paused posts nothing', async () => {
  const { runReconcile } = await pass();
  const s = await scratch();
  const dry = harness();
  assert.equal(runReconcile({ ...dry.deps, ...s, argv: ['--check', '--dry-run'] }), 0);
  assert.equal(dry.posts.length, 0);
  assert.match(dry.lines.join('\n'), /--dry-run: this is what would go to the bus/);
  assert.match(dry.lines.join('\n'), /RECONCILE: 2 open ticket\(s\) whose pull request/);
  assert.equal(s.stamps.readAll().size, 0);
  assert.equal(s.readClock.read(), '');

  const quiet = harness({ paused: true });
  assert.equal(runReconcile({ ...quiet.deps, ...s, argv: ['--check'] }), 0);
  assert.equal(quiet.posts.length, 0);
  assert.match(quiet.lines.join('\n'), /Not posting: the Settings page has the relay paused/);
});

test('--check with no busProject exits 2 and reads nothing; unreadable tickets exit 2, never an all-clear', async () => {
  const { runReconcile } = await pass();
  const s = await scratch();
  let read = 0;
  const h = harness();
  const noBus = runReconcile({ ...h.deps, ...s, config: { ...CONFIG, busProject: '' }, readTickets: () => { read += 1; return { tasks: [], commentsById: new Map() }; }, argv: ['--check'] });
  assert.equal(noBus, 2);
  assert.equal(read, 0);
  const down = harness();
  const code = runReconcile({ ...down.deps, ...s, readTickets: () => { throw new Error('the door timed out'); }, argv: [] });
  assert.equal(code, 2);
  assert.match(down.lines.join('\n'), /CANNOT TELL: .*the door timed out/);
  assert.match(down.lines.join('\n'), /This is not an all-clear/);
});

test('the check changes no ticket: the only door command it can write with is bus-post', () => {
  const text = fs.readFileSync(path.join(REPO, 'scripts', 'reconcile.mjs'), 'utf8');
  const doorCalls = [...text.matchAll(/door\.(\w+)\(/g)].map((m) => m[1]).sort();
  assert.deepEqual([...new Set(doorCalls)], ['pausedNow', 'postToBus', 'readTickets']);
  for (const word of ['status', 'comment', 'describe', 'claim']) {
    assert.doesNotMatch(text, new RegExp(`runDoor\\(\\[\\s*'${word}'`), `reconcile.mjs must not run the door's ${word}`);
  }
});

test('nothing project-specific is written into the reconcile files (rule 2)', () => {
  const config = JSON.parse(fs.readFileSync(path.join(REPO, 'spirality.project.json'), 'utf8'));
  const literals = [config.busProject, config.githubRepo, config.launchdPrefix, config.trackerUrl, config.loopQueueListId !== '0' && config.loopQueueListId, config.trackerPrefix && `${config.trackerPrefix}-`, config.projectSlug && `'${config.projectSlug}'`]
    .filter(Boolean);
  for (const file of ['lib/reconcile.js', 'scripts/reconcile.mjs']) {
    const text = fs.readFileSync(path.join(REPO, file), 'utf8');
    const code = text.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*|#)/.test(l)).join('\n').replace(/\/\/.*$/gm, '').replace(/\(SP-\d+\)/g, '');
    for (const lit of literals) assert.ok(!code.includes(lit), `${file} names ${lit}; it must come from the project config`);
    for (const line of text.split('\n').filter((l) => /['`"].*\b(Dane|operatorName)\b/.test(l) && !/^\s*(\*|\/\/|#)/.test(l))) {
      assert.fail(`${file} types the operator's name into output: ${line.trim()}`);
    }
  }
});
