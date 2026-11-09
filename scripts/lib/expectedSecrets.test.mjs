import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { EXPECTED_SECRETS, TRACKER_SEATS, doctorTarget, usesClickUp, doctorReport, formatReport, laneSeats, laneSecret, projectSeats } from './expectedSecrets.mjs';
import { ProjectConfigError, RESERVED_LANE_NAMES, validateProjectConfig } from '../../lib/projectConfig.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SPIRALITY = JSON.parse(readFileSync(join(ROOT, 'spirality.project.json'), 'utf8'));
// A second project that does not run the tracker (no trackerPort).
const { trackerPort, trackerHost, trackerDataDir, ...rest } = SPIRALITY;
const GUEST = { ...rest, projectSlug: 'normie', dopplerProject: 'normie', dopplerConfig: 'prd', githubRepo: 'owner/normie', trackerPrefix: 'NO' };
// The same project as it really is: on the tracker and never on ClickUp, its ClickUp ids "0".
const NEVER_CLICKUP = { ...GUEST, workspaceId: '0', spaceId: '0', loopQueueListId: '0' };

/**
 * A stand-in tracker answering GET /projects/<slug> with `repo` as the
 * project's GitHub repository, so doctor's repository check never reaches
 * the real one. Returns the config pointed at it, and `close`.
 */
async function standInTracker(config, repo) {
  const server = createServer((req, res) => {
    const known = req.url === `/projects/${config.projectSlug}` && req.headers.authorization === 'Bearer stand-in-token';
    res.writeHead(known ? 200 : 404, { 'content-type': 'application/json' });
    // `undefined` leaves the field out altogether, as a tracker older than SP-80 would.
    res.end(JSON.stringify(known ? { slug: config.projectSlug, repo } : { message: 'no' }));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { config: { ...config, trackerUrl: url, trackerApiUrl: url }, close: () => new Promise((done) => server.close(done)) };
}

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
  // Spirality reads no ClickUp list any more (SP-22): every key but the ClickUp ones.
  assert.deepEqual(expected.map((s) => s.name), EXPECTED_SECRETS.filter((s) => !s.clickup).map((s) => s.name));
  for (const s of expected) assert.deepEqual(s.configs, CONFIGS, s.name);
});

test('another project checks its own Doppler project and config, without the keys only the tracker home needs', () => {
  const guest = doctorTarget(GUEST);
  assert.equal(guest.project, 'normie');
  assert.deepEqual(guest.configs, ['prd']);
  const names = guest.expected.map((s) => s.name);
  for (const only of ['TRACKER_TOKEN_OPERATOR', 'RESEND_API_KEY', 'TRACKER_NOTIFY_TO']) assert.ok(!names.includes(only), only);
  assert.ok(names.includes('TRACKER_TOKEN_LOOP_BUILD'));
  assert.ok(names.includes('TRACKER_TOKEN_HAND_RUN'));
  assert.ok(guest.expected.every((s) => s.configs[0] === 'prd'));
});

test('Spirality, its ClickUp list an archive since SP-22, is not asked for the ClickUp key; still reading a list, it would be', () => {
  assert.equal(SPIRALITY.tracker, 'api');
  assert.equal(usesClickUp(SPIRALITY), false);
  assert.ok(!home.expected.some((s) => s.name === 'CLICKUP_API_TOKEN'));
  const reading = { ...SPIRALITY, loopQueueListId: '901418065068' };
  assert.equal(usesClickUp(reading), true);
  assert.ok(doctorTarget(reading).expected.some((s) => s.name === 'CLICKUP_API_TOKEN'));
});

test('a project on the tracker with ClickUp ids "0" is not asked for the ClickUp key; one on ClickUp is', () => {
  assert.equal(usesClickUp(NEVER_CLICKUP), false);
  const names = doctorTarget(NEVER_CLICKUP).expected.map((s) => s.name);
  assert.ok(!names.includes('CLICKUP_API_TOKEN'));
  assert.ok(names.includes('TRACKER_TOKEN_LOOP_BUILD'));
  for (const config of [{ ...NEVER_CLICKUP, tracker: 'clickup' }, (({ tracker, ...c }) => c)(NEVER_CLICKUP)]) {
    assert.equal(usesClickUp(config), true);
    assert.ok(doctorTarget(config).expected.some((s) => s.name === 'CLICKUP_API_TOKEN'));
  }
});

test('doctor passes for a project never on ClickUp whose Doppler has no ClickUp key', async () => {
  const t = await standInTracker(NEVER_CLICKUP, 'owner/normie');
  const names = doctorTarget(NEVER_CLICKUP).expected.map((s) => s.name);
  const f = projectFolder(t.config, names);
  try {
    const r = await f.runAsync([join(ROOT, 'scripts/doctor.mjs')]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /CLICKUP_API_TOKEN/);
  } finally { f.cleanup(); await t.close(); }
});

test('all present: ok', () => {
  const report = doctorReport({ dev: all('dev') }, expected, CONFIGS);
  assert.equal(report.ok, true);
  assert.deepEqual(report.rows.find((r) => r.name === 'TRACKER_TOKEN_LOOP_BUILD').cells, { dev: 'present' });
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
  assert.match(text, /TRACKER_TOKEN_LOOP_BUILD\s+present/);
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
function projectFolder(config, names) {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-'));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'spirality.project.json'), JSON.stringify(config));
  const answer = JSON.stringify(Object.fromEntries(names.map((n) => [n, {}])));
  writeFileSync(join(dir, 'bin', 'doppler'), `#!/bin/sh\necho "$*" >> "${join(dir, 'calls')}"\ncase "$1" in secrets) echo '${answer}' ;; run) export TRACKER_TOKEN_HAND_RUN=stand-in-token CLICKUP_API_TOKEN=stand-in-token; shift; while [ "$1" != "--" ]; do shift; done; shift; exec "$@" ;; esac\n`);
  chmodSync(join(dir, 'bin', 'doppler'), 0o755);
  const run = (args, input) => spawnSync(process.execPath, args, {
    cwd: dir, input, encoding: 'utf8', env: { PATH: `${join(dir, 'bin')}:${process.env.PATH}`, HOME: dir },
  });
  // The same, without blocking, for a run that calls a stand-in tracker in this process.
  const runAsync = (args) => new Promise((done) => {
    const child = spawn(process.execPath, args, { cwd: dir, env: { PATH: `${join(dir, 'bin')}:${process.env.PATH}`, HOME: dir } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => done({ status, stdout, stderr }));
  });
  return { dir, run, runAsync, calls: () => readFileSync(join(dir, 'calls'), 'utf8'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('doctor checks the Doppler project and config the project config names, and says which', async () => {
  const guest = doctorTarget(GUEST);
  const t = await standInTracker(GUEST, 'owner/normie');
  const f = projectFolder(t.config, guest.expected.map((s) => s.name));
  try {
    const r = await f.runAsync([join(ROOT, 'scripts/doctor.mjs')]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^Doppler project normie, config prd /m);
    assert.doesNotMatch(r.stdout, /TRACKER_TOKEN_OPERATOR|RESEND_API_KEY/);
    assert.equal(f.calls().split('\n')[0], 'secrets --project normie --config prd --only-names --json --no-check-version');
    assert.match(r.stdout, /^repository: the tracker project "normie" and githubRepo agree: owner\/normie\.$/m);
  } finally { f.cleanup(); await t.close(); }
});

test('doctor fails, never passes, on a key the project needs that is missing', async () => {
  const t = await standInTracker(GUEST, 'owner/normie');
  const f = projectFolder(t.config, ['CLICKUP_API_TOKEN']);
  try {
    const r = await f.runAsync([join(ROOT, 'scripts/doctor.mjs')]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /TRACKER_TOKEN_LOOP_BUILD\s+MISSING/);
  } finally { f.cleanup(); await t.close(); }
});

test('doctor reports an empty repository field with where to fill it in, and still passes', async () => {
  const guest = doctorTarget(GUEST);
  const t = await standInTracker(GUEST, null);
  const f = projectFolder(t.config, guest.expected.map((s) => s.name));
  try {
    const r = await f.runAsync([join(ROOT, 'scripts/doctor.mjs')]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^repository: the tracker project "normie" has no GitHub repository recorded; the loops use githubRepo owner\/normie\. Fill it in on http:\/\/127\.0\.0\.1:\d+\/projects\/normie\/edit\.$/m);
    assert.match(f.calls(), /^run --project normie --config prd --no-check-version -- .*clickup\.mjs repo-check$/m);
  } finally { f.cleanup(); await t.close(); }
});

test('doctor fails on a repository field that differs from githubRepo, naming both', async () => {
  const guest = doctorTarget(GUEST);
  const t = await standInTracker(GUEST, 'someone-else/normie');
  const f = projectFolder(t.config, guest.expected.map((s) => s.name));
  try {
    const r = await f.runAsync([join(ROOT, 'scripts/doctor.mjs')]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /repository: DIFFERENT\. The tracker project "normie" records someone-else\/normie, but githubRepo .* is owner\/normie/);
    assert.match(r.stdout, /the repository check FAILED/);
  } finally { f.cleanup(); await t.close(); }
});

test('doctor fails, never passes, when the tracker project cannot be read', async () => {
  const guest = doctorTarget(GUEST);
  const t = await standInTracker({ ...GUEST, projectSlug: 'elsewhere' }, 'owner/normie');
  const f = projectFolder({ ...t.config, projectSlug: 'normie' }, guest.expected.map((s) => s.name));
  try {
    const r = await f.runAsync([join(ROOT, 'scripts/doctor.mjs')]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /read the tracker project "normie" FAILED — HTTP 404/);
  } finally { f.cleanup(); await t.close(); }
});

test('doctor fails, never passes, when the tracker answers with no repository field at all', async () => {
  const guest = doctorTarget(GUEST);
  const t = await standInTracker(GUEST, undefined);
  const f = projectFolder(t.config, guest.expected.map((s) => s.name));
  try {
    const r = await f.runAsync([join(ROOT, 'scripts/doctor.mjs')]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /has no repo field at all, so this check cannot tell/);
  } finally { f.cleanup(); await t.close(); }
});

test('repo-check on a ClickUp project says it is not checked, and passes', () => {
  const f = projectFolder({ ...GUEST, tracker: 'clickup' }, []);
  try {
    const r = f.run([join(ROOT, 'scripts/with_doppler.mjs'), process.execPath, join(ROOT, 'scripts/clickup.mjs'), 'repo-check']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^repository: not checked; the "clickup" tracker has no GitHub repository field\. The loops use githubRepo owner\/normie\.$/m);
  } finally { f.cleanup(); }
});

test('with_doppler runs the command under the project config\'s Doppler project, passing stdin and the exit code through', () => {
  const f = projectFolder(GUEST, []);
  try {
    const wrapper = join(ROOT, 'scripts/with_doppler.mjs');
    const r = f.run([wrapper, 'sh', '-c', 'cat; exit 3'], 'a body on stdin');
    assert.equal(r.status, 3);
    assert.equal(r.stdout, 'a body on stdin');
    assert.equal(f.calls().trim(), 'run --project normie --config prd --no-check-version -- sh -c cat; exit 3');
  } finally { f.cleanup(); }
});

test('with_doppler takes the Doppler project from the settings file a command names with --config', () => {
  const f = projectFolder(GUEST, []);
  try {
    mkdirSync(join(f.dir, 'far'));
    writeFileSync(join(f.dir, 'far', 'spirality.project.json'), JSON.stringify({ ...GUEST, dopplerProject: 'far-project', dopplerConfig: 'dev' }));
    const wrapper = join(ROOT, 'scripts/with_doppler.mjs');
    for (const args of [['--config', 'far/spirality.project.json'], ['--config=far/spirality.project.json']]) {
      writeFileSync(join(f.dir, 'calls'), '');
      const r = f.run([wrapper, 'sh', '-c', 'exit 0', 'sh', ...args]);
      assert.equal(r.status, 0, r.stderr);
      assert.match(f.calls(), /^run --project far-project --config dev --no-check-version -- /);
    }
    const missing = f.run([wrapper, 'true', '--config', 'nowhere.json']);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /nowhere\.json: could not be read/);
  } finally { f.cleanup(); }
});

test('no npm script names a Doppler project of its own: every doppler run goes through with_doppler', () => {
  const { scripts } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  for (const [name, line] of Object.entries(scripts)) {
    assert.doesNotMatch(line, /doppler run|--project/, name);
  }
  assert.match(scripts.clickup, /^node scripts\/with_doppler\.mjs node scripts\/clickup\.mjs$/);
});

test('a lane the project config names in projectLanes is an expected secret; one it does not name is not', () => {
  assert.equal(laneSecret('loop-handoff'), 'TRACKER_TOKEN_LOOP_HANDOFF');
  const names = (config) => doctorTarget(config).expected.map((s) => s.name);
  for (const config of [SPIRALITY, GUEST]) {
    assert.ok(!names(config).includes('TRACKER_TOKEN_LOOP_HANDOFF'), 'no lane named, no seat');
    const withLane = names({ ...config, projectLanes: ['loop-handoff'] });
    assert.ok(withLane.includes('TRACKER_TOKEN_LOOP_HANDOFF'));
    // The built-in seats are all still there, in the same order.
    assert.deepEqual(withLane.filter((n) => n !== 'TRACKER_TOKEN_LOOP_HANDOFF'), names(config));
  }
  const row = doctorTarget({ ...GUEST, projectLanes: ['loop-handoff'] }).expected.find((s) => s.name === 'TRACKER_TOKEN_LOOP_HANDOFF');
  assert.deepEqual(row.configs, [GUEST.dopplerConfig]);
  assert.match(row.what, /loop-handoff lane/);
});

test('projectSeats: the built-in seats untouched, then one machine seat per project lane; a lane that is a built-in seat is refused', () => {
  assert.deepEqual(projectSeats(SPIRALITY), TRACKER_SEATS);
  assert.deepEqual(projectSeats({}), TRACKER_SEATS);
  const seats = projectSeats({ projectLanes: ['loop-handoff'] });
  assert.deepEqual(seats.slice(0, TRACKER_SEATS.length), TRACKER_SEATS);
  assert.deepEqual(seats.slice(TRACKER_SEATS.length).map((s) => [s.secret, s.kind, s.name, Boolean(s.handRun)]), [['TRACKER_TOKEN_LOOP_HANDOFF', 'machine', 'loop-handoff', false]]);
  for (const taken of ['loop-build', 'relay', 'hand-run', 'operator']) {
    assert.throws(() => laneSeats({ projectLanes: [taken] }), (err) => err instanceof ProjectConfigError && err.message.includes(`"${taken}"`) && /built-in tracker seat/.test(err.message), taken);
  }
});

test('nothing in the substrate names a project\'s own lane: the built-in seats are the same for every project', () => {
  const builtIn = TRACKER_SEATS.map((s) => s.name).filter(Boolean);
  assert.deepEqual(builtIn, ['loop-build', 'loop-review', 'loop-intake', 'relay', 'hand-run']);
});

test('the config refuses every built-in seat as a lane: RESERVED_LANE_NAMES covers TRACKER_SEATS and TRACKER_TOKEN_NAME, so the door never sees one', () => {
  const reservedSecrets = RESERVED_LANE_NAMES.map(laneSecret);
  for (const seat of TRACKER_SEATS) assert.ok(reservedSecrets.includes(seat.secret), `${seat.secret} is not reserved`);
  assert.ok(reservedSecrets.includes('TRACKER_TOKEN_NAME'));
  for (const taken of RESERVED_LANE_NAMES) {
    assert.throws(() => validateProjectConfig({ ...SPIRALITY, projectLanes: [taken] }), ProjectConfigError, taken);
    // The backstop, for a config built by hand without loading.
    assert.throws(() => laneSeats({ projectLanes: [taken] }), ProjectConfigError, taken);
  }
});
