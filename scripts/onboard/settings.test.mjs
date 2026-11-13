import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProjectConfig, validateProjectConfig } from '../../lib/projectConfig.mjs';
import { seatsForConfig } from '../../tracker/signins.mjs';
import { buildSeatName, loadHome, readActors, runFill, runWrite, writeAndReadBack } from './settings.mjs';

const homeConfig = validateProjectConfig({
  manifestVersion: 1, workspaceId: '90141423066', spaceId: '90146476540', loopQueueListId: '901418065068',
  operatorUserId: '1', machineUserId: '2', githubRepo: 'mentor24-maker/spirality',
  dopplerProject: 'spirality', dopplerConfig: 'dev', launchdPrefix: 'com.spirality', logDir: '~/loop-logs',
  mergePhrases: ['merge', 'merge it', 'ship it', 'approve'],
  governancePaths: ['CLAUDE.md', 'docs/LOOP_ENGINEERING.md', '.claude/skills/', '.claude/settings.json', '.github/workflows/'],
  autoMergeLanes: [], operatorName: 'Dane', projectSlug: 'spirality', legacyMachinePrefixes: [], projectScripts: {},
  trackerPrefix: 'SP', trackerPort: 4180, trackerHost: '0.0.0.0', trackerDataDir: '~/spirality-tracker',
  tracker: 'api', trackerUrl: 'http://mac-mini.local:4180', trackerApiUrl: 'http://127.0.0.1:4180',
});

const ANSWERS = {
  projectName: 'Normie', githubRepo: 'mentor24-maker/normie', projectSlug: 'normie', trackerPrefix: 'NO',
  checkoutDir: '~/WebApps/normie', checkCommand: 'npm run verify:full', extraGovernancePaths: ['.cursorrules'],
  description: 'Normie is a Next.js app.',
};

/** A tracker that answers GETs from a list of actors; `calls` records each path. */
function fakeTracker(actors, { status = 200 } = {}) {
  const calls = [];
  const get = async (path) => {
    calls.push(path);
    if (status !== 200) return { status, json: { message: 'nope' } };
    if (path === '/people') return { status, json: { people: actors.filter((a) => a.kind === 'human').map(({ id, name }) => ({ id, name })) } };
    if (path === '/search') return { status, json: { filters: [{ key: 'createdBy', options: actors.map((a) => ({ value: String(a.id), label: a.name })) }] } };
    return { status: 404, json: null };
  };
  return { get, calls };
}

const ACTORS = [
  { id: 1, name: 'Dane', kind: 'human' },
  { id: 2, name: 'loop-build', kind: 'machine' },
  { id: 8, name: 'normie loop-build', kind: 'machine' },
];

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'onboard-settings-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const answersPath = join(dir, 'normie.answers.json');
  writeFileSync(answersPath, JSON.stringify(ANSWERS));
  return { dir, answersPath, out: join(dir, 'out') };
}

const readText = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
const deps = (get) => ({ homeConfig, homeRoot: '/Users/dane/WebApps/spirality', get, readText });

test('the build-loop seat name is the sign-ins list\'s own', () => {
  const name = buildSeatName('normie', 'Dane');
  assert.equal(name, 'normie loop-build');
  assert.ok(seatsForConfig({ trackerPort: null, projectSlug: 'normie', operatorName: 'Dane' }).seats.some((s) => s.name === name));
});

test('write: Normie, sign-ins already made, writes a file the reader loads, with both ids found', async (t) => {
  const { answersPath, out } = scratch(t);
  const tracker = fakeTracker(ACTORS);
  const r = await runWrite({ answersPath, outDir: out }, deps(tracker.get));
  assert.equal(r.code, 0, r.lines.join('\n'));
  const config = loadProjectConfig({ cwd: out, env: {} });
  assert.equal(config.githubRepo, 'mentor24-maker/normie');
  assert.equal(config.operatorUserId, '1');
  assert.equal(config.machineUserId, '8');
  assert.equal(config.trackerPort, null);
  assert.match(r.lines.join('\n'), /machineUserId 8: the tracker's "normie loop-build"/);
  assert.deepEqual(tracker.calls, ['/people', '/search']);
});

test('write: before the sign-ins, machineUserId is the placeholder and the line says what to run next', async (t) => {
  const { answersPath, out } = scratch(t);
  const r = await runWrite({ answersPath, outDir: out }, deps(fakeTracker(ACTORS.filter((a) => a.id !== 8)).get));
  assert.equal(r.code, 0);
  assert.equal(loadProjectConfig({ cwd: out, env: {} }).machineUserId, '0');
  assert.match(r.lines.join('\n'), /a placeholder.*fill-machine-user --config/);
});

test('write: rerun on the same folder says nothing changed', async (t) => {
  const { answersPath, out } = scratch(t);
  const { get } = fakeTracker(ACTORS);
  await runWrite({ answersPath, outDir: out }, deps(get));
  const r = await runWrite({ answersPath, outDir: out }, deps(get));
  assert.equal(r.code, 0);
  assert.match(r.lines[0], /already there, with the same settings/);
});

test('write: never writes over another project\'s settings file (so never the tracker home\'s)', async (t) => {
  const { answersPath, dir } = scratch(t);
  const homeFile = join(dir, 'spirality.project.json');
  writeFileSync(homeFile, JSON.stringify({ projectSlug: 'spirality' }));
  const r = await runWrite({ answersPath, outDir: dir }, deps(fakeTracker(ACTORS).get));
  assert.equal(r.code, 1);
  assert.match(r.lines.at(-1), /^FAILED: write the settings file: .*"spirality".*left alone/);
  assert.equal(readFileSync(homeFile, 'utf8'), JSON.stringify({ projectSlug: 'spirality' }));
});

test('write: no operator in the tracker, or the tracker refusing, says FAILED and writes nothing', async (t) => {
  const { answersPath, out } = scratch(t);
  const r1 = await runWrite({ answersPath, outDir: out }, deps(fakeTracker(ACTORS.filter((a) => a.kind !== 'human')).get));
  assert.equal(r1.code, 1);
  assert.match(r1.lines.at(-1), /^FAILED: .*no person named "Dane"/);
  const r2 = await runWrite({ answersPath, outDir: out }, deps(fakeTracker(ACTORS, { status: 401 }).get));
  assert.equal(r2.code, 1);
  assert.match(r2.lines.at(-1), /^FAILED: .*answered \/people with 401: nope/);
  const r3 = await runWrite({ answersPath, outDir: out }, deps(async () => { throw new Error('ECONNREFUSED'); }));
  assert.match(r3.lines.at(-1), /^FAILED: .*did not answer \/people \(ECONNREFUSED\)/);
  assert.equal(readText(join(out, 'spirality.project.json')), null);
});

test('write: a bad answer says FAILED and names the field', async (t) => {
  const { answersPath, out } = scratch(t);
  writeFileSync(answersPath, JSON.stringify({ ...ANSWERS, githubRepo: 'normie' }));
  const r = await runWrite({ answersPath, outDir: out }, deps(fakeTracker(ACTORS).get));
  assert.equal(r.code, 1);
  assert.match(r.lines.at(-1), /^FAILED: write the settings file: .*"githubRepo"/);
});

test('a write that does not read back the same says FAILED and names the field', (t) => {
  const { dir } = scratch(t);
  const file = join(dir, 'spirality.project.json');
  const meant = JSON.parse(readFileSync(new URL('../../spirality.project.json', import.meta.url), 'utf8'));
  // A disk that drops the repository on the way: the read-back catches it.
  const off = writeAndReadBack(file, meant, {
    write: (f, text) => writeFileSync(f, text.replace('mentor24-maker/spirality', 'someone/else')),
  });
  assert.deepEqual(off, ['githubRepo']);
});

test('fill-machine-user: writes the sign-in\'s id in, changes nothing else, and is a no-op the second time', async (t) => {
  const { answersPath, out } = scratch(t);
  await runWrite({ answersPath, outDir: out }, deps(fakeTracker(ACTORS.filter((a) => a.id !== 8)).get));
  const configPath = join(out, 'spirality.project.json');
  const before = JSON.parse(readFileSync(configPath, 'utf8'));
  const tracker = fakeTracker(ACTORS);
  const r = await runFill({ configPath }, { get: tracker.get, readText });
  assert.equal(r.code, 0, r.lines.join('\n'));
  assert.match(r.lines[0], /Wrote machineUserId 8 \(the tracker's "normie loop-build", was "0"\)/);
  const after = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.deepEqual(after, { ...before, machineUserId: '8' });
  assert.deepEqual(Object.keys(after), Object.keys(before));
  const again = await runFill({ configPath }, { get: tracker.get, readText });
  assert.equal(again.code, 0);
  assert.match(again.lines[0], /already has machineUserId 8/);
});

test('fill-machine-user: no sign-in yet is exit 3 and leaves the file alone', async (t) => {
  const { answersPath, out } = scratch(t);
  const { get } = fakeTracker(ACTORS.filter((a) => a.id !== 8));
  await runWrite({ answersPath, outDir: out }, deps(get));
  const configPath = join(out, 'spirality.project.json');
  const text = readFileSync(configPath, 'utf8');
  const r = await runFill({ configPath }, { get, readText });
  assert.equal(r.code, 3);
  assert.match(r.lines[0], /"normie loop-build" is not in the tracker.*unchanged/);
  assert.equal(readFileSync(configPath, 'utf8'), text);
});

test('fill-machine-user: refuses the tracker home\'s own settings file', async () => {
  const configPath = new URL('../../spirality.project.json', import.meta.url).pathname;
  const text = readFileSync(configPath, 'utf8');
  const r = await runFill({ configPath }, { get: fakeTracker(ACTORS).get, readText });
  assert.equal(r.code, 1);
  assert.match(r.lines.at(-1), /^FAILED: fill in machineUserId: .*runs the tracker itself/);
  assert.equal(readFileSync(configPath, 'utf8'), text);
});

test('readActors reads loops as well as people', async () => {
  const { people, actors } = await readActors(fakeTracker(ACTORS).get, 'http://t');
  assert.deepEqual(people, [{ id: 1, name: 'Dane' }]);
  assert.equal(actors.length, 3);
});

test('the tracker home is read from its file, never with the environment\'s TRACKER_URL', (t) => {
  const { dir } = scratch(t);
  writeFileSync(join(dir, 'spirality.project.json'), JSON.stringify(homeConfig));
  const before = { url: process.env.TRACKER_URL, api: process.env.TRACKER_API_URL };
  process.env.TRACKER_URL = 'http://127.0.0.1:9999';
  process.env.TRACKER_API_URL = 'http://127.0.0.1:9998';
  t.after(() => {
    for (const [k, v] of [['TRACKER_URL', before.url], ['TRACKER_API_URL', before.api]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
  const { homeConfig: home, homeRoot } = loadHome(dir, (d) => d);
  assert.equal(home.trackerUrl, 'http://mac-mini.local:4180');
  assert.equal(home.trackerApiUrl, 'http://127.0.0.1:4180');
  assert.equal(homeRoot, dir);
});
