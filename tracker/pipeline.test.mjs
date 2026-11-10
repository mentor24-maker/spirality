// The Pipeline Status pod's answer (SP-168): read from scratch loop logs in
// the runners' own line shapes, never the Mini's real ones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logFolderOf, pipelineOf, readStage, readTail, STAGES } from './pipeline.mjs';
import { logClock, logDate } from './demoData.mjs';
import { INTERVALS } from '../scripts/lib/loopSchedule.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const at = (s) => new Date(s); // a local time, as the runners write them
const start = (job, d) => `===== ${logDate(d)} START /${job} =====`;
const end = (job, d) => `===== ${logDate(d)} END /${job} (exit 0 — not a verdict; the pass's report above is) =====`;
const sleeping = (job, d, n = 1800) => `[loop-runner] ${logClock(d)} sleeping ${n}s before the next /${job}`;
const relayStart = (d) => `===== ${logDate(d)} START relay — /Users/someone/WebApps/project =====`;
const relayEnd = (d) => `===== ${logDate(d)} END relay — pass complete (exit 0) =====`;

function scratch(files) {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), `${text}\n`);
  return dir;
}

test('four stages from scratch logs: a sleeping lane, a running lane, the relay, and a stage with no log', () => {
  const dir = scratch({
    'proj-loop-review.log': [
      start('loop-review', at('2026-11-09T18:22:34')),
      'SECRET-LOOKING REPORT TEXT that must never leave the server',
      end('loop-review', at('2026-11-09T18:25:36')),
      sleeping('loop-review', at('2026-11-09T18:25:36')),
    ].join('\n'),
    'proj-loop-build.log': [
      start('loop-build', at('2026-11-09T18:13:25')),
      end('loop-build', at('2026-11-09T18:16:57')),
      sleeping('loop-build', at('2026-11-09T18:16:57')),
      start('loop-build', at('2026-11-09T18:46:58')),
      'a pass under way',
    ].join('\n'),
    'proj-relay.log': [relayStart(at('2026-11-09T18:37:36')), '[relay] working', relayEnd(at('2026-11-09T18:37:52'))].join('\n'),
  });
  try {
    const answer = pipelineOf({ logDir: dir, slug: 'proj' });
    const by = Object.fromEntries(answer.stages.map((s) => [s.name, s]));
    assert.deepEqual(answer.stages.map((s) => s.name), ['Relay', 'Build', 'Review', 'Intake']);
    assert.deepEqual(by.Review, {
      name: 'Review', job: 'loop-review', logged: true, running: false,
      lastStart: at('2026-11-09T18:22:34').toISOString(), nextDue: at('2026-11-09T18:55:36').toISOString(),
    });
    assert.equal(by.Build.running, true);
    assert.equal(by.Build.nextDue, null);
    assert.equal(by.Build.lastStart, at('2026-11-09T18:46:58').toISOString());
    // The relay: its last start plus the interval the installer writes into its plist.
    assert.equal(by.Relay.running, false);
    assert.equal(by.Relay.nextDue, new Date(at('2026-11-09T18:37:36').getTime() + INTERVALS.relay * 1000).toISOString());
    assert.deepEqual(by.Intake, { name: 'Intake', job: 'loop-intake', logged: false, running: false, lastStart: null, nextDue: null });
    // Times and flags only: no log text anywhere in the answer.
    const text = JSON.stringify(answer);
    assert.doesNotMatch(text, /SECRET|REPORT|working|under way|WebApps|=====/);
    for (const s of answer.stages) assert.deepEqual(Object.keys(s).sort(), ['job', 'lastStart', 'logged', 'name', 'nextDue', 'running']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a running relay says running; a log with no passes in it answers "no passes logged yet", never an error', () => {
  const dir = scratch({
    'p-relay.log': [relayEnd(at('2026-11-09T18:27:36')), relayStart(at('2026-11-09T18:37:36'))].join('\n'),
    'p-loop-intake.log': '[loop-runner] another runner (pid 1) holds the lock; not starting a second.',
  });
  try {
    const by = Object.fromEntries(pipelineOf({ logDir: dir, slug: 'p' }).stages.map((s) => [s.job, s]));
    assert.equal(by.relay.running, true);
    assert.equal(by.relay.nextDue, null);
    assert.equal(by['loop-intake'].logged, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('only the end of each log is read: a large log still answers from its last lines', () => {
  const filler = `${'x'.repeat(199)}\n`.repeat(20_000); // about 4 MB, far past the tail read
  const dir = scratch({
    'big-loop-build.log': [
      start('loop-build', at('2026-11-01T09:00:00')),
      end('loop-build', at('2026-11-01T09:05:00')),
      sleeping('loop-build', at('2026-11-01T09:05:00')),
      filler,
      start('loop-build', at('2026-11-09T07:00:00')),
      end('loop-build', at('2026-11-09T07:10:00')),
      sleeping('loop-build', at('2026-11-09T07:10:00'), 600),
    ].join('\n'),
  });
  try {
    const file = join(dir, 'big-loop-build.log');
    const tail = readTail(file, 4096);
    assert.ok(tail.length <= 4096);
    assert.doesNotMatch(tail, /2026-11-01/, 'the start of the log was read');
    assert.match(tail.split('\n')[0], /^x+$/, 'the tail starts at a whole line');
    const build = pipelineOf({ logDir: dir, slug: 'big' }, { tailBytes: 4096 }).stages.find((s) => s.job === 'loop-build');
    assert.equal(build.nextDue, at('2026-11-09T07:20:00').toISOString());
    assert.equal(readTail(join(dir, 'missing.log')), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a sleeping line past midnight belongs to the next day; another job\'s lines are not this one\'s', () => {
  const text = [
    start('loop-build', at('2026-11-09T23:50:00')),
    end('loop-build', at('2026-11-09T23:59:59')),
    sleeping('loop-build', at('2026-11-10T00:00:01')),
    start('loop-review', at('2026-11-10T00:01:00')),
  ].join('\n');
  const build = readStage(text, 'loop-build');
  assert.equal(build.running, false);
  assert.equal(build.nextDue.toISOString(), at('2026-11-10T00:30:01').toISOString());
  const review = readStage(text, 'loop-review');
  assert.equal(review.running, true);
  // A pass that ended with no sleeping line after it: its next time is not known.
  const noSleep = readStage([start('loop-intake', at('2026-11-09T10:00:00')), end('loop-intake', at('2026-11-09T10:02:00'))].join('\n'), 'loop-intake');
  assert.deepEqual({ logged: noSleep.logged, running: noSleep.running, nextDue: noSleep.nextDue }, { logged: true, running: false, nextDue: null });
});

test('nothing project-specific typed in: the stages are the installer\'s lanes plus the relay, the intervals its one list, the folder the config\'s', () => {
  const installer = readFileSync(join(REPO, 'scripts/install_loop_runner.sh'), 'utf8');
  const lanes = installer.match(/^SKILLS=\(([^)]*)\)$/m)[1].trim().split(/\s+/);
  const relay = installer.match(/^RELAY=(\S+)$/m)[1];
  assert.deepEqual(STAGES.map((s) => s.job).sort(), [...lanes, relay].sort());
  assert.match(installer, /^interval_of\(\) \{ [^\n]*scripts\/lib\/loopSchedule\.mjs" interval "\$1"; \}$/m);
  assert.equal(logFolderOf('~/loop-logs', '/home/someone'), '/home/someone/loop-logs');
  assert.equal(logFolderOf('/var/logs', '/home/someone'), '/var/logs');
  const source = readFileSync(join(REPO, 'tracker/pipeline.mjs'), 'utf8');
  assert.doesNotMatch(source, /loop-logs|spirality|com\.[a-z]/);
});
