// The files the tracker server loads, worked out from its import graph, so a
// pull that changes any of them restarts it (SP-150). Used by
// scripts/lib/tracker_restart.sh; tested by scripts/lib/trackerFiles.test.mjs.
//
// The first cut restarted only on changes under tracker/. But the server
// imports modules from lib/ and scripts/ too (lib/projectConfig.mjs,
// scripts/tracker/clickupTracker.mjs, lib/onboardAnswers.mjs, ...), and reads
// the project config at startup, so merges that changed only those left it on
// old code. A hand-kept list would drift the day the server gains an import;
// following the imports cannot.
//
// The walk follows relative specifiers only (a path starting ./ or ../), in
// all four forms: import-from, export-from, dynamic import() and require(),
// each with a string literal. Packages (bare specifiers like `node:fs`) live in node_modules,
// which follows package-lock.json, so that file is on the list instead. A
// match inside a comment only adds a file, which costs at most one extra
// restart, never a missed one.
//
//   node scripts/lib/trackerFiles.mjs [repo]   prints the watch list, one
//                                              path per line, repo-relative
//                                              (a folder ends in /); exit 1
//                                              when it cannot be worked out.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONFIG_FILE } from '../../lib/projectConfig.mjs';

/** What launchd runs (scripts/install_loop_runner.sh writes this path). */
export const SERVER_ENTRY = 'tracker/server.mjs';

/** Loaded by the server without an import: the config it reads at startup,
 * and the files node_modules is installed from. */
export const ALSO_WATCHED = [CONFIG_FILE, 'package.json', 'package-lock.json'];

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(['"])([^'"\n]+)\1/g;

/** Relative specifiers named in one file's text. */
export function relativeSpecifiers(text) {
  const found = [];
  for (const m of text.matchAll(SPECIFIER)) {
    if (m[2].startsWith('./') || m[2].startsWith('../')) found.push(m[2]);
  }
  return found;
}

// A require() may leave off the extension; an import never may, but trying
// the same candidates costs nothing.
function resolveFile(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}.json`, join(base, 'index.js')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * Every file reachable from `entry` through relative imports, repo-relative,
 * sorted. A specifier that resolves to nothing is listed as written (resolved
 * against its importer), so a file that appears later still counts.
 */
export function importGraph(repo, entry = SERVER_ENTRY) {
  const root = resolve(repo);
  const seen = new Set();
  const listed = new Set();
  const todo = [resolve(root, entry)];
  if (!existsSync(todo[0])) throw new Error(`${entry} not found in ${root}`);
  while (todo.length) {
    const file = todo.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    listed.add(file);
    if (!/\.(m|c)?js$/.test(file)) continue;
    for (const spec of relativeSpecifiers(readFileSync(file, 'utf8'))) {
      const target = resolveFile(file, spec);
      if (target) todo.push(target);
      else listed.add(resolve(dirname(file), spec));
    }
  }
  return [...listed]
    .map((f) => relative(root, f).split(sep).join('/'))
    .filter((f) => f && !f.startsWith('../'))
    .sort();
}

/**
 * The paths a pull is checked against: the whole tracker/ folder (its web
 * files are read at startup too), every file the server imports from outside
 * it, and ALSO_WATCHED.
 */
export function watchList(repo) {
  const outside = importGraph(repo).filter((f) => !f.startsWith('tracker/'));
  return ['tracker/', ...outside, ...ALSO_WATCHED];
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    process.stdout.write(`${watchList(process.argv[2] || process.cwd()).join('\n')}\n`);
  } catch (err) {
    process.stderr.write(`trackerFiles: could not work out what the tracker server loads: ${err.message}\n`);
    process.exit(1);
  }
}
