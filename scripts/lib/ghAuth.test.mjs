// The GitHub sign-in check (scripts/lib/gh_auth.sh) against a fake gh, and
// the installer's use of it (SP-181): with gh signed out the installer refuses
// before it writes anything, and --status prints a gh: line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, 'gh_auth.sh');
const INSTALLER = join(HERE, '..', 'install_loop_runner.sh');

// What gh 2.97 prints (to stdout) when signed in, and an older gh's wording.
const SIGNED_IN_NEW = `github.com
  ✓ Logged in to github.com account octo-dane (keyring)
  - Active account: true
  - Git operations protocol: https
`;
const SIGNED_IN_OLD = `github.com
  ✓ Logged in to github.com as octo-dane (/Users/x/.config/gh/hosts.yml)
`;
const SIGNED_OUT = 'You are not logged into any GitHub hosts. To log in, run: gh auth login\n';

// mode: 'new' | 'old' | 'out' | 'none' (no gh on the PATH at all)
function run(fn, mode) {
  const dir = mkdtempSync(join(tmpdir(), 'gh-auth-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  if (mode !== 'none') {
    const out = { new: SIGNED_IN_NEW, old: SIGNED_IN_OLD, out: SIGNED_OUT }[mode];
    writeFileSync(join(dir, 'out'), out);
    writeFileSync(join(bin, 'gh'), `#!/bin/bash
echo "$*" >> "${dir}/calls"
/bin/cat "${dir}/out"
exit ${mode === 'out' ? 1 : 0}
`);
    chmodSync(join(bin, 'gh'), 0o755);
  }
  // LAUNCHD_PATH is the fake folder alone, so a real gh elsewhere (CI has one
  // in /usr/bin) is never found; the shell's own PATH keeps sed and head.
  const r = spawnSync('/bin/bash', ['-c', `set -euo pipefail; source "$1"; ${fn}`, 'x', LIB], {
    encoding: 'utf8',
    env: { LAUNCHD_PATH: bin, PATH: '/usr/bin:/bin', HOME: dir },
  });
  let calls = '';
  try { calls = readFileSync(join(dir, 'calls'), 'utf8'); } catch { /* gh never ran */ }
  return { ...r, calls };
}

test('signed in: the account is named, on new and old gh wording alike', () => {
  for (const mode of ['new', 'old']) {
    const r = run('gh_signed_in_as', mode);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'octo-dane\n');
    assert.match(r.calls, /^auth status --hostname github\.com$/m, 'asks about github.com only');
    assert.equal(run('gh_state', mode).stdout, 'gh:       signed in as octo-dane\n');
  }
});

test('signed out: gh_state says so and names gh auth login', () => {
  const r = run('gh_signed_in_as', 'out');
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  const s = run('gh_state', 'out');
  assert.equal(s.status, 0, '--status never fails on it');
  assert.match(s.stdout, /^gh: {7}NOT signed in .*gh auth login\n$/);
});

test('no gh at all: gh_state says so, and the refusal leaves it to the tool check', () => {
  assert.match(run('gh_state', 'none').stdout, /^gh: {7}NOT FOUND on launchd's PATH/);
  assert.equal(run('gh_require_signed_in', 'none').status, 0);
});

test('the installer refusal: plain words, gh auth login named, nothing installed', () => {
  const r = run('gh_require_signed_in', 'out');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^Refusing to install: the GitHub command-line tool \(gh\) is not signed in/);
  assert.match(r.stderr, /gh auth login/);
  assert.match(r.stderr, /browser login, so it is Dane's/);
  assert.match(r.stderr, /Nothing was installed\.\n$/);
  assert.equal(run('gh_require_signed_in', 'new').status, 0);
});

test('the installer checks gh first, before it writes anything, and shows it in --status', () => {
  assert.equal(spawnSync('bash', ['-n', LIB]).status, 0, 'gh_auth.sh parses');
  const src = readFileSync(INSTALLER, 'utf8');
  assert.match(src, /source "\$REPO\/scripts\/lib\/gh_auth\.sh"/);
  assert.match(src, /\ninstall\(\) \{\n(?: {2}#.*\n)* {2}gh_require_signed_in \|\| exit 1\n/,
    'the first thing install() does');
  assert.match(src, /\nstatus\(\) \{\n(?:.*\n){0,4} {2}gh_state\n/, '--status prints the gh: line');
});
