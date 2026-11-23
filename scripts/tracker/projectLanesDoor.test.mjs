/**
 * SP-401 through the real door: `project-lanes` sends the project config's
 * `projectLanes` to the tracker, and from then on each lane has its own
 * `paused.<lane>` switch: `settings` lists it, the operator turns it on and
 * off (logged with who), and `pause-check` stops that lane on it alone. The
 * whole-pipeline switch still pauses it, and a project that does not name
 * the lane is refused the setting. A real tracker server on a temporary
 * database; the project config is a file the test writes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openStore } from '../../tracker/store.mjs';
import { startServer } from '../../tracker/server.mjs';
import { CONTROLS } from '../../tracker/pipelineControls.mjs';

const DOOR = fileURLToPath(new URL('../clickup.mjs', import.meta.url));

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'project-lanes-door-'));
  const store = openStore(join(dir, 'tracker.db'));
  const human = store.createActor({ kind: 'human', name: 'Dana' });
  const machine = store.createActor({ kind: 'machine', name: 'Loop' });
  const machineToken = store.issueToken(machine.id);
  const humanToken = store.issueToken(human.id);
  store.createProject({ slug: 'alpha', name: 'Alpha', prefix: 'AL', operator: human.id });
  store.createProject({ slug: 'beta', name: 'Beta', prefix: 'BE', operator: human.id });
  const server = await startServer({ store, port: 0 });
  const url = `http://127.0.0.1:${server.address().port}`;
  const folder = (slug, prefix, extra) => {
    const at = join(dir, slug);
    mkdirSync(at);
    writeFileSync(join(at, 'spirality.project.json'), JSON.stringify({
      manifestVersion: 2, workspaceId: '111', spaceId: '222', loopQueueListId: '333',
      operatorUserId: human.id, machineUserId: machine.id,
      githubRepo: 'owner/repo', dopplerProject: 'proj', dopplerConfig: 'dev',
      launchdPrefix: 'com.example', logDir: '~/loop-logs', mergePhrases: ['merge'],
      governancePaths: [], autoMergeLanes: [], operatorName: 'Dane', projectSlug: slug,
      legacyMachinePrefixes: [], projectScripts: {}, tracker: 'api', trackerUrl: url, trackerPrefix: prefix,
      ...extra,
    }));
    return at;
  };
  const alpha = folder('alpha', 'AL', { projectLanes: ['loop-handoff'] });
  const beta = folder('beta', 'BE', {});
  const run = (cwd, args) => new Promise((resolve) => {
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, TRACKER_TOKEN_HAND_RUN: machineToken };
    const child = spawn(process.execPath, [DOOR, ...args], { cwd, env });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('close', (code) => resolve({ code, out, err }));
    child.stdin.end('');
  });
  const put = async (slug, setting, value, token = humanToken) => {
    const res = await fetch(`${url}/pipeline-controls/${slug}`, {
      method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ setting, value }),
    });
    return { status: res.status, json: await res.json() };
  };
  return {
    store, put, machineToken,
    alpha: (args) => run(alpha, args),
    beta: (args) => run(beta, args),
    async cleanup() {
      await new Promise((r) => server.close(r));
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('project-lanes gives each of a project\'s own lanes a pause switch the lane obeys', async () => {
  const f = await fixture();
  try {
    const before = await f.alpha(['settings']);
    assert.equal(before.code, 0, before.err);
    assert.doesNotMatch(before.out, /paused\.loop-handoff/, 'no switch before the lanes are sent');

    const sent = await f.alpha(['project-lanes']);
    assert.equal(sent.code, 0, sent.err);
    assert.equal(sent.out, 'paused.loop-handoff=off\n');
    assert.match(sent.err, /alpha runs 1 lane\(s\) of its own \(loop-handoff\), read back: added loop-handoff/);
    const again = await f.alpha(['project-lanes']);
    assert.equal(again.code, 0, again.err);
    assert.match(again.err, /read back, unchanged/);

    const settings = await f.alpha(['settings']);
    assert.equal(settings.code, 0, settings.err);
    const lines = settings.out.trim().split('\n');
    assert.ok(lines.includes('paused.loop-handoff=off'));
    assert.equal(lines.length, CONTROLS.length + 1, 'every built-in control is still there, plus the one switch');
    for (const c of CONTROLS) assert.ok(lines.includes(`${c.key}=${c.default}`), c.key);

    // A project that names no lanes of its own: its settings are as they were.
    assert.equal((await f.beta(['project-lanes'])).code, 0);
    const beta = await f.beta(['settings']);
    assert.deepEqual(beta.out.trim().split('\n'), CONTROLS.map((c) => `${c.key}=${c.default}`));

    // Running: neither switch on.
    const running = await f.alpha(['pause-check', '--lane', 'loop-handoff']);
    assert.equal(running.code, 0, running.out + running.err);
    assert.match(running.out, /running — neither the whole pipeline nor loop-handoff is paused/);

    // The operator turns the lane's own switch on: read back and logged.
    const on = await f.put('alpha', 'paused.loop-handoff', 'on');
    assert.equal(on.status, 200, JSON.stringify(on.json));
    assert.equal(on.json.saved.to, 'on');
    assert.equal(on.json.changes[0].setting, 'paused.loop-handoff');
    assert.equal(on.json.changes[0].actorName, 'Dana');
    assert.equal(on.json.changes[0].label, 'loop-handoff paused');
    const paused = await f.alpha(['pause-check', '--lane', 'loop-handoff']);
    assert.equal(paused.code, 3, paused.out + paused.err);
    assert.match(paused.out, /paused by Dana at .+ — not starting \/loop-handoff \(loop-handoff is paused on the Settings page/);
    const build = await f.alpha(['pause-check', '--lane', 'loop-build']);
    assert.equal(build.code, 0, 'the other lanes still run');

    // Off again, and the whole pipeline paused instead: still paused.
    assert.equal((await f.put('alpha', 'paused.loop-handoff', 'off')).status, 200);
    assert.equal((await f.alpha(['pause-check', '--lane', 'loop-handoff'])).code, 0);
    assert.equal((await f.put('alpha', 'paused', 'on')).status, 200);
    const whole = await f.alpha(['pause-check', '--lane', 'loop-handoff']);
    assert.equal(whole.code, 3);
    assert.match(whole.out, /the whole pipeline is paused/);

    // A project that does not name the lane has no such setting.
    const refused = await f.put('beta', 'paused.loop-handoff', 'on');
    assert.equal(refused.status, 400);
    assert.equal(refused.json.error, 'unknown-setting');
    // And a loop sign-in still cannot change a switch.
    assert.equal((await f.put('alpha', 'paused.loop-handoff', 'on', f.machineToken)).status, 403);
  } finally {
    await f.cleanup();
  }
});
