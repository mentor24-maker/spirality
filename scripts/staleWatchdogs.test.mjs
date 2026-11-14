// The two ticket watchdogs' passes (SP-267), driven end to end with every
// read and write handed in: no tracker, no GitHub, no bus. The pure rules
// have StarCaster's own tests in lib/staleReady.test.js and
// lib/staleAnswer.test.js; these prove the shells around them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStaleReady, folderStamps, fileClock } from './stale_ready.mjs';
import { runStaleAnswer } from './stale_answer.mjs';
import { parseTickets, asCommentRecord } from './lib/watchdogDoor.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOUR = 3600 * 1000;
const NOW = Date.parse('2026-11-14T18:00:00Z');
const CONFIG = { projectSlug: 'example', operatorUserId: '1', busProject: 'example-bus', githubRepo: 'owner/example' };

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'stale-watchdogs-'));
  return { stamps: folderStamps(join(dir, 'stamps')), readClock: fileClock(join(dir, 'read.stamp')), dir };
}

function harness({ tickets, comments = new Map(), postOk = true, paused = false } = {}) {
  const posts = [];
  const lines = [];
  return {
    posts,
    lines,
    deps: {
      config: CONFIG,
      now: NOW,
      readTickets: () => ({ tasks: tickets, commentsById: comments }),
      prSnapshot: () => ({ state: 'OPEN', checks: { pending: [], failed: ['verify'], total: 1 }, why: null }),
      paused: () => ({ paused, why: paused ? 'relay paused' : '' }),
      post: (text) => { posts.push(text); return postOk ? { ok: true } : { ok: false, why: 'bus-post exited 1: tracker down' }; },
      out: (l) => lines.push(String(l)),
      node: 'test-machine',
    },
  };
}

// A ticket 30 hours in Ready to launch, its PR red: the incident's shape.
const READY = [{ id: 'EX-7', name: 'A ticket whose name is well over sixty characters long, kept whole in every line', status: { status: 'ready to launch' }, date_updated: String(NOW - 30 * HOUR), url: 'http://t/t/EX-7' }];
const READY_COMMENTS = new Map([['EX-7', [{ id: 'c1', comment_text: 'PR opened: https://github.com/owner/example/pull/12', user: { id: 2, kind: 'machine' }, date: String(NOW - 31 * HOUR) }]]]);

test('stale-ready without --check lists the stuck ticket by id and exact name, posts nothing, exit 1', () => {
  const s = scratch();
  const h = harness({ tickets: READY, comments: READY_COMMENTS });
  const code = runStaleReady({ ...h.deps, ...s, argv: [] });
  assert.equal(code, 1);
  assert.equal(h.posts.length, 0);
  const report = h.lines.join('\n');
  assert.match(report, /EX-7 "A ticket whose name is well over sixty characters long, kept whole in every line"/);
  assert.match(report, /failing checks \(verify\)/);
});

test('stale-ready --check posts once; a second run in the window posts nothing; a move clears the stamp', () => {
  const s = scratch();
  const first = harness({ tickets: READY, comments: READY_COMMENTS });
  assert.equal(runStaleReady({ ...first.deps, ...s, argv: ['--check'] }), 0);
  assert.equal(first.posts.length, 1, 'one bus post for the stuck ticket');
  assert.match(first.posts[0], /EX-7/);

  const second = harness({ tickets: READY, comments: READY_COMMENTS });
  assert.equal(runStaleReady({ ...second.deps, ...s, argv: ['--check', '--force'] }), 0);
  assert.equal(second.posts.length, 0, 'already said within 6 hours');
  assert.match(second.lines.join('\n'), /already said on the bus/);

  // The ticket leaves the stage: its stamp goes, so sticking again is said at once.
  const moved = harness({ tickets: [] });
  runStaleReady({ ...moved.deps, ...s, argv: ['--check', '--force'] });
  assert.equal(s.stamps.readAll().size, 0);
});

test('stale-ready --check reads at most once an hour unless --force', () => {
  const s = scratch();
  runStaleReady({ ...harness({ tickets: [] }).deps, ...s, argv: ['--check'] });
  const again = harness({ tickets: READY, comments: READY_COMMENTS });
  assert.equal(runStaleReady({ ...again.deps, ...s, argv: ['--check'] }), 0);
  assert.equal(again.posts.length, 0);
  assert.match(again.lines.join('\n'), /read within the last hour/);
});

test('stale-ready --check: a failed post exits 1 and stamps nothing', () => {
  const s = scratch();
  const h = harness({ tickets: READY, comments: READY_COMMENTS, postOk: false });
  assert.equal(runStaleReady({ ...h.deps, ...s, argv: ['--check'] }), 1);
  assert.equal(s.stamps.readAll().size, 0, 'not stamped, so the next pass tries again');
  assert.match(h.lines.join('\n'), /Could NOT post to the bus \(bus-post exited 1: tracker down\)/);
});

test('stale-ready --check: paused posts nothing; a dry run posts and writes nothing', () => {
  const s = scratch();
  const p = harness({ tickets: READY, comments: READY_COMMENTS, paused: true });
  assert.equal(runStaleReady({ ...p.deps, ...s, argv: ['--check'] }), 0);
  assert.equal(p.posts.length, 0);
  const dry = scratch();
  const d = harness({ tickets: READY, comments: READY_COMMENTS });
  assert.equal(runStaleReady({ ...d.deps, ...dry, argv: ['--check', '--dry-run'] }), 0);
  assert.equal(d.posts.length, 0);
  assert.match(d.lines.join('\n'), /what would go to the bus/);
  assert.equal(existsSync(join(dry.dir, 'read.stamp')), false, 'a dry run writes nothing');
  assert.equal(dry.stamps.readAll().size, 0);
});

test('stale-ready --check with no busProject exits 2 and reads nothing; an unreadable tracker exits 2', () => {
  const s = scratch();
  const h = harness({ tickets: READY });
  let read = 0;
  assert.equal(runStaleReady({ ...h.deps, ...s, config: { ...CONFIG, busProject: undefined }, readTickets: () => { read += 1; return {}; }, argv: ['--check'] }), 2);
  assert.equal(read, 0);
  const down = harness();
  assert.equal(runStaleReady({ ...down.deps, ...s, readTickets: () => { throw new Error('tracker down'); }, argv: [] }), 2);
  assert.match(down.lines.join('\n'), /CANNOT TELL: the tracker's tickets could not be read: tracker down/);
});

// A card from a loop, answered by the operator 2 hours ago, still parked.
// The banner the relay itself looks for, so the fixture is a real card.
const operatorCard = (await import('node:module')).createRequire(import.meta.url)('../lib/operatorCard.js');
const CARD = `@@ASKED x\n\n${operatorCard.BANNER_LABEL.trim()}\nYour move: Reply`;
function parkedComments(answerAgoHours) {
  return new Map([['EX-9', [
    { id: 'a2', comment_text: 'C', user: { id: 1, kind: 'human' }, date: String(NOW - answerAgoHours * HOUR) },
    { id: 'a1', comment_text: CARD, user: { id: 2, kind: 'machine' }, date: String(NOW - 5 * HOUR) },
  ]]]);
}
const PARKED = [{ id: 'EX-9', name: 'Answered and left', status: { status: 'needs your input' }, date_updated: String(NOW), url: 'http://t/t/EX-9' }];

test('stale-answer: the card format the relay reads is the one this test uses', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { handbackAnswer } = require('../lib/relayLane.js');
  const { isMachineAuthored } = require('../lib/machineComment.js');
  const comments = parkedComments(2).get('EX-9');
  const v = handbackAnswer({ comments, operatorId: 1, isMachine: isMachineAuthored });
  // If the card banner ever changes, this names the fixture to fix rather
  // than letting the tests below pass on a ticket with no card at all.
  assert.equal(v.state, 'answered');
});

test('stale-answer --check: an unacted answer posts once, then is held; a failed post exits 1', () => {
  const s = scratch();
  const first = harness({ tickets: PARKED, comments: parkedComments(2) });
  assert.equal(runStaleAnswer({ ...first.deps, ...s, argv: ['--check'] }), 0);
  assert.equal(first.posts.length, 1);
  assert.match(first.posts[0], /EX-9 "Answered and left"/);

  const second = harness({ tickets: PARKED, comments: parkedComments(2) });
  assert.equal(runStaleAnswer({ ...second.deps, ...s, argv: ['--check', '--force'] }), 0);
  assert.equal(second.posts.length, 0);

  const fresh = scratch();
  const failed = harness({ tickets: PARKED, comments: parkedComments(2), postOk: false });
  assert.equal(runStaleAnswer({ ...failed.deps, ...fresh, argv: ['--check'] }), 1);
  assert.equal(fresh.stamps.readAll().size, 0);
});

test('stale-answer: an answer inside the 30 minutes is quiet', () => {
  const s = scratch();
  const h = harness({ tickets: PARKED, comments: parkedComments(0.2) });
  assert.equal(runStaleAnswer({ ...h.deps, ...s, argv: ['--check'] }), 0);
  assert.equal(h.posts.length, 0);
  assert.match(h.lines.join('\n'), /Nothing is stuck/);
});

test('the door\'s tickets JSON comes back in the shapes the modules read, newest comment first', () => {
  const stdout = JSON.stringify([{
    id: 'EX-1', name: 'One', status: 'ready to launch', priority: null, tags: ['a'], created: '2026-11-01T00:00:00.000Z', updated: '2026-11-02T00:00:00.000Z', statusSince: null,
    comments: [
      { id: '1', author: { id: 2, name: 'Loop', kind: 'machine' }, by: 'machine', at: '2026-11-01T00:00:00.000Z', text: 'PR opened: x' },
      { id: '2', author: { id: 1, name: 'Dana', kind: 'human' }, by: 'operator', at: '2026-11-02T00:00:00.000Z', text: 'merge' },
    ],
  }]);
  const { tasks, commentsById } = parseTickets(stdout, { trackerUrl: 'http://tracker.example:4180/' });
  assert.equal(tasks[0].status.status, 'ready to launch');
  assert.equal(tasks[0].date_updated, String(Date.parse('2026-11-02T00:00:00.000Z')));
  assert.equal(tasks[0].url, 'http://tracker.example:4180/t/EX-1');
  assert.deepEqual(commentsById.get('EX-1').map((c) => c.id), ['2', '1']);
  assert.deepEqual(asCommentRecord({ id: 3, author: { id: 1, name: 'D', kind: 'human' }, at: null, text: 'x' }).user, { id: 1, username: 'D', kind: 'human' });
  assert.throws(() => parseTickets('not json'), /not a JSON list of tickets/);
});

test('nothing project-specific is written into the watchdog files (rule 2)', () => {
  const config = JSON.parse(readFileSync(join(REPO, 'spirality.project.json'), 'utf8'));
  const literals = [config.busProject, config.githubRepo, config.launchdPrefix, config.trackerUrl, config.trackerPrefix && `${config.trackerPrefix}-`, config.projectSlug && `'${config.projectSlug}'`]
    .filter(Boolean);
  for (const file of ['scripts/stale_ready.mjs', 'scripts/stale_answer.mjs', 'scripts/lib/watchdogDoor.mjs', 'scripts/lib/relay_watchdogs.sh', 'lib/staleReady.js', 'lib/staleAnswer.js']) {
    const text = readFileSync(join(REPO, file), 'utf8');
    // Code lines only: a comment may cite a ticket (SP-267) by its id.
    const code = text.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*|#)/.test(l)).join('\n').replace(/\/\/.*$/gm, '').replace(/\(SP-\d+\)/g, '');
    for (const lit of literals) assert.ok(!code.includes(lit), `${file} names ${lit}; it must come from the project config`);
    // The operator's name comes from the config too, never typed into a line a reader sees.
    for (const line of text.split('\n').filter((l) => /['`"].*\bDane\b/.test(l) && !/^\s*(\*|\/\/|#)/.test(l))) {
      assert.fail(`${file} types the operator's name into output: ${line.trim()}`);
    }
  }
});
