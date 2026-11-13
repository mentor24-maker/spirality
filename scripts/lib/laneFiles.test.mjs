/**
 * Every lane file in the shared log folder carries its project's name, and a
 * pause in one project never stops another's lanes (SP-263).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { laneFile, laneFileNames, standdownFile, unscopedLaneFiles } from './laneFiles.mjs';
import pipelinePause from '../../lib/pipelinePause.js';

const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

// Every file that puts a name in the log folder: the runners, the relay, the
// installer, and the modules that build the same names. A new one goes here.
const SOURCES = [
  { file: 'scripts/loop_runner.sh', lang: 'sh' },
  { file: 'scripts/run_relay.sh', lang: 'sh' },
  { file: 'scripts/install_loop_runner.sh', lang: 'sh' },
  { file: 'scripts/lib/wakeLane.mjs', lang: 'js' },
  { file: 'lib/passHandback.js', lang: 'js' },
  { file: 'lib/substrateConfig.js', lang: 'js' },
  { file: 'tracker/pipeline.mjs', lang: 'js' },
  { file: 'scripts/onboard/onboard.mjs', lang: 'js' },
  { file: 'scripts/onboard/lanes.mjs', lang: 'js' },
  { file: 'scripts/lib/laneFiles.mjs', lang: 'js' },
];

test('every lane file a runner, the relay, the installer or a module names in the log folder starts with the project slug', () => {
  for (const { file, lang } of SOURCES) {
    const text = readFileSync(join(REPO, file), 'utf8');
    const names = laneFileNames(text, { lang });
    if (file !== 'scripts/lib/laneFiles.mjs') assert.ok(names.length > 0, `${file}: the check found no log-folder file at all, so it is not reading this file`);
    const bad = unscopedLaneFiles(text, { lang });
    assert.deepEqual(bad, [], `${file}: these log-folder files are not named for the project: ${bad.map((b) => `line ${b.line} "${b.name}"`).join(', ')}`);
  }
});

test('the runners name the files Dane sees in --status: log, lock, wake, sync lock and snapshot, and the relay\'s tick files', () => {
  const runner = laneFileNames(readFileSync(join(REPO, 'scripts/loop_runner.sh'), 'utf8'), { lang: 'sh' }).map((f) => f.name);
  for (const want of ['$SLUG-$SKILL.log', '$SLUG-$SKILL.lock', '$SLUG-$SKILL.wake', '$SLUG-sync.lock', '$SLUG-$SKILL.timeout-snapshot']) {
    assert.ok(runner.includes(want), `loop_runner.sh no longer names ${want}`);
  }
  const relay = laneFileNames(readFileSync(join(REPO, 'scripts/run_relay.sh'), 'utf8'), { lang: 'sh' }).map((f) => f.name);
  // The tick's start time, kept wake time and wake file (SP-236), beside the lock.
  assert.deepEqual(relay.sort(), ['$SLUG-relay.interval', '$SLUG-relay.last-start', '$SLUG-relay.lock', '$SLUG-relay.wake', '$SLUG-sync.lock']);
});

test('a file without the project\'s name is refused', () => {
  const sh = 'LOG_DIR=x\n# $LOG_DIR/loops.standdown in a comment is prose\nSTOP="$LOG_DIR/loops.standdown"\nLOCK="$LOG_DIR/$SLUG-relay.lock"\n';
  assert.deepEqual(unscopedLaneFiles(sh, { lang: 'sh' }).map((b) => [b.line, b.name]), [[3, 'loops.standdown']]);
  assert.deepEqual(unscopedLaneFiles('W="${LOG_DIR}/loop-build.wake"', { lang: 'sh' }).map((b) => b.name), ['loop-build.wake']);

  const js = [
    "const a = join(logDir, 'loops.standdown');",
    'const b = join(folder, `${job}.log`);',
    'const c = `${logDir()}/${skill}.log`;',
    "const d = '~/loop-logs/loop-review.log';",
    'const ok = join(logDir, `${slug}-${job}.wake`);',
    ' * join(logDir, `<lane>.wake`) in a comment is prose',
  ].join('\n');
  assert.deepEqual(unscopedLaneFiles(js).map((b) => b.name), ['loops.standdown', '${job}.log', '${skill}.log', 'loop-review.log']);
});

test('a log folder reached through a property (config.logDir) is read too', () => {
  const js = [
    "const a = join(config.logDir, 'loops.standdown');",
    "const b = join(this.project.logDir, 'x.lock');",
    'const ok = join(config.logDir, `${config.projectSlug}-standdown`);',
  ].join('\n');
  assert.deepEqual(unscopedLaneFiles(js).map((b) => [b.line, b.name]), [[1, 'loops.standdown'], [2, 'x.lock']]);
  assert.equal(laneFileNames(js).length, 3);
});

test('a stand-down file is <projectSlug>-standdown, so two projects never share one', () => {
  const a = { logDir: '~/loop-logs', projectSlug: 'alpha' };
  const b = { logDir: '~/loop-logs', projectSlug: 'beta' };
  assert.equal(standdownFile(a, { home: '/h' }), '/h/loop-logs/alpha-standdown');
  assert.equal(standdownFile(b, { home: '/h' }), '/h/loop-logs/beta-standdown');
  assert.equal(laneFile(a, 'loop-build.lock', { home: '/h' }), '/h/loop-logs/alpha-loop-build.lock');
  assert.throws(() => laneFile({ logDir: '~/loop-logs', projectSlug: '' }, 'standdown'), /no projectSlug/);
  assert.throws(() => laneFile(a, '../standdown'), /not a file name/);
});

// The pause switch, asked of each project's own tracker project.
const comment = (text, date) => ({ comment_text: text, date: String(date) });
const paused = comment(pipelinePause.pauseRecord({ by: 'Dane', at: '2026-11-12T20:00:00Z', why: 'urgent fix by hand' }), 2000);
const running = comment(pipelinePause.resumeRecord({ by: 'Dane', at: '2026-11-12T19:00:00Z' }), 1000);
const switchIn = (id, project) => ({ id, name: 'Pipeline pause switch', list: { id: project } });

test('a pause on project A leaves project B running', () => {
  const alpha = { tracker: 'api', projectSlug: 'alpha' };
  const beta = { tracker: 'api', projectSlug: 'beta' };
  const tasks = [switchIn('AL-1', 'alpha'), switchIn('BE-1', 'beta'), { id: 'AL-2', name: 'Something else', list: { id: 'alpha' } }];
  const trails = { 'AL-1': [running, paused], 'BE-1': [running] };
  const commentsOf = (id) => trails[id];

  const a = pipelinePause.projectPauseVerdict(alpha, { tasks, commentsOf });
  assert.equal(a.code, 3);
  assert.equal(a.paused, true);
  assert.equal(a.switchTask, 'AL-1');

  const b = pipelinePause.projectPauseVerdict(beta, { tasks, commentsOf });
  assert.equal(b.code, 0);
  assert.equal(b.paused, false);
  assert.equal(b.switchTask, 'BE-1');

  // A project with no switch of its own is running, even while another's is paused.
  const gamma = pipelinePause.projectPauseVerdict({ tracker: 'api', projectSlug: 'gamma' }, { tasks, commentsOf });
  assert.equal(gamma.code, 0);
  assert.equal(pipelinePause.pauseSwitchOf(tasks, { tracker: 'api', projectSlug: 'gamma' }).elsewhere, 2);
});

test('on ClickUp the switch is looked for in the project\'s Loop Queue list', () => {
  const tasks = [switchIn('c1', '901418546619'), switchIn('c2', '901422159126')];
  const found = pipelinePause.pauseSwitchOf(tasks, { tracker: 'clickup', loopQueueListId: '901422159126' });
  assert.equal(found.task.id, 'c2');
  assert.equal(found.elsewhere, 1);
});

test('a switch that cannot be told apart, or a config with no project, is treated as paused (fail-safe), never as running', () => {
  const two = [switchIn('AL-1', 'alpha'), switchIn('AL-9', 'alpha')];
  const v = pipelinePause.projectPauseVerdict({ tracker: 'api', projectSlug: 'alpha' }, { tasks: two });
  assert.equal(v.code, 3);
  assert.equal(v.certain, false);
  assert.match(v.message, /2 tickets named "Pipeline pause switch" in alpha/);

  const none = pipelinePause.projectPauseVerdict({ tracker: 'clickup', loopQueueListId: '0' }, { tasks: [switchIn('x', '0')] });
  assert.equal(none.code, 3);
  assert.match(none.message, /names no tracker project/);
});

test('the switch that was not read is never "running": a failed tickets read, a failed or async comments read', () => {
  const alpha = { tracker: 'api', projectSlug: 'alpha' };
  const tasks = [switchIn('AL-1', 'alpha')];

  // (a) An async read handed in where the comments are needed: a Promise is not a trail.
  const asyncRead = pipelinePause.projectPauseVerdict(alpha, { tasks, commentsOf: async () => [running] });
  assert.equal(asyncRead.code, 3);
  assert.equal(asyncRead.paused, true);
  assert.equal(asyncRead.certain, false);
  assert.match(asyncRead.message, /came back as a Promise/);
  const nullRead = pipelinePause.projectPauseVerdict(alpha, { tasks, commentsOf: () => null });
  assert.equal(nullRead.code, 3);

  // (b) A comments read that throws becomes the unreadable verdict, not an escaped error.
  const threw = pipelinePause.projectPauseVerdict(alpha, { tasks, commentsOf: () => { throw new Error('tracker 503'); } });
  assert.equal(threw.code, 3);
  assert.equal(threw.certain, false);
  assert.match(threw.message, /tracker 503/);

  // (c) A tickets read that failed is not "no switch, running".
  for (const bad of [null, { error: 'timeout' }, 'oops']) {
    const v = pipelinePause.projectPauseVerdict(alpha, { tasks: bad, commentsOf: () => [] });
    assert.equal(v.code, 3, `tasks=${JSON.stringify(bad)}`);
    assert.equal(v.certain, false);
    assert.match(v.message, /did not come back as a list/);
  }
});
