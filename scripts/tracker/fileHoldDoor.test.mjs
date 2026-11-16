/**
 * SP-351 through the real door: `queue --claimable` and `claim` hold a
 * Queued ticket back while an open pull request (or a ticket in Building
 * with no pull request yet) changes one of the same files, `--note-holds`
 * says so on it once, and `likely-files` writes the line an older ticket
 * lacks. A real tracker server on a temporary database.
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

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'file-hold-door-'));
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
    legacyMachinePrefixes: [], projectScripts: {}, tracker: 'api', trackerUrl: url, trackerPrefix: 'AL',
  }));
  return {
    store, human, machine,
    file: (name, description, status = 'queued') => store.fileTicket({ project: 'alpha', actor: machine.id, status, name, description }).id,
    pr: (ticket, number, files) => store.recordPrFiles({ project: 'alpha', number, ticket, repo: 'owner/repo', head: 'a'.repeat(40), files, actor: machine.id }),
    notes: (id) => store.listComments(id).filter((c) => /HELD FOR SHARED FILES/.test(c.body ?? c.text ?? '')),
    door(args) {
      return new Promise((resolve) => {
        const env = { PATH: process.env.PATH, HOME: process.env.HOME, TRACKER_TOKEN_HAND_RUN: machineToken };
        const child = spawn(process.execPath, [DOOR, ...args], { cwd: project, env });
        let out = '';
        let err = '';
        child.stdout.on('data', (c) => { out += c; });
        child.stderr.on('data', (c) => { err += c; });
        child.on('close', (code) => resolve({ code, out, err }));
        child.stdin.end('');
      });
    },
    async cleanup() {
      await new Promise((r) => server.close(r));
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const ids = (r) => r.out.trim().split('\n').filter(Boolean).map((l) => l.split('\t')[0]);

test('a ticket sharing a file with an open pull request is skipped and not claimed; the next one is taken', async () => {
  const f = await fixture();
  try {
    const inFlight = f.file('In review one', 'Likely files: tracker/server.mjs', 'in review');
    f.pr(inFlight, 40, ['tracker/server.mjs', 'lib/x.js']);
    const held = f.file('Shares a file', '## Affected files / artifacts\n- `tracker/server.mjs`\n\nLikely files: tracker/server.mjs, docs/A.md\n');
    const free = f.file('Shares nothing', 'Likely files: docs/B.md');

    const q = await f.door(['queue', '--claimable']);
    assert.equal(q.code, 0, q.err);
    assert.deepEqual(ids(q), [free]);
    assert.match(q.err, new RegExp(`skipped ${held}: held for shared files: ${inFlight} \\(PR #40\\) changes tracker/server\\.mjs`));
    assert.equal(f.notes(held).length, 0, 'without --note-holds nothing is written');

    const c = await f.door(['claim', '--task', held]);
    assert.equal(c.code, 3, c.err);
    assert.match(c.err, /NOT claimed: .*held for shared files: .*PR #40/);
    assert.equal(f.store.getTicket(held).status, 'queued');

    // The pull request merges: its ticket goes Live, and the hold lifts at
    // once, before the relay has forgotten its files.
    f.store.changeTicket(inFlight, { actor: f.human.id, status: 'live' });
    const after = await f.door(['queue', '--claimable']);
    assert.deepEqual(ids(after), [held, free]);
    const claimed = await f.door(['claim', '--task', held]);
    assert.equal(claimed.code, 0, claimed.err);
    assert.equal(f.store.getTicket(held).status, 'building');
  } finally { await f.cleanup(); }
});

test('a ticket in Building with no pull request yet holds by its likely files, until it has one', async () => {
  const f = await fixture();
  try {
    const building = f.file('Being built', 'Likely files: tracker/web/app.mjs', 'building');
    const held = f.file('Same page script', 'Likely files: tracker/web/app.mjs');
    const q = await f.door(['queue', '--claimable']);
    assert.deepEqual(ids(q), []);
    assert.match(q.err, new RegExp(`${building} \\(being built, no pull request yet\\) will change tracker/web/app\\.mjs`));
    // Its pull request turns out to change other files: the record wins.
    f.pr(building, 41, ['docs/C.md']);
    assert.deepEqual(ids(await f.door(['queue', '--claimable'])), [held]);
  } finally { await f.cleanup(); }
});

test('--note-holds writes the note once, and again only when what holds it changes', async () => {
  const f = await fixture();
  try {
    const a = f.file('A', 'x', 'in review');
    f.pr(a, 40, ['a.js']);
    const held = f.file('Held', 'Likely files: a.js, b.js');
    const first = await f.door(['queue', '--claimable', '--note-holds']);
    assert.equal(first.code, 0, first.err);
    assert.match(first.err, /hold note \d+ written and read back/);
    assert.equal(f.notes(held).length, 1);
    await f.door(['queue', '--claimable', '--note-holds']);
    assert.equal(f.notes(held).length, 1, 'the same holders do not get a second note');
    const b = f.file('B', 'x', 'rework');
    f.pr(b, 42, ['b.js']);
    await f.door(['queue', '--claimable', '--note-holds']);
    assert.equal(f.notes(held).length, 2);
    // A hold note is not something waiting on Dane.
    const w = await f.door(['waiting', '--task', held]);
    assert.equal(w.code, 0, w.out + w.err);
  } finally { await f.cleanup(); }
});

test('Rework and merge fix-up tickets are never held by open pull requests', async () => {
  const f = await fixture();
  try {
    const a = f.file('A', 'x', 'in review');
    f.pr(a, 40, ['a.js']);
    const rework = f.file('Rework one', 'Likely files: a.js', 'rework');
    f.pr(rework, 41, ['a.js']);
    const fixup = f.file('Find out why PR #40 (a-branch) will not merge', 'Likely files: a.js');
    const q = await f.door(['queue', '--claimable']);
    assert.deepEqual(ids(q), [rework, fixup]);
    const c = await f.door(['claim', '--task', fixup]);
    assert.equal(c.code, 0, c.err);
  } finally { await f.cleanup(); }
});

test('a ticket that names no files is refused at claim while work is in flight, then likely-files lets it be checked', async () => {
  const f = await fixture();
  try {
    const a = f.file('A', 'x', 'in review');
    f.pr(a, 40, ['a.js']);
    const old = f.file('Older ticket', '## Goal\nDo it.\n\n## Acceptance criteria\n- done\n');
    const q = await f.door(['queue', '--claimable']);
    assert.deepEqual(ids(q), [old]);
    assert.match(q.err, new RegExp(`note ${old}: names no files it will change`));
    const refused = await f.door(['claim', '--task', old]);
    assert.equal(refused.code, 2, refused.err);
    assert.match(refused.err, /names no files it will change/);
    assert.equal(f.store.getTicket(old).status, 'queued');

    const w = await f.door(['likely-files', '--task', old, '--files', 'b.js, docs/D.md']);
    assert.equal(w.code, 0, w.err);
    assert.match(w.out, /Likely files: b\.js, docs\/D\.md \(added and read back\)/);
    assert.match(f.store.getTicket(old).description, /## Goal\nDo it\.\n\n## Acceptance criteria\n- done\n\nLikely files: b\.js, docs\/D\.md\n$/);
    const again = await f.door(['likely-files', '--task', old, '--files', 'c.js']);
    assert.equal(again.code, 2);
    assert.match(again.err, /already has a Likely files: line/);
    const claimed = await f.door(['claim', '--task', old]);
    assert.equal(claimed.code, 0, claimed.err);
  } finally { await f.cleanup(); }
});

test('with nothing in flight, a ticket that names no files is claimed as before', async () => {
  const f = await fixture();
  try {
    const t = f.file('Plain', '## Goal\nx');
    const c = await f.door(['claim', '--task', t]);
    assert.equal(c.code, 0, c.err);
  } finally { await f.cleanup(); }
});
