// SP-270: Spirality's door, its config reader and its Doppler wrapper act for
// another project's checkout, named by SPIRALITY_PROJECT, from Spirality's own
// folder; with nothing named they behave exactly as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openStore } from '../tracker/store.mjs';
import { seedDemo, tickingClock } from '../tracker/demoData.mjs';
import { startServer } from '../tracker/server.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DOOR = join(ROOT, 'scripts/clickup.mjs');
const WRAPPER = join(ROOT, 'scripts/with_doppler.mjs');
const CONFIG_SCRIPT = join(ROOT, 'scripts/project_config.mjs');

const manifest = (slug, extra = {}) => ({
  manifestVersion: 2, workspaceId: '111', spaceId: '222', loopQueueListId: '333',
  operatorUserId: '1', machineUserId: '2',
  githubRepo: `owner/${slug}`, dopplerProject: `${slug}-doppler`, dopplerConfig: 'dev',
  launchdPrefix: `com.${slug}`, logDir: '~/loop-logs', mergePhrases: ['merge'],
  governancePaths: [], autoMergeLanes: [], operatorName: 'Dane', projectSlug: slug,
  legacyMachinePrefixes: [], projectScripts: {}, ...extra,
});

function writeProject(dir, slug, extra) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'spirality.project.json'), JSON.stringify(manifest(slug, extra)));
  return dir;
}

function run(cmd, args, { cwd, env, input }) {
  return new Promise((done) => {
    const child = spawn(cmd, args, { cwd, env });
    let out = ''; let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('close', (code) => done({ code, out, err }));
    child.stdin.end(input ?? '');
  });
}

test('the door, run from Spirality\'s folder, lists the named project\'s queue; with nothing named, the one found from the current folder', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'named-project-'));
  const store = openStore(join(dir, 'tracker.db'), { now: tickingClock() });
  const seed = seedDemo(store, { operatorName: 'Dane', clock: tickingClock() });
  const token = store.issueToken(seed.loop.id);
  const server = await startServer({ store, port: 0 });
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const seats = { operatorUserId: seed.operator.id, machineUserId: seed.loop.id, tracker: 'api', trackerUrl: url };
    const alpha = writeProject(join(dir, 'alpha-checkout'), 'alpha', { ...seats, trackerPrefix: 'AL' });
    const beta = writeProject(join(dir, 'beta-checkout'), 'beta', { ...seats, trackerPrefix: 'BE' });
    const env = { PATH: process.env.PATH, HOME: dir, TRACKER_TOKEN_HAND_RUN: token };
    const queue = ['queue', '--status', 'Needs your input'];

    // Named: the door lives in Spirality's folder, the current folder is beta's
    // checkout, and alpha is named, so alpha's manifest wins.
    const named = await run(process.execPath, [DOOR, ...queue], { cwd: beta, env: { ...env, SPIRALITY_PROJECT: alpha } });
    assert.equal(named.code, 0, named.err);
    const namedIds = named.out.trim().split('\n').filter(Boolean).map((l) => l.split('\t')[0]);
    assert.ok(namedIds.length > 0, named.out + named.err);
    assert.ok(namedIds.every((id) => id.startsWith('AL-')), namedIds.join(' '));
    assert.match(named.err, /task\(s\) with status "Needs your input"/);

    // `~` in the name is the home folder, as a launchd job writes it.
    const tilde = await run(process.execPath, [DOOR, ...queue], { cwd: beta, env: { ...env, SPIRALITY_PROJECT: '~/alpha-checkout' } });
    assert.equal(tilde.code, 0, tilde.err);
    assert.equal(tilde.out, named.out);

    // Nothing named (unset or empty): exactly today's behaviour, the manifest
    // found from the current folder up.
    for (const unnamed of [env, { ...env, SPIRALITY_PROJECT: '' }]) {
      const r = await run(process.execPath, [DOOR, ...queue], { cwd: join(beta), env: unnamed });
      assert.equal(r.code, 0, r.err);
      const ids = r.out.trim().split('\n').filter(Boolean).map((l) => l.split('\t')[0]);
      assert.ok(ids.length > 0 && ids.every((id) => id.startsWith('BE-')), ids.join(' '));
    }

    // The token is never printed.
    for (const r of [named, tilde]) assert.ok(!r.out.includes(token) && !r.err.includes(token));
  } finally {
    await new Promise((r) => server.close(r));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a named project with no manifest, or a broken one, is refused naming the file, and never falls back to another queue', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'named-project-'));
  try {
    // A manifest in the folder ABOVE the named one must not be picked up.
    writeProject(dir, 'above', { tracker: 'clickup' });
    const empty = join(dir, 'empty-checkout');
    mkdirSync(empty);
    const broken = join(dir, 'broken-checkout');
    mkdirSync(broken);
    writeFileSync(join(broken, 'spirality.project.json'), '{ not json');
    const bad = writeProject(join(dir, 'bad-checkout'), 'bad', { loopQueueListId: 'not-a-number' });
    const env = { PATH: process.env.PATH, HOME: dir };
    const cases = [
      [empty, [join(empty, 'spirality.project.json'), 'not found', 'SPIRALITY_PROJECT']],
      [join(dir, 'no-such-checkout'), [join(dir, 'no-such-checkout'), 'does not exist']],
      [broken, [join(broken, 'spirality.project.json'), 'not valid JSON']],
      [bad, [join(bad, 'spirality.project.json'), '"loopQueueListId"']],
    ];
    for (const [folder, names] of cases) {
      for (const [script, args, prefix] of [
        [DOOR, ['queue', '--status', 'Queued'], 'clickup:'],
        [WRAPPER, ['true'], 'with_doppler:'],
        [CONFIG_SCRIPT, ['projectSlug'], 'project_config:'],
      ]) {
        const r = await run(process.execPath, [script, ...args], { cwd: dir, env: { ...env, SPIRALITY_PROJECT: folder } });
        assert.equal(r.code, 1, `${script} ${folder}: ${r.out}${r.err}`);
        assert.ok(r.err.startsWith(prefix), r.err);
        for (const n of names) assert.ok(r.err.includes(n), `${script} ${folder}: expected ${n} in ${r.err}`);
        assert.equal(r.out, '');
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('with_doppler reads the named project\'s Doppler project and config, and passes the name on to the command', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'named-project-'));
  try {
    const here = writeProject(join(dir, 'here'), 'here');
    const there = writeProject(join(dir, 'there'), 'there', { dopplerConfig: 'prd' });
    mkdirSync(join(dir, 'bin'));
    // A stand-in doppler: records its arguments, then runs the command.
    writeFileSync(join(dir, 'bin', 'doppler'), `#!/bin/sh\necho "$*" >> "${join(dir, 'calls')}"\nwhile [ "$1" != "--" ]; do shift; done; shift; exec "$@"\n`);
    chmodSync(join(dir, 'bin', 'doppler'), 0o755);
    const env = { PATH: `${join(dir, 'bin')}:${process.env.PATH}`, HOME: dir };
    const calls = () => readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n');

    const named = await run(process.execPath, [WRAPPER, process.execPath, CONFIG_SCRIPT, 'dopplerProject'], { cwd: here, env: { ...env, SPIRALITY_PROJECT: there } });
    assert.equal(named.code, 0, named.err);
    assert.equal(named.out, 'there-doppler\n');
    assert.match(calls().at(-1), /^run --project there-doppler --config prd --no-check-version -- /);

    const unnamed = await run(process.execPath, [WRAPPER, process.execPath, CONFIG_SCRIPT, 'dopplerProject'], { cwd: here, env });
    assert.equal(unnamed.code, 0, unnamed.err);
    assert.equal(unnamed.out, 'here-doppler\n');
    assert.match(calls().at(-1), /^run --project here-doppler --config dev --no-check-version -- /);

    // A command that names its own settings file with --config still wins.
    writeFileSync(join(dir, 'calls'), '');
    const r = spawnSync(process.execPath, [WRAPPER, 'sh', '-c', 'exit 0', 'sh', '--config', join(here, 'spirality.project.json')], { cwd: dir, env: { ...env, SPIRALITY_PROJECT: there }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(calls().at(-1), /^run --project here-doppler --config dev /);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
