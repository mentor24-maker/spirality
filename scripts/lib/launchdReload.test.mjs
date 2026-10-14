// reload_job (scripts/lib/launchd_reload.sh) against a fake launchctl that
// behaves like the real one did on the Mac Mini on 10/14: after `bootout` the
// old job stays listed for a while, and a `bootstrap` in that window fails
// with "Bootstrap failed: 5: Input/output error".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, 'launchd_reload.sh');
const INSTALLER = join(HERE, '..', 'install_loop_runner.sh');
const LABEL = 'com.example.loop-build';

// State lives in files: `listed` means launchd lists the job; `leaving` holds
// how many more `list` calls still show it after a bootout ("never" = stuck).
const FAKE_LAUNCHCTL = `#!/bin/bash
S="$FAKE_STATE"
echo "$*" >> "$S/calls"
case "$1" in
  list)
    printf 'PID\\tStatus\\tLabel\\n'
    if [ -f "$S/leaving" ]; then
      n="$(cat "$S/leaving")"
      if [ "$n" = never ] || [ "$n" -gt 0 ]; then
        [ "$n" != never ] && echo $((n - 1)) > "$S/leaving"
        printf '123\\t0\\t%s\\n' "$FAKE_LABEL"
        exit 0
      fi
      rm -f "$S/leaving" "$S/listed"
    fi
    [ -f "$S/listed" ] && printf '123\\t0\\t%s\\n' "$FAKE_LABEL"
    exit 0 ;;
  bootout)
    [ -f "$S/listed" ] && echo "\${FAKE_LINGER:-0}" > "$S/leaving"
    exit 0 ;;
  bootstrap)
    if [ -f "$S/leaving" ] || [ -n "\${FAKE_BOOTSTRAP_FAILS:-}" ]; then
      echo "Bootstrap failed: 5: Input/output error" >&2
      exit 5
    fi
    [ -z "\${FAKE_BOOTSTRAP_SILENT:-}" ] && touch "$S/listed"
    exit 0 ;;
esac
`;

function run({ loadedBefore = true, env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'launchd-reload-'));
  const bin = join(dir, 'bin');
  spawnSync('mkdir', ['-p', bin]);
  writeFileSync(join(bin, 'launchctl'), FAKE_LAUNCHCTL);
  chmodSync(join(bin, 'launchctl'), 0o755);
  writeFileSync(join(dir, 'calls'), '');
  if (loadedBefore) writeFileSync(join(dir, 'listed'), '');
  const r = spawnSync('bash', ['-c', 'set -euo pipefail; source "$1"; reload_job "$2" "$3"', 'x', LIB, LABEL, join(dir, 'job.plist')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_STATE: dir,
      FAKE_LABEL: LABEL,
      LAUNCHD_WAIT_SECONDS: '3',
      ...env,
    },
  });
  const calls = readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').map((l) => l.split(' ')[0]);
  return { status: r.status, stderr: r.stderr, calls, listed: existsSync(join(dir, 'listed')) };
}

test('an old job that lingers after bootout is waited out, then the new one loads', () => {
  const r = run({ env: { FAKE_LINGER: '2' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.ok(r.listed, 'the job is loaded at the end');
  const boot = r.calls.indexOf('bootstrap');
  assert.ok(boot > r.calls.lastIndexOf('bootout'), 'bootstrap comes after bootout');
  assert.equal(r.calls.filter((c) => c === 'bootstrap').length, 1, 'no failed bootstrap on the way');
  assert.equal(r.calls.at(-1), 'list', 'the load is read back');
});

test('a job that was not loaded before simply loads', () => {
  const r = run({ loadedBefore: false });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.listed);
});

test('an old job that never leaves: not loaded, named, non-zero, and no bootstrap attempted', () => {
  const r = run({ env: { FAKE_LINGER: 'never', LAUNCHD_WAIT_SECONDS: '2' } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(`NOT LOADED: ${LABEL.replace(/\./g, '\\.')} — the old job was still listed`));
  assert.ok(!r.calls.includes('bootstrap'));
});

test('a bootstrap that keeps failing: not loaded, named, carries the error, non-zero', () => {
  const r = run({ loadedBefore: false, env: { FAKE_BOOTSTRAP_FAILS: '1', LAUNCHD_WAIT_SECONDS: '2' } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /NOT LOADED: com\.example\.loop-build — launchctl bootstrap kept failing/);
  assert.match(r.stderr, /Bootstrap failed: 5: Input\/output error/);
  assert.ok(r.calls.filter((c) => c === 'bootstrap').length > 1, 'it retried before giving up');
});

test('a bootstrap that "succeeds" but leaves nothing listed is not reported as loaded', () => {
  const r = run({ loadedBefore: false, env: { FAKE_BOOTSTRAP_SILENT: '1' } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /NOT LOADED: com\.example\.loop-build — launchctl bootstrap reported success, but launchctl list does not show the job/);
});

test('the installer parses, loads every job through reload_job, and fails the run when one is not loaded', () => {
  assert.equal(spawnSync('bash', ['-n', INSTALLER]).status, 0, 'install_loop_runner.sh parses');
  assert.equal(spawnSync('bash', ['-n', LIB]).status, 0, 'launchd_reload.sh parses');
  const src = readFileSync(INSTALLER, 'utf8');
  assert.match(src, /source "\$REPO\/scripts\/lib\/launchd_reload\.sh"/);
  assert.doesNotMatch(src, /launchctl bootstrap/, 'every load goes through reload_job');
  assert.equal((src.match(/if reload_job /g) || []).length, 2, 'the skill lanes and the relay');
  assert.match(src, /not_loaded\+=\("\$local_label"\)/);
  assert.match(src, /exit 1\n {2}fi\n\}/, 'a job not loaded fails the whole run');
});
