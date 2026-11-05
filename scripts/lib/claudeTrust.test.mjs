// scripts/lib/claudeTrust.mjs against scratch copies of Claude's settings
// file, never the real ~/.claude.json (SP-116).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withTrust, isTrusted, ensureTrusted, checkTrusted, folderKey } from './claudeTrust.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function scratch(settings) {
  const dir = mkdtempSync(join(tmpdir(), 'claude-trust-'));
  const folder = join(dir, 'WebApps', 'pressplay');
  mkdirSync(folder, { recursive: true });
  const file = join(dir, '.claude.json');
  if (settings !== undefined) writeFileSync(file, typeof settings === 'string' ? settings : `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  return { dir, folder: folderKey(folder), file };
}

test('withTrust adds the one key and keeps everything else', () => {
  const settings = { numStartups: 4, projects: { '/a': { allowedTools: [], hasTrustDialogAccepted: true }, '/b': { mcpServers: { x: 1 } } } };
  const { changed, next } = withTrust(settings, '/b');
  assert.equal(changed, true);
  assert.deepEqual(next, { numStartups: 4, projects: { '/a': { allowedTools: [], hasTrustDialogAccepted: true }, '/b': { mcpServers: { x: 1 }, hasTrustDialogAccepted: true } } });
  assert.deepEqual(settings.projects['/b'], { mcpServers: { x: 1 } }, 'the input is not changed');
  assert.equal(withTrust(next, '/b').changed, false);
  assert.deepEqual(withTrust({}, '/c').next, { projects: { '/c': { hasTrustDialogAccepted: true } } });
  assert.throws(() => withTrust([], '/c'), /one JSON object/);
  assert.equal(isTrusted({ projects: { '/c': { hasTrustDialogAccepted: 'yes' } } }, '/c'), false, 'only true is trusted');
});

test('no entry yet: the folder is trusted, read back, and the old copy kept', () => {
  const { folder, file } = scratch({ numStartups: 1, projects: { '/other': { hasTrustDialogAccepted: false, x: 2 } } });
  const before = readFileSync(file, 'utf8');
  const r = ensureTrusted(folder, { file });
  assert.equal(r.ok, true, r.why);
  assert.equal(r.changed, true);
  assert.match(r.why, /now trusted \(read back/);
  const after = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(after, { numStartups: 1, projects: { '/other': { hasTrustDialogAccepted: false, x: 2 }, [folder]: { hasTrustDialogAccepted: true } } });
  assert.equal(readFileSync(`${file}.spirality-backup`, 'utf8'), before);
  assert.equal(statSync(file).mode & 0o777, 0o600, 'the file stays private to its owner');
  assert.deepEqual(readdirSync(dirname(file)).filter((n) => n.endsWith('.tmp')), [], 'no temporary file is left behind');
});

test('an entry with other keys keeps them all', () => {
  const { folder, file } = scratch({});
  writeFileSync(file, `${JSON.stringify({ projects: { [folder]: { allowedTools: ['Bash'], lastVersionBase: '2.1' } } }, null, 2)}\n`);
  assert.equal(ensureTrusted(folder, { file }).ok, true);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).projects[folder], { allowedTools: ['Bash'], lastVersionBase: '2.1', hasTrustDialogAccepted: true });
});

test('already trusted: nothing is written at all', () => {
  const { folder, file } = scratch({});
  writeFileSync(file, `${JSON.stringify({ projects: { [folder]: { hasTrustDialogAccepted: true } } })}\n`);
  const old = new Date('2026-01-01T00:00:00Z');
  utimesSync(file, old, old);
  const r = ensureTrusted(folder, { file });
  assert.deepEqual([r.ok, r.changed], [true, false]);
  assert.equal(statSync(file).mtimeMs, old.getTime(), 'the file was not touched');
  assert.equal(existsSync(`${file}.spirality-backup`), false);
});

test('a file that does not parse, or is missing, is never written: FAILED', () => {
  const broken = scratch('{ "projects": ');
  const r = ensureTrusted(broken.folder, { file: broken.file });
  assert.equal(r.ok, false);
  assert.match(r.why, /could not be read as JSON.*nothing was written/);
  assert.equal(readFileSync(broken.file, 'utf8'), '{ "projects": ');
  const missing = scratch(undefined);
  const m = ensureTrusted(missing.folder, { file: missing.file });
  assert.equal(m.ok, false);
  assert.match(m.why, /ENOENT.*nothing was written/);
  assert.equal(existsSync(missing.file), false, 'no file is created');
});

test('a session writing the file mid-way: read again, and its write is kept', () => {
  const { folder, file } = scratch({ projects: {}, numStartups: 1 });
  let writes = 0;
  const session = (f) => {
    if (writes++ > 0) return;
    const later = new Date(Date.now() + 5000);
    writeFileSync(f, `${JSON.stringify({ projects: {}, numStartups: 2 }, null, 2)}\n`);
    utimesSync(f, later, later);
  };
  const r = ensureTrusted(folder, { file, beforeMove: session });
  assert.equal(r.ok, true, r.why);
  const after = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(after.numStartups, 2, 'the session\'s write was not lost');
  assert.equal(after.projects[folder].hasTrustDialogAccepted, true);
  assert.deepEqual(readdirSync(dirname(file)).filter((n) => n.endsWith('.tmp')), [], 'the abandoned temporary file was removed');
});

test('a file that keeps changing under the write is a FAILED, never a lost write', () => {
  const { folder, file } = scratch({ projects: {} });
  let tick = Date.now();
  const session = (f) => {
    tick += 5000;
    writeFileSync(f, `${JSON.stringify({ projects: {}, by: 'session' })}\n`);
    utimesSync(f, new Date(tick), new Date(tick));
  };
  const r = ensureTrusted(folder, { file, beforeMove: session });
  assert.equal(r.ok, false);
  assert.match(r.why, /kept changing under the write \(3 tries\)/);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { projects: {}, by: 'session' });
});

test('check is read only and says yes, NO or could not tell', () => {
  const { folder, file } = scratch({ projects: {} });
  assert.equal(checkTrusted(folder, { file }).trusted, false);
  assert.match(checkTrusted(folder, { file }).why, /not trusted.*install_loop_runner\.sh/);
  ensureTrusted(folder, { file });
  assert.equal(checkTrusted(folder, { file }).trusted, true);
  assert.equal(checkTrusted(folder, { file: join(dirname(file), 'none.json') }).trusted, null);
});

test('the command line: ensure and check against a scratch HOME', () => {
  const { dir, folder, file } = scratch({ projects: {} });
  const cli = (...a) => spawnSync(process.execPath, [join(HERE, 'claudeTrust.mjs'), ...a], { encoding: 'utf8', env: { ...process.env, HOME: dir } });
  const before = cli('check', folder);
  assert.equal(before.status, 3);
  assert.match(before.stdout, /^trust: {4}NO — /);
  const ensured = cli('ensure', folder);
  assert.equal(ensured.status, 0, ensured.stderr);
  assert.match(ensured.stdout, /now trusted/);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).projects[folder].hasTrustDialogAccepted, true);
  assert.match(cli('check', folder).stdout, /^trust: {4}yes — /);
  writeFileSync(file, 'not json');
  const failed = cli('ensure', folder);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /^FAILED: trust: /);
  assert.equal(cli('nope').status, 2);
});

test('the installer trusts the checkout before any lane, and --status shows it', () => {
  const text = readFileSync(join(HERE, '..', 'install_loop_runner.sh'), 'utf8');
  const install = text.slice(text.indexOf('install() {'));
  const ensure = install.indexOf('claudeTrust.mjs" ensure "$REPO"');
  const firstLane = install.indexOf('for s in "${SKILLS[@]}"; do');
  assert.ok(ensure > 0 && ensure < firstLane, 'ensure runs before the first lane is loaded');
  assert.match(install, /if \[ -n "\$trust_failed" \]; then[\s\S]*?FAILED:[\s\S]*?exit 1/);
  const status = text.slice(text.indexOf('status() {'), text.indexOf('install_tracker() {'));
  assert.match(status, /claudeTrust\.mjs" check "\$REPO" \|\| true/);
});
