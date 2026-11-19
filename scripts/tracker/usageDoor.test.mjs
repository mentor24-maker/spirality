/**
 * SP-398 through the real door: `usage-record` reads a Claude session's
 * transcripts (its own and its subagents'), records one row per model on
 * the project's API Usage report with the ticket the session claimed, reads
 * them back, and a second run counts nothing twice. A real tracker server
 * on a temporary database; the transcripts are files the test writes.
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
const SESSION = '7085b85a-e384-48c1-96c1-860579f70a33';

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'usage-door-'));
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
  const transcripts = join(dir, 'claude', 'projects');
  const line = (id, model, u, content = []) => JSON.stringify({ type: 'assistant', timestamp: '2026-11-19T18:00:00Z', message: { id, model, content,
    usage: { input_tokens: u[0], output_tokens: u[1], cache_creation_input_tokens: u[2], cache_read_input_tokens: u[3] } } });
  mkdirSync(join(transcripts, '-Users-x-alpha', SESSION, 'subagents'), { recursive: true });
  writeFileSync(join(transcripts, '-Users-x-alpha', `${SESSION}.jsonl`), [
    line('m1', 'claude-opus-5-5', [1, 20, 300, 4000], [{ type: 'tool_use', name: 'Bash', input: { command: 'npm run --silent clickup -- claim --task AL-3' } }]),
    line('m1', 'claude-opus-5-5', [1, 20, 300, 4000]),
    line('m2', 'claude-opus-5-5', [1, 10, 0, 5000]),
  ].join('\n'));
  writeFileSync(join(transcripts, '-Users-x-alpha', SESSION, 'subagents', 'agent-a.jsonl'), line('s1', 'claude-haiku-5-5', [50, 5, 0, 0]));
  return {
    store, transcripts,
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

test('usage-record records one row per model with the claimed ticket, read back, and a second run counts nothing twice', async () => {
  const f = await fixture();
  try {
    const args = ['usage-record', '--session', SESSION, '--action', '/loop-build', '--transcripts', f.transcripts];
    const dry = await f.door([...args, '--dry-run']);
    assert.equal(dry.code, 0, dry.err);
    assert.deepEqual(f.store.listUsage('alpha'), [], 'a dry run writes nothing');

    const first = await f.door(args);
    assert.equal(first.code, 0, first.err);
    assert.match(first.out, /\/loop-build on AL-3, claude-opus-5-5: 9332 tokens .*read back/);
    const rows = f.store.listUsage('alpha');
    assert.deepEqual(rows.map((r) => [r.action, r.model, r.ticket, r.input, r.output, r.cacheWrite, r.cacheRead, r.session]).sort(), [
      ['/loop-build', 'claude-haiku-5-5', 'AL-3', 50, 5, 0, 0, SESSION],
      ['/loop-build', 'claude-opus-5-5', 'AL-3', 2, 30, 300, 9000, SESSION],
    ]);
    assert.equal(rows[0].at, '2026-11-19T18:00:00.000Z');

    const again = await f.door(args);
    assert.equal(again.code, 0, again.err);
    assert.match(again.out, /already recorded/);
    assert.equal(f.store.listUsage('alpha').length, 2, 'nothing counted twice');
  } finally { await f.cleanup(); }
});

test('usage-record says so and records nothing when the session has no transcript or the arguments are missing', async () => {
  const f = await fixture();
  try {
    const none = await f.door(['usage-record', '--session', '00000000-0000-0000-0000-000000000000', '--action', '/loop-build', '--transcripts', f.transcripts]);
    assert.equal(none.code, 2);
    assert.match(none.err, /no transcript/);
    assert.equal((await f.door(['usage-record', '--session', SESSION, '--transcripts', f.transcripts])).code, 2, 'no --action');
    assert.equal((await f.door(['usage-record', '--session', '../etc', '--action', 'x'])).code, 2, 'not a session id');
    assert.deepEqual(f.store.listUsage('alpha'), []);
  } finally { await f.cleanup(); }
});
