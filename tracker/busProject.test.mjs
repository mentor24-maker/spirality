import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from './store.mjs';
import { startServer } from './server.mjs';
import { busShape, ensureBusProject } from './busProject.mjs';
import { seatsForConfig } from './signins.mjs';
import { validateProjectConfig } from '../lib/projectConfig.mjs';

const DOOR = fileURLToPath(new URL('../scripts/clickup.mjs', import.meta.url));

/**
 * A fresh tracker with the operator and a guest project's loop sign-ins, as
 * the sign-ins step leaves them, and that project's settings (with a bus).
 */
function fixture({ busProject = 'pressplay-bus' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bus-project-'));
  const store = openStore(join(dir, 'tracker.db'));
  const operator = store.createActor({ kind: 'human', name: 'Dana' });
  const raw = {
    workspaceId: '0', spaceId: '0', loopQueueListId: '0',
    operatorUserId: String(operator.id), machineUserId: '0',
    githubRepo: 'owner/pressplay', dopplerProject: 'pressplay', dopplerConfig: 'dev',
    launchdPrefix: 'com.pressplay', logDir: '~/loop-logs', mergePhrases: ['merge'],
    governancePaths: [], autoMergeLanes: [], operatorName: 'Dana', projectSlug: 'pressplay',
    legacyMachinePrefixes: [], projectScripts: {}, trackerPrefix: 'PP', tracker: 'api',
    trackerUrl: 'http://tracker.test',
    ...(busProject ? { busProject } : {}),
  };
  const seats = seatsForConfig(validateProjectConfig(raw, { env: {} })).seats;
  const loops = Object.fromEntries(seats.map((s) => [s.secret, store.createActor({ kind: 'machine', name: s.name })]));
  raw.machineUserId = String(loops.TRACKER_TOKEN_LOOP_BUILD.id);
  const config = validateProjectConfig(raw, { env: {} });
  return {
    dir, store, operator, raw, config, loops,
    cleanup() { store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test('a project with a bus gets its tracker project once: made, read back, every loop sees it; a second run changes nothing', (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  assert.deepEqual(busShape(f.config, 'PressPlay'), { slug: 'pressplay-bus', name: 'PressPlay bus', prefix: 'PPBUS' });

  const first = ensureBusProject({ store: f.store, config: f.config, projectName: 'PressPlay' });
  assert.equal(first.ok, true, first.lines.join('\n'));
  assert.equal(first.made, true);
  const made = f.store.getProject('pressplay-bus');
  assert.equal(made.name, 'PressPlay bus');
  assert.equal(made.prefix, 'PPBUS');
  assert.equal(made.operator, f.operator.id);
  assert.equal(made.repo, null, 'nothing on the bus is ever built');
  assert.ok(f.store.listMembers('pressplay-bus').some((m) => m.id === f.operator.id), 'the operator is its member');
  for (const actor of Object.values(f.loops)) {
    assert.ok(f.store.projectsVisibleTo(actor.id).includes('pressplay-bus'), actor.name);
    assert.ok(first.lines.some((l) => l.startsWith(`${actor.name}: sees "pressplay-bus"`)), actor.name);
  }

  const projects = f.store.listProjects().length;
  const second = ensureBusProject({ store: f.store, config: f.config, projectName: 'PressPlay' });
  assert.equal(second.ok, true, second.lines.join('\n'));
  assert.equal(second.made, false);
  assert.match(second.lines[0], /already there .*left alone/);
  assert.equal(f.store.listProjects().length, projects, 'nothing new');
});

test('no bus: nothing is made', (t) => {
  const f = fixture({ busProject: null });
  t.after(() => f.cleanup());
  const r = ensureBusProject({ store: f.store, config: f.config, projectName: 'PressPlay' });
  assert.equal(r.ok, true);
  assert.equal(r.made, false);
  assert.deepEqual(f.store.listProjects(), []);
});

test('a bus project that is there under another operator is refused, and nothing changes', (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  const other = f.store.createActor({ kind: 'human', name: 'Someone Else' });
  f.store.createProject({ slug: 'pressplay-bus', name: 'Not ours', prefix: 'NO', operator: other.id });
  const r = ensureBusProject({ store: f.store, config: f.config, projectName: 'PressPlay' });
  assert.equal(r.ok, false);
  assert.match(r.lines[0], /REFUSED\. It is there, but its operator is actor/);
  assert.equal(f.store.getProject('pressplay-bus').name, 'Not ours');
});

test('a loop sign-in not made yet fails the check, naming it; a taken prefix is not made', (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  const config = validateProjectConfig({ ...f.raw, projectSlug: 'other', trackerPrefix: 'OT', busProject: 'other-bus' }, { env: {} });
  const r = ensureBusProject({ store: f.store, config, projectName: 'Other' });
  assert.equal(r.ok, false);
  assert.match(r.lines.join('\n'), /other loop-build: no such sign-in yet \(the sign-ins step makes it\)/);

  f.store.createProject({ slug: 'taken', name: 'Taken', prefix: 'PPBUS', operator: f.operator.id });
  const refused = ensureBusProject({ store: f.store, config: f.config, projectName: 'PressPlay' });
  assert.equal(refused.ok, false);
  assert.match(refused.lines[0], /NOT made: .*already exists/);
  assert.equal(f.store.getProject('pressplay-bus'), null);
});

test('bus-post from the project\'s folder, signed in as its build loop, posts to the bus the step made and reads back', async (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  assert.equal(ensureBusProject({ store: f.store, config: f.config, projectName: 'PressPlay' }).ok, true);
  const server = await startServer({ store: f.store, port: 0 });
  t.after(() => new Promise((r) => server.close(r)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const folder = join(f.dir, 'pressplay');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'spirality.project.json'), JSON.stringify({ ...f.raw, trackerUrl: url }));
  const token = f.store.issueToken(f.loops.TRACKER_TOKEN_LOOP_BUILD.id);
  const door = (args, input) => new Promise((resolve) => {
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, TRACKER_TOKEN_NAME: 'TRACKER_TOKEN_LOOP_BUILD', TRACKER_TOKEN_LOOP_BUILD: token };
    const child = spawn(process.execPath, [DOOR, ...args], { cwd: folder, env });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('close', (code) => resolve({ code, out, err }));
    child.stdin.end(input ?? '');
  });
  const posted = await door(['bus-post', '--body-file', '-', '--from', 'mini'], 'the heartbeat stopped at 09:10');
  assert.equal(posted.code, 0, `${posted.out}\n${posted.err}`);
  assert.match(posted.out, /Posted to the bus: comment \d+ on PPBUS-1 "Team chat" in pressplay-bus \(verified by reading it back\)/);
  const read = await door(['bus-read']);
  assert.equal(read.code, 0, `${read.out}\n${read.err}`);
  assert.match(read.out, /PPBUS-1\tmachine\tpressplay loop-build\t/);
});
