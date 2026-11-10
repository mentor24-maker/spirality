/**
 * The Docs page's Commands section (SP-179): every slash command a session
 * on this repository can be given, with what it does and its steps.
 *
 * Two folders hold them, both inside the tracker's own checkout:
 *
 *   commands/<name>/SKILL.md          Dane's own commands, a copy kept here
 *                                     (`npm run commands:copy` refreshes it)
 *   .claude/skills/<name>/SKILL.md    the repository's loop skills
 *
 * Only a `SKILL.md` directly inside a folder directly inside one of those two
 * is read. A name that is not plain letters, digits and dashes, a link
 * (symbolic or otherwise) in place of a folder or a file, or anything deeper
 * is passed over without being opened, so no other file is ever read.
 */
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The checkout this file sits in: where the two folders are looked for. */
export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The two folders, in the order the list shows them, each with how the page names where a command comes from. */
export const COMMAND_FOLDERS = Object.freeze([
  { folder: 'commands', source: 'Your command' },
  { folder: '.claude/skills', source: 'Loop skill' },
]);

/** A command's name: plain letters, digits and dashes. */
export const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/**
 * A SKILL.md's front matter (the `---` block at its top) as `{ name,
 * description }`, and its steps (the text below the block). A value may be
 * quoted, or folded over indented lines after `>` or `|`. Null when the file
 * has no front matter.
 */
export function parseSkill(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return null;
  const fields = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const kv = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let value = kv[2].trim();
    if (/^[>|][+-]?$/.test(value)) {
      const folded = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) folded.push(lines[(i += 1)].trim());
      value = folded.join(value.startsWith('|') ? '\n' : ' ');
    } else if (/^(["']).*\1$/.test(value) && value.length >= 2) {
      value = value.slice(1, -1);
    }
    fields[kv[1]] = value;
  }
  return { name: fields.name ?? null, description: fields.description ?? null, steps: text.slice(m[0].length).replace(/^\s*\n/, '') };
}

/** The file system calls this module makes, so a test can see every path it touches. */
const DISK = { readdir: (p) => readdirSync(p), lstat: (p) => lstatSync(p), read: (p) => readFileSync(p, 'utf8') };

/** `lstat`, or null when the path is not there. */
function look(disk, path) {
  try {
    return disk.lstat(path);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
}

/**
 * Every command in the two folders under `root`, as `{ name, source,
 * description, steps }`: Your commands first, then Loop skills, each by
 * name. A missing folder lists nothing. A file without a `name:` and
 * `description:` line is left out. A name taken by both folders is listed
 * once, as Your command.
 */
export function listCommands({ root = REPO_ROOT, disk = DISK } = {}) {
  const out = [];
  const seen = new Set();
  for (const { folder, source } of COMMAND_FOLDERS) {
    const dir = join(root, folder);
    const stat = look(disk, dir);
    if (!stat || !stat.isDirectory()) continue;
    const names = disk.readdir(dir).filter((n) => COMMAND_NAME.test(n)).sort();
    for (const name of names) {
      const sub = look(disk, join(dir, name));
      if (!sub || !sub.isDirectory()) continue;
      const file = join(dir, name, 'SKILL.md');
      const f = look(disk, file);
      if (!f || !f.isFile()) continue;
      const skill = parseSkill(disk.read(file));
      if (!skill || !skill.name || !COMMAND_NAME.test(skill.name) || !skill.description || seen.has(skill.name)) continue;
      seen.add(skill.name);
      out.push({ name: skill.name, source, description: skill.description, steps: skill.steps });
    }
  }
  return out;
}
