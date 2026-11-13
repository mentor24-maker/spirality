import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runAppChecks, runCommand, checkEnv, stateFile } from './app_checks.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'app_checks.mjs');
const T0 = Date.parse('2026-11-12T20:00:00Z');

const manifest = (over = {}) => ({
  manifestVersion: 2, workspaceId: '0', spaceId: '0', loopQueueListId: '0', operatorUserId: '1', machineUserId: '2',
  githubRepo: 'owner/example', dopplerProject: 'example', dopplerConfig: 'dev', launchdPrefix: 'com.example',
  logDir: '', mergePhrases: ['merge'], governancePaths: [], autoMergeLanes: [], operatorName: 'Dana',
  projectSlug: 'example', legacyMachinePrefixes: [], projectScripts: {}, busProject: 'example-bus',
  ...over,
});

/** A project folder with a manifest; its log folder is inside it. */
function project(checks) {
  const dir = mkdtempSync(join(tmpdir(), 'appchecks-'));
  const logDir = join(dir, 'logs');
  mkdirSync(logDir);
  writeFileSync(join(dir, 'spirality.project.json'), JSON.stringify(manifest({ logDir, applicationChecks: checks })));
  return { dir, logDir };
}

const config = (checks, logDir = '/tmp/never-written') => ({ ...manifest({ logDir }), applicationChecks: checks.map((c) => ({ alarm: true, timeoutSeconds: 60, ...c })) });
const quiet = () => {};

test('app-checks: Spirality\'s own manifest lists none: one line, nothing posted', () => {
  const out = execFileSync(process.execPath, [SCRIPT], { cwd: join(HERE, '..'), encoding: 'utf8' });
  assert.equal(out, 'app-checks: none listed\n');
});

test('app-checks --dry-run: one failing and one passing check print the one post it would make, and write nothing', () => {
  const { dir, logDir } = project([
    { name: 'imports', command: 'echo "3 imports stalled"; echo "second line never posted"; exit 1', everyMinutes: 10 },
    { name: 'links', command: 'echo fine', everyMinutes: 10 },
  ]);
  const r = spawnSync(process.execPath, [SCRIPT, '--dry-run', '--config', join(dir, 'spirality.project.json')], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const posts = r.stdout.split('\n').filter((l) => l.includes('would post:'));
  assert.deepEqual(posts, ['imports: failing: 3 imports stalled; would post: ALARM: imports: 3 imports stalled']);
  assert.match(r.stdout, /^links: well \(nothing to post\)$/m);
  assert.match(r.stdout, /^app-checks: 2 run, 0 not due yet, 1 failing, nothing posted or saved \(dry run\)\.$/m);
  assert.doesNotMatch(r.stdout + r.stderr, /second line/);
  assert.deepEqual(readdirSync(logDir), [], 'nothing written to the log folder');
});

test('app-checks: a post that lands saves the state; the next pass, still failing, posts nothing', async () => {
  const { logDir } = project([]);
  const cfg = config([{ name: 'imports', command: 'x', everyMinutes: 10 }], logDir);
  const statePath = stateFile(cfg);
  const posts = [];
  const post = async (text) => { posts.push(text); return { ok: true }; };
  const run = async () => ({ code: 1, stdout: 'stalled' });
  const lines = [];
  assert.equal(await runAppChecks({ config: cfg, repoDir: logDir, statePath, now: T0, run, post, log: (l) => lines.push(l), warn: quiet }), 0);
  assert.deepEqual(posts, ['ALARM: imports: stalled']);
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).imports.since, T0);
  assert.match(lines.at(-1), /^app-checks: 1 run, 0 not due yet, 1 failing, 1 posted\.$/);
  // Five minutes on: not due.
  assert.equal(await runAppChecks({ config: cfg, repoDir: logDir, statePath, now: T0 + 5 * 60000, run, post, log: quiet, warn: quiet }), 0);
  // Ten minutes on: due, still failing, nothing posted.
  assert.equal(await runAppChecks({ config: cfg, repoDir: logDir, statePath, now: T0 + 10 * 60000, run, post, log: quiet, warn: quiet }), 0);
  assert.equal(posts.length, 1);
  assert.match(statePath, /\/example-app-checks\.json$/);
});

test('app-checks: a post that does not land leaves that check\'s state untouched and exits 1 naming it, never a success line', async () => {
  const { logDir } = project([]);
  const cfg = config([
    { name: 'imports', command: 'x', everyMinutes: 10 },
    { name: 'links', command: 'y', everyMinutes: 10 },
  ], logDir);
  const statePath = stateFile(cfg);
  const before = { imports: { well: true, ranAt: T0 - 20 * 60000 } };
  writeFileSync(statePath, JSON.stringify(before));
  const run = async (command) => (command === 'x' ? { code: 1, stdout: 'stalled' } : { code: 0 });
  const post = async () => ({ ok: false, why: 'bus-post exited 1: tracker down' });
  const lines = [];
  const warns = [];
  const code = await runAppChecks({ config: cfg, repoDir: logDir, statePath, now: T0, run, post, log: (l) => lines.push(l), warn: (l) => warns.push(l) });
  assert.equal(code, 1);
  const saved = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.deepEqual(saved.imports, before.imports, 'the check whose post did not land keeps its old state');
  assert.equal(saved.links.well, true, 'a check with nothing to post is saved');
  assert.ok(warns.some((w) => /^imports: .*did NOT land \(bus-post exited 1: tracker down\)/.test(w)));
  assert.match(warns.at(-1), /^app-checks: FAILED: .*did NOT land: imports\.$/);
  assert.ok(!lines.some((l) => l.startsWith('app-checks:')), 'no success summary');
});

test('app-checks: a saved state that cannot be read runs nothing and exits 1 naming the file', async () => {
  const { logDir } = project([]);
  const cfg = config([{ name: 'imports', command: 'x', everyMinutes: 10 }], logDir);
  const statePath = stateFile(cfg);
  writeFileSync(statePath, '{ not json');
  let ran = 0;
  const warns = [];
  const code = await runAppChecks({ config: cfg, repoDir: logDir, statePath, now: T0, run: async () => { ran += 1; return { code: 0 }; }, post: async () => ({ ok: true }), log: quiet, warn: (l) => warns.push(l) });
  assert.equal(code, 1);
  assert.equal(ran, 0);
  assert.ok(warns[0].includes(statePath));
});

test('app-checks: a check runs in the project folder, without the tracker sign-in, and is stopped at its time limit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'appchecks-run-'));
  const env = checkEnv({ PATH: process.env.PATH, TRACKER_TOKEN: 'secret-token-1', TRACKER_TOKEN_RELAY: 'secret-token-2', OTHER: 'kept' });
  assert.deepEqual(Object.keys(env).sort(), ['OTHER', 'PATH']);
  const where = await runCommand('pwd; echo "${TRACKER_TOKEN:-none}"; echo "$OTHER"', { cwd: dir, env, timeoutSeconds: 10 });
  assert.equal(where.code, 0);
  const [pwd, token, other] = where.stdout.trim().split('\n');
  assert.ok(pwd.endsWith(dir.split('/').pop()));
  assert.equal(token, 'none');
  assert.equal(other, 'kept');
  const started = Date.now();
  const slow = await runCommand('sleep 30', { cwd: dir, env, timeoutSeconds: 1 });
  assert.equal(slow.timedOut, true);
  assert.ok(Date.now() - started < 10000, 'stopped well before it would have finished');
});

test('app-checks: the runner names no project, machine or list of its own', () => {
  const src = readFileSync(SCRIPT, 'utf8');
  assert.doesNotMatch(src, /mac-mini|starcaster|wavecenter|spirality-bus|\b9014\d{8}\b/i);
  assert.ok(!existsSync(join(HERE, '..', 'logs')));
});
