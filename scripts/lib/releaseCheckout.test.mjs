/**
 * releaseCheckout.mjs (SP-276): the checkout of the Spirality release a
 * project's pass runs from, against real scratch git repositories (a
 * "Spirality" with release tags on a bare origin). The door and `npm ci` are
 * stand-ins, so nothing here reaches a tracker or the network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import scratchGit from '../../lib/scratchGit.js';
import {
  EXIT, DOOR_ENV, RELEASES_DIR_ENV, fallbackPost, finish, namedFor, prepare, readRecord, spiralitySettings, statusLine,
} from './releaseCheckout.mjs';

scratchGit.forgetOuterRepository();
const MODULE = fileURLToPath(new URL('./releaseCheckout.mjs', import.meta.url));
const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/**
 * A scratch Spirality: a main checkout with its manifest (logDir in the
 * scratch folder), an empty package.json and lockfile (so a real `npm ci`
 * runs offline), and a bare origin holding tags release-1..3 on three
 * commits.
 */
function scratchSpirality() {
  const root = mkdtempSync(join(tmpdir(), 'release-checkout-'));
  const dir = join(root, 'spirality');
  const logDir = join(root, 'logs');
  mkdirSync(dir);
  const git = (cwd, ...args) => scratchGit.git(cwd, ...args);
  git(dir, 'init', '-q', '-b', 'main');
  const manifest = JSON.parse(readFileSync(join(REPO, 'spirality.project.json'), 'utf8'));
  writeFileSync(join(dir, 'spirality.project.json'), JSON.stringify({ ...manifest, logDir }));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'scratch-spirality', version: '1.0.0', private: true }));
  writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ name: 'scratch-spirality', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'scratch-spirality', version: '1.0.0' } } }));
  writeFileSync(join(dir, '.gitignore'), 'node_modules\n');
  const commits = {};
  for (const n of [1, 2, 3]) {
    writeFileSync(join(dir, 'which.txt'), `release ${n}\n`);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', `work for release ${n}`);
    git(dir, 'tag', `release-${n}`);
    commits[`release-${n}`] = git(dir, 'rev-parse', 'HEAD').trim();
  }
  const origin = `${dir}.git`;
  git(root, 'clone', '-q', '--bare', dir, origin);
  git(dir, 'remote', 'add', 'origin', origin);
  // The main checkout keeps no local tags: they come from origin, as on the Mini.
  for (const n of [1, 2, 3]) git(dir, 'tag', '-d', `release-${n}`);
  const dirs = spiralitySettings(dir, {});
  return { root, dir, logDir, origin, commits, dirs };
}

/**
 * Stand-ins for the door and npm ci. `record` is what `release list` prints
 * per project; `door.posts` collects bus posts. Set `door.down` to make the
 * release list fail, `door.busDown` to make posts fail, `ci.fail` to fail npm ci.
 */
function standIns(s, record = {}) {
  const door = (args, { input } = {}) => {
    if (args[0] === 'release' && args[1] === 'list') {
      if (door.down) return { status: 1, stdout: '', stderr: 'tracker: the tracker did not answer\n' };
      return { status: 0, stdout: Object.entries(door.record).map(([k, v]) => `${k}\t${v}\n`).join(''), stderr: '' };
    }
    if (args[0] === 'bus-post') {
      if (door.busDown) return { status: 1, stdout: '', stderr: 'bus-post: the bus did not answer\n' };
      door.posts.push(input);
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 2, stdout: '', stderr: `stand-in door: no ${args.join(' ')}` };
  };
  door.record = { spirality: 'main (always the newest)', ...record };
  door.posts = [];
  const ci = (dir) => (ci.fail ? { status: 1, stdout: '', stderr: 'npm ERR! the lockfile is broken\n' } : (ci.ran.push(dir), { status: 0, stdout: '', stderr: '' }));
  ci.ran = [];
  const git = (args, cwd = s.dir) => spawnSync('git', args, { cwd, encoding: 'utf8', env: scratchGit.scratchGitEnv() });
  return { door, npmCi: ci, git, remote: 'origin' };
}

const head = (dir) => scratchGit.git(dir, 'rev-parse', 'HEAD').trim();

test('a named release is checked out once, at its tag, in <logDir>/releases/release-<n>, and the pass runs from there', () => {
  const s = scratchSpirality();
  try {
    const deps = standIns(s, { normie: 'release-2' });
    const first = prepare({ dirs: s.dirs, slug: 'normie', pid: process.pid, deps });
    assert.equal(first.code, EXIT.READY, first.lines.join('\n'));
    assert.equal(first.dir, join(s.logDir, 'releases', 'release-2'));
    assert.equal(head(first.dir), s.commits['release-2']);
    assert.equal(readFileSync(join(first.dir, 'which.txt'), 'utf8'), 'release 2\n');
    assert.match(first.lines[0], /^this pass runs on release-2 \(.*release-2\), checked out and npm ci run just now$/);
    assert.deepEqual(deps.npmCi.ran, [first.dir]);
    // Detached at the tag: the main checkout's own branch is untouched.
    assert.equal(scratchGit.git(first.dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'HEAD');
    assert.equal(scratchGit.git(s.dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main');
    assert.equal(head(s.dir), s.commits['release-3']);
    // The next pass on the same release reuses it: no second npm ci.
    const again = prepare({ dirs: s.dirs, slug: 'normie', pid: process.pid, deps });
    assert.equal(again.code, EXIT.READY);
    assert.equal(again.lines[0], `this pass runs on release-2 (${first.dir})`);
    assert.equal(deps.npmCi.ran.length, 1);
    assert.equal(deps.door.posts.length, 0);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('naming another release changes the next pass: the record is read at every start', () => {
  const s = scratchSpirality();
  try {
    const deps = standIns(s, { normie: 'release-1' });
    assert.equal(prepare({ dirs: s.dirs, slug: 'normie', pid: process.pid, deps }).dir, join(s.dirs.releasesDir, 'release-1'));
    deps.door.record.normie = 'release-3';
    const moved = prepare({ dirs: s.dirs, slug: 'normie', pid: process.pid, deps });
    assert.equal(moved.dir, join(s.dirs.releasesDir, 'release-3'));
    assert.equal(head(moved.dir), s.commits['release-3']);
    // The pass already running on release-1 keeps its folder until a finish finds nothing needs it.
    assert.ok(existsSync(join(s.dirs.releasesDir, 'release-1')));
    // A roll-back is the same: the older name again.
    deps.door.record.normie = 'release-1';
    assert.equal(prepare({ dirs: s.dirs, slug: 'normie', pid: process.pid, deps }).dir, join(s.dirs.releasesDir, 'release-1'));
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('a missing tag falls back to the release the project ran last, says why, and tells the bus once', () => {
  const s = scratchSpirality();
  try {
    const deps = standIns(s, { normie: 'release-1' });
    assert.equal(prepare({ dirs: s.dirs, slug: 'normie', pid: process.pid, deps }).code, EXIT.READY);
    deps.door.record.normie = 'release-9';
    const out = prepare({ dirs: s.dirs, slug: 'normie', pid: process.pid, deps });
    assert.equal(out.code, EXIT.FELL_BACK, out.lines.join('\n'));
    assert.equal(out.dir, join(s.dirs.releasesDir, 'release-1'));
    assert.match(out.lines[0], /^could not run on release-9: the tag release-9 could not be fetched from origin \(it is missing, or the fetch failed\): .* — this pass runs on release-1 \(.*\), the release normie ran last; said on the bus$/);
    assert.equal(deps.door.posts.length, 1);
    assert.match(deps.door.posts[0], /^WARNING: normie's lanes could not run on release-9, the Spirality release named for it: the tag release-9 could not be fetched/);
    assert.match(deps.door.posts[0], /They run on release-1, the release they ran last, until it is fixed\.$/);
    assert.ok(!existsSync(join(s.dirs.releasesDir, 'release-9')), 'a half-made checkout was left behind');
    // The next pass says it in the log again, but not on the bus.
    const next = prepare({ dirs: s.dirs, slug: 'normie', pid: process.pid, deps });
    assert.equal(next.code, EXIT.FELL_BACK);
    assert.match(next.lines[0], /; the bus was told already$/);
    assert.equal(deps.door.posts.length, 1);
    // Fixed (named back to a good one), then broken again: said again.
    deps.door.record.normie = 'release-2';
    assert.equal(prepare({ dirs: s.dirs, slug: 'normie', pid: process.pid, deps }).code, EXIT.READY);
    deps.door.record.normie = 'release-9';
    prepare({ dirs: s.dirs, slug: 'normie', pid: process.pid, deps });
    assert.equal(deps.door.posts.length, 2);
    assert.match(deps.door.posts[1], /They run on release-2/);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('npm ci failing leaves no checkout and falls back; with no release run before, the pass does not run and the bus hears an ALARM', () => {
  const s = scratchSpirality();
  try {
    const deps = standIns(s, { normie: 'release-2' });
    deps.npmCi.fail = true;
    const out = prepare({ dirs: s.dirs, slug: 'normie', pid: process.pid, deps });
    assert.equal(out.code, EXIT.CANNOT_RUN, out.lines.join('\n'));
    assert.equal(out.dir, '');
    assert.match(out.lines[0], /^could not run on release-2: npm ci failed in the release-2 checkout: npm ERR! the lockfile is broken — and normie has no earlier release checked out to fall back on, so this pass does not run; said on the bus$/);
    assert.ok(!existsSync(join(s.dirs.releasesDir, 'release-2')));
    assert.equal(scratchGit.git(s.dir, 'worktree', 'list').trim().split('\n').length, 1, 'git still lists the removed checkout');
    assert.match(deps.door.posts[0], /^ALARM: normie's lanes could not run on release-2.*not running until it is fixed\.$/);
    // npm ci fixed: the next pass makes it whole.
    deps.npmCi.fail = false;
    assert.equal(prepare({ dirs: s.dirs, slug: 'normie', pid: process.pid, deps }).code, EXIT.READY);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('a record that cannot be read falls back to the last release; a bus that cannot be told is said, and tried again next pass', () => {
  const s = scratchSpirality();
  try {
    const deps = standIns(s, { normie: 'release-1' });
    prepare({ dirs: s.dirs, slug: 'normie', pid: process.pid, deps });
    deps.door.down = true;
    deps.door.busDown = true;
    const out = prepare({ dirs: s.dirs, slug: 'normie', pid: process.pid, deps });
    assert.equal(out.code, EXIT.FELL_BACK);
    assert.match(out.lines[0], /^could not run on the named release: the door's release list failed: tracker: the tracker did not answer — this pass runs on release-1 .*; the bus post FAILED \(bus-post: the bus did not answer\), so the next pass tries again$/);
    deps.door.busDown = false;
    prepare({ dirs: s.dirs, slug: 'normie', pid: process.pid, deps });
    assert.equal(deps.door.posts.length, 1);
    assert.match(deps.door.posts[0], /could not run on its Spirality release \(the record could not be read\)/);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('no release named: the pass does not run, in one line; Spirality\'s own project is refused', () => {
  const s = scratchSpirality();
  try {
    const deps = standIns(s, { normie: 'none named' });
    const out = prepare({ dirs: s.dirs, slug: 'normie', pid: process.pid, deps });
    assert.equal(out.code, EXIT.NONE_NAMED);
    assert.equal(out.dir, '');
    assert.deepEqual(out.lines, ['normie has no Spirality release named (npm run clickup -- release name --project normie --to release-<n>), so this pass does not run from Spirality']);
    assert.equal(deps.door.posts.length, 0);
    assert.equal(prepare({ dirs: s.dirs, slug: 'spirality', pid: process.pid, deps }).code, EXIT.USAGE);
    // A project the record does not know is a failed read, never "none named".
    assert.match(namedFor(readRecord(deps.door), 'ghost').problem, /no project ghost/);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('a dry run checks nothing out and tells the bus nothing', () => {
  const s = scratchSpirality();
  try {
    const deps = standIns(s, { normie: 'release-2' });
    const out = prepare({ dirs: s.dirs, slug: 'normie', pid: process.pid, deps, dryRun: true });
    assert.equal(out.code, EXIT.CANNOT_RUN);
    assert.ok(!existsSync(join(s.dirs.releasesDir, 'release-2')));
    assert.equal(deps.door.posts.length, 0);
    assert.match(out.lines[0], /a dry run tells the bus nothing$/);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('finish removes a checkout nothing needs, and keeps the named, the newest, a project\'s last and one a live pass is on', async () => {
  const s = scratchSpirality();
  try {
    const deps = standIns(s, { normie: 'release-1', pressplay: 'release-2' });
    prepare({ dirs: s.dirs, slug: 'normie', pid: process.pid, deps });
    prepare({ dirs: s.dirs, slug: 'pressplay', pid: process.pid, deps });
    // Every one in use or named: nothing goes.
    assert.deepEqual(finish({ dirs: s.dirs, pid: process.pid, deps }), []);
    // normie moves on to release-3 (the newest); release-1 is its last until
    // its next pass, so it stays.
    deps.door.record.normie = 'release-3';
    assert.deepEqual(finish({ dirs: s.dirs, pid: process.pid, deps }), []);
    // A live pass (this test's parent) still on release-1 keeps it after normie's next pass.
    const other = spawn('sleep', ['30']);
    const gone = new Promise((r) => other.on('exit', r));
    try {
      prepare({ dirs: s.dirs, slug: 'normie', pid: process.pid, deps });
      mkdirSync(join(s.dirs.releasesDir, 'in-use'), { recursive: true });
      writeFileSync(join(s.dirs.releasesDir, 'in-use', String(other.pid)), 'release-1\n');
      assert.deepEqual(finish({ dirs: s.dirs, pid: process.pid, deps }), []);
      assert.ok(existsSync(join(s.dirs.releasesDir, 'release-1')));
    } finally {
      other.kill('SIGKILL');
    }
    await gone;
    // That pass gone: release-1 is not named, not the newest, nobody's last.
    const lines = finish({ dirs: s.dirs, pid: process.pid, deps });
    assert.deepEqual(lines, ['release checkout release-1 removed: no project names it or ran it last, no pass is on it, and it is not the newest']);
    assert.ok(!existsSync(join(s.dirs.releasesDir, 'release-1')));
    assert.ok(existsSync(join(s.dirs.releasesDir, 'release-2')), 'pressplay\'s named release went');
    assert.ok(existsSync(join(s.dirs.releasesDir, 'release-3')), 'normie\'s named release went');
    assert.ok(!existsSync(join(s.dirs.releasesDir, 'in-use', String(other.pid))), 'the dead pass\'s mark was kept');
    assert.equal(scratchGit.git(s.dir, 'worktree', 'list').trim().split('\n').length, 3);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('finish removes nothing when the record or the tags cannot be read', () => {
  const s = scratchSpirality();
  try {
    const deps = standIns(s, { normie: 'release-1' });
    prepare({ dirs: s.dirs, slug: 'normie', pid: process.pid, deps });
    deps.door.record.normie = 'release-2';
    rmSync(join(s.dirs.releasesDir, 'last-normie'));
    deps.door.down = true;
    assert.match(finish({ dirs: s.dirs, pid: process.pid, deps })[0], /^release checkouts not tidied: the door's release list failed/);
    deps.door.down = false;
    rmSync(s.origin, { recursive: true, force: true });
    assert.match(finish({ dirs: s.dirs, pid: process.pid, deps })[0], /^release checkouts not tidied: the newest release could not be read/);
    assert.ok(existsSync(join(s.dirs.releasesDir, 'release-1')));
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('the status line names the release, where it is checked out, and what the last pass ran on', () => {
  const s = scratchSpirality();
  try {
    const deps = standIns(s, { normie: 'release-2', pressplay: 'none named' });
    assert.match(statusLine({ dirs: s.dirs, slug: 'normie', deps }), /^release: {2}release-2, not checked out yet \(its next pass does that\); no pass has run on a release yet$/);
    prepare({ dirs: s.dirs, slug: 'normie', pid: process.pid, deps });
    assert.equal(statusLine({ dirs: s.dirs, slug: 'normie', deps }), `release:  release-2, checked out in ${join(s.dirs.releasesDir, 'release-2')}; its last pass ran on release-2`);
    assert.match(statusLine({ dirs: s.dirs, slug: 'pressplay', deps }), /^release: {2}none named — its lanes do not run until one is/);
    assert.equal(statusLine({ dirs: s.dirs, slug: 'spirality', deps }), "release:  main (Spirality's own lanes always run main)");
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('the command line, end to end with a real npm ci: the folder on line one, the log lines after, and the exit code', () => {
  const s = scratchSpirality();
  try {
    const door = join(s.root, 'door');
    writeFileSync(door, '#!/bin/bash\n[ "$1 $2" = "release list" ] && printf "spirality\\tmain (always the newest)\\nnormie\\trelease-3\\n"\n', { mode: 0o755 });
    const env = { ...scratchGit.scratchGitEnv(), [DOOR_ENV]: door, [RELEASES_DIR_ENV]: '' };
    const run = (...args) => spawnSync('node', [MODULE, ...args, '--root', s.dir], { encoding: 'utf8', env, timeout: 120_000 });
    const r = run('prepare', '--project', 'normie', '--pid', String(process.pid));
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const [dir, line] = r.stdout.split('\n');
    assert.equal(dir, join(s.logDir, 'releases', 'release-3'));
    assert.match(line, /^this pass runs on release-3 /);
    assert.ok(existsSync(join(dir, 'node_modules')) || existsSync(join(dir, 'package-lock.json')));
    const st = run('status', '--project', 'normie');
    assert.equal(st.status, 0, st.stderr);
    assert.match(st.stdout, /^release: {2}release-3, checked out in /);
    assert.match(st.stdout, new RegExp(`\\nreleases: ${join(s.logDir, 'releases')}: release-3\\n$`));
    assert.equal(run('finish', '--pid', String(process.pid)).status, 0);
    assert.equal(run('prepare', '--project', 'normie').status, EXIT.USAGE);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('the bus post for a fallback is one line', () => {
  for (const last of ['release-1', '']) {
    const text = fallbackPost({ slug: 'normie', named: 'release-2', why: 'npm ci failed', last });
    assert.doesNotMatch(text, /\n/);
  }
});
