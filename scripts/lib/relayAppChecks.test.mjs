// The relay's application-checks step (scripts/lib/relay_app_checks.sh,
// SP-274), run for real: `npm run app-checks` from this checkout against a
// scratch manifest, with a stand-in `doppler` on PATH that records each bus
// post instead of reaching the tracker. Plus the END line the relay writes,
// read the way tracker/pipeline.mjs and lib/onboardLanes.mjs read it, and the
// time the two parts may take together.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const LIB = join(HERE, 'relay_app_checks.sh');

// Stands in for the Doppler CLI: `run ... -- <command>` records the body of a
// bus post (the door's `bus-post --body-file -`) and lands it; anything else
// is refused, so a test never reaches a real tracker.
const FAKE_DOPPLER = `#!/bin/bash
[ "$1" = "run" ] || exit 9
case " $* " in
  *" bus-post "*) { cat; echo; } >> "$FAKE_POSTS"; [ -n "\${FAKE_POST_FAILS:-}" ] && { echo "tracker down"; exit 1; }; echo "posted"; exit 0 ;;
esac
exit 9
`;

const manifest = (dir, checks) => ({
  manifestVersion: 2, workspaceId: '0', spaceId: '0', loopQueueListId: '0', operatorUserId: '1', machineUserId: '2',
  githubRepo: 'owner/example', dopplerProject: 'example', dopplerConfig: 'dev', launchdPrefix: 'com.example',
  logDir: join(dir, 'logs'), mergePhrases: ['merge'], governancePaths: [], autoMergeLanes: [], operatorName: 'Dana',
  projectSlug: 'example', legacyMachinePrefixes: [], projectScripts: {}, busProject: 'example-bus',
  tracker: 'api', trackerUrl: 'http://tracker.example:4180',
  ...(checks ? { applicationChecks: checks } : {}),
});

function scratch(checks) {
  const dir = mkdtempSync(join(tmpdir(), 'relay-app-checks-'));
  mkdirSync(join(dir, 'logs'));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'doppler'), FAKE_DOPPLER);
  chmodSync(join(dir, 'bin', 'doppler'), 0o755);
  writeFileSync(join(dir, 'spirality.project.json'), JSON.stringify(manifest(dir, checks)));
  writeFileSync(join(dir, 'posts'), '');
  return {
    dir,
    state: join(dir, 'logs', 'example-app-checks.json'),
    posts: () => readFileSync(join(dir, 'posts'), 'utf8').split('\n').filter(Boolean),
  };
}

/** One check step, as run_relay.sh runs it, from this checkout. */
function step(s, limit, { args = [], env = {}, cwd = REPO } = {}) {
  const r = spawnSync('bash', ['-c', 'source "$1"; shift; run_relay_app_checks "$@"', 'x', LIB, String(limit), '--config', join(s.dir, 'spirality.project.json'), ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${join(s.dir, 'bin')}:${process.env.PATH}`, FAKE_POSTS: join(s.dir, 'posts'), ...env },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/** A shell function from the step's file, with its output trimmed. */
function fn(name, ...args) {
  const r = spawnSync('bash', ['-c', `source "$1"; shift; ${name} "$@"`, 'x', LIB, ...args.map(String)], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

/** The step's stop margin, in seconds. */
const MARGIN = Number(spawnSync('bash', ['-c', 'source "$1"; echo "$RELAY_APP_CHECKS_MARGIN"', 'x', LIB], { encoding: 'utf8' }).stdout.trim());

const DISK = { name: 'disk', command: "echo 'disk nearly full'; exit 1", everyMinutes: 10 };

test('app-checks on the relay: a failing check posts once; the next due pass, still failing, posts nothing new', () => {
  const s = scratch([DISK]);
  const first = step(s, 60);
  assert.equal(first.status, 0, first.out);
  assert.deepEqual(s.posts(), ['ALARM: disk: disk nearly full']);
  assert.match(first.out, /^app-checks: 1 run, 0 not due yet, 1 failing, 1 posted\.$/m);

  // Ten minutes later: the check is due again and still failing.
  const saved = JSON.parse(readFileSync(s.state, 'utf8'));
  saved.disk.ranAt -= 11 * 60 * 1000;
  writeFileSync(s.state, JSON.stringify(saved));
  const second = step(s, 60);
  assert.equal(second.status, 0, second.out);
  assert.match(second.out, /^disk: failing: disk nearly full \(nothing to post\)$/m);
  assert.deepEqual(s.posts(), ['ALARM: disk: disk nearly full'], 'nothing new posted');
});

test('app-checks on the relay: a check listed as a plain post posts without ALARM', () => {
  const s = scratch([{ ...DISK, alarm: false }]);
  assert.equal(step(s, 60).status, 0);
  assert.deepEqual(s.posts(), ['disk: disk nearly full']);
});

test('app-checks on the relay: none listed logs one line and posts nothing', () => {
  const s = scratch(null);
  const r = step(s, 60);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.out.trim(), 'app-checks: none listed');
  assert.deepEqual(s.posts(), []);
  assert.equal(existsSync(s.state), false);
});

test('app-checks on the relay: a checkout with no app-checks command (a wizard copy) logs that, runs nothing and is not a failed step', () => {
  const s = scratch([DISK]);
  writeFileSync(join(s.dir, 'package.json'), JSON.stringify({ scripts: { verify: 'true' } }));
  const r = step(s, 60, { cwd: s.dir });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.out.trim(), 'app-checks: none listed (this checkout has no app-checks command)');
  assert.deepEqual(s.posts(), []);
  assert.equal(existsSync(s.state), false);
});

test('app-checks on the relay: a dry run posts and saves nothing', () => {
  const s = scratch([DISK]);
  const r = step(s, 60, { args: ['--dry-run'] });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /would post: ALARM: disk: disk nearly full/);
  assert.deepEqual(s.posts(), []);
  assert.equal(existsSync(s.state), false);
});

test('app-checks on the relay: a post that does not land exits 1, and the END line says a step failed while the relay part stands', () => {
  const s = scratch([DISK]);
  const r = step(s, 60, { env: { FAKE_POST_FAILS: '1' } });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /^app-checks: FAILED: .*did NOT land: disk\.$/m);
  const end = fn('relay_end_words', 0, r.status, 300, 180);
  assert.doesNotMatch(end, /pass complete/);
  assert.match(end, /^A STEP FAILED AND SAID SO ABOVE \(exit 1\): the relay part finished, its merges and hand-backs stand; app-checks failed and said so above$/);
  assert.equal(fn('relay_pass_exit', 0, 1), '1');
});

test('app-checks on the relay: a check pass that overruns is stopped at its limit and says so', () => {
  const s = scratch([{ name: 'slow', command: 'sleep 30', everyMinutes: 10, timeoutSeconds: 60 }]);
  const started = Date.now();
  const r = step(s, 2);
  const took = (Date.now() - started) / 1000;
  assert.equal(r.status, 124, r.out);
  assert.match(r.out, /^app-checks: STOPPED: the check pass hit its 2s time limit/m);
  assert.ok(took < 2 + MARGIN, `took ${took}s`);
  assert.match(fn('relay_end_words', 0, 124, 300, 2), /^A STEP FAILED AND SAID SO ABOVE \(exit 1\).*; app-checks hit its 2s time limit and was stopped$/);
});

test('app-checks on the relay: with no time left the step does not run and says so', () => {
  const s = scratch([DISK]);
  const r = step(s, -5);
  assert.equal(r.status, 125);
  assert.match(r.out, /^app-checks: NOT RUN: /m);
  assert.deepEqual(s.posts(), []);
});

test('app-checks on the relay: the END line\'s first "(exit N)" is the pass\'s own, and "pass complete" means both parts finished', () => {
  const EXIT = /\(exit (\d+)/; // tracker/pipeline.mjs
  const cases = [
    [0, 0, '0', true],
    [0, 1, '1', false],
    [0, 2, '1', false],
    [0, 124, '1', false],
    [0, 125, '1', false],
    [1, 0, '1', false],
    [124, 125, '124', false],
    [7, 0, '7', false],
  ];
  for (const [relay, checks, exit, complete] of cases) {
    const words = fn('relay_end_words', relay, checks, 300, 180);
    assert.equal(EXIT.exec(words)[1], exit, words);
    assert.equal(fn('relay_pass_exit', relay, checks), exit, words);
    assert.equal(/pass complete \(exit 0\)/.test(words), complete, words); // lib/onboardLanes.mjs
    assert.equal(words.split('(exit').length - 1, 1, `one exit code only: ${words}`);
  }
  assert.equal(fn('relay_end_words', 0, 0, 300, 180), 'pass complete (exit 0); app-checks finished');
});

test('app-checks on the relay: the two parts together never outlast the pass limit', () => {
  const margin = MARGIN;
  assert.ok(margin >= 6, 'the margin covers the time limit\'s look-once-a-second and five-second grace');
  for (const used of [0, 16, 299, 300, 345, 470, 480, 600]) {
    const budget = Number(fn('relay_app_checks_budget', 480, 180, used));
    assert.ok(budget <= 180, `never more than its share (used ${used})`);
    assert.ok(used + budget + margin <= 480 || budget < 1, `used ${used} + budget ${budget} + margin ${margin} fits in 480`);
  }
  assert.equal(fn('relay_app_checks_budget', 480, 180, 16), '180');
  assert.equal(fn('relay_app_checks_budget', 480, 180, 345), String(480 - 345 - margin));
});

test('app-checks on the relay: run_relay.sh runs the step after the relay part, signed in as the relay, inside the pass limit', () => {
  const text = readFileSync(join(HERE, '..', 'run_relay.sh'), 'utf8');
  const token = text.indexOf('export TRACKER_TOKEN_NAME=TRACKER_TOKEN_RELAY');
  const relay = text.indexOf('"$REPO/scripts/run_with_time_limit.sh" "$RELAY_LIMIT" --');
  const budget = text.indexOf('CHECKS_LIMIT="$(relay_app_checks_budget "$PASS_LIMIT" "$CHECKS_SHARE"');
  const checks = text.indexOf('run_relay_app_checks "$CHECKS_LIMIT"');
  const end = text.indexOf('END relay — $(relay_end_words "$status" "$checks_status"');
  assert.ok(text.includes('source "$REPO/scripts/lib/relay_app_checks.sh"'));
  assert.ok(text.includes('RELAY_LIMIT=$((PASS_LIMIT - CHECKS_SHARE))'));
  assert.ok(token > 0 && token < relay && relay < budget && budget < checks && checks < end, 'token, relay, budget, checks, END in that order');
  assert.ok(text.includes('exit "$(relay_pass_exit "$status" "$checks_status")"'));
  assert.equal(text.split('PASS_START=$(date +%s)').length - 1, 1);
});

/** The real installer's --status, reading a scratch manifest (no tracker port) from its folder. */
function status(s) {
  const r = spawnSync('bash', [join(HERE, '..', 'install_loop_runner.sh'), '--status'], { cwd: s.dir, encoding: 'utf8' });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

test('app-checks on the relay: --status over a relay log with no app-checks line yet says "(none yet)" and still prints the tracker section', () => {
  const s = scratch(null);
  writeFileSync(join(s.dir, 'logs', 'example-relay.log'), '===== 2026-11-13 00:31:55 START relay — /x =====\n===== 2026-11-13 00:32:11 END relay — pass complete (exit 0) =====\n');
  const r = status(s);
  assert.equal(r.status, 0, `${r.out}${r.err}`);
  assert.match(r.out, /^last end: +2026-11-13 00:32:11 END relay — pass complete \(exit 0\)$/m);
  assert.match(r.out, /^app-checks: \(none yet\)$/m);
  assert.match(r.out, /^── tracker$/m, 'the sections after the relay still print');
});

test('app-checks on the relay: --status shows the newest app-checks line from the relay log', () => {
  const s = scratch(null);
  writeFileSync(join(s.dir, 'logs', 'example-relay.log'), 'app-checks: none listed\napp-checks: 1 run, 0 not due yet, 1 failing, 1 posted.\n===== END relay — pass complete (exit 0); app-checks finished =====\n');
  const r = status(s);
  assert.equal(r.status, 0, `${r.out}${r.err}`);
  assert.match(r.out, /^app-checks: 1 run, 0 not due yet, 1 failing, 1 posted\.$/m);
  assert.match(r.out, /^── tracker$/m);
});

test('app-checks on the relay: the relay part keeps the whole limit when no check is listed, and sets the share aside only when one is', () => {
  assert.equal(fn('relay_app_checks_listed', scratch(null).dir), 'none');
  assert.equal(fn('relay_app_checks_listed', scratch([]).dir), 'none');
  assert.equal(fn('relay_app_checks_listed', scratch([DISK, { ...DISK, name: 'disk2' }]).dir), '2');
  // A manifest that cannot be read here: the share is set aside and the check step says why.
  const broken = scratch(null);
  writeFileSync(join(broken.dir, 'spirality.project.json'), '{ not json');
  assert.equal(fn('relay_app_checks_listed', broken.dir), 'unknown');

  const text = readFileSync(join(HERE, '..', 'run_relay.sh'), 'utf8');
  assert.ok(text.includes('if [ "$CHECKS_LISTED" = "none" ]; then RELAY_LIMIT="$PASS_LIMIT"; else RELAY_LIMIT=$((PASS_LIMIT - CHECKS_SHARE)); fi'));
  const listed = text.indexOf('CHECKS_LISTED="$(relay_app_checks_listed "$REPO")"');
  assert.ok(listed > text.indexOf('back_to_main') && listed < text.indexOf('PASS_START=$(date +%s)'), 'counted after the pull, before the relay part starts');
});

test('app-checks on the relay: a checks share of 0, or one not less than the pass limit, is refused up front', () => {
  const usable = (pass, share) => spawnSync('bash', ['-c', 'source "$1"; relay_limits_usable "$2" "$3"', 'x', LIB, pass, share]).status === 0;
  assert.equal(usable('480', '180'), true);
  assert.equal(usable('480', '1'), true);
  assert.equal(usable('480', '0'), false);
  assert.equal(usable('480', '480'), false);
  assert.equal(usable('480', 'abc'), false);
  assert.equal(usable('', '180'), false);
  assert.ok(readFileSync(join(HERE, '..', 'run_relay.sh'), 'utf8').includes('if ! relay_limits_usable "$PASS_LIMIT" "$CHECKS_SHARE"; then'));
});

test('app-checks on the relay: a package.json that cannot be read is a failed step, never "none listed"', () => {
  const s = scratch([DISK]);
  writeFileSync(join(s.dir, 'package.json'), '{ broken');
  const r = step(s, 60, { cwd: s.dir });
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /^app-checks: FAILED: this checkout's package\.json could not be read \(.+\), so the checks did not run\.$/m);
  assert.doesNotMatch(r.out, /none listed/);
  const missing = scratch([DISK]);
  const m = step(missing, 60, { cwd: missing.dir });
  assert.equal(m.status, 2, m.out);
  assert.match(m.out, /^app-checks: FAILED: .*package\.json could not be read/m);
  assert.deepEqual(s.posts(), []);
});

test('app-checks on the relay: the step names no project, label, port or folder', () => {
  const text = readFileSync(LIB, 'utf8');
  assert.doesNotMatch(text, /com\.spirality|4180|loop-logs|spirality-|starcaster|wavecenter/i);
});
