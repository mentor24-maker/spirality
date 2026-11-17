/**
 * The door's `move` through a real tracker server on a temporary database:
 * a ticket goes into another project with its comments, is read back under
 * its new id and through its old one, and a read-back whose comment count
 * differs fails the command (exit 1). A refused move is exit 2, nothing moved.
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

/** A tracker with projects alpha and beta. `wrap` may replace the store the server is given. */
async function fixture({ wrap = (s) => s } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'move-door-'));
  const store = openStore(join(dir, 'tracker.db'));
  const human = store.createActor({ kind: 'human', name: 'Dana' });
  const machine = store.createActor({ kind: 'machine', name: 'Loop' });
  const machineToken = store.issueToken(machine.id);
  store.createProject({ slug: 'alpha', name: 'Alpha', prefix: 'AL', operator: human.id });
  store.createProject({ slug: 'beta', name: 'Beta', prefix: 'BE', operator: human.id });
  const server = await startServer({ store: wrap(store), port: 0 });
  const url = `http://127.0.0.1:${server.address().port}`;
  const project = join(dir, 'project');
  mkdirSync(project);
  writeFileSync(join(project, 'spirality.project.json'), JSON.stringify({
    manifestVersion: 2, workspaceId: '111', spaceId: '222', loopQueueListId: '333',
    operatorUserId: human.id, machineUserId: machine.id,
    githubRepo: 'owner/repo', dopplerProject: 'proj', dopplerConfig: 'dev',
    launchdPrefix: 'com.example', logDir: '~/loop-logs', mergePhrases: ['merge'],
    governancePaths: [], autoMergeLanes: [], operatorName: 'Dane', projectSlug: 'alpha',
    legacyMachinePrefixes: [], projectScripts: {}, tracker: 'api', trackerUrl: url, trackerPrefix: 'AL',
  }));
  return {
    store, human, machine,
    door(args) {
      return new Promise((resolve) => {
        const env = { PATH: process.env.PATH, HOME: process.env.HOME, TRACKER_TOKEN_HAND_RUN: machineToken, CLICKUP_API_TOKEN: 'not-used' };
        const child = spawn(process.execPath, [DOOR, ...args], { cwd: project, env });
        let out = '';
        let err = '';
        child.stdout.on('data', (c) => { out += c; });
        child.stderr.on('data', (c) => { err += c; });
        child.on('close', (code) => resolve({ code, out, err }));
        child.stdin.end();
      });
    },
    async cleanup() {
      await new Promise((r) => server.close(r));
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function chatTicket(f) {
  const t = f.store.fileTicket({ project: 'alpha', actor: f.machine.id, name: 'Team chat', status: 'queued', tags: ['chat'] });
  const first = f.store.postComment({ ticket: t.id, author: f.human.id, body: 'one' });
  f.store.postComment({ ticket: t.id, author: f.machine.id, body: 'a reply', parent: first.id });
  f.store.postComment({ ticket: t.id, author: f.machine.id, body: 'three' });
  return t;
}

test('move takes a ticket into another project, prints the old and new ids, and checks the comments read back', async () => {
  const f = await fixture();
  try {
    const t = chatTicket(f);
    const r = await f.door(['move', '--task', t.id, '--to', 'beta']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, `${t.id}\tBE-1\n`);
    assert.match(r.err, /Moved AL-1 to BE-1 in beta with its 3 comment\(s\), verified by reading it back; AL-1 still opens it\./);
    assert.match(r.err, /tag\(s\) made in beta: chat/);
    assert.equal(f.store.getTicket('AL-1'), null);
    assert.equal(f.store.listComments('BE-1').length, 3);
    const got = await f.door(['get', '--task', 'AL-1']);
    assert.equal(got.code, 0, got.err);
    assert.match(got.out, /^id: {7}BE-1$/m, 'the old id opens the moved ticket');
  } finally { await f.cleanup(); }
});

test('move exits 1 when the moved ticket reads back with a different comment count', async () => {
  // A tracker whose move comes back with a comment more: the door must not call that a success.
  const f = await fixture({
    wrap: (store) => new Proxy(store, {
      get(target, key) {
        if (key !== 'moveTicket') return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
        return (...args) => {
          const moved = target.moveTicket(...args);
          target.postComment({ ticket: moved.ticket.id, author: args[1].actor, body: 'one too many' });
          return moved;
        };
      },
    }),
  });
  try {
    const t = chatTicket(f);
    const r = await f.door(['move', '--task', t.id, '--to', 'beta']);
    assert.equal(r.code, 1, r.err);
    assert.match(r.err, /move FAILED — AL-1 had 3 comment\(s\); BE-1 reads back with 4\./);
  } finally { await f.cleanup(); }
});

test('move into the ticket\'s own project, or an unknown one, is refused with exit 2 and nothing moves', async () => {
  const f = await fixture();
  try {
    const t = chatTicket(f);
    const same = await f.door(['move', '--task', t.id, '--to', 'alpha']);
    assert.equal(same.code, 2, same.err);
    assert.match(same.err, /move: refused — AL-1 is already in project "alpha"; nothing was moved\./);
    const unknown = await f.door(['move', '--task', t.id, '--to', 'nope']);
    assert.equal(unknown.code, 2, unknown.err);
    assert.match(unknown.err, /nothing was moved/);
    assert.equal(f.store.getTicket('AL-1').project, 'alpha');
    assert.equal(f.store.listComments('AL-1').length, 3);
    assert.equal((await f.door(['move', '--task', t.id])).code, 2, 'no --to is a usage error');
  } finally { await f.cleanup(); }
});
