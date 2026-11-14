/**
 * The kept-alive lanes the installer puts on the Mini (SKILLS in
 * scripts/install_loop_runner.sh), checked against what each lane needs to
 * run: a skill for `claude -p /<lane>` to find, and a tracker sign-in seat
 * under the name loop_runner.sh derives from the lane (loop-intake ->
 * TRACKER_TOKEN_LOOP_INTAKE), or the door refuses every pass.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TRACKER_SEATS } from './expectedSecrets.mjs';
import { INTERVALS } from './loopSchedule.mjs';
import scratchGit from '../../lib/scratchGit.js';

const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const installer = readFileSync(join(REPO, 'scripts/install_loop_runner.sh'), 'utf8');

function lanes() {
  const m = installer.match(/^SKILLS=\(([^)]*)\)$/m);
  assert.ok(m, 'install_loop_runner.sh has no SKILLS=(...) line');
  return m[1].trim().split(/\s+/);
}

/** The secret name loop_runner.sh exports as TRACKER_TOKEN_NAME for a lane. */
const seatSecretFor = (lane) => `TRACKER_TOKEN_${lane.toUpperCase().replace(/-/g, '_')}`;

test('the installer keeps three lanes alive (build, review, intake) beside the relay: four loop jobs', () => {
  assert.deepEqual(lanes(), ['loop-build', 'loop-review', 'loop-intake']);
  assert.match(installer, /^RELAY=relay$/m);
});

test('every lane has a skill and its own machine sign-in seat', () => {
  for (const lane of lanes()) {
    assert.ok(existsSync(join(REPO, '.claude/skills', lane, 'SKILL.md')), `${lane}: no .claude/skills/${lane}/SKILL.md`);
    const seat = TRACKER_SEATS.find((s) => s.secret === seatSecretFor(lane));
    assert.ok(seat, `${lane}: no seat ${seatSecretFor(lane)} in TRACKER_SEATS`);
    assert.equal(seat.kind, 'machine');
    assert.equal(seat.name, lane);
  }
});

test('every lane has its own interval, and labels come from the project config, never typed in', () => {
  // The numbers live in scripts/lib/loopSchedule.mjs, shared with the tracker's Pipeline Status pod (SP-168).
  assert.match(installer, /^interval_of\(\) \{ PATH="\$LAUNCHD_PATH" node "\$REPO\/scripts\/lib\/loopSchedule\.mjs" interval "\$1"; \}$/m);
  for (const job of [...lanes(), 'relay']) assert.ok(Object.hasOwn(INTERVALS, job), `${job}: no interval in scripts/lib/loopSchedule.mjs`);
  assert.match(installer, /^PREFIX="\$\(config_value launchdPrefix\)"$/m);
  assert.doesNotMatch(installer, /com\.spirality/);
});

// The runner itself, run in a scratch copy of the repository (a git checkout
// on a clean main, so it takes the sync lock) whose settings file names
// another project. Spirality's sync lock is held by a live process: a runner
// that still used it would wait ten minutes. The other project's own sync
// lock is left stale, so taking it clears it. Claude is a stand-in that lists
// the log folder mid-pass (the lane's lock is seen held) and then reports a
// sign-in failure (the runner prints its restart line). The runner sleeps
// after one pass, and is stopped there.
test('loop_runner.sh names its log, lock, sync lock and restart label from the settings file', { timeout: 30_000 }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'runner-names-'));
  const logDir = mkdtempSync(join(tmpdir(), 'runner-names-logs-'));
  try {
    mkdirSync(join(scratch, 'scripts'));
    copyFileSync(join(REPO, 'scripts/loop_runner.sh'), join(scratch, 'scripts/loop_runner.sh'));
    // A stand-in for the Settings page's pause check (SP-237): not paused.
    writeFileSync(join(scratch, 'scripts/pause_check.sh'), '#!/bin/bash\necho "running"\n', { mode: 0o755 });
    // A link, so project_config.mjs still finds lib/ beside the real file.
    for (const f of ['project_config.mjs', 'run_with_time_limit.sh']) symlinkSync(join(REPO, 'scripts', f), join(scratch, 'scripts', f));
    const spirality = JSON.parse(readFileSync(join(REPO, 'spirality.project.json'), 'utf8'));
    writeFileSync(join(scratch, 'spirality.project.json'), JSON.stringify({
      ...spirality, projectSlug: 'normie', launchdPrefix: 'com.normie', logDir,
    }));
    const fakeClaude = join(scratch, 'fake-claude');
    writeFileSync(fakeClaude, `#!/bin/bash\nls "${logDir}"\necho "Please run /login"\n`, { mode: 0o755 });
    const git = (...args) => scratchGit.git(scratch, ...args);
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('commit', '-q', '-m', 'scratch');
    mkdirSync(join(logDir, 'spirality-sync.lock'));
    writeFileSync(join(logDir, 'spirality-sync.lock/pid'), String(process.pid));
    mkdirSync(join(logDir, 'normie-sync.lock'));
    writeFileSync(join(logDir, 'normie-sync.lock/pid'), '999999');

    const runner = spawn('bash', [join(scratch, 'scripts/loop_runner.sh'), 'loop-build', '3600'], {
      // The runner pulls main with git: never into a repository a commit hook named (SP-104).
      cwd: scratch, detached: true, stdio: 'ignore', env: { ...scratchGit.scratchGitEnv(), CLAUDE_BIN: fakeClaude, RUN_WITH_TIME_LIMIT_POLL: '1' },
    });
    const log = join(logDir, 'normie-loop-build.log');
    try {
      for (let i = 0; !(existsSync(log) && readFileSync(log, 'utf8').includes('sleeping 3600s')); i++) {
        assert.ok(i < 200, 'the runner never finished its first pass');
        await new Promise((r) => setTimeout(r, 100));
      }
    } finally {
      process.kill(-runner.pid, 'SIGKILL');
    }

    const text = readFileSync(log, 'utf8');
    assert.match(text, /START \/loop-build/);
    assert.match(text, /^normie-loop-build\.lock$/m, 'the lane did not hold normie-loop-build.lock during its pass');
    assert.match(text, /launchctl kickstart -k gui\/\d+\/com\.normie\.loop-build$/m);
    assert.ok(!existsSync(join(logDir, 'normie-sync.lock')), 'the runner never took (and cleared) normie-sync.lock');
    assert.deepEqual(readdirSync(logDir).filter((f) => !f.startsWith('normie-')), ['spirality-sync.lock']);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(logDir, { recursive: true, force: true });
  }
});

test('loop_runner.sh names no project of its own', () => {
  assert.doesNotMatch(readFileSync(join(REPO, 'scripts/loop_runner.sh'), 'utf8'), /spirality/);
});

// The wake (SP-219): the sleep between passes ends early on the lane's wake
// file, ends on time without one, and a wake sent during a pass neither stops
// nor doubles it. Each test runs the real runner in a scratch copy, as above,
// with the wake file looked for every second.
async function withRunner({ interval, claude, wakeSetting = null, modelSetting = null }, body) {
  const scratch = mkdtempSync(join(tmpdir(), 'runner-wake-'));
  const logDir = mkdtempSync(join(tmpdir(), 'runner-wake-logs-'));
  let runner;
  try {
    mkdirSync(join(scratch, 'scripts/lib'), { recursive: true });
    copyFileSync(join(REPO, 'scripts/loop_runner.sh'), join(scratch, 'scripts/loop_runner.sh'));
    // A stand-in for the Settings page's pause check (SP-237): not paused.
    writeFileSync(join(scratch, 'scripts/pause_check.sh'), '#!/bin/bash\necho "running"\n', { mode: 0o755 });
    for (const f of ['project_config.mjs', 'run_with_time_limit.sh', 'lib/wakeLane.mjs']) symlinkSync(join(REPO, 'scripts', f), join(scratch, 'scripts', f));
    // A stand-in for the tracker's answer (SP-236), when the test gives one: never the live tracker.
    if (wakeSetting) writeFileSync(join(scratch, 'scripts/lib/wakeSetting.mjs'), wakeSetting({ logDir }));
    // A stand-in for the model chosen on the Settings page (SP-239), the same way.
    if (modelSetting) writeFileSync(join(scratch, 'scripts/lib/modelSetting.mjs'), modelSetting({ logDir }));
    const spirality = JSON.parse(readFileSync(join(REPO, 'spirality.project.json'), 'utf8'));
    writeFileSync(join(scratch, 'spirality.project.json'), JSON.stringify({
      ...spirality, projectSlug: 'normie', launchdPrefix: 'com.normie', logDir,
    }));
    const wake = join(logDir, 'normie-loop-build.wake');
    const fakeClaude = join(scratch, 'fake-claude');
    writeFileSync(fakeClaude, `#!/bin/bash\n${claude({ wake, logDir })}\n`, { mode: 0o755 });
    const git = (...args) => scratchGit.git(scratch, ...args);
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('commit', '-q', '-m', 'scratch');
    runner = spawn('bash', [join(scratch, 'scripts/loop_runner.sh'), 'loop-build', String(interval)], {
      cwd: scratch, detached: true, stdio: 'ignore',
      env: { ...scratchGit.scratchGitEnv(), CLAUDE_BIN: fakeClaude, RUN_WITH_TIME_LIMIT_POLL: '1', LOOP_WAKE_POLL_SECONDS: '1' },
    });
    const log = join(logDir, 'normie-loop-build.log');
    const read = () => (existsSync(log) ? readFileSync(log, 'utf8') : '');
    const count = (re) => (read().match(re) || []).length;
    const until = async (what, ok, seconds) => {
      for (let i = 0; !ok(); i++) {
        assert.ok(i < seconds * 10, `${what} (log so far:\n${read()})`);
        await new Promise((r) => setTimeout(r, 100));
      }
    };
    await body({ scratch, logDir, wake, read, count, until });
  } finally {
    if (runner) try { process.kill(-runner.pid, 'SIGKILL'); } catch { /* already gone */ }
    rmSync(scratch, { recursive: true, force: true });
    rmSync(logDir, { recursive: true, force: true });
  }
}

const STARTS = /START \/loop-build/g;
const WOKEN = /woken early after \d+s of \d+s/g;

test('a wake ends the runner\'s sleep: wakeLane.mjs starts the next pass within seconds, and the log says so', { timeout: 60_000 }, async () => {
  await withRunner({ interval: 3600, claude: () => 'echo pass' }, async ({ scratch, wake, read, count, until }) => {
    await until('the runner never finished its first pass', () => read().includes('sleeping 3600s'), 20);
    const sent = Date.now();
    const cli = spawnSync(process.execPath, [join(scratch, 'scripts/lib/wakeLane.mjs'), 'loop-build'], { cwd: scratch, encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /^loop-build: woken — wake file .*normie-loop-build\.wake written; runner pid \d+/);
    await until('the wake did not start a second pass within 15 seconds', () => count(STARTS) === 2, 15);
    assert.ok(Date.now() - sent < 15_000);
    assert.equal(count(WOKEN), 1);
    assert.ok(!existsSync(wake), 'the wake file was not cleared as the pass started');
  });
});

test('with no wake, the sleep ends on time and the log says nothing of a wake', { timeout: 60_000 }, async () => {
  await withRunner({ interval: 2, claude: () => 'echo pass' }, async ({ read, count, until }) => {
    await until('the timer never started a second pass', () => count(STARTS) === 2, 30);
    assert.equal(count(WOKEN), 0);
    assert.match(read(), /sleeping 2s before the next \/loop-build/);
  });
});

test('wakes sent during a pass never stop or double it: exactly one more pass follows', { timeout: 60_000 }, async () => {
  // The first pass sends two wakes and keeps working; the second only reports.
  const claude = ({ wake, logDir }) => [
    `if [ ! -e "${logDir}/first-done" ]; then`,
    `  : > "${logDir}/first-done"; echo first-pass-begins; : > "${wake}"; sleep 1; : > "${wake}"; sleep 1; echo first-pass-ends`,
    'else echo second-pass; fi',
  ].join('\n');
  await withRunner({ interval: 3600, claude }, async ({ wake, read, count, until }) => {
    await until('the second pass never ran', () => count(/sleeping 3600s/g) === 2, 30);
    await new Promise((r) => setTimeout(r, 3000));
    const text = read();
    assert.equal(count(STARTS), 2, 'not exactly one more pass');
    assert.equal(count(WOKEN), 1);
    const order = text.match(/START \/loop-build|first-pass-begins|first-pass-ends|END \/loop-build|woken early|second-pass/g);
    assert.deepEqual(order, ['START /loop-build', 'first-pass-begins', 'first-pass-ends', 'END /loop-build', 'woken early', 'START /loop-build', 'second-pass', 'END /loop-build']);
    assert.match(text, /woken early after 0s of 3600s/);
    assert.ok(!existsSync(wake));
  });
});

// The wake time set on the Settings page (SP-236): read before every sleep.
// The stand-in answers in turn from a list, one answer per read: the
// tracker unreachable, a 0 it must never sleep on, then the set value.
const answering = (answers) => ({ logDir }) => [
  "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
  `const calls = ${JSON.stringify(join(logDir, 'wake-calls'))};`,
  'const n = existsSync(calls) ? Number(readFileSync(calls, "utf8")) + 1 : 1;',
  'writeFileSync(calls, String(n));',
  `const answers = ${JSON.stringify(answers)};`,
  'const [code, line] = answers[Math.min(n, answers.length) - 1];',
  "if (process.argv[2] !== 'loop-build') { console.log(`asked for ${process.argv[2]}`); process.exit(1); }",
  'console.log(line); process.exit(code);',
].join('\n');

test('the runner sleeps the wake time set on the Settings page, read before every sleep; a read that fails or answers 0 keeps the last good value in one log line, and the lane carries on (SP-236)', { timeout: 60_000 }, async () => {
  const wakeSetting = answering([[1, 'the settings read failed (exit 1: fetch failed)'], [0, '0'], [0, '600']]);
  await withRunner({ interval: 2, claude: () => 'echo pass', wakeSetting }, async ({ read, count, until }) => {
    await until('the runner never slept the set value', () => read().includes('sleeping 600s'), 30);
    const text = read();
    assert.equal(count(STARTS), 3, 'a failed read stopped the lane');
    const sleeps = text.match(/sleeping \d+s before the next \/loop-build/g);
    assert.deepEqual(sleeps, ['sleeping 2s before the next /loop-build', 'sleeping 2s before the next /loop-build', 'sleeping 600s before the next /loop-build']);
    const failed = text.match(/^\[loop-runner\] .*could not read \/loop-build's wake time.*$/gm);
    assert.equal(failed.length, 2, text);
    assert.match(failed[0], /could not read \/loop-build's wake time from the tracker \(the settings read failed \(exit 1: fetch failed\)\) — keeping the last good value, 2s$/);
    assert.match(failed[1], /could not read \/loop-build's wake time from the tracker \(0\) — keeping the last good value, 2s$/);
    // The read comes after the pass and before its sleep line, so the line says what it will sleep.
    assert.match(text, /END \/loop-build[^\n]*\n\[loop-runner\][^\n]*could not read[^\n]*wake time[^\n]*\n\[loop-runner\][^\n]*sleeping 2s/);
  });
});

// The model chosen on the Settings page (SP-239): read before every pass.
// The stand-in claude prints the arguments it was given, so the log shows
// the exact command each pass ran.
const modelAnswer = (code, line) => () => `console.log(${JSON.stringify(line)}); process.exit(${code});\n`;
const TODAYS_ARGS = 'ARGS: -p /loop-build --allowedTools Bash Edit Write Read Glob Grep Task TodoWrite WebFetch';

async function onePass(modelSetting) {
  let text = '';
  await withRunner({ interval: 3600, claude: () => 'echo "ARGS: $*"', modelSetting }, async ({ read, until }) => {
    await until('the pass never finished', () => /sleeping 3600s/.test(read()), 30);
    text = read();
  });
  return text;
}

test('a model chosen for the lane goes on the claude line as --model <id>, and the START line names it (SP-239)', { timeout: 60_000 }, async () => {
  const text = await onePass(modelAnswer(0, 'claude-sonnet-5-5'));
  assert.match(text, /^===== \d{4}-\d\d-\d\d \d\d:\d\d:\d\d START \/loop-build \(model: claude-sonnet-5-5\) =====$/m);
  assert.match(text, /^ARGS: -p \/loop-build --model claude-sonnet-5-5 --allowedTools Bash Edit Write Read Glob Grep Task TodoWrite WebFetch$/m);
  assert.doesNotMatch(text, /could not read \/loop-build's model/);
});

test('with Claude\'s default chosen, the claude line is today\'s, byte for byte, with no --model (SP-239)', { timeout: 60_000 }, async () => {
  const text = await onePass(modelAnswer(0, 'default'));
  assert.match(text, /START \/loop-build \(model: default\) =====/);
  assert.equal(text.split('\n').filter((l) => l.startsWith('ARGS: ')).join('\n'), TODAYS_ARGS);
  assert.doesNotMatch(text, /could not read \/loop-build's model/);
});

test('settings that cannot be read, or a model not on the list, run the pass on Claude\'s default with one log line saying why (SP-239)', { timeout: 90_000 }, async () => {
  const cases = [
    [modelAnswer(1, 'the settings read failed (exit 1: fetch failed)'), /could not read \/loop-build's model from the tracker \(the settings read failed \(exit 1: fetch failed\)\) — this pass runs on Claude's default$/m],
    // The runner checks again: even a reader that answered 0 never hands claude anything but a plain model id.
    [modelAnswer(0, 'gpt-9'), /could not read \/loop-build's model from the tracker \(gpt-9\) — this pass runs on Claude's default$/m],
    [modelAnswer(0, 'claude-x --dangerously-skip-permissions'), /could not read \/loop-build's model from the tracker \(claude-x --dangerously-skip-permissions\) — this pass runs on Claude's default$/m],
  ];
  for (const [answer, said] of cases) {
    const text = await onePass(answer);
    assert.match(text, said);
    assert.equal((text.match(/could not read \/loop-build's model/g) || []).length, 1, text);
    assert.match(text, /START \/loop-build \(model: default\) =====/);
    assert.equal(text.split('\n').filter((l) => l.startsWith('ARGS: ')).join('\n'), TODAYS_ARGS);
  }
});

// The installer, run for real with --print-plists, which writes and loads
// nothing (SP-271). HOME is a scratch folder whose .local/bin holds this node,
// the last folder on launchd's PATH, so the installer's own node calls work
// on any machine (CI included); plists it would write name that HOME.
function scratchHome() {
  const home = mkdtempSync(join(tmpdir(), 'installer-home-'));
  mkdirSync(join(home, '.local/bin'), { recursive: true });
  symlinkSync(process.execPath, join(home, '.local/bin/node'));
  mkdirSync(join(home, 'Library/LaunchAgents'), { recursive: true });
  return home;
}

/** A project checkout folder (not a git checkout) with its own manifest. */
function scratchProject(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'installer-project-'));
  const spirality = JSON.parse(readFileSync(join(REPO, 'spirality.project.json'), 'utf8'));
  writeFileSync(join(dir, 'spirality.project.json'), JSON.stringify({
    ...spirality, projectSlug: 'normie', launchdPrefix: 'com.normie', logDir: join(dir, 'logs'), ...overrides,
  }));
  return dir;
}

function runInstaller(args, home, cwd = REPO) {
  const env = { ...process.env, HOME: home };
  delete env.SPIRALITY_PROJECT;
  return spawnSync('bash', [join(REPO, 'scripts/install_loop_runner.sh'), ...args], { encoding: 'utf8', env, cwd });
}

/** --print-plists output, as { file name: plist text }. */
function printedPlists(args, home, cwd = REPO) {
  const r = runInstaller(['--print-plists', ...args], home, cwd);
  assert.equal(r.status, 0, r.stderr);
  const out = {};
  for (const part of r.stdout.split(/^=== /m).slice(1)) {
    const nl = part.indexOf('\n');
    out[part.slice(0, nl).split('/').pop()] = part.slice(nl + 1);
  }
  return out;
}

const stringAfter = (plist, key) => plist.match(new RegExp(`<key>${key}</key>\\s*(?:<array>\\s*)?<string>([^<]*)</string>`))?.[1];

test('for a project, the installer writes plists whose program is Spirality\'s runner and whose working folder is the project\'s checkout (SP-271)', () => {
  const home = scratchHome();
  const project = scratchProject();
  try {
    const plists = printedPlists(['--project', project], home);
    assert.deepEqual(Object.keys(plists).sort(), ['com.normie.loop-build.plist', 'com.normie.loop-intake.plist', 'com.normie.loop-review.plist', 'com.normie.relay.plist']);
    for (const lane of lanes()) {
      const text = plists[`com.normie.${lane}.plist`];
      assert.equal(stringAfter(text, 'Label'), `com.normie.${lane}`);
      assert.equal(stringAfter(text, 'ProgramArguments'), join(REPO, 'scripts/loop_runner.sh'), `${lane}: not Spirality's runner`);
      assert.match(text, new RegExp(`<string>${lane}</string>\\n\\s*<string>${INTERVALS[lane]}</string>`));
      assert.equal(stringAfter(text, 'WorkingDirectory'), project);
      assert.equal(stringAfter(text, 'SPIRALITY_PROJECT'), project);
    }
    const relay = plists['com.normie.relay.plist'];
    assert.equal(stringAfter(relay, 'ProgramArguments'), join(REPO, 'scripts/run_relay.sh'));
    assert.match(relay, /<string>--tick<\/string>/);
    assert.equal(stringAfter(relay, 'WorkingDirectory'), project);
    assert.equal(stringAfter(relay, 'SPIRALITY_PROJECT'), project);
    assert.equal(stringAfter(relay, 'StandardOutPath'), join(project, 'logs/normie-relay.log'));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test('Spirality\'s own plists are what they always were: its own folder, no SPIRALITY_PROJECT, even one left in the shell (SP-271)', () => {
  const home = scratchHome();
  try {
    const own = JSON.parse(readFileSync(join(REPO, 'spirality.project.json'), 'utf8'));
    const plists = printedPlists([], home);
    assert.deepEqual(Object.keys(plists).sort(), [...lanes(), 'relay'].map((j) => `${own.launchdPrefix}.${j}.plist`).sort());
    for (const text of Object.values(plists)) {
      assert.equal(stringAfter(text, 'WorkingDirectory'), REPO.replace(/\/$/, ''));
      assert.doesNotMatch(text, /SPIRALITY_PROJECT/);
    }
    // Naming Spirality's own folder as the project is Spirality's own lanes.
    assert.deepEqual(printedPlists(['--project', REPO], home), plists);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the relay\'s plist starts run_relay.sh --tick on the one-minute tick, never on the wake time, so a new wake time needs no reinstall (SP-236)', () => {
  const home = scratchHome();
  try {
    const relay = Object.entries(printedPlists([], home)).find(([f]) => f.endsWith('.relay.plist'))[1];
    assert.match(relay, /<string>[^<]*\/scripts\/run_relay\.sh<\/string>\n\s*<string>--tick<\/string>/);
    assert.match(relay, /<key>StartInterval<\/key>\n\s*<integer>(\d+)<\/integer>/);
    assert.equal(Number(relay.match(/<key>StartInterval<\/key>\n\s*<integer>(\d+)<\/integer>/)[1]), Number(spawnSync(process.execPath, [join(REPO, 'scripts/lib/loopSchedule.mjs'), 'tick'], { encoding: 'utf8' }).stdout.trim()));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  assert.match(installer, /^relay_tick\(\) \{ PATH="\$LAUNCHD_PATH" node "\$REPO\/scripts\/lib\/loopSchedule\.mjs" tick; \}$/m);
});

test('installing for a project whose lanes run its own copy refuses, naming them, and changes nothing without --take-over (SP-271)', () => {
  const home = scratchHome();
  const project = scratchProject();
  try {
    const theirs = join(home, 'Library/LaunchAgents/com.normie.loop-build.plist');
    const before = `<plist version="1.0">\n<dict>\n    <key>ProgramArguments</key>\n    <array>\n        <string>${project}/scripts/loop_runner.sh</string>\n    </array>\n</dict>\n</plist>\n`;
    writeFileSync(theirs, before);
    const r = runInstaller(['--install', '--project', project], home);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /Refusing to install: these jobs run something other than Spirality's runner/);
    assert.match(r.stderr, new RegExp(`com\\.normie\\.loop-build \\(runs ${project}/scripts/loop_runner\\.sh\\)`));
    assert.match(r.stderr, /--take-over/);
    assert.equal(readFileSync(theirs, 'utf8'), before);
    assert.deepEqual(readdirSync(join(home, 'Library/LaunchAgents')), ['com.normie.loop-build.plist']);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test('a project naming Spirality\'s own label prefix or short name is refused before anything is printed or written (SP-271)', () => {
  const home = scratchHome();
  const own = JSON.parse(readFileSync(join(REPO, 'spirality.project.json'), 'utf8'));
  for (const clash of [{ launchdPrefix: own.launchdPrefix }, { projectSlug: own.projectSlug }]) {
    const project = scratchProject(clash);
    try {
      const r = runInstaller(['--print-plists', '--project', project], home);
      assert.equal(r.status, 1);
      assert.equal(r.stdout, '');
      assert.match(r.stderr, /names Spirality's own launchdPrefix/);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  }
  rmSync(home, { recursive: true, force: true });
});

test('for a project, the clash guard reads Spirality\'s own values from Spirality\'s folder, wherever the installer is started from (SP-271 review)', () => {
  const home = scratchHome();
  const project = scratchProject();
  const own = JSON.parse(readFileSync(join(REPO, 'spirality.project.json'), 'utf8'));
  // A third project, sitting where the installer is started from, whose
  // prefix is the project's: the clash guard must still compare against
  // Spirality's own values, not this folder's.
  const third = scratchProject({ projectSlug: 'third', launchdPrefix: 'com.normie' });
  try {
    // Started in the project's own folder, naming it as ".".
    // (The started-in folder is the real path: /var is /private/var on a Mac.)
    assert.deepEqual(printedPlists(['--project', '.'], home, project), printedPlists(['--project', realpathSync(project)], home));
    // Started in a third project's folder: same plists for the project...
    assert.deepEqual(printedPlists(['--project', project], home, third), printedPlists(['--project', project], home));
    // A real clash with Spirality's prefix is still refused from there.
    const clash = scratchProject({ launchdPrefix: own.launchdPrefix });
    try {
      const r = runInstaller(['--print-plists', '--project', clash], home, third);
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stderr, new RegExp(`names Spirality's own launchdPrefix \\(${own.launchdPrefix.replace(/\./g, '\\.')}\\)`));
    } finally {
      rmSync(clash, { recursive: true, force: true });
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
    rmSync(third, { recursive: true, force: true });
  }
});

test('--project=~/... is expanded like the space form (SP-271 review)', () => {
  const home = scratchHome();
  const project = scratchProject();
  try {
    // The project, reached through the scratch HOME.
    symlinkSync(project, join(home, 'normie'));
    const viaTilde = printedPlists(['--project=~/normie'], home);
    assert.deepEqual(Object.keys(viaTilde).sort(), ['com.normie.loop-build.plist', 'com.normie.loop-intake.plist', 'com.normie.loop-review.plist', 'com.normie.relay.plist']);
    assert.equal(stringAfter(viaTilde['com.normie.relay.plist'], 'WorkingDirectory'), join(home, 'normie'));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test('uninstalling for a project whose lanes run its own copy refuses, naming them, and removes nothing without --take-over (SP-271 review)', () => {
  const home = scratchHome();
  const project = scratchProject();
  try {
    const agents = join(home, 'Library/LaunchAgents');
    const theirs = join(agents, 'com.normie.relay.plist');
    const before = `<plist version="1.0">\n<dict>\n    <key>ProgramArguments</key>\n    <array>\n        <string>${project}/scripts/run_relay.sh</string>\n    </array>\n</dict>\n</plist>\n`;
    writeFileSync(theirs, before);
    const r = runInstaller(['--uninstall', '--project', project], home);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /Refusing to uninstall: these jobs run something other than Spirality's runner/);
    assert.match(r.stderr, new RegExp(`com\\.normie\\.relay \\(runs ${project}/scripts/run_relay\\.sh\\)`));
    assert.match(r.stderr, /--take-over/);
    assert.doesNotMatch(r.stdout, /Removed/);
    assert.equal(readFileSync(theirs, 'utf8'), before);
    assert.deepEqual(readdirSync(agents), ['com.normie.relay.plist']);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

// The runner and the relay for a named project (SP-271), each in a scratch
// Spirality folder beside a scratch project, both clean mains with an origin
// that has moved on by one commit. The pass must start in the project, pull
// the project's main, and leave Spirality's checkout where it was.
function scratchPair() {
  const root = mkdtempSync(join(tmpdir(), 'project-lanes-'));
  const spiralityDir = join(root, 'spirality');
  const projectDir = join(root, 'normie');
  const logDir = join(root, 'logs');
  const git = (cwd, ...args) => scratchGit.git(cwd, ...args);
  const spirality = JSON.parse(readFileSync(join(REPO, 'spirality.project.json'), 'utf8'));
  for (const dir of [spiralityDir, projectDir]) {
    mkdirSync(dir);
    git(dir, 'init', '-q', '-b', 'main');
  }
  mkdirSync(join(spiralityDir, 'scripts/lib'), { recursive: true });
  for (const f of ['loop_runner.sh', 'run_relay.sh']) copyFileSync(join(REPO, 'scripts', f), join(spiralityDir, 'scripts', f));
  writeFileSync(join(spiralityDir, 'scripts/pause_check.sh'), '#!/bin/bash\necho "running"\n', { mode: 0o755 });
  for (const f of ['project_config.mjs', 'run_with_time_limit.sh']) symlinkSync(join(REPO, 'scripts', f), join(spiralityDir, 'scripts', f));
  for (const f of ['back_to_main.sh', 'tracker_restart.sh', 'relay_app_checks.sh', 'loopSchedule.mjs']) symlinkSync(join(REPO, 'scripts/lib', f), join(spiralityDir, 'scripts/lib', f));
  writeFileSync(join(spiralityDir, 'spirality.project.json'), JSON.stringify(spirality));
  writeFileSync(join(projectDir, 'spirality.project.json'), JSON.stringify({ ...spirality, projectSlug: 'normie', launchdPrefix: 'com.normie', logDir }));
  const heads = {};
  for (const dir of [spiralityDir, projectDir]) {
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'scratch');
    const origin = `${dir}.git`;
    git(root, 'clone', '-q', '--bare', dir, origin);
    git(dir, 'remote', 'add', 'origin', origin);
    // origin moves on by one commit, through a second clone.
    const other = `${dir}-other`;
    git(root, 'clone', '-q', origin, other);
    writeFileSync(join(other, 'moved.txt'), 'moved\n');
    git(other, 'add', '-A');
    git(other, 'commit', '-q', '-m', 'moved on');
    git(other, 'push', '-q', 'origin', 'main');
    git(dir, 'fetch', '-q', 'origin');
    git(dir, 'branch', '-q', '--set-upstream-to=origin/main', 'main');
    heads[dir] = { before: git(dir, 'rev-parse', 'HEAD').trim(), origin: git(other, 'rev-parse', 'HEAD').trim() };
  }
  return { root, spiralityDir, projectDir, logDir, heads, head: (dir) => git(dir, 'rev-parse', 'HEAD').trim() };
}

test('a runner for a named project starts its pass in the project\'s checkout and pulls the project\'s main, never Spirality\'s (SP-271)', { timeout: 60_000 }, async () => {
  const pair = scratchPair();
  try {
    const fakeClaude = join(pair.root, 'fake-claude');
    writeFileSync(fakeClaude, '#!/bin/bash\necho "PASS IN: $(pwd)"\necho "PASS FOR: $SPIRALITY_PROJECT"\n', { mode: 0o755 });
    const runner = spawn('bash', [join(pair.spiralityDir, 'scripts/loop_runner.sh'), 'loop-build', '3600'], {
      cwd: pair.spiralityDir, detached: true, stdio: 'ignore',
      env: { ...scratchGit.scratchGitEnv(), CLAUDE_BIN: fakeClaude, RUN_WITH_TIME_LIMIT_POLL: '1', SPIRALITY_PROJECT: pair.projectDir },
    });
    const log = join(pair.logDir, 'normie-loop-build.log');
    try {
      for (let i = 0; !(existsSync(log) && readFileSync(log, 'utf8').includes('sleeping 3600s')); i++) {
        assert.ok(i < 400, 'the runner never finished its first pass');
        await new Promise((r) => setTimeout(r, 100));
      }
    } finally {
      process.kill(-runner.pid, 'SIGKILL');
    }
    const text = readFileSync(log, 'utf8');
    const real = (p) => realpathSync(p);
    assert.equal(real(text.match(/^PASS IN: (.*)$/m)[1]), real(pair.projectDir));
    assert.equal(text.match(/^PASS FOR: (.*)$/m)[1], pair.projectDir);
    assert.equal(pair.head(pair.projectDir), pair.heads[pair.projectDir].origin, 'the project\'s main was not pulled');
    assert.equal(pair.head(pair.spiralityDir), pair.heads[pair.spiralityDir].before, 'Spirality\'s own main was pulled by a project\'s lane');
  } finally {
    rmSync(pair.root, { recursive: true, force: true });
  }
});

test('a relay for a named project pulls the project\'s main, never Spirality\'s, and names the project on its START line (SP-271)', { timeout: 60_000 }, () => {
  const pair = scratchPair();
  try {
    // The scratch Spirality folder has no package.json, so the door step
    // fails at once; this test is about where the relay pulls and works.
    const r = spawnSync('bash', [join(pair.spiralityDir, 'scripts/run_relay.sh'), '--dry-run'], {
      cwd: pair.spiralityDir, encoding: 'utf8', timeout: 50_000,
      env: { ...scratchGit.scratchGitEnv(), SPIRALITY_PROJECT: pair.projectDir },
    });
    assert.match(r.stdout, new RegExp(`START relay — ${pair.projectDir} =====`), r.stdout + r.stderr);
    assert.equal(pair.head(pair.projectDir), pair.heads[pair.projectDir].origin, 'the project\'s main was not pulled');
    assert.equal(pair.head(pair.spiralityDir), pair.heads[pair.spiralityDir].before, 'Spirality\'s own main was pulled by a project\'s relay');
    assert.ok(existsSync(join(pair.logDir, 'normie-relay.last-start')) === false, 'a dry run wrote the start file');
  } finally {
    rmSync(pair.root, { recursive: true, force: true });
  }
});
