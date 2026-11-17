/**
 * The off-Mini copy: after the nightly backup (tracker/backup.mjs) has made
 * tonight's copy of the tracker's database on the Mini's own disk, send it,
 * and the Mini's launch agents, to a private GitHub repository, so a dead
 * disk no longer loses every project's tickets at once. Design and restore
 * steps: docs/OFF_MINI_BACKUP.md (Dane chose a private repository of its
 * own, answer B, 2026-11-16).
 *
 * WHERE IT GOES. The repository is named after the project's own
 * `githubRepo` with `-machine-backup` added (`owner/spirality` ->
 * `owner/spirality-machine-backup`), so no id is typed here (CLAUDE.md rule 2)
 * and no new manifest field is needed.
 *
 * WHAT GOES, AND HOW:
 *   - The launch agents (every `*.plist` in ~/Library/LaunchAgents) are small
 *     text files, committed to `launch-agents/` on `main` with an ordinary
 *     push, never a force-push. Git keeps every night's version, so "what did
 *     the Mini's jobs look like the week it broke" can be answered.
 *   - The database (tens of megabytes, growing) is gzipped and attached to a
 *     release named `tracker-YYYY-MM-DD`, never committed: a file that size
 *     committed every night would push the repository past GitHub's limits
 *     within weeks. The newest `keep` releases are kept, the same number the
 *     Mini keeps on its own disk; older ones are removed only after
 *     tonight's upload has been read back.
 *
 * NO SECRET LEAVES. A launch agent that looks like it holds a key (a known
 * token shape, or an environment variable named like a token, secret,
 * password or key) is not copied, and the run fails naming it. Nothing else
 * is read: no sign-in, no identity file (Dane's non-goal).
 *
 * Every write is read back (CLAUDE.md rule 5): the pushed commit against
 * `git ls-remote`, the uploaded file against the release's asset size.
 * Every shell-out goes through `run`, so the tests drive every branch with
 * no network.
 */
import { spawnSync } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { findSecrets } from '../scripts/lib/secretScan.mjs';

export const REPO_SUFFIX = '-machine-backup';
export const AGENTS_FOLDER = 'launch-agents';
const TAG = /^tracker-\d{4}-\d{2}-\d{2}$/;
const COMMITTER = ['-c', 'user.name=Spirality machine backup', '-c', 'user.email=machine-backup@spirality.invalid'];

/** `owner/name` -> `owner/name-machine-backup`; throws on anything else. */
export function offMiniRepoOf(githubRepo) {
  if (typeof githubRepo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(githubRepo)) {
    throw new Error(`the project config's githubRepo (${JSON.stringify(githubRepo)}) is not owner/name, so there is no off-Mini repository to name.`);
  }
  return `${githubRepo}${REPO_SUFFIX}`;
}

/** The release a backup file goes to: `.../tracker-2026-11-16.db` -> `tracker-2026-11-16`. */
export function releaseTagOf(backupFile) {
  const tag = basename(backupFile).replace(/\.db$/, '');
  if (!TAG.test(tag)) throw new Error(`${basename(backupFile)} is not a dated tracker backup (tracker-YYYY-MM-DD.db).`);
  return tag;
}

/** The dated releases to remove so the newest `keep` remain; other releases are never touched. */
export function releasesToPrune(tags, keep) {
  if (!Number.isInteger(keep) || keep < 1) throw new Error(`keep must be a whole number of at least 1, not ${keep}.`);
  return tags.filter((t) => TAG.test(t)).sort().slice(0, -keep);
}

const EXTRA_PATTERNS = [
  { label: 'a GitHub token', re: /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/ },
  { label: 'an Anthropic key', re: /\bsk-ant-[A-Za-z0-9_-]{16,}/ },
  { label: 'a Doppler token', re: /\bdp\.(st|pt|sa|ct)\.[A-Za-z0-9_-]{16,}/ },
  { label: 'a private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];
const SECRET_NAME = /<key>\s*([A-Z0-9_]*(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY)[A-Z0-9_]*)\s*<\/key>/i;

/** Every reason this launch agent should not leave the Mini (empty when clean). */
export function launchAgentSecrets(name, text) {
  const hits = findSecrets(name, text);
  text.split('\n').forEach((line, i) => {
    for (const { label, re } of EXTRA_PATTERNS) if (re.test(line)) hits.push(`line ${i + 1}: looks like ${label}`);
    const named = SECRET_NAME.exec(line);
    if (named) hits.push(`line ${i + 1}: sets ${named[1]}, which is named like a secret`);
  });
  return hits;
}

/** The README the repository carries: what is in it and how to get it back. */
export function readmeText(repo) {
  return `# ${repo.split('/')[1]}

The Mini's off-machine copy, made every night after the tracker's own backup
by Spirality's \`tracker/backup.mjs\` (docs/OFF_MINI_BACKUP.md in Spirality).
Private: it holds every project's tickets.

- \`${AGENTS_FOLDER}/\`: the Mini's launch agents (\`~/Library/LaunchAgents/*.plist\`),
  one commit per night they change.
- Releases named \`tracker-YYYY-MM-DD\`: that night's tracker database,
  gzipped. The newest 14 are kept.

No sign-in, key or identity file is ever copied here.

To get a database back: \`gh release download tracker-YYYY-MM-DD --repo ${repo}\`,
then \`gunzip tracker-YYYY-MM-DD.db.gz\`, and follow "Restoring a backup" in
Spirality's docs/TRACKER_MVP.md.
`;
}

/** The default shell-out: argv, no shell, output captured. */
export function defaultRun(cmd, args, { cwd } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? '', stderr: r.error ? r.error.message : (r.stderr ?? '') };
}

class StepError extends Error {}

function must(run, step, cmd, args, opts) {
  const r = run(cmd, args, opts);
  if (r.status !== 0) {
    const why = (r.stderr || r.stdout || `exit ${r.status}`).trim().split('\n').slice(-2).join(' ');
    throw new StepError(`${step}: \`${cmd} ${args[0]}\` failed (${why})`);
  }
  return r.stdout;
}

/**
 * Bring the clone at `clone` level with the repository's `main` (or set up an
 * empty one), mirror the launch agents into it, and push. Returns
 * `{ files, commit, pushed }`, the commit read back from GitHub.
 */
export function pushLaunchAgents({ repo, clone, agentsDir, run = defaultRun }) {
  const names = existsSync(agentsDir) ? readdirSync(agentsDir).filter((f) => f.endsWith('.plist')).sort() : [];
  if (!names.length) throw new StepError(`launch agents: there are no .plist files in ${agentsDir}`);
  const refused = [];
  const texts = new Map();
  for (const name of names) {
    const text = readFileSync(join(agentsDir, name), 'utf8');
    const hits = launchAgentSecrets(name, text);
    if (hits.length) refused.push(`${name} (${hits.join('; ')})`);
    else texts.set(name, text);
  }
  if (refused.length) {
    throw new StepError(`launch agents: not copied, because ${refused.length === 1 ? 'one looks' : `${refused.length} look`} like ${refused.length === 1 ? 'it holds' : 'they hold'} a secret: ${refused.join(', ')}. Nothing was pushed`);
  }

  if (!existsSync(join(clone, '.git'))) {
    rmSync(clone, { recursive: true, force: true });
    must(run, 'clone', 'gh', ['repo', 'clone', repo, clone]);
  }
  const git = (step, ...args) => must(run, step, 'git', args, { cwd: clone });
  git('fetch', 'fetch', 'origin', '--prune');
  const remoteMain = run('git', ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'], { cwd: clone });
  if (remoteMain.status === 0) {
    git('catch up', 'checkout', '--force', '-B', 'main', 'origin/main');
  } else {
    // An empty repository: the first push creates main.
    git('start main', 'symbolic-ref', 'HEAD', 'refs/heads/main');
  }
  git('tidy', 'clean', '-fdx');

  const folder = join(clone, AGENTS_FOLDER);
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });
  for (const [name, text] of texts) writeFileSync(join(folder, name), text);
  writeFileSync(join(clone, 'README.md'), readmeText(repo));

  git('stage', 'add', '-A');
  const changed = run('git', ['diff', '--cached', '--quiet'], { cwd: clone }).status !== 0
    || run('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: clone }).status !== 0;
  if (changed) {
    git('commit', ...COMMITTER, 'commit', '--quiet', '-m', `Launch agents as of ${new Date().toString()}`);
    git('push', 'push', '--quiet', 'origin', 'main');
  }
  const commit = git('read back', 'rev-parse', 'HEAD').trim();
  const remote = git('read back', 'ls-remote', 'origin', 'refs/heads/main').trim().split(/\s+/)[0];
  if (remote !== commit) {
    throw new StepError(`read back: GitHub's main is ${remote || '(none)'}, not the commit just pushed (${commit})`);
  }
  return { files: texts.size, commit, pushed: changed };
}

function assetsOf(run, repo, tag) {
  const r = run('gh', ['release', 'view', tag, '--repo', repo, '--json', 'assets']);
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout).assets ?? [];
  } catch {
    throw new StepError(`read back: \`gh release view ${tag}\` did not answer in JSON`);
  }
}

/**
 * Gzip `backupFile`, attach it to its dated release (creating the release, or
 * replacing that night's file on a second run), read it back, then prune.
 * Returns `{ tag, asset, bytes, removed }`.
 */
export async function uploadDatabase({ repo, backupFile, keep, run = defaultRun }) {
  const tag = releaseTagOf(backupFile);
  const work = mkdtempSync(join(tmpdir(), 'off-mini-'));
  try {
    const asset = `${tag}.db.gz`;
    const gz = join(work, asset);
    await pipeline(createReadStream(backupFile), createGzip({ level: 9 }), createWriteStream(gz));
    const bytes = statSync(gz).size;

    if (assetsOf(run, repo, tag) === null) {
      must(run, 'upload', 'gh', ['release', 'create', tag, gz, '--repo', repo, '--target', 'main',
        '--title', tag, '--notes', `The tracker's database as backed up on the Mini, ${tag.slice('tracker-'.length)}. Gzipped.`]);
    } else {
      must(run, 'upload', 'gh', ['release', 'upload', tag, gz, '--repo', repo, '--clobber']);
    }
    const back = (assetsOf(run, repo, tag) ?? []).find((a) => a.name === asset);
    if (!back || back.size !== bytes) {
      throw new StepError(`read back: release ${tag} has ${back ? `${back.size} bytes` : 'no file'} named ${asset}, not the ${bytes} bytes uploaded`);
    }

    const listed = must(run, 'prune', 'gh', ['release', 'list', '--repo', repo, '--limit', '500', '--json', 'tagName']);
    let tags;
    try { tags = JSON.parse(listed).map((r) => r.tagName); } catch { throw new StepError('prune: `gh release list` did not answer in JSON'); }
    const removed = releasesToPrune(tags, keep);
    for (const old of removed) must(run, 'prune', 'gh', ['release', 'delete', old, '--repo', repo, '--yes', '--cleanup-tag']);
    return { tag, asset, bytes, removed };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * The whole off-Mini copy. Resolves to the one log line for a good night;
 * rejects with an error whose message names the step that failed.
 */
export async function copyOffMini({ githubRepo, backupFile, clone, agentsDir, keep, run = defaultRun }) {
  const repo = offMiniRepoOf(githubRepo);
  const agents = pushLaunchAgents({ repo, clone, agentsDir, run });
  const db = await uploadDatabase({ repo, backupFile, keep, run });
  const mb = (db.bytes / 1e6).toFixed(1);
  return `off-Mini copy OK to ${repo}: ${agents.files} launch agent(s) ${agents.pushed ? 'pushed' : 'unchanged'} at ${agents.commit.slice(0, 7)}; `
    + `database ${db.asset} (${mb} MB) uploaded and read back; kept the newest ${keep} release(s), removed ${db.removed.length}.`;
}
