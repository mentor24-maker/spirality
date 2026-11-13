/**
 * laneFiles.mjs — every file a lane keeps in the shared log folder is named
 * for its project (SP-263, slice 1 of move 2 in docs/INTEGRATION.md).
 *
 * The log folder (`logDir`, `~/loop-logs` today) is shared by every project
 * on the Mini. A lock, wake file, log, sync lock, pass snapshot or stand-down
 * file named without the project would be read by every project's lanes, so
 * one project pausing or standing down would stop all of them. StarCaster's
 * old `~/loop-logs/loops.standdown` is that kind of name; it is harmless today
 * only because StarCaster's own code is the one thing that reads it.
 *
 * So every name is `<projectSlug>-<name>`, built here or written the same way
 * in the shell runners, and `unscopedLaneFiles` is the check the tests run
 * over every runner, the relay, the installer and the modules that name a
 * file in the log folder: a name that does not start with the project's slug
 * fails the build.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The stand-down file's name after the slug: `<projectSlug>-standdown`. */
export const STANDDOWN = 'standdown';

/** `~` at the start of the folder, as the operator types it, made a real path. */
export function expandLogDir(logDir, home = homedir()) {
  return /^~(\/|$)/.test(String(logDir || '')) ? String(logDir).replace(/^~/, home) : String(logDir || '');
}

/**
 * The path of one lane file for one project: `<logDir>/<projectSlug>-<name>`.
 * Refuses a config with no slug or no folder, and a name that is a path,
 * rather than writing a file every project would read.
 */
export function laneFile({ logDir, projectSlug } = {}, name, { home = homedir() } = {}) {
  if (!String(projectSlug || '').trim()) throw new Error('laneFile: the project config has no projectSlug, so the file would be shared by every project');
  if (!String(logDir || '').trim()) throw new Error('laneFile: the project config has no logDir');
  if (!String(name || '').trim() || /[/\\]/.test(name)) throw new Error(`laneFile: "${name ?? ''}" is not a file name`);
  return join(expandLogDir(logDir, home), `${projectSlug}-${name}`);
}

/** Where a project's stand-down file lives, when Spirality writes one: `<logDir>/<projectSlug>-standdown`. */
export function standdownFile(config, opts) {
  return laneFile(config, STANDDOWN, opts);
}

/**
 * A name counts as the project's when it starts with the slug, however the
 * code spells it: `$SLUG-`, `${SLUG}-` in the shell runners; `${slug}-`,
 * `${projectSlug}-`, `${config.projectSlug}-` or `${projectSlug()}-` in a
 * module.
 */
const SCOPED = /^\$\{?(?:[\w]+\.)*(?:SLUG|slug|projectSlug)(?:\(\))?\}?-/;

/** Comment lines out, so prose about a file (`<logDir>/<slug>-<lane>.wake`) is not read as code. */
function codeLines(text, lang) {
  return String(text || '').split('\n').map((l, i) => ({ n: i + 1, l })).filter(({ l }) => {
    const t = l.trim();
    if (lang === 'sh') return !t.startsWith('#');
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
  });
}

/** The part after the last `/` of a name some code put in the log folder. */
const baseOf = (name) => name.slice(name.lastIndexOf('/') + 1);

/**
 * Every file name a source file puts in the log folder, as
 * `[{ line, name, scoped }]`. What counts as "in the log folder":
 *
 *   sh  `$LOG_DIR/<name>` or `${LOG_DIR}/<name>`
 *   js  `join(<logDir|folder|dir|logDir()|expandHome(…logDir…)>, <literal>)`,
 *       `${logDir}/<name>` or `${logDir()}/<name>` in a template, and any
 *       literal naming `loop-logs/<name>` (the folder typed in)
 */
export function laneFileNames(text, { lang = 'js' } = {}) {
  const found = [];
  const add = (n, raw) => {
    const name = raw.replace(/["'`;)]+$/, '');
    if (!name) return;
    found.push({ line: n, name, scoped: SCOPED.test(baseOf(name)) });
  };
  for (const { n, l } of codeLines(text, lang)) {
    if (lang === 'sh') {
      for (const m of l.matchAll(/\$\{?LOG_DIR\}?\/([^\s"';)]+)/g)) add(n, m[1]);
      continue;
    }
    for (const m of l.matchAll(/join\(\s*(?:logDir(?:\(\))?|folder|dir|expandHome\([^()]*logDir\)|expandLogDir\([^()]*\))\s*,\s*([`'"])([^`'"]+)\1/g)) add(n, m[2]);
    for (const m of l.matchAll(/\$\{logDir(?:\(\))?\}\/([^\s`'")]+)/g)) add(n, m[1]);
    for (const m of l.matchAll(/loop-logs\/([^\s`'")]+)/g)) add(n, m[1]);
  }
  return found;
}

/** Only the names that do NOT carry the project's slug: an empty list is a pass. */
export function unscopedLaneFiles(text, opts) {
  return laneFileNames(text, opts).filter((f) => !f.scoped);
}
