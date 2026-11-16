/**
 * SP-345 through the real door: a ticket's kind, who started it and how it
 * ended, set by `task` at filing and by `classify` afterwards, each read
 * back, printed by `get` and carried by `tickets --json`. A real tracker
 * server on a temporary database.
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

const DOOR = fileURLToPath(new URL('../clickup.mjs', import.meta.url));

async function fixture({ tracker = 'api' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ticket-class-door-'));
  const store = openStore(join(dir, 'tracker.db'));
  const human = store.createActor({ kind: 'human', name: 'Dana' });
  const machine = store.createActor({ kind: 'machine', name: 'Loop' });
  const machineToken = store.issueToken(machine.id);
  store.createProject({ slug: 'alpha', name: 'Alpha', prefix: 'AL', operator: human.id });
  const server = await startServer({ store, port: 0 });
  const url = `http://127.0.0.1:${server.address().port}`;
  const project = join(dir, 'project');
  mkdirSync(project);
  writeFileSync(join(project, 'spirality.project.json'), JSON.stringify({
    manifestVersion: 2, workspaceId: '111', spaceId: '222', loopQueueListId: '333',
    operatorUserId: human.id, machineUserId: machine.id,
    githubRepo: 'owner/repo', dopplerProject: 'proj', dopplerConfig: 'dev',
    launchdPrefix: 'com.example', logDir: '~/loop-logs', mergePhrases: ['merge'],
    governancePaths: [], autoMergeLanes: [], operatorName: 'Dane', projectSlug: 'alpha',
    legacyMachinePrefixes: [], projectScripts: {}, tracker, trackerUrl: url, trackerPrefix: 'AL',
  }));
  return {
    store, machine,
    door(args, stdin = '') {
      return new Promise((resolve) => {
        const env = { PATH: process.env.PATH, HOME: process.env.HOME, TRACKER_TOKEN_HAND_RUN: machineToken, CLICKUP_API_TOKEN: 'not-used' };
        const child = spawn(process.execPath, [DOOR, ...args], { cwd: project, env });
        let out = '';
        let err = '';
        child.stdout.on('data', (c) => { out += c; });
        child.stderr.on('data', (c) => { err += c; });
        child.on('close', (code) => resolve({ code, out, err }));
        child.stdin.end(stdin);
      });
    },
    async cleanup() {
      await new Promise((r) => server.close(r));
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('task files a ticket with its kind and starter, read back; get prints them', async () => {
  const f = await fixture();
  try {
    const filed = await f.door(['task', '--name', 'Resolve the merge conflict on PR #9', '--body-file', '-', '--kind', 'operational', '--started-by', 'agent'], 'The spec.');
    assert.equal(filed.code, 0, filed.err);
    assert.match(filed.out, /kind: {8}operational; started by agent; ended \(none\)/);
    const t = f.store.listTickets('alpha')[0];
    assert.deepEqual([t.kind, t.startedBy, t.outcome], ['operational', 'agent', null]);
    const got = await f.door(['get', '--task', t.id]);
    assert.equal(got.code, 0, got.err);
    assert.match(got.out, /^kind: {5}operational$/m);
    assert.match(got.out, /^started: {2}agent$/m);
    assert.match(got.out, /^ended: {4}\(still open\)$/m);
  } finally { await f.cleanup(); }
});

test('task refuses a value that is none of the choices, filing nothing', async () => {
  const f = await fixture();
  try {
    const out = await f.door(['task', '--name', 'x', '--body-file', '-', '--kind', 'bug'], 'The spec.');
    assert.equal(out.code, 2);
    assert.match(out.err, /"bug" is not a kind: feature, fix, operational, documentation, or none\. Nothing was created\./);
    assert.equal(f.store.listTickets('alpha').length, 0);
  } finally { await f.cleanup(); }
});

test('classify sets and clears each field, read back; an ending on an open ticket is refused', async () => {
  const f = await fixture();
  try {
    const id = f.store.fileTicket({ project: 'alpha', actor: f.machine.id, name: 'x', status: 'queued' }).id;
    const set = await f.door(['classify', '--task', id, '--kind', 'Feature', '--started-by', 'operator']);
    assert.equal(set.code, 0, set.err);
    assert.match(set.out, /kind "none" -> "feature", started by "none" -> "operator" \(read back\)/);
    const open = await f.door(['classify', '--task', id, '--outcome', 'done']);
    assert.notEqual(open.code, 0);
    assert.match(open.err, /only a closed ticket has an ending/);
    assert.equal(f.store.getTicket(id).outcome, null);
    f.store.changeTicket(id, { actor: f.machine.id, status: 'live' });
    const ended = await f.door(['classify', '--task', id, '--outcome', "won't do", '--started-by', 'none']);
    assert.equal(ended.code, 0, ended.err);
    const t = f.store.getTicket(id);
    assert.deepEqual([t.kind, t.startedBy, t.outcome], ['feature', null, 'wont-do']);
    const none = await f.door(['classify', '--task', id]);
    assert.equal(none.code, 2);
    assert.match(none.err, /give at least one of --kind, --started-by, --outcome/);
  } finally { await f.cleanup(); }
});

test('tickets --json carries kind, startedBy and outcome', async () => {
  const f = await fixture();
  try {
    f.store.fileTicket({ project: 'alpha', actor: f.machine.id, name: 'x', status: 'queued', kind: 'documentation', startedBy: 'client' });
    const out = await f.door(['tickets', '--json']);
    assert.equal(out.code, 0, out.err);
    const [t] = JSON.parse(out.out);
    assert.deepEqual([t.kind, t.startedBy, t.outcome], ['documentation', 'client', null]);
  } finally { await f.cleanup(); }
});
