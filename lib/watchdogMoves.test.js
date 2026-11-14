'use strict';

/**
 * What SP-268 added around the three moved watchdogs (throughput, checkout
 * currency, failed-pass report). The moved modules keep their own StarCaster
 * tests (loopThroughput.test.js, loopThroughputUnknownStamps.test.js,
 * checkoutCurrency.test.js); this file covers only the Spirality side: the
 * door's tickets in the shape the throughput readers take, the noticeboards,
 * the read-only checkout readings, and the shared post helpers.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const lt = require('./loopThroughput.js');
const cc = require('./checkoutCurrency.js');
const posts = require('./watchdogPosts.js');
const boards = require('./loopNoticeboards.js');

const REPO = path.join(__dirname, '..');
const HOUR = 3600000;
const DAY = 24 * HOUR;

// --- the door's tickets as the throughput readers take them ------------------

test('a door ticket becomes the ClickUp-style task the throughput readers count', () => {
  const [live, queued, undated] = lt.fromTicketsJson([
    { id: 'SP-1', name: 'a', status: 'live', created: '2026-11-01T10:00:00.000Z', updated: '2026-11-03T10:00:00.000Z', statusSince: '2026-11-02T10:00:00.000Z' },
    { id: 'SP-2', name: 'b', status: 'Queued', created: '2026-11-01T10:00:00.000Z', updated: '2026-11-01T10:00:00.000Z', statusSince: '2026-11-01T10:00:00.000Z' },
    { id: 'SP-3', name: 'c', status: 'live', created: '2026-11-01T10:00:00.000Z', updated: '2026-11-01T10:00:00.000Z', statusSince: null },
  ]);
  assert.equal(live.status.status, 'live');
  assert.equal(live.date_created, String(Date.parse('2026-11-01T10:00:00.000Z')));
  assert.equal(live.date_updated, String(Date.parse('2026-11-03T10:00:00.000Z')));
  assert.equal(live.date_closed, String(Date.parse('2026-11-02T10:00:00.000Z')),
    'a finished ticket closed when it entered its finished status');
  assert.equal(queued.status.status, 'queued', 'statuses are matched lower-case');
  assert.equal(queued.date_closed, null, 'an open ticket has no closure, whatever its statusSince');
  assert.equal(undated.date_closed, null, 'a finished ticket with no readable statusSince is an undated closure, not a guess');
  assert.equal(lt.undatedClosures([undated]), 1);
  assert.deepEqual(lt.fromTicketsJson(null), []);
  assert.deepEqual(lt.fromTicketsJson([null, 3]), []);
});

test('closures counted from the door read land on the day they entered Live', () => {
  const now = Date.parse('2026-11-14T18:00:00.000Z');
  const tasks = lt.fromTicketsJson([
    { id: 'SP-1', status: 'live', created: new Date(now - 5 * DAY).toISOString(), updated: new Date(now - 2 * HOUR).toISOString(), statusSince: new Date(now - 2 * HOUR).toISOString() },
    { id: 'SP-2', status: 'queued', created: new Date(now - 5 * DAY).toISOString(), updated: new Date(now - 5 * DAY).toISOString(), statusSince: new Date(now - 5 * DAY).toISOString() },
  ]);
  assert.equal(lt.closedSince({ tasks, now }), 1);
  const v = lt.verdict({ closedLast24h: lt.closedSince({ tasks, now }), queue: lt.queueShape(tasks) });
  assert.equal(v.state, 'MOVING');
});

test('the noticeboards are left out of the count: Team chat and the pause switch', () => {
  const tasks = [
    { id: '1', name: 'Team chat', status: { status: 'live' }, date_closed: String(Date.now()) },
    { id: '2', name: ' pipeline pause switch ', status: { status: 'live' } },
    { id: '3', name: 'Real work', status: { status: 'queued' } },
  ];
  assert.deepEqual(lt.workTickets(tasks).map((t) => t.id), ['3']);
  assert.ok(boards.isNoticeboard({ name: 'TEAM CHAT' }));
  assert.equal(boards.isNoticeboard({ name: 'Team chat about something' }), false);
});

test('the throughput posts name no StarCaster id or sign-off, and a stall is an ALARM', () => {
  const src = fs.readFileSync(path.join(__dirname, 'loopThroughput.js'), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.doesNotMatch(code, /9014\d{8}|CC-starcaster|2kydhxeu/, 'nothing project-specific in the code (rule 2)');
  const now = Date.parse('2026-11-14T18:00:00.000Z');
  const tasks = [{ id: 'q', status: { status: 'queued' }, date_created: String(now - 9 * DAY), date_updated: String(now - 9 * DAY) }];
  const curve = lt.depthPerDay({ tasks, now, calendar: lt.UTC_DAYS });
  const text = lt.renderStallPost({
    verdict: lt.verdict({ closedLast24h: 0, queue: lt.queueShape(tasks), queueTouched: false }),
    closed: lt.closedPerDay({ tasks, now, calendar: lt.UTC_DAYS }), plateau: lt.depthPlateau(curve),
    rework: { rows: [], oldest: null }, queue: lt.queueShape(tasks), now,
  });
  assert.match(text, /^ALARM: /, 'a stall starts ALARM:, so the tracker texts it');
  const unknown = lt.renderUnknownPost({ verdict: lt.verdict({ unreadable: 'the tracker said 500' }), now });
  assert.doesNotMatch(unknown, /^ALARM:/, 'a reading that could not be taken is counted, not texted');
  assert.match(unknown, /npm run clickup -- queue /);
});

// --- checkout currency, read without pulling ---------------------------------

test('the untracked files that would block an update are the ones main adds', () => {
  assert.deepEqual(
    cc.untrackedBlockers(['docs/reports/a.json', 'lib/new.js'], ['docs/reports/a.json', 'scratch.txt']),
    ['docs/reports/a.json'],
  );
  assert.deepEqual(cc.untrackedBlockers([], ['x']), []);
  assert.deepEqual(cc.untrackedBlockers(null, null), []);
});

test('the three readings the ticket names, and the two in between', () => {
  const base = { branch: 'main', dirty: false, fetched: true, ahead: 0, now: 0 };
  assert.equal(cc.summaryLine(cc.classify({ ...base, behind: 0 })), 'current');
  assert.equal(cc.summaryLine(cc.classify({ ...base, behind: 0, merged: true })), 'behind, pulled');

  const blocked = cc.classify({ ...base, behind: 3, blocking: ['docs/reports/a.json'] });
  assert.equal(blocked.state, cc.STATES.BLOCKED_UNTRACKED);
  assert.ok(blocked.alarm);
  assert.match(cc.summaryLine(blocked), /^behind, could not pull: 1 untracked file\(s\) would be overwritten by the update: docs\/reports\/a\.json$/);

  const fromGit = cc.classify({ ...base, behind: 3, pullRefused: true,
    mergeStderr: 'error: The following untracked working tree files would be overwritten by merge:\n\tdocs/x.json\nPlease move or remove them before you merge.' });
  assert.deepEqual(fromGit.blocking, ['docs/x.json'], 'git\'s own words win when the refused pull said them');

  const guard = cc.classify({ ...base, behind: 2, untracked: ['scratch.txt'] });
  assert.ok(guard.alarm, 'any untracked file stops the runners\' pull, so the machine stays stale');
  assert.match(cc.summaryLine(guard), /^behind, could not pull: the relay pulls only into a folder with no untracked files, and 1 sit here: scratch\.txt$/);

  const other = cc.classify({ ...base, behind: 2, pullRefused: true, mergeStderr: 'fatal: unable to access origin' });
  assert.equal(other.state, cc.STATES.BLOCKED_OTHER);
  assert.match(cc.summaryLine(other), /^behind, could not pull: the fast-forward failed: fatal: unable to access origin$/);

  const waiting = cc.classify({ ...base, behind: 2 });
  assert.equal(waiting.state, cc.STATES.NOT_PULLED_YET);
  assert.equal(waiting.alarm, false, 'nothing blocks it and no pull was refused: the next pull takes it, no alarm');
  assert.match(cc.summaryLine(waiting), /^behind, not pulled yet: /);

  const notMain = cc.classify({ ...base, branch: 'setup', behind: 2 });
  assert.match(cc.summaryLine(notMain), /^behind, could not pull: the checkout is on "setup", not main/);

  assert.match(cc.summaryLine(cc.classify({ ...base, fetched: false })), /^cannot tell: could not reach origin/);
});

// --- the shared post helpers ---------------------------------------------------

test('a failed pass is one ALARM naming the job, the machine and the exit', () => {
  const text = posts.renderFailurePost({
    job: 'loop-build', node: 'mini', status: 1, at: '2026-11-14T18:00:00.000Z',
    logTail: 'Failed to authenticate.', logPath: '/logs/x.log', when: posts.mountainTime,
  });
  assert.match(text, /^ALARM: 🚨 \*\*loop-build FAILED on mini\*\*, exit status 1 at 11\/14\/2026, 11:00 AM MT\./);
  assert.match(text, /Failed to authenticate\./);
  assert.match(text, /once every 6 hours/);
  assert.doesNotMatch(text, /CC-starcaster/);
});

test('the repeat window and the stamp folder', () => {
  const now = Date.parse('2026-11-14T18:00:00.000Z');
  assert.equal(posts.dueAgain({ lastAt: '', now, everyMs: posts.REPOST_EVERY_MS }), true);
  assert.equal(posts.dueAgain({ lastAt: 'not a time', now, everyMs: posts.REPOST_EVERY_MS }), true);
  assert.equal(posts.dueAgain({ lastAt: new Date(now - 5 * HOUR).toISOString(), now, everyMs: posts.REPOST_EVERY_MS }), false);
  assert.equal(posts.dueAgain({ lastAt: new Date(now - 6 * HOUR).toISOString(), now, everyMs: posts.REPOST_EVERY_MS }), true);
  assert.equal(posts.ageText(90 * 60000), '1h 30m ago');
  assert.equal(posts.stampDir({ logDir: '/logs', slug: 'wavecenter' }), '/logs/wavecenter-watchdogs');
  assert.throws(() => posts.stampDir({ logDir: '', slug: 'x' }), /logDir/);
  assert.equal(posts.failureStampFile({ logDir: '/logs', slug: 'sp', job: 'loop build!' }), '/logs/sp-watchdogs/failed-loop-build-.stamp');
});

test('the lane runner clears the same failure stamp the reporter writes', () => {
  const sh = fs.readFileSync(path.join(REPO, 'scripts', 'loop_runner.sh'), 'utf8');
  const dirLine = sh.split('\n').find((l) => l.startsWith('WATCHDOG_DIR='));
  assert.equal(dirLine, 'WATCHDOG_DIR="$LOG_DIR/$SLUG-watchdogs"', 'the stamp folder, named for the project');
  const line = sh.split('\n').find((l) => l.startsWith('FAILURE_STAMP='));
  assert.ok(line, 'loop_runner.sh names the stamp');
  assert.equal(line, 'FAILURE_STAMP="$WATCHDOG_DIR/failed-$(printf \'%s\' "$SKILL" | tr -c \'A-Za-z0-9-\' \'-\').stamp"',
    'and names it the way lib/watchdogPosts.js failureStampFile does: <logDir>/<slug>-watchdogs/failed-<lane>.stamp');
  assert.equal(posts.failureStampFile({ logDir: '$LOG_DIR', slug: '$SLUG', job: 'loop-review' }), '$LOG_DIR/$SLUG-watchdogs/failed-loop-review.stamp');
});
