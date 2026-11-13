import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import scratchGit from '../lib/scratchGit.js';
import { cut } from './release.mjs';

const { git, scratchGitEnv, SCRATCH_IDENTITY } = scratchGit;
const SCRIPT = fileURLToPath(new URL('./release.mjs', import.meta.url));

/**
 * A scratch "GitHub" (a bare repository), a clone that lands work on its
 * main, and a second clone standing in for Spirality's checkout, where
 * `cut` runs against the bare one as its remote.
 */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'release-'));
  const remote = join(dir, 'remote.git');
  const work = join(dir, 'work');
  const checkout = join(dir, 'checkout');
  git(dir, 'init', '--quiet', '--bare', '--initial-branch=main', remote);
  git(dir, 'clone', '--quiet', remote, work);
  const land = (text) => {
    writeFileSync(join(work, 'file.txt'), text);
    git(work, 'add', 'file.txt');
    git(work, 'commit', '--quiet', '-m', text);
    git(work, 'push', '--quiet', 'origin', 'HEAD:main');
    return git(work, 'rev-parse', 'HEAD');
  };
  land('one');
  git(dir, 'clone', '--quiet', remote, checkout);
  const run = (args) => spawnSync('git', [...SCRATCH_IDENTITY, ...args], { cwd: checkout, encoding: 'utf8', env: scratchGitEnv() });
  const tags = () => git(dir, '--git-dir', remote, 'tag', '--list', '--format=%(refname:short) %(objectname)').split('\n').filter(Boolean);
  return { dir, remote, checkout, land, run, tags, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('cut tags the newest main on the remote as release-1, then release-2, each pushed and read back (SP-265)', () => {
  const f = fixture();
  try {
    const first = cut({ git: f.run, remote: f.remote });
    assert.equal(first.code, 0, first.problem);
    assert.match(first.lines[0], /^cut release-1 at [0-9a-f]{12} \(the newest main, the first release\), pushed to .* and read back\.$/);
    const two = f.land('two');
    // The checkout itself is behind: cut reads main from the remote, not from here.
    const second = cut({ git: f.run, remote: f.remote });
    assert.equal(second.code, 0, second.problem);
    assert.match(second.lines[0], /^cut release-2 at .*after release-1/);
    assert.deepEqual(f.tags().find((t) => t.startsWith('release-2 ')), `release-2 ${two}`);
    assert.equal(f.tags().length, 2);
  } finally { f.cleanup(); }
});

test('cut refuses with exit 2, pushing nothing, when main has not moved since the last release (SP-265)', () => {
  const f = fixture();
  try {
    assert.equal(cut({ git: f.run, remote: f.remote }).code, 0);
    const again = cut({ git: f.run, remote: f.remote });
    assert.equal(again.code, 2);
    assert.match(again.problem, /^nothing cut: main has not moved since release-1/);
    assert.equal(f.tags().length, 1);
  } finally { f.cleanup(); }
});

test('cut says which step failed: an unreachable remote, a push the remote refused (SP-265)', () => {
  const f = fixture();
  try {
    const gone = cut({ git: f.run, remote: join(f.dir, 'no-such.git') });
    assert.equal(gone.code, 1);
    assert.match(gone.problem, /^could not read main from /);
    const refusing = (args) => (args[0] === 'push' ? { status: 1, stdout: '', stderr: 'remote: permission denied' } : f.run(args));
    const refused = cut({ git: refusing, remote: f.remote });
    assert.equal(refused.code, 1);
    assert.match(refused.problem, /^release-1 was not pushed to .*permission denied/);
    assert.equal(f.tags().length, 0);
  } finally { f.cleanup(); }
});

test('npm run release with no command, or an unknown one, prints the usage and exits 2 (SP-265)', () => {
  for (const args of [[], ['nope'], ['cut', 'extra']]) {
    const out = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: scratchGitEnv() });
    assert.equal(out.status, 2, args.join(' '));
    assert.match(out.stderr, /npm run release -- cut/);
  }
});
