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
 * it checks the loop's own files. A test that fails on main too, or that
 * names none of the setup's files, is never retired: the setup branch's
 * verify then fails, and the wizard stops before it stops the old loops.
 * Nothing here decides by hand, and nothing here runs a command: the copy
 * step (scripts/onboard/copy.mjs) runs the tests and asks these functions.
 */
import { basename } from 'node:path';

/** A test file of the project's own that can be run alone with `node --test`. */
export const TEST_FILE = /\.test\.(?:c|m)?js$/;

/** How one test file is run alone: this, then its path. Plain Node (engineering rule 8). */
export const RUN_ONE_TEST = Object.freeze(['node', '--test']);

/**
 * The environment one test runs alone in: the caller's, without
 * NODE_TEST_CONTEXT, which a run started from inside `node --test` inherits
 * and which makes the inner run report to its parent instead of failing.
 * (An undefined value is left out of the child's environment.)
 */
export const RUN_ONE_TEST_ENV = Object.freeze({ NODE_TEST_CONTEXT: undefined });

/** The rule, as the pull request states it. */
export const RETIRE_RULE = 'it fails when run alone on this branch, passes when run alone on the commit this branch started from, and it (or a file of this repository it names) names a file this setup writes';

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

/**
 * The project's test files that meet rule 3, each with the setup's files it
 * names and the repository files it names them through.
 *
 *   testFiles  the test files on the commit the setup started from
 *   repoFiles  every file of the repository on that commit
 *   written    every path the setup writes (replaced or new)
 *   read       (path) → that file's text on the setup branch, or null
 *
 * A file the setup writes is never a candidate: it is the loop's own.
 */
export function retireCandidates({ testFiles, repoFiles, written, read }) {
  const writes = [...new Set(written)];
  const writtenSet = new Set(writes);
  const others = [...new Set(repoFiles)].filter((p) => p && !writtenSet.has(p));
  const out = [];
  for (const file of [...new Set(testFiles)].filter((f) => TEST_FILE.test(f) && !writtenSet.has(f)).sort()) {
    const text = read(file);
    if (text == null) continue;
    // Named directly, that is the reason given; only a test that names none
    // of them itself is looked at through the files it names.
    const direct = namesIn(text, writes);
    if (direct.length) { out.push({ file, names: [...direct].sort(), via: [] }); continue; }
    const names = new Set();
    const via = [];
    for (const n of namesIn(text, others.filter((p) => p !== file))) {
      const hits = namesIn(read(n), writes);
      if (hits.length) { via.push(n); hits.forEach((h) => names.add(h)); }
    }
    if (names.size) out.push({ file, names: [...names].sort(), via: via.sort() });
  }
  return out;
}

/** Rules 1 and 2: retired only when it fails alone on the setup branch and passes alone where it started. */
export function retireVerdict({ setupCode, baseCode }) {
  if (setupCode === 0) return { retire: false, why: 'passes on the setup branch' };
  if (baseCode !== 0) return { retire: false, why: 'fails on the commit the setup started from too, so the setup is not what breaks it' };
  return { retire: true, why: 'fails on the setup branch only' };
}

/**
 * Rules 1 and 2 over the candidates: each run alone on the setup branch, and
 * the ones that fail there run alone where the branch started. `runOnSetup`
 * and `runOnBase` take a test file and give its exit code; `beforeBase` runs
 * once, only if some candidate fails on the setup branch (the copy step makes
 * the base's scratch worktree there). Returns { retired, kept }, kept naming
 * why each failing test that is not retired stays.
 */
export function pickRetired({ candidates, runOnSetup, runOnBase, beforeBase = () => {} }) {
  const failing = candidates.map((c) => ({ c, setupCode: runOnSetup(c.file) })).filter((x) => x.setupCode !== 0);
  if (!failing.length) return { retired: [], kept: [], failing: 0 };
  beforeBase(failing.length);
  const retired = [];
  const kept = [];
  for (const { c, setupCode } of failing) {
    const v = retireVerdict({ setupCode, baseCode: runOnBase(c.file) });
    if (v.retire) retired.push(c);
    else kept.push({ file: c.file, why: v.why });
  }
  return { retired, kept, failing: failing.length };
}

/** One line per retired test, for the pull request and the run's own output. */
export function retiredLine(r, most = 5) {
  const some = (list) => {
    const shown = list.slice(0, most).map((n) => `\`${n}\``).join(', ');
    return list.length > most ? `${shown} and ${list.length - most} more` : shown;
  };
  const through = r.via.length ? ` (through ${some(r.via)})` : '';
  return `\`${r.file}\`: names ${some(r.names)}${through}`;
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
