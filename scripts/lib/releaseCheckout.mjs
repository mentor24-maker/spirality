#!/usr/bin/env node
/**
 * releaseCheckout.mjs — the copy of Spirality a project's pass runs from
 * (SP-276, move 5 of docs/INTEGRATION.md, "How a change reaches the
 * projects").
 *
 * Spirality's own lanes run Spirality's `main` and so meet every change
 * first. A project's lanes run the release the tracker names for it
 * (SP-265, `npm run clickup -- release list`), from one checkout per
 * release in use, kept in Spirality's log folder:
 *
 *   <Spirality's logDir>/releases/release-<n>     `git worktree add --detach`
 *                                                at the tag, then `npm ci`
 *   <...>/releases/.ready-release-<n>             the commit, written once that
 *                                                checkout is whole
 *   <...>/releases/last-<slug>                    the release <slug> ran last
 *   <...>/releases/in-use/<pid>                   the release runner <pid>'s
 *                                                pass is on right now
 *   <...>/releases/fallback-<slug>.said           what the bus was last told
 *   <...>/releases/.lock                          one prepare or tidy at a time
 *
 * The runners (scripts/loop_runner.sh, scripts/run_relay.sh) stay in
 * Spirality's main checkout and launch every pass; everything the pass runs
 * of Spirality's (the door, the plugin's skills and hooks, the checks) comes
 * from the folder `prepare` prints.
 *
 *   node scripts/lib/releaseCheckout.mjs prepare --spirality <dir> --project <slug> --pid <pid> [--dry-run]
 *   node scripts/lib/releaseCheckout.mjs finish  --spirality <dir> --pid <pid>
 *   node scripts/lib/releaseCheckout.mjs status  --spirality <dir> --project <slug>
 *
 * `prepare` prints the folder to run from on its first line (empty when the
 * pass must not run), then one or more lines for the pass log. Exit 0 the
 * named release is ready; 3 it could not be made ready (or the record could
 * not be read), so the pass runs on the release this project ran last, and
 * the bus was told once; 4 no release is named for the project, so the pass
 * does not run; 5 the named release could not be made ready and the
 * project has run no release before, so the pass does not run; 2 asked
 * wrongly. A newly named release is read here, at the start of a pass, so
 * a move or a roll-back takes effect at the next pass, never the one running.
 *
 * `finish` clears the runner's in-use mark and removes every release
 * checkout that no project names, no project ran last, no live pass is on,
 * and that is not the newest release. When the record or the tags cannot
 * be read it removes nothing and says so. Always exit 0 unless asked wrongly:
 * a tidy that failed never fails the pass.
 *
 * Nothing here names a project: the slug comes from the runner, the log
 * folder from Spirality's own manifest, the remote from lib/releases.mjs.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadProjectConfig, ProjectConfigError } from '../../lib/projectConfig.mjs';
import { isReleaseName, OWN_PROJECT_RELEASE, readReleaseTags, releaseRemote } from '../../lib/releases.mjs';

export const EXIT = { READY: 0, USAGE: 2, FELL_BACK: 3, NONE_NAMED: 4, CANNOT_RUN: 5 };

/** A test names its own folder; otherwise it is `<Spirality's logDir>/releases`. */
export const RELEASES_DIR_ENV = 'SPIRALITY_RELEASES_DIR';

/**
 * A test's stand-in for Spirality's door (`npm run --silent clickup --`): an
 * executable run with the door's arguments in its place. Never set on the
 * Mini.
 */
export const DOOR_ENV = 'SPIRALITY_RELEASE_DOOR';

const expandHome = (v, home = homedir()) => (typeof v === 'string' && /^~(\/|$)/.test(v) ? v.replace(/^~/, home) : v);

/** Spirality's own manifest, read from its folder, whatever project the runner works for. */
export function spiralitySettings(spiralityDir, env = process.env) {
  const config = loadProjectConfig({ file: join(spiralityDir, 'spirality.project.json'), env });
  const logDir = expandHome(config.logDir);
  return {
    slug: config.projectSlug,
    logDir,
    releasesDir: String(env[RELEASES_DIR_ENV] ?? '').trim() || join(logDir, 'releases'),
    syncLock: join(logDir, `${config.projectSlug}-sync.lock`),
  };
}

// ── small helpers ────────────────────────────────────────────────────────

const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

/**
 * Take a mkdir lock the way the runners take theirs: a folder holding the
 * holder's pid, a holder whose pid is gone cleared. Answers a release
 * function, or null when it waited `waitMs` and the holder still held it.
 */
export function takeLock(dir, { pid = process.pid, waitMs = 600_000, stepMs = 500, alive = pidAlive } = {}) {
  let waited = 0;
  for (;;) {
    try {
      mkdirSync(dir);
      writeFileSync(join(dir, 'pid'), `${pid}\n`);
      return () => {
        let holder = '';
        try { holder = readFileSync(join(dir, 'pid'), 'utf8').trim(); } catch { /* gone */ }
        if (holder === String(pid)) rmSync(dir, { recursive: true, force: true });
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    let holder = '';
    try { holder = readFileSync(join(dir, 'pid'), 'utf8').trim(); } catch { /* being written, or gone */ }
    if (holder && !alive(holder)) { rmSync(dir, { recursive: true, force: true }); continue; }
    if (waited >= waitMs) return null;
    sleepMs(stepMs); waited += stepMs;
  }
}

const readText = (file) => { try { return readFileSync(file, 'utf8').trim(); } catch { return ''; } };

function firstLine(r) {
  if (r.error) return r.error.code === 'ETIMEDOUT' ? 'it timed out' : String(r.error.message);
  const said = String(r.stderr || r.stdout || '').split('\n').map((l) => l.trim())
    .find((l) => l && !/^tracker: \d+ request/.test(l)) || '';
  return said.slice(0, 300) || `it exited ${r.status}`;
}

// ── the real git, npm and door ───────────────────────────────────────────

export function realDeps({ spiralityDir, env = process.env }) {
  const git = (args, cwd = spiralityDir) => spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 5 * 60_000, env });
  const door = (args, { input } = {}) => {
    const standIn = String(env[DOOR_ENV] ?? '').trim();
    const [bin, pre] = standIn ? [standIn, []] : ['npm', ['run', '--silent', 'clickup', '--']];
    return spawnSync(bin, [...pre, ...args], { cwd: spiralityDir, input, encoding: 'utf8', timeout: 3 * 60_000, env, maxBuffer: 64 * 1024 * 1024 });
  };
  const npmCi = (dir) => spawnSync('npm', ['ci', '--silent', '--no-audit', '--no-fund'], { cwd: dir, encoding: 'utf8', timeout: 15 * 60_000, env });
  return { git, door, npmCi, remote: releaseRemote(env) };
}

// ── what the tracker names ───────────────────────────────────────────────

/**
 * Every project's release from the door's `release list` (one
 * `<slug>\t<release>` line each). `release list` prints the projects even
 * when it then fails to read the tags, so its lines are read whatever its
 * exit; no lines at all is a failed read. Answers `{ projects: Map, problem }`.
 */
export function readRecord(door) {
  const r = door(['release', 'list']);
  const projects = new Map();
  for (const line of String(r.stdout || '').split('\n')) {
    const m = /^([a-z0-9][a-z0-9-]*)\t(.+)$/.exec(line.trim());
    if (m) projects.set(m[1], m[2].trim());
  }
  if (projects.size === 0) return { projects, problem: `the door's release list failed: ${firstLine(r)}` };
  return { projects, problem: null, tagsProblem: r.status === 0 ? null : firstLine(r) };
}

/** What the record says for one project: `{ release }`, `{ none: true }`, `{ own: true }` or `{ problem }`. */
export function namedFor(record, slug) {
  if (record.problem) return { problem: record.problem };
  if (!record.projects.has(slug)) return { problem: `the tracker's release record has no project ${slug}` };
  const said = record.projects.get(slug);
  if (said === OWN_PROJECT_RELEASE) return { own: true };
  if (said === 'none named') return { none: true };
  if (isReleaseName(said)) return { release: said };
  return { problem: `the tracker's release record says "${said}" for ${slug}, which is not a release name` };
}

// ── one checkout per release ─────────────────────────────────────────────

const checkoutDir = (dirs, release) => join(dirs.releasesDir, release);
const readyFile = (dirs, release) => join(dirs.releasesDir, `.ready-${release}`);

/** The release checkouts on disk, by name. */
export function checkoutsOnDisk(dirs) {
  let names = [];
  try { names = readdirSync(dirs.releasesDir); } catch { return []; }
  return names.filter((n) => isReleaseName(n)).sort();
}

/** A checkout made whole (its ready mark names the commit it is at). */
export function isReady(dirs, release, { git }) {
  const dir = checkoutDir(dirs, release);
  const commit = readText(readyFile(dirs, release));
  if (!commit || !existsSync(dir)) return false;
  const head = git(['rev-parse', 'HEAD'], dir);
  return head.status === 0 && String(head.stdout).trim() === commit;
}

/** Remove one checkout and its ready mark; answers a problem or null. */
export function removeCheckout(dirs, release, { git }) {
  const dir = checkoutDir(dirs, release);
  rmSync(readyFile(dirs, release), { force: true });
  if (!existsSync(dir)) { git(['worktree', 'prune']); return null; }
  const r = git(['worktree', 'remove', '--force', dir]);
  if (r.status === 0 && !existsSync(dir)) return null;
  // A folder git no longer knows as a worktree: removed by hand, then pruned.
  try { rmSync(dir, { recursive: true, force: true }); } catch (err) { return `could not remove ${dir}: ${err.message}`; }
  git(['worktree', 'prune']);
  return null;
}

/**
 * Make `release`'s checkout whole: fetch its tag from the remote, `git
 * worktree add --detach` at it, `npm ci` in it, check HEAD is the tag's
 * commit, and only then write the ready mark. A half-made one (no mark, or
 * a mark that does not match) is removed first. The fetch and the worktree
 * add run under Spirality's sync lock, the one its own lanes pull under.
 * Answers `{ dir }` or `{ problem }`.
 */
export function ensureCheckout(dirs, release, deps) {
  const dir = checkoutDir(dirs, release);
  if (isReady(dirs, release, deps)) return { dir, made: false };
  if (existsSync(dir) || existsSync(readyFile(dirs, release))) {
    const gone = removeCheckout(dirs, release, deps);
    if (gone) return { problem: `a half-made checkout of ${release} is in the way and ${gone}` };
  }
  mkdirSync(dirs.releasesDir, { recursive: true });
  const unlock = (deps.takeSyncLock ?? ((d) => takeLock(d)))(dirs.syncLock);
  if (!unlock) return { problem: `another lane held Spirality's sync lock (${dirs.syncLock}) for 10 minutes, so ${release} could not be fetched` };
  let commit;
  try {
    const fetched = deps.git(['fetch', '-q', deps.remote, `+refs/tags/${release}:refs/tags/${release}`]);
    if (fetched.status !== 0) return { problem: `the tag ${release} could not be fetched from ${deps.remote} (it is missing, or the fetch failed): ${firstLine(fetched)}` };
    const peeled = deps.git(['rev-parse', '--verify', '-q', `refs/tags/${release}^{commit}`]);
    commit = String(peeled.stdout || '').trim();
    if (peeled.status !== 0 || !commit) return { problem: `the tag ${release} was fetched but names no commit` };
    const added = deps.git(['worktree', 'add', '-q', '--detach', dir, commit]);
    if (added.status !== 0) {
      removeCheckout(dirs, release, deps);
      return { problem: `git worktree add for ${release} failed: ${firstLine(added)}` };
    }
  } finally {
    unlock();
  }
  const ci = deps.npmCi(dir);
  if (ci.status !== 0 || ci.error) {
    removeCheckout(dirs, release, deps);
    return { problem: `npm ci failed in the ${release} checkout: ${firstLine(ci)}` };
  }
  const head = deps.git(['rev-parse', 'HEAD'], dir);
  if (head.status !== 0 || String(head.stdout).trim() !== commit) {
    removeCheckout(dirs, release, deps);
    return { problem: `the ${release} checkout is not at the tag's commit ${commit.slice(0, 12)}` };
  }
  writeFileSync(readyFile(dirs, release), `${commit}\n`);
  return { dir, made: true };
}

// ── prepare and finish ───────────────────────────────────────────────────

const lastFile = (dirs, slug) => join(dirs.releasesDir, `last-${slug}`);
const saidFile = (dirs, slug) => join(dirs.releasesDir, `fallback-${slug}.said`);
const inUseDir = (dirs) => join(dirs.releasesDir, 'in-use');

function markInUse(dirs, pid, release) {
  mkdirSync(inUseDir(dirs), { recursive: true });
  writeFileSync(join(inUseDir(dirs), String(pid)), `${release}\n`);
}

/** The releases a live pass is on, clearing the marks of passes that are gone. */
export function releasesInUse(dirs, { alive = pidAlive } = {}) {
  const using = new Set();
  let pids = [];
  try { pids = readdirSync(inUseDir(dirs)); } catch { return using; }
  for (const pid of pids) {
    const file = join(inUseDir(dirs), pid);
    if (!alive(pid)) { rmSync(file, { force: true }); continue; }
    const release = readText(file);
    if (isReleaseName(release)) using.add(release);
  }
  return using;
}

/** The one bus line for a pass that could not run on its named release. */
export function fallbackPost({ slug, named, why, last }) {
  const wanted = named ? `on ${named}, the Spirality release named for it` : 'on its Spirality release (the record could not be read)';
  return last
    ? `WARNING: ${slug}'s lanes could not run ${wanted}: ${why}. They run on ${last}, the release they ran last, until it is fixed.`
    : `ALARM: ${slug}'s lanes could not run ${wanted}: ${why}. They have run no release before, so they are not running until it is fixed.`;
}

/**
 * One pass's start, for project `slug` and runner `pid`. Answers
 * `{ code, dir, lines }` (EXIT above). Never throws for a git, npm or door
 * failure: each is a line and a fallback.
 */
export function prepare({ dirs, slug, pid, deps, alive = pidAlive, dryRun = false }) {
  const lines = [];
  mkdirSync(dirs.releasesDir, { recursive: true });
  const unlock = takeLock(join(dirs.releasesDir, '.lock'), { alive });
  if (!unlock) {
    lines.push(`another pass held the release checkouts' lock (${join(dirs.releasesDir, '.lock')}) for 10 minutes`);
  }
  try {
    const named = unlock ? namedFor(readRecord(deps.door), slug) : { problem: lines[0] };
    if (named.own) {
      return { code: EXIT.USAGE, dir: '', lines: [`${slug} is Spirality's own project: its lanes run main, never a release checkout`] };
    }
    if (named.none) {
      // A project that once ran a release and has none named now does not run either: never a silent run on main.
      return { code: EXIT.NONE_NAMED, dir: '', lines: [`${slug} has no Spirality release named (npm run clickup -- release name --project ${slug} --to release-<n>), so this pass does not run from Spirality`] };
    }
    let why = named.problem;
    if (named.release) {
      // A dry run makes nothing and posts nothing: it uses a checkout already whole, or falls back.
      const made = dryRun
        ? (isReady(dirs, named.release, deps) ? { dir: checkoutDir(dirs, named.release), made: false } : { problem: `${named.release} is not checked out yet, and a dry run checks nothing out` })
        : ensureCheckout(dirs, named.release, deps);
      if (made.dir) {
        if (!dryRun) {
          writeFileSync(lastFile(dirs, slug), `${named.release}\n`);
          rmSync(saidFile(dirs, slug), { force: true });
        }
        markInUse(dirs, pid, named.release);
        lines.push(`this pass runs on ${named.release} (${made.dir})${made.made ? ', checked out and npm ci run just now' : ''}`);
        return { code: EXIT.READY, dir: made.dir, lines };
      }
      why = made.problem;
    }
    const last = readText(lastFile(dirs, slug));
    const lastReady = isReleaseName(last) && last !== named.release && isReady(dirs, last, deps) ? last : '';
    const key = `${named.release ?? 'unreadable'}`;
    const post = () => {
      if (dryRun) return 'a dry run tells the bus nothing';
      if (readText(saidFile(dirs, slug)) === key) return 'the bus was told already';
      const sent = deps.door(['bus-post', '--body-file', '-'], { input: fallbackPost({ slug, named: named.release, why, last: lastReady }) });
      if (sent.status === 0 && !sent.error) { writeFileSync(saidFile(dirs, slug), `${key}\n`); return 'said on the bus'; }
      return `the bus post FAILED (${firstLine(sent)}), so the next pass tries again`;
    };
    if (lastReady) {
      markInUse(dirs, pid, lastReady);
      lines.push(`could not run on ${named.release ?? 'the named release'}: ${why} — this pass runs on ${lastReady} (${checkoutDir(dirs, lastReady)}), the release ${slug} ran last; ${post()}`);
      return { code: EXIT.FELL_BACK, dir: checkoutDir(dirs, lastReady), lines };
    }
    lines.push(`could not run on ${named.release ?? 'the named release'}: ${why} — and ${slug} has no earlier release checked out to fall back on, so this pass does not run; ${post()}`);
    return { code: EXIT.CANNOT_RUN, dir: '', lines };
  } finally {
    if (unlock) unlock();
  }
}

/**
 * The end of a pass: clear runner `pid`'s in-use mark, then remove every
 * checkout nothing needs. Answers the lines to log.
 */
export function finish({ dirs, pid, deps, alive = pidAlive }) {
  rmSync(join(inUseDir(dirs), String(pid)), { force: true });
  const onDisk = checkoutsOnDisk(dirs);
  if (onDisk.length === 0) return [];
  const unlock = takeLock(join(dirs.releasesDir, '.lock'), { alive, waitMs: 60_000 });
  if (!unlock) return ['release checkouts not tidied: another pass held their lock for a minute'];
  try {
    const record = readRecord(deps.door);
    if (record.problem) return [`release checkouts not tidied: ${record.problem}`];
    const tags = readReleaseTags({ git: (args) => deps.git(args), remote: deps.remote });
    if (tags.problem) return [`release checkouts not tidied: the newest release could not be read (${tags.problem})`];
    const keep = new Set();
    for (const r of record.projects.values()) if (isReleaseName(r)) keep.add(r);
    if (tags.tags[0]) keep.add(tags.tags[0].name);
    for (const file of readdirSafe(dirs.releasesDir)) {
      const m = /^last-(.+)$/.exec(file);
      if (m) { const r = readText(join(dirs.releasesDir, file)); if (isReleaseName(r)) keep.add(r); }
    }
    for (const r of releasesInUse(dirs, { alive })) keep.add(r);
    const lines = [];
    for (const release of onDisk) {
      if (keep.has(release)) continue;
      const problem = removeCheckout(dirs, release, deps);
      lines.push(problem ? `release checkout ${release} could NOT be removed: ${problem}` : `release checkout ${release} removed: no project names it or ran it last, no pass is on it, and it is not the newest`);
    }
    return lines;
  } finally {
    unlock();
  }
}

function readdirSafe(dir) { try { return readdirSync(dir); } catch { return []; } }

/** For `install_loop_runner.sh --status`: the release a project runs on, in one line. */
export function statusLine({ dirs, slug, deps }) {
  const named = namedFor(readRecord(deps.door), slug);
  const last = readText(lastFile(dirs, slug));
  const ran = isReleaseName(last) ? `; its last pass ran on ${last}` : '; no pass has run on a release yet';
  if (named.own) return 'release:  main (Spirality\'s own lanes always run main)';
  if (named.none) return `release:  none named — its lanes do not run until one is (npm run clickup -- release name --project ${slug} --to release-<n>)${ran}`;
  if (named.problem) return `release:  could not read (${named.problem})${ran}`;
  const where = isReady(dirs, named.release, deps) ? `checked out in ${checkoutDir(dirs, named.release)}` : 'not checked out yet (its next pass does that)';
  return `release:  ${named.release}, ${where}${ran}`;
}

// ── the command line ─────────────────────────────────────────────────────

function main(argv, env = process.env) {
  const [sub, ...rest] = argv;
  const arg = (name) => { const i = rest.indexOf(`--${name}`); return i >= 0 && rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : ''; };
  const usage = (why) => {
    console.error(`releaseCheckout: ${why}\n  usage: releaseCheckout.mjs prepare --spirality <dir> --project <slug> --pid <pid>\n         releaseCheckout.mjs finish --spirality <dir> --pid <pid>\n         releaseCheckout.mjs status --spirality <dir> --project <slug>`);
    return EXIT.USAGE;
  };
  const spirality = arg('spirality');
  if (!spirality) return usage('--spirality <Spirality\'s main checkout> is required');
  const spiralityDir = resolve(spirality);
  let dirs;
  try {
    dirs = spiralitySettings(spiralityDir, env);
  } catch (err) {
    if (!(err instanceof ProjectConfigError)) throw err;
    console.log('');
    console.log(`Spirality's own manifest is not usable (${err.message}), so no release checkout can be found`);
    return sub === 'finish' ? 0 : EXIT.CANNOT_RUN;
  }
  const deps = realDeps({ spiralityDir, env });
  const slug = arg('project');
  const pid = arg('pid');
  if (sub === 'prepare') {
    if (!slug || !/^\d+$/.test(pid)) return usage('prepare needs --project <slug> and --pid <pid>');
    const out = prepare({ dirs, slug, pid, deps, dryRun: rest.includes('--dry-run') });
    console.log(out.dir);
    for (const l of out.lines) console.log(l);
    return out.code;
  }
  if (sub === 'finish') {
    if (!/^\d+$/.test(pid)) return usage('finish needs --pid <pid>');
    for (const l of finish({ dirs, pid, deps })) console.log(l);
    return 0;
  }
  if (sub === 'status') {
    if (!slug) return usage('status needs --project <slug>');
    console.log(statusLine({ dirs, slug, deps }));
    const on = checkoutsOnDisk(dirs);
    console.log(`releases: ${dirs.releasesDir}: ${on.length ? on.join(', ') : 'no release checked out'}`);
    return 0;
  }
  return usage(`unknown command ${JSON.stringify(sub ?? '')}`);
}

const invokedAs = (() => { try { return pathToFileURL(realpathSync(process.argv[1] ?? '')).href; } catch { return ''; } })();
if (import.meta.url === invokedAs) {
  process.exit(main(process.argv.slice(2)));
}
