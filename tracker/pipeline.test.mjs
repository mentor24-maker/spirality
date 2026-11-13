// The Pipeline Status pod's answer (SP-168): read from scratch loop logs in
// the runners' own line shapes, never the Mini's real ones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAILING_AFTER, FAILING_REASONS, logFolderOf, pausedBy, pipelineOf, readStage, readTail, STAGES } from './pipeline.mjs';
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
      lastStart: at('2026-11-09T18:22:34').toISOString(), lastEnd: at('2026-11-09T18:25:36').toISOString(), lastExit: 0,
      interval: 1800, set: 1800, used: 1800, nextDue: at('2026-11-09T18:55:36').toISOString(),
      failing: false, failedPasses: 0, failingSince: null, failingReason: null,
      paused: null,
    });
    assert.equal(by.Build.running, true);
    assert.equal(by.Build.nextDue, null);
    assert.equal(by.Build.lastStart, at('2026-11-09T18:46:58').toISOString());
    // While a pass runs, its last end is the pass before it.
    assert.equal(by.Build.lastEnd, at('2026-11-09T18:16:57').toISOString());
    // The relay: its last start plus its wake time, the default while it has kept none.
    assert.equal(by.Relay.running, false);
    assert.equal(by.Relay.nextDue, new Date(at('2026-11-09T18:37:36').getTime() + INTERVALS.relay * 1000).toISOString());
    assert.equal(by.Relay.interval, INTERVALS.relay);
    assert.equal(by.Relay.lastEnd, at('2026-11-09T18:37:52').toISOString());
    assert.equal(by.Relay.lastExit, 0);
    // No log: nothing logged, and it wakes as the installer sets it to.
    assert.deepEqual(by.Intake, { name: 'Intake', job: 'loop-intake', logged: false, running: false, lastStart: null, lastEnd: null, lastExit: null, interval: INTERVALS['loop-intake'], set: INTERVALS['loop-intake'], used: null, nextDue: null, failing: false, failedPasses: 0, failingSince: null, failingReason: null, paused: null });
    // Times and flags only: no log text anywhere in the answer.
    const text = JSON.stringify(answer);
    assert.doesNotMatch(text, /SECRET|REPORT|working|under way|WebApps|=====/);
    for (const s of answer.stages) {
      assert.deepEqual(Object.keys(s).sort(), ['failedPasses', 'failing', 'failingReason', 'failingSince', 'interval', 'job', 'lastEnd', 'lastExit', 'lastStart', 'logged', 'name', 'nextDue', 'paused', 'running', 'set', 'used']);
      // Times, codes and intervals only: every value a flag, a name, an ISO time, a number or null.
      for (const t of [s.lastStart, s.lastEnd, s.nextDue]) assert.ok(t === null || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(t), t);
      assert.ok(s.lastExit === null || Number.isInteger(s.lastExit));
      assert.ok(Number.isInteger(s.interval));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the wake times set on the Settings page: a lane sleeping on an older value shows when it really wakes, and the set one once it has slept on it; the relay goes by the wake time it kept (SP-236)', () => {
  const dir = scratch({
    // The runner's own line since SP-219, with "(a wake ends it early)" after the lane.
    'proj-loop-review.log': [
      start('loop-review', at('2026-11-09T18:22:34')),
      end('loop-review', at('2026-11-09T18:25:36')),
      `${sleeping('loop-review', at('2026-11-09T18:25:36'), 1800)} (a wake ends it early)`,
    ].join('\n'),
    'proj-loop-build.log': [
      start('loop-build', at('2026-11-09T18:13:25')),
      end('loop-build', at('2026-11-09T18:16:57')),
      `${sleeping('loop-build', at('2026-11-09T18:16:57'), 600)} (a wake ends it early)`,
    ].join('\n'),
    'proj-relay.log': [relayStart(at('2026-11-09T18:37:36')), relayEnd(at('2026-11-09T18:37:52'))].join('\n'),
    'proj-relay.interval': '300',
  });
  try {
    const wake = { 'loop-review': 900, 'loop-build': 600, relay: 300, 'loop-intake': 1200 };
    const by = Object.fromEntries(pipelineOf({ logDir: dir, slug: 'proj' }, { wake }).stages.map((s) => [s.job, s]));
    // Set to 900 while it sleeps 1800: it still wakes at the end of the 1800.
    assert.deepEqual([by['loop-review'].set, by['loop-review'].used, by['loop-review'].interval], [900, 1800, 1800]);
    assert.equal(by['loop-review'].nextDue, at('2026-11-09T18:55:36').toISOString());
    // Set to 600 and sleeping 600: picked up.
    assert.deepEqual([by['loop-build'].set, by['loop-build'].used], [600, 600]);
    assert.equal(by['loop-build'].nextDue, at('2026-11-09T18:26:57').toISOString());
    // The relay's next pass is its last start plus the 300 its tick goes by.
    assert.deepEqual([by.relay.set, by.relay.used, by.relay.interval], [300, 300, 300]);
    assert.equal(by.relay.nextDue, at('2026-11-09T18:42:36').toISOString());
    // No log: it sleeps the set value first.
    assert.deepEqual([by['loop-intake'].set, by['loop-intake'].used, by['loop-intake'].interval], [1200, null, 1200]);
    // A kept wake time that is not a number is not used: the default is.
    writeFileSync(join(dir, 'proj-relay.interval'), 'soon\n');
    const relay = pipelineOf({ logDir: dir, slug: 'proj' }, { wake }).stages.find((s) => s.job === 'relay');
    assert.deepEqual([relay.set, relay.used], [300, INTERVALS.relay]);
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

test('each exit code the runners write on an END line is read back as its number (SP-173)', () => {
  // The relay's four END lines (scripts/run_relay.sh) and the lanes' one shape (scripts/loop_runner.sh).
  const relayLine = {
    0: 'pass complete (exit 0)',
    1: 'A STEP FAILED AND SAID SO ABOVE (exit 1)',
    124: 'hit the 900s time limit and was stopped (exit 124); its tickets are untouched or marked, never half-moved silently',
    127: 'the pass could not run (exit 127)',
  };
  for (const [code, words] of Object.entries(relayLine)) {
    const text = [relayStart(at('2026-11-09T18:37:36')), `===== ${logDate(at('2026-11-09T18:38:00'))} END relay — ${words} =====`].join('\n');
    const relay = readStage(text, 'relay', { interval: 600 });
    assert.equal(relay.lastExit, Number(code), words);
    assert.equal(relay.lastEnd.toISOString(), at('2026-11-09T18:38:00').toISOString());
    assert.equal(relay.interval, 600);
  }
  for (const code of [0, 1, 124, 2]) {
    const text = [
      start('loop-build', at('2026-11-09T10:00:00')),
      `===== ${logDate(at('2026-11-09T10:05:00'))} END /loop-build (exit ${code} — not a verdict; the pass's report above is) =====`,
      sleeping('loop-build', at('2026-11-09T10:05:00'), 900),
    ].join('\n');
    const build = readStage(text, 'loop-build');
    assert.equal(build.lastExit, code);
    assert.equal(build.interval, 900, 'a lane wakes as its own sleeping line says');
  }
  // An END line with no code in it: ended, code unknown.
  const bare = readStage([start('loop-build', at('2026-11-09T10:00:00')), `===== ${logDate(at('2026-11-09T10:01:00'))} END /loop-build =====`].join('\n'), 'loop-build');
  assert.equal(bare.lastExit, null);
  assert.equal(bare.running, false);
});

// ── SP-218: a stage that keeps failing ──────────────────────────────────────
const relayFailed = (d) => `===== ${logDate(d)} END relay — A STEP FAILED AND SAID SO ABOVE (exit 1) =====`;
/** One relay pass that could not resolve GitHub, as on 11/11. */
const offlineRelayPass = (began) => [
  relayStart(began),
  "fatal: unable to access 'https://github.com/someone/project.git/': Could not resolve host: github.com",
  relayFailed(new Date(began.getTime() + 15_000)),
];
/** One lane pass: its exit 0 is "not a verdict", so only a FAILED: line in its report fails it. */
const lanePass = (job, began, reportLines, code = 0) => [
  start(job, began),
  ...reportLines,
  `===== ${logDate(new Date(began.getTime() + 120_000))} END /${job} (exit ${code} — not a verdict; the pass's report above is) =====`,
  sleeping(job, new Date(began.getTime() + 120_000)),
];

test('three relay passes in a row that could not resolve GitHub: failing since the first of them started, and the reason is the internet (SP-218)', () => {
  assert.equal(FAILING_AFTER, 3);
  const firsts = ['2026-11-10T21:00:00', '2026-11-10T21:10:00', '2026-11-10T21:20:00'].map(at);
  const text = [
    relayStart(at('2026-11-10T20:50:00')), relayEnd(at('2026-11-10T20:50:20')),
    ...firsts.flatMap(offlineRelayPass),
  ].join('\n');
  const relay = readStage(text, 'relay', { interval: 600 });
  assert.deepEqual(
    { failing: relay.failing, failedPasses: relay.failedPasses, failingSince: relay.failingSince.toISOString(), failingReason: relay.failingReason },
    { failing: true, failedPasses: 3, failingSince: firsts[0].toISOString(), failingReason: "can't reach the internet" },
  );
  // A fourth pass under way neither breaks the run nor adds to it.
  const running = readStage([text, relayStart(at('2026-11-10T21:30:00'))].join('\n'), 'relay', { interval: 600 });
  assert.equal(running.running, true);
  assert.equal(running.failedPasses, 3);
  assert.equal(running.failing, true);
});

test('two failed passes in a row are not failing; one passing pass after the failures clears it (SP-218)', () => {
  const two = [
    ...offlineRelayPass(at('2026-11-10T21:00:00')),
    ...offlineRelayPass(at('2026-11-10T21:10:00')),
  ];
  const twoRead = readStage(two.join('\n'), 'relay');
  assert.deepEqual([twoRead.failing, twoRead.failedPasses, twoRead.failingReason], [false, 2, null]);
  const many = [...two, ...offlineRelayPass(at('2026-11-10T21:20:00')), ...offlineRelayPass(at('2026-11-10T21:30:00'))];
  assert.equal(readStage(many.join('\n'), 'relay').failedPasses, 4);
  const back = readStage([...many, relayStart(at('2026-11-11T09:22:00')), relayEnd(at('2026-11-11T09:22:30'))].join('\n'), 'relay');
  assert.deepEqual([back.failing, back.failedPasses, back.failingSince, back.failingReason], [false, 0, null, null]);
});

test('a lane pass that exits 0 but reports FAILED: counts as failed; one without such a line counts as passed; a bad exit fails it too (SP-218)', () => {
  const job = 'loop-intake';
  const failedReport = ['the pass did its work', 'FAILED: the intake pass could not hand SP-1 to you.'];
  const quiet = ['the pass did its work', 'Filed SP-2. Nothing FAILED: here mid-line.'];
  const passes = (reports) => reports.flatMap((r, i) => lanePass(job, new Date(at('2026-11-10T14:30:00').getTime() + i * 1800_000), r.lines, r.code ?? 0));
  const allFailed = readStage(passes([{ lines: failedReport }, { lines: failedReport }, { lines: [], code: 1 }]).join('\n'), job);
  assert.deepEqual(
    [allFailed.failing, allFailed.failedPasses, allFailed.failingSince.toISOString(), allFailed.failingReason],
    [true, 3, at('2026-11-10T14:30:00').toISOString(), 'keeps failing'],
  );
  const middlePassed = readStage(passes([{ lines: failedReport }, { lines: quiet }, { lines: failedReport }]).join('\n'), job);
  assert.deepEqual([middlePassed.failing, middlePassed.failedPasses], [false, 1]);
  // The relay's exit is its verdict: a FAILED: line in a relay pass that ended 0 is not a failure.
  const relay = readStage([relayStart(at('2026-11-10T10:00:00')), 'FAILED: something', relayEnd(at('2026-11-10T10:00:10'))].join('\n'), 'relay');
  assert.equal(relay.failedPasses, 0);
});

test('the reason comes from the newest failed pass: offline earlier, failing otherwise now, says "keeps failing" (SP-218)', () => {
  const lines = [
    ...offlineRelayPass(at('2026-11-10T21:00:00')),
    ...offlineRelayPass(at('2026-11-10T21:10:00')),
    relayStart(at('2026-11-10T21:20:00')), 'some other trouble', relayFailed(at('2026-11-10T21:20:10')),
  ];
  assert.equal(readStage(lines.join('\n'), 'relay').failingReason, FAILING_REASONS.failing);
  for (const said of ['getaddrinfo ENOTFOUND api.doppler.com', 'Error: getaddrinfo EAI_AGAIN github.com']) {
    const offline = [0, 10, 20].flatMap((m) => [relayStart(at(`2026-11-10T21:${String(m).padStart(2, '0')}:00`)), said, relayFailed(at(`2026-11-10T21:${String(m).padStart(2, '0')}:10`))]);
    assert.equal(readStage(offline.join('\n'), 'relay').failingReason, FAILING_REASONS.offline, said);
  }
  assert.deepEqual(Object.values(FAILING_REASONS).sort(), ["can't reach the internet", 'keeps failing']);
});

test('GET /pipeline\'s answer for a failing stage carries counts, a time and the fixed reason words, never a line of the log (SP-218)', () => {
  const secret = 'TOKEN=dp.st.made-up-secret-value-1234567890';
  const dir = scratch({
    'proj-relay.log': [0, 10, 20].flatMap((m) => [
      relayStart(at(`2026-11-10T21:${String(m).padStart(2, '0')}:00`)),
      secret,
      "fatal: unable to access 'https://github.com/someone/project.git/': Could not resolve host: github.com",
      relayFailed(at(`2026-11-10T21:${String(m).padStart(2, '0')}:15`)),
    ]).join('\n'),
    'proj-loop-review.log': [0, 1, 2].flatMap((i) => lanePass('loop-review', new Date(at('2026-11-10T12:00:00').getTime() + i * 1800_000), [secret, 'FAILED: review could not run verify'])).join('\n'),
  });
  try {
    const answer = pipelineOf({ logDir: dir, slug: 'proj' });
    const by = Object.fromEntries(answer.stages.map((s) => [s.job, s]));
    assert.deepEqual(
      [by.relay.failing, by.relay.failedPasses, by.relay.failingSince, by.relay.failingReason],
      [true, 3, at('2026-11-10T21:00:00').toISOString(), "can't reach the internet"],
    );
    assert.deepEqual([by['loop-review'].failing, by['loop-review'].failingReason], [true, 'keeps failing']);
    assert.deepEqual([by['loop-build'].failing, by['loop-build'].failedPasses, by['loop-build'].failingSince, by['loop-build'].failingReason], [false, 0, null, null]);
    const text = JSON.stringify(answer);
    assert.doesNotMatch(text, /made-up-secret|TOKEN|dp\.st|github\.com|resolve|FAILED|verify|fatal/);
    for (const s of answer.stages) {
      assert.ok(s.failingReason === null || Object.values(FAILING_REASONS).includes(s.failingReason));
      assert.ok(Number.isInteger(s.failedPasses));
      assert.equal(typeof s.failing, 'boolean');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pausedBy reads the Settings page\'s two switches: the whole pipeline first, then the lane (SP-237)', () => {
  const controls = (on) => ['paused', 'paused.loop-build', 'paused.relay'].map((key) => ({ key, value: on.includes(key) ? 'on' : 'off' }));
  assert.equal(pausedBy(controls([]), 'loop-build'), null);
  assert.equal(pausedBy(controls(['paused.loop-build']), 'loop-build'), 'lane');
  assert.equal(pausedBy(controls(['paused.loop-build']), 'loop-review'), null);
  assert.equal(pausedBy(controls(['paused', 'paused.relay']), 'relay'), 'pipeline');
  assert.equal(pausedBy(controls(['paused']), 'loop-intake'), 'pipeline');
  assert.equal(pausedBy(null, 'relay'), null, 'controls not known: nothing shown paused');
});

test('pipelineOf marks each stage paused from the controls it is given, logged or not (SP-237)', () => {
  const dir = scratch({});
  try {
    const answer = pipelineOf({ logDir: dir, slug: 'proj' }, { controls: [{ key: 'paused', value: 'off' }, { key: 'paused.loop-build', value: 'on' }] });
    const by = Object.fromEntries(answer.stages.map((s) => [s.job, s.paused]));
    assert.deepEqual(by, { relay: null, 'loop-build': 'lane', 'loop-review': null, 'loop-intake': null });
    const whole = pipelineOf({ logDir: dir, slug: 'proj' }, { controls: [{ key: 'paused', value: 'on' }] });
    assert.ok(whole.stages.every((s) => s.paused === 'pipeline'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
