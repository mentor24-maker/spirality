// The relay's watchdog step (scripts/lib/relay_watchdogs.sh, SP-267), run
// for real against a scratch checkout whose stale_ready.mjs, stale_answer.mjs
// and reconcile.mjs (SP-354) are stand-ins that record what they were asked
// and exit as told.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, 'relay_watchdogs.sh');

function scratch({ answer = true } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'relay-watchdogs-'));
  mkdirSync(join(repo, 'scripts'));
  copyFileSync(join(HERE, '..', 'run_with_time_limit.sh'), join(repo, 'scripts', 'run_with_time_limit.sh'));
  const stand = (name) => `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(join(repo, 'calls'))}, ${JSON.stringify(name)} + ' ' + process.argv.slice(2).join(' ') + '\\n');
process.exit(Number(process.env.${name.toUpperCase()}_EXIT || 0));
`;
  writeFileSync(join(repo, 'scripts', 'stale_ready.mjs'), stand('stale_ready'));
  if (answer) writeFileSync(join(repo, 'scripts', 'stale_answer.mjs'), stand('stale_answer'));
  writeFileSync(join(repo, 'scripts', 'reconcile.mjs'), stand('reconcile'));
  writeFileSync(join(repo, 'calls'), '');
  return { repo, calls: () => readFileSync(join(repo, 'calls'), 'utf8').split('\n').filter(Boolean) };
}

function step(s, args = [], env = {}) {
  return spawnSync('bash', ['-c', 'source "$1"; shift; run_relay_watchdogs "$@"; echo "returned $?"', 'x', LIB, s.repo, '30', ...args], {
    encoding: 'utf8',
    // The time-limit wrapper looks every 15s by default; a stand-in exits at
    // once, so look every second or three watchdogs cost 45s a test.
    env: { ...process.env, RUN_WITH_TIME_LIMIT_POLL: '1', ...env },
  });
}

test('all three watchdogs run with --check, one after the other', () => {
  const s = scratch();
  const r = step(s);
  assert.deepEqual(s.calls(), ['stale_ready --check', 'stale_answer --check', 'reconcile --check']);
  assert.match(r.stdout, /returned 0/);
  assert.doesNotMatch(r.stdout, /FAILED/);
});

test('a dry run passes --dry-run to each', () => {
  const s = scratch();
  step(s, ['--dry-run']);
  assert.deepEqual(s.calls(), ['stale_ready --check --dry-run', 'stale_answer --check --dry-run', 'reconcile --check --dry-run']);
});

test('a failing watchdog is named, the next still runs, and the relay is never failed', () => {
  const s = scratch();
  const r = step(s, [], { STALE_READY_EXIT: '1' });
  assert.match(r.stdout, /\[relay\] the stale-ready check FAILED \(exit 1;/);
  assert.deepEqual(s.calls(), ['stale_ready --check', 'stale_answer --check', 'reconcile --check']);
  assert.match(r.stdout, /returned 0/);
});

test('a failing reconcile check is one FAILED line and the relay\'s verdict is unchanged (SP-354)', () => {
  const s = scratch();
  const r = step(s, [], { RECONCILE_EXIT: '2' });
  assert.match(r.stdout, /\[relay\] the reconcile check FAILED \(exit 2;/);
  assert.equal(r.stdout.split('\n').filter((l) => /FAILED/.test(l)).length, 1);
  assert.match(r.stdout, /returned 0/);
});

test('a checkout without a watchdog says so in one line and carries on', () => {
  const s = scratch({ answer: false });
  const r = step(s);
  assert.match(r.stdout, /stale-answer: not in this checkout \(no scripts\/stale_answer\.mjs\)/);
  assert.deepEqual(s.calls(), ['stale_ready --check', 'reconcile --check']);
  assert.match(r.stdout, /returned 0/);
});

// A project with no bus (SP-386): every watchdog has nowhere to post. The real
// ones then exit 2 under --check ("names no busProject"), and a due alarm from
// throughput (exit 3) or checkout-currency (exit 1) cannot land, so each read
// as a FAILED line on every relay pass. The stand-ins below behave the same
// way, and the pass below runs the steps in run_relay.sh's order.
const HEARTBEAT_LIB = join(HERE, 'relay_heartbeat.sh');
const QUEUE_LIB = join(HERE, 'relay_queue_watchdogs.sh');

function busScratch() {
  const s = scratch();
  const nowhere = (name, code) => `import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(s.repo, 'calls'))}, ${JSON.stringify(name)} + ' ' + args.join(' ') + '\\n');
if (process.env.${name.toUpperCase()}_EXIT) process.exit(Number(process.env.${name.toUpperCase()}_EXIT));
// With no bus a post is due and cannot land; a dry run or a report posts nothing.
process.exit(!process.env.BUS && args.includes('--check') && !args.includes('--dry-run') ? ${code} : 0);
`;
  for (const [name, code] of [['heartbeat', 2], ['stale_ready', 2], ['stale_answer', 2], ['reconcile', 2], ['loop_throughput', 3], ['checkout_currency', 1]]) {
    writeFileSync(join(s.repo, 'scripts', `${name}.mjs`), nowhere(name, code));
  }
  // The config reader: BUS is the busProject; CONFIG_EXIT a config it cannot read.
  writeFileSync(join(s.repo, 'scripts', 'project_config.mjs'), `if (process.argv[2] !== 'busProject') process.exit(2);
if (process.env.CONFIG_EXIT) { console.error('project_config: the project config is not usable'); process.exit(Number(process.env.CONFIG_EXIT)); }
console.log(process.env.BUS || '');
`);
  return s;
}

/** The watchdog steps of a relay pass, as scripts/run_relay.sh runs them. */
function pass(s, env = {}) {
  const script = `source "$1"; source "$2"; source "$3"; REPO="$4"; SLUG=example
BUS_STATE="$(relay_bus_state "$REPO")"
NO_BUS=""
if [ "$BUS_STATE" = "no" ]; then NO_BUS=yes; relay_no_bus_line "$SLUG"; fi
run_relay_heartbeat "$REPO" 30 \${NO_BUS:+--no-bus}
run_relay_watchdogs "$REPO" 30 \${NO_BUS:+--no-bus}
run_relay_queue_watchdogs "$REPO" 30 abc123 "" \${NO_BUS:+--no-bus}
echo "===== END relay"`;
  return spawnSync('bash', ['-c', script, 'x', HEARTBEAT_LIB, LIB, QUEUE_LIB, s.repo], {
    encoding: 'utf8',
    env: { ...process.env, RUN_WITH_TIME_LIMIT_POLL: '1', BUS: '', CONFIG_EXIT: '', ...env },
  });
}

test('relay_bus_state: yes with a busProject, no with none, unknown when the config cannot be read', () => {
  const s = busScratch();
  const state = (env) => spawnSync('bash', ['-c', 'source "$1"; relay_bus_state "$2"', 'x', LIB, s.repo], { encoding: 'utf8', env: { ...process.env, BUS: '', CONFIG_EXIT: '', ...env } }).stdout;
  assert.equal(state({ BUS: 'example-bus' }), 'yes\n');
  assert.equal(state({}), 'no\n');
  assert.equal(state({ CONFIG_EXIT: '1' }), 'unknown\n');
});

test('no bus: one skip line, no FAILED line, and the watchdogs only report', () => {
  const s = busScratch();
  const r = pass(s);
  assert.equal(r.stdout.split('\n').filter((l) => /bus watchdogs skipped/.test(l)).length, 1, r.stdout);
  assert.match(r.stdout, /\[relay\] bus watchdogs skipped: example has no bus \(no busProject in its project config\)/);
  assert.doesNotMatch(r.stdout, /FAILED/);
  assert.deepEqual(s.calls(), ['heartbeat ', 'loop_throughput --check --dry-run', 'checkout_currency --before abc123'],
    'the heartbeat lists the lanes, throughput reads as a dry run, the currency check reports; the ticket watchdogs do not run');
  assert.match(r.stdout, /===== END relay/);
});

test('a bus: no skip line, every watchdog runs with --check exactly as before', () => {
  const s = busScratch();
  const r = pass(s, { BUS: 'example-bus' });
  assert.doesNotMatch(r.stdout, /skipped/);
  assert.doesNotMatch(r.stdout, /FAILED/);
  assert.deepEqual(s.calls(), ['heartbeat --check', 'stale_ready --check', 'stale_answer --check', 'reconcile --check', 'loop_throughput --check', 'checkout_currency --check --before abc123']);
});

test('a bus whose posts fail still reads FAILED: the skip is only for a project with no bus', () => {
  const s = busScratch();
  const r = pass(s, { BUS: 'example-bus', STALE_READY_EXIT: '2', CHECKOUT_CURRENCY_EXIT: '1' });
  assert.match(r.stdout, /\[relay\] the stale-ready check FAILED \(exit 2;/);
  assert.match(r.stdout, /\[relay\] the checkout-currency check FAILED \(exit 1;/);
});

test('a config that cannot be read is never taken for "no bus": every watchdog runs and its failure is said', () => {
  const s = busScratch();
  const r = pass(s, { CONFIG_EXIT: '1' });
  assert.doesNotMatch(r.stdout, /skipped/);
  assert.match(r.stdout, /\[relay\] the heartbeat check FAILED \(exit 2;/);
  assert.match(r.stdout, /\[relay\] the stale-ready check FAILED \(exit 2;/);
});

test('no bus: a watchdog failing for another reason still reads FAILED', () => {
  const s = busScratch();
  const r = pass(s, { HEARTBEAT_EXIT: '1', LOOP_THROUGHPUT_EXIT: '4', CHECKOUT_CURRENCY_EXIT: '1' });
  assert.match(r.stdout, /bus watchdogs skipped/);
  assert.match(r.stdout, /\[relay\] the heartbeat check FAILED \(exit 1;/);
  assert.match(r.stdout, /\[relay\] the throughput check FAILED \(exit 4;/);
  assert.match(r.stdout, /\[relay\] the checkout-currency check FAILED \(exit 1;/);
  const quiet = pass(s, { HEARTBEAT_EXIT: '3' });
  assert.doesNotMatch(quiet.stdout, /heartbeat check FAILED/, 'exit 3 without --check is a quiet lane, already listed');
});

test('run_relay.sh asks about the bus once and hands --no-bus to every watchdog step', () => {
  const sh = readFileSync(join(HERE, '..', 'run_relay.sh'), 'utf8');
  assert.equal(sh.split('relay_bus_state "$REPO"').length - 1, 1);
  assert.match(sh, /if \[ "\$BUS_STATE" = "no" \]; then\n  NO_BUS=yes\n  relay_no_bus_line "\$SLUG"\nfi/);
  for (const step of ['run_relay_heartbeat "$RUN_DIR"', 'run_relay_watchdogs "$RUN_DIR"', 'run_relay_queue_watchdogs "$RUN_DIR"']) {
    const line = sh.split('\n').find((l) => l.includes(step));
    assert.ok(line && line.includes('${NO_BUS:+--no-bus}'), `${step} gets --no-bus`);
  }
  assert.ok(sh.indexOf('relay_bus_state "$REPO"') < sh.indexOf('run_relay_heartbeat "$RUN_DIR"'));
});
