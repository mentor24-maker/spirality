/**
 * Which of a project's own tests the setup pull request retires (SP-252).
 *
 * A project that ran its own copy of the loop (StarCaster) has tests of that
 * old copy: they read its loop skills, its LOOP_ENGINEERING.md, its
 * loop_runner.sh. The setup replaces those files, so those tests fail on the
 * setup branch, and the project's `verify` with them. Such a test is retired
 * (deleted on the setup branch, and listed in the pull request with why) only
 * when ALL THREE of these hold, each one something a reviewer can check:
 *
 *   1. it fails when run alone on the setup branch (`node --test <file>`);
 *   2. it passes when run alone on the commit the setup branch started from;
 *   3. it names a file the setup writes, by its path or by its file name
 *      standing on its own (`'SKILL.md'`, `loop_runner.sh`); or, naming none
 *      itself, a file of the repository it names does (one step, no
 *      further: StarCaster's clickupCaller test reads loop_runner.sh through
 *      scripts/lib/clickupCaller.cjs).
 *
 * 1 and 2 together say the setup is what breaks it; 3 says it breaks because
 * it checks the loop's own files.
 *
 * SP-254: and only when everything it tests is the setup's. A test that also
 * points at code the project still runs (a file its npm commands run, or one
 * those load, by a relative path or its whole path, and that the setup does
 * not write) is never deleted, even when 1 to 3 hold: it is kept, on a
 * `not retired:` line naming that code and the tests in it that fail, for a
 * hand fix on the setup branch, and the pull request lists it. StarCaster's
 * shipThread test read a rewritten CLAUDE.md, and also `npm run ship`'s
 * ship_thread.cjs. A test that fails on main too, or that
 * names none of the setup's files, is never retired: the setup branch's
 * verify then fails, and the wizard stops before it stops the old loops.
 * Nothing here decides by hand, and nothing here runs a command: the copy
 * step (scripts/onboard/copy.mjs) runs the tests and asks these functions.
 */
import { basename, dirname, posix } from 'node:path';

/** A test file of the project's own that can be run alone with `node --test`. */
export const TEST_FILE = /\.test\.(?:c|m)?js$/;

/** How one test file is run alone: this, then its path. Plain Node (engineering rule 8). */
export const RUN_ONE_TEST = Object.freeze(['node', '--test', '--test-reporter=tap']);

/**
 * The environment one test runs alone in: the caller's, without
 * NODE_TEST_CONTEXT, which a run started from inside `node --test` inherits
 * and which makes the inner run report to its parent instead of failing.
 * (An undefined value is left out of the child's environment.)
 */
export const RUN_ONE_TEST_ENV = Object.freeze({ NODE_TEST_CONTEXT: undefined });

/** The rule, as the pull request states it. */
export const RETIRE_RULE = 'it fails when run alone on this branch, passes when run alone on the commit this branch started from, it (or a file of this repository it names) names a file this setup writes, and it points at no code the project still runs';

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A name stands on its own: nothing of a longer name glued to either side
// (a full stop after it ends a sentence; `.bak` after it is another file).
const standsAlone = (name) => new RegExp(`(?<![A-Za-z0-9_.-])${escape(name)}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`);

/**
 * The paths in `paths` that `text` names: by the whole path, by the file name
 * standing on its own, or (a .js/.cjs/.mjs file) required without its ending
 * (`require('./remoteProbe')`).
 */
export function namesIn(text, paths) {
  const t = String(text ?? '');
  return paths.filter((p) => {
    if (t.includes(p)) return true;
    const name = basename(p);
    if (standsAlone(name).test(t)) return true;
    const stem = name.replace(/\.(?:c|m)?js$/, '');
    return stem !== name && new RegExp(`/${escape(stem)}['"\`]`).test(t);
  });
}

/** A file a project runs: not a test, not data, not a document. */
export const CODE_FILE = /\.(?:c|m)?[jt]s$|\.sh$/;

const RELATIVE = /^\.{1,2}\//;
const ENDINGS = ['', '.js', '.cjs', '.mjs', '.ts', '/index.js', '/index.cjs', '/index.mjs'];

/**
 * The paths in `paths` that the file at `from` (its text `text`) points at:
 * by its whole path from the repository's top (`'scripts/pipeline.mjs'`), by
 * a path relative to its own folder (`require('./wipCap')`,
 * `'../ship_thread.cjs'`), or by `join(<folder>, 'a', 'b.cjs')` with plain
 * strings, read from its own folder or the top. Never by a file name alone:
 * which file that is cannot be told.
 */
export function pointsAt(from, text, paths) {
  const t = String(text ?? '');
  const want = new Set(paths);
  const hit = new Set();
  const here = dirname(from) === '.' ? '' : dirname(from);
  const tryPath = (p) => {
    const n = posix.normalize(p).replace(/^\.\//, '');
    if (n.startsWith('../')) return;
    for (const e of ENDINGS) if (want.has(n + e)) { hit.add(n + e); return; }
  };
  for (const [, , s] of t.matchAll(/(['"`])([^'"`\n]+)\1/g)) {
    if (RELATIVE.test(s)) tryPath(posix.join(here, s));
    else if (want.has(s)) hit.add(s);
  }
  for (const [, args] of t.matchAll(/\b(?:join|resolve)\(\s*[A-Za-z_$][\w$.]*\s*((?:,\s*(['"])[^'"\n]*\2\s*)+)\)/g)) {
    const joined = [...args.matchAll(/(['"])([^'"\n]*)\1/g)].map((m) => m[2]).join('/');
    tryPath(posix.join(here, joined));
    tryPath(joined);
  }
  return [...hit].sort();
}

/**
 * The project's code that is still live once the setup is in: every code
 * file its npm commands run (`scripts` of its package.json, on the setup
 * branch), and every code file those point at, followed all the way (by
 * `pointsAt`). A file the setup writes, or a test, is never counted: the one
 * is the loop's, the other is what is being judged.
 *
 *   scripts    package.json's `scripts` object
 *   repoFiles  every file of the repository
 *   written    every path the setup writes
 *   read       (path) → that file's text on the setup branch, or null
 */
export function liveCode({ scripts, repoFiles, written, read }) {
  const writtenSet = new Set(written);
  const code = [...new Set(repoFiles)].filter((p) => p && CODE_FILE.test(p) && !TEST_FILE.test(p) && !writtenSet.has(p));
  const codeSet = new Set(code);
  const live = new Set();
  const queue = [];
  const add = (p) => { if (codeSet.has(p) && !live.has(p)) { live.add(p); queue.push(p); } };
  for (const command of Object.values(scripts && typeof scripts === 'object' ? scripts : {})) {
    for (const token of String(command).split(/[\s;&|()<>"'=`]+/)) add(token.replace(/^\.\//, ''));
  }
  while (queue.length) {
    const p = queue.shift();
    for (const n of pointsAt(p, read(p), code)) add(n);
  }
  return [...live].sort();
}

/**
 * The tests a `node --test --test-reporter=tap` run reports failing, each by
 * its name, a nested one as `outer > inner` (the outer one, which fails
 * because it does, is not listed again). A file that would not load at all
 * is reported by node as one failing test named by its path.
 */
export function failedTests(tap) {
  const pending = [];
  for (const line of String(tap ?? '').split('\n')) {
    const m = /^(\s*)(not ok|ok) \d+ - (.*?)(?:\s+#\s*(?:TODO|SKIP)\b.*)?$/.exec(line);
    if (!m) continue;
    const depth = Math.floor(m[1].length / 4);
    const inner = pending[depth + 1] || [];
    pending[depth + 1] = [];
    if (m[2] === 'ok') continue;
    const name = m[3].replace(/\\#/g, '#');
    pending[depth] = [...(pending[depth] || []), ...(inner.length ? inner.map((i) => `${name} > ${i}`) : [name])];
  }
  return [...new Set(pending[0] || [])];
}

/**
 * The project's test files that meet rule 3, each with the setup's files it
 * names and the repository files it names them through.
 *
 *   testFiles  the test files on the commit the setup started from
 *   repoFiles  every file of the repository on that commit
 *   written    every path the setup writes (replaced or new)
 *   read       (path) → that file's text on the setup branch, or null
 *   live       the project's live code (`liveCode`); each candidate's `live`
 *              is the live files it points at (SP-254), empty when none
 *
 * A file the setup writes is never a candidate: it is the loop's own.
 */
export function retireCandidates({ testFiles, repoFiles, written, read, live = [] }) {
  const writes = [...new Set(written)];
  const writtenSet = new Set(writes);
  const others = [...new Set(repoFiles)].filter((p) => p && !writtenSet.has(p));
  const out = [];
  for (const file of [...new Set(testFiles)].filter((f) => TEST_FILE.test(f) && !writtenSet.has(f)).sort()) {
    const text = read(file);
    if (text == null) continue;
    // Named directly, that is the reason given; only a test that names none
    // of them itself is looked at through the files it names.
    const points = pointsAt(file, text, live);
    const direct = namesIn(text, writes);
    if (direct.length) { out.push({ file, names: [...direct].sort(), via: [], live: points }); continue; }
    const names = new Set();
    const via = [];
    for (const n of namesIn(text, others.filter((p) => p !== file))) {
      const hits = namesIn(read(n), writes);
      if (hits.length) { via.push(n); hits.forEach((h) => names.add(h)); }
    }
    if (names.size) out.push({ file, names: [...names].sort(), via: via.sort(), live: points });
  }
  return out;
}

/** Rules 1 and 2: retired only when it fails alone on the setup branch and passes alone where it started. */
export function retireVerdict({ setupCode, baseCode }) {
  if (setupCode === 0) return { retire: false, why: 'passes on the setup branch' };
  if (baseCode !== 0) return { retire: false, why: 'fails on the commit the setup started from too, so the setup is not what breaks it' };
  return { retire: true, why: 'fails on the setup branch only' };
}

const some = (list, most = 5) => {
  const shown = list.slice(0, most).map((n) => `\`${n}\``).join(', ');
  return list.length > most ? `${shown} and ${list.length - most} more` : shown;
};
const exitOf = (r) => (r != null && typeof r === 'object' ? r.code : r);

/**
 * Rules 1 and 2 over the candidates: each run alone on the setup branch, and
 * the ones that fail there run alone where the branch started. `runOnSetup`
 * and `runOnBase` take a test file and give its exit code, or { code, out }
 * with the run's TAP output; `beforeBase` runs once, only if some candidate
 * fails on the setup branch (the copy step makes the base's scratch worktree
 * there). Returns { retired, kept, handFix }: kept naming why each failing
 * test that is not retired stays; handFix the ones the rule would retire but
 * that also test live code (SP-254), each with that code and the tests in it
 * that fail here.
 */
export function pickRetired({ candidates, runOnSetup, runOnBase, beforeBase = () => {} }) {
  const failing = candidates.map((c) => ({ c, setup: runOnSetup(c.file) })).filter((x) => exitOf(x.setup) !== 0);
  if (!failing.length) return { retired: [], kept: [], handFix: [], failing: 0 };
  beforeBase(failing.length);
  const retired = [];
  const kept = [];
  const handFix = [];
  for (const { c, setup } of failing) {
    const v = retireVerdict({ setupCode: exitOf(setup), baseCode: exitOf(runOnBase(c.file)) });
    if (!v.retire) kept.push({ file: c.file, why: v.why });
    else if (c.live?.length) {
      const failed = failedTests(setup?.out);
      handFix.push({ file: c.file, names: c.names, live: c.live, failing: failed });
      kept.push({ file: c.file, why: `also tests code that is still live (${some(c.live).replace(/`/g, '')}), so it is kept for a hand fix on the setup branch${failed.length ? `; failing here: ${failed.slice(0, 5).join('; ')}${failed.length > 5 ? ` and ${failed.length - 5} more` : ''}` : ''}` });
    } else retired.push(c);
  }
  return { retired, kept, handFix, failing: failing.length };
}

/** One line per retired test, for the pull request and the run's own output. */
export function retiredLine(r, most = 5) {
  const through = r.via.length ? ` (through ${some(r.via, most)})` : '';
  return `\`${r.file}\`: names ${some(r.names, most)}${through}`;
}

/** One line per test kept for a hand fix (SP-254): the live code it tests, and what failed. */
export function handFixLine(k, most = 5) {
  const failing = k.failing?.length
    ? `; failed on this branch before the fix: ${k.failing.slice(0, most).map((f) => `"${f}"`).join(', ')}${k.failing.length > most ? ` and ${k.failing.length - most} more` : ''}`
    : '';
  return `\`${k.file}\`: tests ${some(k.live, most)}, still live, and names ${some(k.names, most)}, which this setup writes${failing}`;
}

/** The pull request's section on tests kept for a hand fix; none when there were none. */
export function handFixSection(handFix, { projectName }) {
  if (!handFix.length) return [];
  return [
    `**Tests kept, fixed by hand.** These ${handFix.length} test file(s) of ${projectName}'s own check files this setup rewrites, and also code ${projectName} still runs, so they are not retired: the tests that failed on this branch were fixed by hand in it, and the rest of each file still runs. Check each fix before merging:`,
    '',
    ...handFix.map((k) => `- ${handFixLine(k)}`),
    '',
  ];
}

/** The hand-fix list, as saved beside the setup worktree, read back: an array of { file, names, live, failing }, or null if it does not read. */
export function parseHandFix(text) {
  if (text == null) return [];
  let v;
  try { v = JSON.parse(text); } catch { return null; }
  if (!Array.isArray(v)) return null;
  const good = v.every((k) => k && typeof k.file === 'string' && [k.names, k.live, k.failing].every(Array.isArray));
  return good ? v : null;
}

/** The pull request's section on retired tests; none when nothing was retired. */
export function retiredSection(retired, { projectName, base }) {
  if (!retired.length) return [];
  return [
    `**Tests retired.** These ${retired.length} test file(s) of ${projectName}'s own checked its old copy of the loop, which this setup replaces, so they are deleted on this branch. Each was retired by one rule, not by hand: ${RETIRE_RULE}${base ? ` (\`${String(base).slice(0, 7)}\`)` : ''}. Check each before merging:`,
    '',
    ...retired.map((r) => `- ${retiredLine(r)}`),
    '',
  ];
}

/** The retired list, as saved beside the setup worktree, read back: an array of { file, names, via }, or null if it does not read. */
export function parseRetired(text) {
  if (text == null) return [];
  let v;
  try { v = JSON.parse(text); } catch { return null; }
  if (!Array.isArray(v)) return null;
  const good = v.every((r) => r && typeof r.file === 'string' && Array.isArray(r.names) && Array.isArray(r.via));
  return good ? v : null;
}
