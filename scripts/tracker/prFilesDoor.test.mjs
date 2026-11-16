/**
 * SP-349 through the real door: `pr-opened` records which files the pull
 * request changes, `pr-files` reads them back and names the open pull
 * requests sharing a file, and the relay's `pr-files-refresh` keeps them
 * current. A real tracker server on a temporary database; a stand-in `gh`
 * on the PATH answers from a JSON file the test writes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openStore } from '../../tracker/store.mjs';
import { startServer } from '../../tracker/server.mjs';

const DOOR = fileURLToPath(new URL('../clickup.mjs', import.meta.url));

/** The stand-in gh: `pr view`, `pr list` and `api .../pulls/<n>/files`, from world.json. */
const FAKE_GH = `#!/usr/bin/env node
const fs = require('fs');
const world = JSON.parse(fs.readFileSync(process.env.FAKE_GH_WORLD, 'utf8'));
const a = process.argv.slice(2);
const fail = (why) => { process.stderr.write(why + '\\n'); process.exit(1); };
if (a[0] === 'pr' && a[1] === 'view') {
  const pr = world.prs[a[2]];
  if (!pr) fail('no pull request ' + a[2]);
  const fields = a[a.indexOf('--json') + 1].split(',');
  const out = {};
  for (const k of fields) out[k] = k === 'url' ? 'https://github.com/owner/repo/pull/' + a[2] : pr[k];
  process.stdout.write(JSON.stringify(out));
} else if (a[0] === 'pr' && a[1] === 'list') {
  if (world.listFails) fail('GitHub is down');
  process.stdout.write(JSON.stringify(Object.entries(world.prs).filter(([, p]) => p.state === 'OPEN')
    .map(([n, p]) => ({ number: Number(n), headRefOid: p.headRefOid, body: p.body }))));
} else if (a[0] === 'api') {
  const n = /pulls\\/(\\d+)\\/files/.exec(a.join(' '))[1];
  if ((world.filesFail || []).includes(Number(n))) fail('HTTP 502');
  for (const [path, old] of world.prs[n].files) process.stdout.write(path + '\\t' + (old || '') + '\\n');
} else fail('unexpected gh ' + a.join(' '));
`;

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'pr-files-door-'));
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
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), FAKE_GH);
  chmodSync(join(bin, 'gh'), 0o755);
  const worldFile = join(dir, 'world.json');
  const f = {
    store, url, machine,
    world(w) { writeFileSync(worldFile, JSON.stringify(w)); },
    ticket: (name) => store.fileTicket({ project: 'alpha', actor: machine.id, status: 'building', name }).id,
    body: (id) => `Does the thing.\n\nTicket: ${url}/t/${id}\n`,
    door(args) {
      return new Promise((resolve) => {
        const env = { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME, TRACKER_TOKEN_HAND_RUN: machineToken, FAKE_GH_WORLD: worldFile };
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
  return f;
}

const SHA = (c) => c.repeat(40);

test('pr-opened records the files, and pr-files names the open pull requests sharing one', async () => {
  const f = await fixture();
  try {
    const a = f.ticket('First');
    const b = f.ticket('Second');
    f.world({ prs: {
      7: { body: f.body(a), state: 'OPEN', headRefOid: SHA('a'), changedFiles: 2, files: [['tracker/store.mjs'], ['lib/new.js', 'lib/old.js']] },
      8: { body: f.body(b), state: 'OPEN', headRefOid: SHA('b'), changedFiles: 1, files: [['tracker/store.mjs']] },
    } });
    const one = await f.door(['pr-opened', '--task', a, '--pr', 'https://github.com/owner/repo/pull/7']);
    assert.equal(one.code, 0, one.err);
    assert.match(one.out, /PR #7 \(AL-1\): 3 changed file\(s\) recorded at aaaaaaa, read back\./);
    const two = await f.door(['pr-opened', '--task', b, '--pr', 'https://github.com/owner/repo/pull/8']);
    assert.equal(two.code, 0, two.err);
    assert.deepEqual(f.store.prFiles('alpha').map((r) => [r.number, r.ticket, r.files]), [
      [7, a, ['lib/new.js', 'lib/old.js', 'tracker/store.mjs']],
      [8, b, ['tracker/store.mjs']],
    ]);

    const mine = await f.door(['pr-files', '--task', a]);
    assert.equal(mine.code, 3, mine.err);
    assert.equal(mine.out, `Changes the same files as ${b} (PR #8): tracker/store.mjs\n`);
    const asked = await f.door(['pr-files', '--files', 'lib/old.js,docs/x.md', '--json']);
    assert.equal(asked.code, 3, asked.err);
    assert.deepEqual(JSON.parse(asked.out).shared, [{ ticket: a, number: 7, files: ['lib/old.js'] }]);
    const none = await f.door(['pr-files', '--files', 'docs/x.md']);
    assert.equal(none.code, 0, none.err);
    assert.match(none.out, /No other open pull request changes any of those files/);
    const all = await f.door(['pr-files']);
    assert.equal(all.code, 0, all.err);
    assert.equal(all.out.trim().split('\n').length, 2);
  } finally { await f.cleanup(); }
});

test('a files read that fails is said and stores nothing, never "no files"; the PR is still recorded', async () => {
  const f = await fixture();
  try {
    const a = f.ticket('First');
    f.world({ filesFail: [7], prs: { 7: { body: f.body(a), state: 'OPEN', headRefOid: SHA('a'), changedFiles: 1, files: [['a.js']] } } });
    const r = await f.door(['pr-opened', '--task', a, '--pr', 'https://github.com/owner/repo/pull/7']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /PR #7 recorded/);
    assert.match(r.err, /changed files were NOT recorded: GitHub did not list PR #7's files: HTTP 502/);
    assert.deepEqual(f.store.prFiles('alpha'), []);
    // A list cut short (GitHub says 2, lists 1) is a failed read too.
    f.world({ prs: { 7: { body: f.body(a), state: 'OPEN', headRefOid: SHA('a'), changedFiles: 2, files: [['a.js']] } } });
    const short = await f.door(['pr-opened', '--task', a, '--pr', 'https://github.com/owner/repo/pull/7', '--if-missing']);
    assert.match(short.err, /listed 1 changed file\(s\) for PR #7 but the pull request says 2/);
    assert.deepEqual(f.store.prFiles('alpha'), []);
  } finally { await f.cleanup(); }
});

test('pr-files-refresh re-reads a moved branch, forgets a closed one, and leaves the current alone', async () => {
  const f = await fixture();
  try {
    const a = f.ticket('First');
    const b = f.ticket('Second');
    const c = f.ticket('Third');
    f.world({ prs: {
      7: { body: f.body(a), state: 'OPEN', headRefOid: SHA('a'), changedFiles: 1, files: [['a.js']] },
      8: { body: f.body(b), state: 'OPEN', headRefOid: SHA('b'), changedFiles: 1, files: [['b.js']] },
      9: { body: f.body(c), state: 'OPEN', headRefOid: SHA('c'), changedFiles: 1, files: [['c.js']] },
      10: { body: 'No ticket here.', state: 'OPEN', headRefOid: SHA('d'), changedFiles: 1, files: [['d.js']] },
    } });
    const first = await f.door(['pr-files-refresh']);
    assert.equal(first.code, 0, first.err);
    assert.match(first.out, /PR #10: its body links no ticket/);
    assert.match(first.out, /4 open pull request\(s\); 0 already current, 3 read, 0 forgotten, 1 with no ticket, 0 failed/);

    // #7's branch moves and now changes b.js too; #8 merges; #9 stays put.
    f.world({ prs: {
      7: { body: f.body(a), state: 'OPEN', headRefOid: SHA('e'), changedFiles: 2, files: [['a.js'], ['b.js']] },
      8: { body: f.body(b), state: 'MERGED', headRefOid: SHA('b'), changedFiles: 1, files: [['b.js']] },
      9: { body: f.body(c), state: 'OPEN', headRefOid: SHA('c'), changedFiles: 1, files: [['c.js']] },
    } });
    const dry = await f.door(['pr-files-refresh', '--dry-run']);
    assert.equal(dry.code, 0, dry.err);
    assert.match(dry.out, /PR #7 \(AL-1\): would read its files \(branch moved\)/);
    assert.match(dry.out, /PR #8 \(AL-2\): would forget its files/);
    assert.equal(f.store.prFiles('alpha').length, 3, 'a dry run writes nothing');

    const second = await f.door(['pr-files-refresh']);
    assert.equal(second.code, 0, second.err);
    assert.match(second.out, /2 open pull request\(s\); 1 already current, 1 read, 1 forgotten, 0 with no ticket, 0 failed/);
    assert.deepEqual(f.store.prFiles('alpha').map((r) => [r.number, r.head, r.files]), [
      [7, SHA('e'), ['a.js', 'b.js']],
      [9, SHA('c'), ['c.js']],
    ]);
  } finally { await f.cleanup(); }
});

test('pr-files-refresh says a failed read and changes nothing when GitHub cannot list the pull requests', async () => {
  const f = await fixture();
  try {
    const a = f.ticket('First');
    f.world({ filesFail: [7], prs: { 7: { body: f.body(a), state: 'OPEN', headRefOid: SHA('a'), changedFiles: 1, files: [['a.js']] } } });
    const bad = await f.door(['pr-files-refresh']);
    assert.equal(bad.code, 1);
    assert.match(bad.err, /PR #7: GitHub did not list PR #7's files: HTTP 502\. Nothing was stored for it/);
    f.world({ listFails: true, prs: {} });
    const down = await f.door(['pr-files-refresh']);
    assert.equal(down.code, 1);
    assert.match(down.err, /could not be listed .*Nothing was changed, nothing forgotten/);
  } finally { await f.cleanup(); }
});

test('pr-opened keeps no files for a pull request that has merged or closed, or one in another repository', async () => {
  const f = await fixture();
  try {
    const a = f.ticket('First');
    f.world({ prs: { 7: { body: f.body(a), state: 'MERGED', headRefOid: SHA('a'), changedFiles: 1, files: [['a.js']] } } });
    const merged = await f.door(['pr-opened', '--task', a, '--pr', 'https://github.com/owner/repo/pull/7']);
    assert.equal(merged.code, 0, merged.err);
    assert.match(merged.out, /PR #7 recorded/);
    assert.match(merged.out, /PR #7 is merged, so its files are not kept\./);
    assert.deepEqual(f.store.prFiles('alpha'), []);

    f.world({ prs: { 7: { body: f.body(a), state: 'OPEN', headRefOid: SHA('a'), changedFiles: 1, files: [['a.js']] } } });
    const elsewhere = await f.door(['pr-opened', '--task', a, '--pr', 'https://github.com/someone/fork/pull/7']);
    assert.equal(elsewhere.code, 0, elsewhere.err);
    assert.match(elsewhere.out, /PR #7 is in someone\/fork, not this project's repository \(owner\/repo\), so its files are not kept\./);
    assert.deepEqual(f.store.prFiles('alpha'), []);
  } finally { await f.cleanup(); }
});

test('pr-files-refresh leaves alone a record kept from another repository', async () => {
  const f = await fixture();
  try {
    const a = f.ticket('First');
    const b = f.ticket('Second');
    f.store.recordPrFiles({ project: 'alpha', number: 7, ticket: b, repo: 'someone/fork', head: SHA('f'), files: ['x.js'], actor: f.machine.id });
    f.world({ prs: { 7: { body: f.body(a), state: 'OPEN', headRefOid: SHA('a'), changedFiles: 1, files: [['a.js']] } } });
    const r = await f.door(['pr-files-refresh']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /1 record\(s\) from a repository other than owner\/repo left alone/);
    // Upserting this repository's #7 replaces the stray row: the record names
    // this repository's ticket, never the fork's.
    assert.deepEqual(f.store.prFiles('alpha').map((x) => [x.number, x.ticket, x.repo, x.files]), [[7, a, 'owner/repo', ['a.js']]]);
  } finally { await f.cleanup(); }
});
