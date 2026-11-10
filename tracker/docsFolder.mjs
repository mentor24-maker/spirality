/**
 * Spirality's own documentation, read for the Docs page (SP-175): the
 * Markdown files in a folder (the repository's `docs/`) and its subfolders,
 * listed by title, and one of them read by its path.
 *
 * Read only, and only ever inside that folder. A path is taken only when
 * every piece of it is a plain name (letters, digits, `.`, `_`, `-`, never
 * starting with a dot, so never `..`) ending in `.md`; it is then resolved
 * and checked again to sit inside the folder, and its real location (any
 * link followed) checked a third time. Anything else is "not there" (null),
 * and nothing is opened. A link in the folder is never listed or followed
 * out of it.
 */

import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const PIECE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/** Whether `rel` is a path the folder may answer: plain pieces, a `.md` file. */
export function safeDocPath(rel) {
  const text = String(rel ?? '');
  if (!text.endsWith('.md') || text.length > 300) return false;
  return text.split('/').every((piece) => PIECE.test(piece));
}

/**
 * The file's title: its first `# ` heading outside fenced code (a `# comment`
 * in a bash block is not a heading), else its file name without `.md`.
 */
export function docTitle(text, rel) {
  let fence = null;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const run = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (run && run[1][0] === fence[0] && run[1].length >= fence.length && !line.trim().slice(run[1].length).trim()) fence = null;
      continue;
    }
    if (run) { fence = run[1]; continue; }
    const m = /^#[ \t]+(.+?)[ \t#]*$/.exec(line);
    if (m) return m[1].trim();
  }
  return String(rel).split('/').pop().replace(/\.md$/, '');
}

/** Whether `path` is `dir` itself or sits inside it. */
const inside = (dir, path) => path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/**
 * Every `.md` file under `dir`, as `{ path, title }` with `path` relative
 * to `dir` ('onboarding/WIZARD.md'), the folder's own files first, then
 * each subfolder's, each in name order. Only real files and folders count:
 * a link is skipped. A folder that does not exist lists nothing.
 */
export function listDocs(dir) {
  const root = resolve(dir);
  const found = [];
  const walk = (folder) => {
    let entries;
    try {
      entries = readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(folder, entry.name);
      const rel = relative(root, full).split(sep).join('/');
      if (entry.isDirectory() && PIECE.test(entry.name)) walk(full);
      else if (entry.isFile() && safeDocPath(rel)) found.push({ path: rel, title: docTitle(readFileSync(full, 'utf8'), rel) });
    }
  };
  walk(root);
  const depth = (p) => p.split('/').length;
  return found.sort((a, b) => depth(a.path) - depth(b.path) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * One file under `dir` by its relative path, as `{ path, title, text }`,
 * or null when the path is not one the folder answers (safeDocPath), lies
 * outside the folder, is not a plain file, or is not there. Nothing outside
 * `dir` is ever opened: every check runs before the read.
 */
export function readDoc(dir, rel) {
  if (!safeDocPath(rel)) return null;
  const root = resolve(dir);
  const full = resolve(root, rel);
  if (!inside(root, full) || full === root) return null;
  try {
    if (!lstatSync(full).isFile()) return null;
    if (!inside(realpathSync(root), realpathSync(full))) return null;
    const text = readFileSync(full, 'utf8');
    return { path: rel, title: docTitle(text, rel), text };
  } catch {
    return null;
  }
}
