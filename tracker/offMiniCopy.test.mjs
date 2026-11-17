import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  AGENTS_FOLDER, copyOffMini, defaultRun, launchAgentSecrets, offMiniRepoOf, pushLaunchAgents,
  releaseTagOf, releasesToPrune, uploadDatabase,
} from './offMiniCopy.mjs';
import { offMiniPlan } from './backup.mjs';
import { openStore } from './store.mjs';

const BACKUP_SCRIPT = new URL('./backup.mjs', import.meta.url).pathname;
const REPO = 'owner/proj-machine-backup';

const plist = (label, env = '') => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/bin:/bin</string>${env}
    </dict>
</dict>
</plist>
`;

/**
 * A stand-in GitHub: a local bare repository for the git side (real git does
 * the work), and an in-memory list of releases for `gh release`. Every call
 * is recorded, so a test can say what was and was not done.
 */
function fakeGitHub() {
  const dir = mkdtempSync(join(tmpdir(), 'off-mini-test-'));
  const bare = join(dir, 'remote.git');
  spawnSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', bare]);
  const releases = new Map(); // tag -> [{ name, size }]
  const calls = [];
  const fail = new Set();
  let sizeLie = null;
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
  const run = (cmd, args, opts = {}) => {
    calls.push([cmd, ...args]);
    const key = `${cmd} ${args[0]} ${args[1] ?? ''}`.trim();
    if ([...fail].some((f) => key.startsWith(f))) return { status: 1, stdout: '', stderr: `${key} refused (test)` };
    if (cmd === 'gh' && args[0] === 'repo' && args[1] === 'clone') {
      assert.equal(args[2], REPO);
      return defaultRun('git', ['clone', '--quiet', bare, args[3]]);
    }
    if (cmd === 'gh' && args[0] === 'release') {
      const [, verb, tagOrFile, ...rest] = args;
      if (verb === 'view') {
        if (!releases.has(tagOrFile)) return { status: 1, stdout: '', stderr: 'release not found' };
        const assets = releases.get(tagOrFile).map((a) => ({ ...a, size: sizeLie ?? a.size }));
        return ok(JSON.stringify({ assets }));
      }
      if (verb === 'create' || verb === 'upload') {
        if (verb === 'create' && releases.has(tagOrFile)) return { status: 1, stdout: '', stderr: 'already exists' };
        const file = rest[0];
        const asset = { name: file.split('/').pop(), size: statSync(file).size, bytes: readFileSync(file) };
        const list = (releases.get(tagOrFile) ?? []).filter((a) => a.name !== asset.name);
        releases.set(tagOrFile, [...list, asset]);
        return ok();
      }
      if (verb === 'list') return ok(JSON.stringify([...releases.keys()].map((tagName) => ({ tagName }))));
      if (verb === 'delete') { releases.delete(tagOrFile); return ok(); }
    }
    if (cmd === 'git') return defaultRun(cmd, args, opts);
    throw new Error(`unexpected call ${cmd} ${args.join(' ')}`);
  };
  const remoteFiles = (ref = 'main') => {
    const r = spawnSync('git', ['--git-dir', bare, 'ls-tree', '-r', '--name-only', ref], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim().split('\n').filter(Boolean) : [];
  };
  const remoteFile = (path) => spawnSync('git', ['--git-dir', bare, 'show', `main:${path}`], { encoding: 'utf8' }).stdout;
  const commits = () => Number(spawnSync('git', ['--git-dir', bare, 'rev-list', '--count', 'main'], { encoding: 'utf8' }).stdout.trim() || 0);
  const agents = join(dir, 'LaunchAgents');
  mkdirSync(agents);
  const clone = join(dir, 'clone');
  return {
    dir, bare, agents, clone, releases, calls, fail, run, remoteFiles, remoteFile, commits,
    lieAboutSize: (n) => { sizeLie = n; },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function backupFileIn(dir, date, text = 'pretend database') {
  const file = join(dir, `tracker-${date}.db`);
  writeFileSync(file, text.repeat(100));
  return file;
}

test('the off-Mini repository is the project repository with -machine-backup added, never typed in', () => {
  assert.equal(offMiniRepoOf('mentor24-maker/spirality'), 'mentor24-maker/spirality-machine-backup');
  assert.throws(() => offMiniRepoOf('not a repo'), /not owner\/name/);
  assert.throws(() => offMiniRepoOf(undefined), /not owner\/name/);
});

test('a backup file names its release; anything else is refused', () => {
  assert.equal(releaseTagOf('/x/backups/tracker-2026-11-16.db'), 'tracker-2026-11-16');
  assert.throws(() => releaseTagOf('/x/clickup-archive-starcaster-2026-11-12.tar.gz'), /not a dated tracker backup/);
});

test('pruning keeps the newest dated releases and never touches any other release', () => {
  const tags = ['tracker-2026-11-03', 'v1.0', 'tracker-2026-11-01', 'tracker-2026-11-02', 'notes'];
  assert.deepEqual(releasesToPrune(tags, 2), ['tracker-2026-11-01']);
  assert.deepEqual(releasesToPrune(tags, 14), []);
  assert.throws(() => releasesToPrune(tags, 0), /at least 1/);
});

test('a launch agent that looks like it holds a key is caught; an ordinary one is not', () => {
  assert.deepEqual(launchAgentSecrets('a.plist', plist('com.x.lane')), []);
  const named = launchAgentSecrets('b.plist', plist('com.x.lane', '\n        <key>DOPPLER_TOKEN</key>\n        <string>whatever</string>'));
  assert.match(named.join(), /sets DOPPLER_TOKEN, which is named like a secret/);
  const shaped = launchAgentSecrets('c.plist', plist('com.x.lane', `\n        <key>X</key>\n        <string>ghp_${'a'.repeat(36)}</string>`));
  assert.match(shaped.join(), /looks like a GitHub token/);
  assert.match(launchAgentSecrets('d.plist', `sk-ant-${'b'.repeat(30)}`).join(), /Anthropic key/);
});

test('the launch agents are pushed to main in an empty repository, read back, and a quiet night pushes nothing', () => {
  const gh = fakeGitHub();
  try {
    writeFileSync(join(gh.agents, 'com.x.relay.plist'), plist('com.x.relay'));
    writeFileSync(join(gh.agents, 'com.y.lane.plist'), plist('com.y.lane'));
    writeFileSync(join(gh.agents, 'notes.txt'), 'not a launch agent');

    const first = pushLaunchAgents({ repo: REPO, clone: gh.clone, agentsDir: gh.agents, run: gh.run });
    assert.equal(first.files, 2);
    assert.equal(first.pushed, true);
    assert.deepEqual(gh.remoteFiles().sort(), ['README.md', `${AGENTS_FOLDER}/com.x.relay.plist`, `${AGENTS_FOLDER}/com.y.lane.plist`]);
    assert.equal(gh.remoteFile(`${AGENTS_FOLDER}/com.y.lane.plist`), plist('com.y.lane'));
    assert.equal(gh.commits(), 1);

    const second = pushLaunchAgents({ repo: REPO, clone: gh.clone, agentsDir: gh.agents, run: gh.run });
    assert.equal(second.pushed, false);
    assert.equal(second.commit, first.commit);
    assert.equal(gh.commits(), 1);

    // A job removed from the Mini leaves the copy too; its history stays in git.
    rmSync(join(gh.agents, 'com.x.relay.plist'));
    writeFileSync(join(gh.agents, 'com.y.lane.plist'), plist('com.y.lane-renamed'));
    const third = pushLaunchAgents({ repo: REPO, clone: gh.clone, agentsDir: gh.agents, run: gh.run });
    assert.equal(third.pushed, true);
    assert.deepEqual(gh.remoteFiles().sort(), ['README.md', `${AGENTS_FOLDER}/com.y.lane.plist`]);
    assert.equal(gh.commits(), 2);
    assert.ok(!gh.calls.some((c) => c.includes('--force') && c[1] === 'push'), 'never a force-push');
  } finally { gh.cleanup(); }
});

test('a lost clone is cloned again and carries on from what GitHub already holds', () => {
  const gh = fakeGitHub();
  try {
    writeFileSync(join(gh.agents, 'com.x.relay.plist'), plist('com.x.relay'));
    pushLaunchAgents({ repo: REPO, clone: gh.clone, agentsDir: gh.agents, run: gh.run });
    rmSync(gh.clone, { recursive: true, force: true });
    const again = pushLaunchAgents({ repo: REPO, clone: gh.clone, agentsDir: gh.agents, run: gh.run });
    assert.equal(again.pushed, false);
    assert.equal(gh.commits(), 1);
  } finally { gh.cleanup(); }
});

test('a launch agent holding something secret-shaped stops the push, naming it, and nothing leaves', () => {
  const gh = fakeGitHub();
  try {
    writeFileSync(join(gh.agents, 'com.x.ok.plist'), plist('com.x.ok'));
    writeFileSync(join(gh.agents, 'com.x.bad.plist'), plist('com.x.bad', '\n        <key>API_KEY</key>\n        <string>abc</string>'));
    assert.throws(() => pushLaunchAgents({ repo: REPO, clone: gh.clone, agentsDir: gh.agents, run: gh.run }),
      /com\.x\.bad\.plist \(line \d+: sets API_KEY.*Nothing was pushed/);
    assert.deepEqual(gh.calls, [], 'not even a clone');
    assert.deepEqual(gh.remoteFiles(), []);
  } finally { gh.cleanup(); }
});

test('no launch agents at all is a failure, not an empty copy', () => {
  const gh = fakeGitHub();
  try {
    assert.throws(() => pushLaunchAgents({ repo: REPO, clone: gh.clone, agentsDir: gh.agents, run: gh.run }), /no \.plist files/);
  } finally { gh.cleanup(); }
});

test('a push GitHub refuses fails, naming the step', () => {
  const gh = fakeGitHub();
  try {
    writeFileSync(join(gh.agents, 'com.x.relay.plist'), plist('com.x.relay'));
    gh.fail.add('git push');
    assert.throws(() => pushLaunchAgents({ repo: REPO, clone: gh.clone, agentsDir: gh.agents, run: gh.run }), /^Error: push: `git push` failed/);
  } finally { gh.cleanup(); }
});

test('the database goes to its dated release gzipped, is read back, and a second run that night replaces the file', async () => {
  const gh = fakeGitHub();
  try {
    const file = backupFileIn(gh.dir, '2026-11-16');
    const r = await uploadDatabase({ repo: REPO, backupFile: file, keep: 14, run: gh.run });
    assert.equal(r.tag, 'tracker-2026-11-16');
    assert.equal(r.asset, 'tracker-2026-11-16.db.gz');
    const [asset] = gh.releases.get('tracker-2026-11-16');
    assert.deepEqual(gunzipSync(asset.bytes), readFileSync(file), 'the upload is the backup, byte for byte, once unzipped');
    assert.deepEqual(r.removed, []);

    writeFileSync(file, 'a later copy the same night');
    await uploadDatabase({ repo: REPO, backupFile: file, keep: 14, run: gh.run });
    assert.equal(gh.releases.get('tracker-2026-11-16').length, 1);
    assert.equal(gunzipSync(gh.releases.get('tracker-2026-11-16')[0].bytes).toString(), 'a later copy the same night');
    assert.ok(gh.calls.some((c) => c[2] === 'upload' && c.includes('--clobber')));
  } finally { gh.cleanup(); }
});

test('older releases are removed only after tonight reads back, and only the dated ones', async () => {
  const gh = fakeGitHub();
  try {
    for (const d of ['2026-11-13', '2026-11-14', '2026-11-15']) gh.releases.set(`tracker-${d}`, [{ name: `tracker-${d}.db.gz`, size: 1 }]);
    gh.releases.set('keepsake', []);
    const r = await uploadDatabase({ repo: REPO, backupFile: backupFileIn(gh.dir, '2026-11-16'), keep: 2, run: gh.run });
    assert.deepEqual(r.removed, ['tracker-2026-11-13', 'tracker-2026-11-14']);
    assert.deepEqual([...gh.releases.keys()].sort(), ['keepsake', 'tracker-2026-11-15', 'tracker-2026-11-16']);

    gh.lieAboutSize(3);
    for (const d of ['2026-11-10', '2026-11-11']) gh.releases.set(`tracker-${d}`, []);
    await assert.rejects(uploadDatabase({ repo: REPO, backupFile: backupFileIn(gh.dir, '2026-11-17'), keep: 1, run: gh.run }),
      /read back: release tracker-2026-11-17 has 3 bytes/);
    assert.ok(gh.releases.has('tracker-2026-11-10'), 'nothing pruned after a bad read-back');
  } finally { gh.cleanup(); }
});

test('the whole copy names the repository and both halves in its one line', async () => {
  const gh = fakeGitHub();
  try {
    writeFileSync(join(gh.agents, 'com.x.relay.plist'), plist('com.x.relay'));
    const line = await copyOffMini({
      githubRepo: 'owner/proj', backupFile: backupFileIn(gh.dir, '2026-11-16'), clone: gh.clone, agentsDir: gh.agents, keep: 14, run: gh.run,
    });
    assert.match(line, /^off-Mini copy OK to owner\/proj-machine-backup: 1 launch agent\(s\) pushed at [0-9a-f]{7}; database tracker-2026-11-16\.db\.gz \(\d+\.\d MB\) uploaded and read back; kept the newest 14 release\(s\), removed 0\.$/);
    // The release is made after main exists, so it has a commit to point at.
    const pushAt = gh.calls.findIndex((c) => c[0] === 'git' && c[1] === 'push');
    const createAt = gh.calls.findIndex((c) => c[0] === 'gh' && c[2] === 'create');
    assert.ok(pushAt >= 0 && createAt > pushAt);
  } finally { gh.cleanup(); }
});

test('only the project\'s own database goes off the Mini', () => {
  const config = { githubRepo: 'owner/proj', trackerDataDir: '~/proj-tracker' };
  assert.deepEqual(offMiniPlan({ db: '/home/me/proj-tracker/tracker.db', config, home: '/home/me', env: {} }),
    { githubRepo: 'owner/proj', clone: '/home/me/proj-tracker/off-mini-clone' });
  assert.match(offMiniPlan({ db: '/tmp/x/tracker.db', config, home: '/home/me', env: {} }).skip, /not the project's own tracker database/);
  assert.match(offMiniPlan({ db: '/home/me/proj-tracker/tracker.db', config, home: '/home/me', env: { TRACKER_OFF_MINI: 'off' } }).skip, /TRACKER_OFF_MINI=off/);
  assert.match(offMiniPlan({ db: '/x/tracker.db', config: { githubRepo: 'owner/proj' }, env: {} }).skip, /no trackerDataDir/);
});

test('run directly on a database that is not the project\'s own, the backup is made and nothing leaves the machine', () => {
  const dir = mkdtempSync(join(tmpdir(), 'off-mini-cli-'));
  try {
    const db = join(dir, 'tracker.db');
    const backups = join(dir, 'backups');
    mkdirSync(backups);
    openStore(db).close();
    const r = spawnSync(process.execPath, [BACKUP_SCRIPT], {
      encoding: 'utf8', env: { ...process.env, TRACKER_DB: db, TRACKER_BACKUP_DIR: backups },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /backup OK: /);
    assert.match(r.stdout, /off-Mini copy skipped: .*is not the project's own tracker database\./);
    assert.equal(readdirSync(backups).length, 1);
    assert.equal(existsSync(join(dir, 'off-mini-clone')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
