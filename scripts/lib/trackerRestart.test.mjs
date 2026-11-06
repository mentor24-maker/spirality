// restart_tracker_if_changed (scripts/lib/tracker_restart.sh) against a real
// scratch repository and stand-in launchctl and curl on PATH (SP-150): a pull
// that changes tracker/ restarts the tracker job once; anything else restarts
// nothing; a failed restart says so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { git, scratchGitEnv } = require('../../lib/scratchGit.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, 'tracker_restart.sh');
const PREFIX = 'com.example';

// launchctl records each call; FAKE_KICKSTART_FAILS makes it fail.
const FAKE_LAUNCHCTL = `#!/bin/bash
echo "$*" >> "$FAKE_STATE/launchctl"
[ -n "\${FAKE_KICKSTART_FAILS:-}" ] && { echo "Could not kickstart service" >&2; exit 113; }
exit 0
`;
// curl records the address it was asked; prints 401 (the tracker's answer to
// /me with no token) unless FAKE_DOWN, then 000 like a real curl to nothing.
const FAKE_CURL = `#!/bin/bash
echo "\${@: -1}" >> "$FAKE_STATE/curl"
if [ -n "\${FAKE_DOWN:-}" ]; then printf 000; exit 7; fi
printf 401
`;

// A repository with a first commit touching both folders; returns its path
// and a helper that commits one file and returns the new HEAD.
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-restart-'));
  const repo = join(dir, 'repo');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'launchctl'), FAKE_LAUNCHCTL);
  writeFileSync(join(bin, 'curl'), FAKE_CURL);
  chmodSync(join(bin, 'launchctl'), 0o755);
  chmodSync(join(bin, 'curl'), 0o755);
  writeFileSync(join(dir, 'launchctl'), '');
  writeFileSync(join(dir, 'curl'), '');
  git(dir, 'init', '-q', '-b', 'main', repo);
  mkdirSync(join(repo, 'tracker'));
  mkdirSync(join(repo, 'scripts'));
  writeFileSync(join(repo, 'tracker', 'server.mjs'), 'one\n');
  writeFileSync(join(repo, 'scripts', 'a.sh'), 'one\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'one');
  const commit = (path, text) => {
    writeFileSync(join(repo, path), text);
    git(repo, 'add', path);
    git(repo, 'commit', '-q', '-m', path);
    return git(repo, 'rev-parse', 'HEAD');
  };
  return { dir, repo, bin, commit, head: () => git(repo, 'rev-parse', 'HEAD') };
}

function run(s, oldHead, newHead, { port = '4180', prefix = PREFIX, env = {} } = {}) {
  const r = spawnSync('bash', ['-c', 'source "$1"; restart_tracker_if_changed "$2" "$3" "$4" "$5"', 'x', LIB, oldHead, newHead, prefix, port], {
    cwd: s.repo,
    encoding: 'utf8',
    env: { ...scratchGitEnv(), PATH: `${s.bin}:${process.env.PATH}`, FAKE_STATE: s.dir, TRACKER_RESTART_WAIT: '1', ...env },
  });
  const lines = (f) => readFileSync(join(s.dir, f), 'utf8').split('\n').filter(Boolean);
  return { status: r.status, out: r.stdout.trim(), err: r.stderr, launchctl: lines('launchctl'), curl: lines('curl') };
}

test('a pull that changes a file under tracker/ restarts the tracker job once and says so', () => {
  const s = scratch();
  const old = s.head();
  s.commit('scripts/a.sh', 'two\n');
  const neu = s.commit('tracker/server.mjs', 'two\n');
  const r = run(s, old, neu);
  assert.equal(r.status, 0, r.err);
  const range = `${git(s.repo, 'rev-parse', '--short', old)}..${git(s.repo, 'rev-parse', '--short', neu)}`;
  assert.equal(r.out, `tracker restarted for ${range}`);
  assert.equal(r.launchctl.length, 1);
  assert.match(r.launchctl[0], new RegExp(`^kickstart -k gui/\\d+/${PREFIX}\\.tracker$`));
  assert.equal(r.curl.at(-1), 'http://127.0.0.1:4180/me');
});

test('a pull that changes nothing under tracker/ restarts nothing, silently', () => {
  const s = scratch();
  const old = s.head();
  const neu = s.commit('scripts/a.sh', 'two\n');
  const r = run(s, old, neu);
  assert.equal(r.status, 0);
  assert.equal(r.out, '');
  assert.deepEqual(r.launchctl, []);
});

test('a pull that moved nothing restarts nothing, silently', () => {
  const s = scratch();
  const r = run(s, s.head(), s.head());
  assert.equal(r.status, 0);
  assert.equal(r.out, '');
  assert.deepEqual(r.launchctl, []);
});

test('a project with no trackerPort restarts nothing, even when tracker/ changed', () => {
  const s = scratch();
  const old = s.head();
  const neu = s.commit('tracker/server.mjs', 'two\n');
  const r = run(s, old, neu, { port: '' });
  assert.equal(r.status, 0);
  assert.equal(r.out, '');
  assert.deepEqual(r.launchctl, []);
});

test('a failed kickstart says so, never a success line', () => {
  const s = scratch();
  const old = s.head();
  const neu = s.commit('tracker/server.mjs', 'two\n');
  const r = run(s, old, neu, { env: { FAKE_KICKSTART_FAILS: '1' } });
  assert.equal(r.status, 1);
  assert.match(r.out, /^TRACKER RESTART FAILED for \w+\.\.\w+: launchctl kickstart -k gui\/\d+\/com\.example\.tracker did not succeed/);
  assert.doesNotMatch(r.out, /tracker restarted/);
});

test('a server that does not answer after the restart says so, never a success line', () => {
  const s = scratch();
  const old = s.head();
  const neu = s.commit('tracker/server.mjs', 'two\n');
  const r = run(s, old, neu, { env: { FAKE_DOWN: '1' } });
  assert.equal(r.status, 1);
  assert.match(r.out, /^TRACKER RESTART DID NOT COME BACK for \w+\.\.\w+: nothing answered on port 4180 within 1s/);
  assert.equal(r.launchctl.length, 1);
  assert.ok(r.curl.length >= 2, 'it kept asking until the wait ran out');
});

test('a range git cannot compare is "could not tell", never a silent skip', () => {
  const s = scratch();
  const r = run(s, s.head(), 'f'.repeat(40));
  assert.equal(r.status, 1);
  assert.match(r.out, /^TRACKER NOT RESTARTED: could not tell whether .* touches tracker\//);
  assert.deepEqual(r.launchctl, []);
});

test('the helper names no project: no literal label prefix or port', () => {
  const text = readFileSync(LIB, 'utf8');
  assert.doesNotMatch(text, /com\.spirality/);
  assert.doesNotMatch(text, /4180/);
});

test('both runners read the label and port from the config and run the step right after their pull', () => {
  for (const name of ['loop_runner.sh', 'run_relay.sh']) {
    const text = readFileSync(join(HERE, '..', name), 'utf8');
    assert.match(text, /PREFIX="\$\(node "\$REPO\/scripts\/project_config\.mjs" launchdPrefix\)"/, `${name} reads launchdPrefix`);
    assert.match(text, /TRACKER_PORT="\$\(node "\$REPO\/scripts\/project_config\.mjs" trackerPort\)"/, `${name} reads trackerPort`);
    const source = text.indexOf('source "$REPO/scripts/lib/tracker_restart.sh"');
    const before = text.indexOf('BEFORE="$(git rev-parse HEAD');
    const pull = text.indexOf('git pull -q --ff-only origin main');
    const call = text.indexOf('restart_tracker_if_changed "$BEFORE"');
    assert.ok(source > 0, `${name} sources tracker_restart.sh`);
    assert.ok(source < before && before < pull && pull < call, `${name} notes HEAD, pulls, then runs the step`);
    assert.equal(text.split('restart_tracker_if_changed').length - 1, 1, `${name} runs the step once per pull`);
  }
});
