import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EXPECTED_SECRETS, doctorTarget, doctorReport, formatReport } from './expectedSecrets.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SPIRALITY = JSON.parse(readFileSync(join(ROOT, 'spirality.project.json'), 'utf8'));
// A second product that does not run the tracker (no trackerPort).
const { trackerPort, trackerHost, trackerDataDir, ...rest } = SPIRALITY;
const GUEST = { ...rest, productSlug: 'normie', dopplerProject: 'normie', dopplerConfig: 'prd', githubRepo: 'owner/normie', trackerPrefix: 'NO' };

const home = doctorTarget(SPIRALITY);
const { expected, configs: CONFIGS } = home;
const all = (config) => new Set(expected.filter((s) => s.configs.includes(config)).map((s) => s.name));
const two = [
  { name: 'CLICKUP_API_TOKEN', configs: ['dev'] },
  { name: 'OTHER_KEY', configs: ['dev', 'prd'] },
];

test('names are unique, and every one is expected in the config the project config names', () => {
  const names = EXPECTED_SECRETS.map((s) => s.name);
  assert.equal(new Set(names).size, names.length);
  assert.equal(home.project, SPIRALITY.dopplerProject);
  assert.deepEqual(CONFIGS, [SPIRALITY.dopplerConfig]);
  assert.deepEqual(expected.map((s) => s.name), names);
  for (const s of expected) assert.deepEqual(s.configs, CONFIGS, s.name);
});

test('another product checks its own Doppler project and config, without the keys only the tracker home needs', () => {
  const guest = doctorTarget(GUEST);
  assert.equal(guest.project, 'normie');
  assert.deepEqual(guest.configs, ['prd']);
  const names = guest.expected.map((s) => s.name);
  for (const only of ['TRACKER_TOKEN_OPERATOR', 'RESEND_API_KEY', 'TRACKER_NOTIFY_TO']) assert.ok(!names.includes(only), only);
  assert.ok(names.includes('TRACKER_TOKEN_LOOP_BUILD'));
  assert.ok(names.includes('TRACKER_TOKEN_HAND_RUN'));
  assert.ok(guest.expected.every((s) => s.configs[0] === 'prd'));
});

test('all present: ok', () => {
  const report = doctorReport({ dev: all('dev') }, expected, CONFIGS);
  assert.equal(report.ok, true);
  assert.deepEqual(report.rows.find((r) => r.name === 'CLICKUP_API_TOKEN').cells, { dev: 'present' });
});

test('a name not needed in a config is not a failure; one missing name fails the whole report', () => {
  const okReport = doctorReport({ dev: new Set(['CLICKUP_API_TOKEN', 'OTHER_KEY']), prd: new Set(['OTHER_KEY']) }, two, ['dev', 'prd']);
  assert.equal(okReport.ok, true);
  assert.deepEqual(okReport.rows.find((r) => r.name === 'CLICKUP_API_TOKEN').cells, { dev: 'present', prd: 'not needed' });
  const bad = doctorReport({ dev: new Set(['CLICKUP_API_TOKEN', 'OTHER_KEY']), prd: new Set() }, two, ['dev', 'prd']);
  assert.equal(bad.ok, false);
  assert.equal(bad.rows.find((r) => r.name === 'OTHER_KEY').cells.prd, 'MISSING');
});

test('a config that could not be read is a failure, never a pass', () => {
  const report = doctorReport({ dev: null }, expected, CONFIGS);
  assert.equal(report.ok, false);
  assert.equal(report.rows[0].cells.dev, 'unreadable');
});

test('the table has a header and one line per expected name', () => {
  const text = formatReport(doctorReport({ dev: all('dev') }, expected, CONFIGS), CONFIGS);
  const lines = text.split('\n');
  assert.equal(lines.length, expected.length + 1);
  assert.match(lines[0], /^NAME\s+dev$/);
  assert.match(text, /CLICKUP_API_TOKEN\s+present/);
});

test('every tracker token a runner names is on the list, so doctor reports it', () => {
  const names = new Set(EXPECTED_SECRETS.map((s) => s.name));
  const installer = readFileSync(new URL('../install_loop_runner.sh', import.meta.url), 'utf8');
  const skills = installer.match(/^SKILLS=\(([^)]*)\)/m)[1].trim().split(/\s+/);
  assert.ok(skills.length > 0);
  // loop_runner.sh: TRACKER_TOKEN_ + the skill name, upper case, dashes to underscores.
  const runner = readFileSync(new URL('../loop_runner.sh', import.meta.url), 'utf8');
  assert.match(runner, /export TRACKER_TOKEN_NAME="TRACKER_TOKEN_\$\(printf '%s' "\$SKILL" \| tr 'a-z-' 'A-Z_'\)"/);
  for (const skill of skills) assert.ok(names.has(`TRACKER_TOKEN_${skill.toUpperCase().replaceAll('-', '_')}`), skill);
  const relay = readFileSync(new URL('../run_relay.sh', import.meta.url), 'utf8');
  assert.ok(names.has(relay.match(/^export TRACKER_TOKEN_NAME=(\S+)$/m)[1]));
  assert.ok(names.has('TRACKER_TOKEN_OPERATOR'));
});

/**
 * A folder holding a project config and a stand-in `doppler` on PATH that
 * logs its arguments and answers `secrets --only-names` with `names`.
 */
function productFolder(config, names) {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-'));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'spirality.project.json'), JSON.stringify(config));
  const answer = JSON.stringify(Object.fromEntries(names.map((n) => [n, {}])));
  writeFileSync(join(dir, 'bin', 'doppler'), `#!/bin/sh\necho "$*" >> "${join(dir, 'calls')}"\ncase "$1" in secrets) echo '${answer}' ;; run) shift; while [ "$1" != "--" ]; do shift; done; shift; exec "$@" ;; esac\n`);
  chmodSync(join(dir, 'bin', 'doppler'), 0o755);
  const run = (args, input) => spawnSync(process.execPath, args, {
    cwd: dir, input, encoding: 'utf8', env: { PATH: `${join(dir, 'bin')}:${process.env.PATH}`, HOME: dir },
  });
  return { dir, run, calls: () => readFileSync(join(dir, 'calls'), 'utf8'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('doctor checks the Doppler project and config the project config names, and says which', () => {
  const guest = doctorTarget(GUEST);
  const f = productFolder(GUEST, guest.expected.map((s) => s.name));
  try {
    const r = f.run([join(ROOT, 'scripts/doctor.mjs')]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^Doppler project normie, config prd /m);
    assert.doesNotMatch(r.stdout, /TRACKER_TOKEN_OPERATOR|RESEND_API_KEY/);
    assert.equal(f.calls().trim(), 'secrets --project normie --config prd --only-names --json --no-check-version');
  } finally { f.cleanup(); }
});

test('doctor fails, never passes, on a key the product needs that is missing', () => {
  const f = productFolder(GUEST, ['CLICKUP_API_TOKEN']);
  try {
    const r = f.run([join(ROOT, 'scripts/doctor.mjs')]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /TRACKER_TOKEN_LOOP_BUILD\s+MISSING/);
  } finally { f.cleanup(); }
});

test('with_doppler runs the command under the project config\'s Doppler project, passing stdin and the exit code through', () => {
  const f = productFolder(GUEST, []);
  try {
    const wrapper = join(ROOT, 'scripts/with_doppler.mjs');
    const r = f.run([wrapper, 'sh', '-c', 'cat; exit 3'], 'a body on stdin');
    assert.equal(r.status, 3);
    assert.equal(r.stdout, 'a body on stdin');
    assert.equal(f.calls().trim(), 'run --project normie --config prd --no-check-version -- sh -c cat; exit 3');
  } finally { f.cleanup(); }
});

test('no npm script names a Doppler project of its own: every doppler run goes through with_doppler', () => {
  const { scripts } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  for (const [name, line] of Object.entries(scripts)) {
    assert.doesNotMatch(line, /doppler run|--project/, name);
  }
  assert.match(scripts.clickup, /^node scripts\/with_doppler\.mjs node scripts\/clickup\.mjs$/);
});
