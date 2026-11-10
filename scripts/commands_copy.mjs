#!/usr/bin/env node
/**
 * `npm run commands:copy` (SP-179): refresh `commands/`, this repository's
 * copy of Dane's own slash commands, from `~/.claude/skills/` on the machine
 * it runs on (the MacBook, where they live). The Docs page's Commands
 * section lists the copy; the copy changes through a normal pull request.
 *
 * For each folder in `~/.claude/skills/` holding a `SKILL.md` with a `name:`
 * and a `description:` line, that one file is copied to
 * `commands/<folder>/SKILL.md`. Nothing else in the folder is copied, and a
 * folder without a `SKILL.md` (such as `synced/`) is passed over. A copy
 * whose original is gone is removed.
 *
 * It prints one line per command: `copied <name>`, `unchanged <name>` or
 * `removed <name>`. It writes nothing, and exits 1, when any file looks like
 * it holds a key (this repository is public), when a name is not plain
 * letters, digits and dashes, or when it finds no commands at all (so a run
 * on a machine without them never empties the copy).
 *
 *   npm run commands:copy                 # from ~/.claude/skills into this checkout
 *   node scripts/commands_copy.mjs --home <folder> --repo <folder>
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findSecrets } from './lib/secretScan.mjs';
import { COMMAND_NAME, parseSkill } from '../tracker/commands.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));

const isDir = (p) => { try { return lstatSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return lstatSync(p).isFile(); } catch { return false; } };

/**
 * Refresh `<repo>/commands` from `<home>/.claude/skills`. Answers the exit
 * code; every line it prints goes through `out` (or `err` for a refusal).
 */
export function copyCommands({ home = homedir(), repo = REPO, out = console.log, err = console.error } = {}) {
  const from = join(home, '.claude', 'skills');
  const to = join(repo, 'commands');
  if (!isDir(from)) {
    err(`commands:copy: ${from} is not a folder, so there is nothing to copy. Run this on the machine your commands live on. Nothing was written.`);
    return 1;
  }
  const found = [];
  const problems = [];
  for (const folder of readdirSync(from).sort()) {
    const file = join(from, folder, 'SKILL.md');
    if (!isDir(join(from, folder)) || !isFile(file)) continue;
    const text = readFileSync(file, 'utf8');
    const skill = parseSkill(text);
    if (!skill || !skill.name || !skill.description) {
      out(`skipped ${folder}: its SKILL.md has no name: and description: lines`);
      continue;
    }
    if (!COMMAND_NAME.test(folder) || !COMMAND_NAME.test(skill.name)) {
      problems.push(`${folder}: the name ${JSON.stringify(COMMAND_NAME.test(folder) ? skill.name : folder)} is not plain letters, digits and dashes`);
      continue;
    }
    for (const hit of findSecrets(`commands/${folder}/SKILL.md`, text)) problems.push(`${folder}/SKILL.md ${hit}`);
    found.push({ name: folder, text });
  }
  if (problems.length) {
    for (const p of problems) err(`commands:copy: ${p}`);
    err(`commands:copy: refused, nothing was written. This repository is public; fix ${problems.length === 1 ? 'that file' : 'those files'} in ${from} and run it again.`);
    return 1;
  }
  if (!found.length) {
    err(`commands:copy: found no commands in ${from}, so the copy in ${to} was left as it is. Run this on the machine your commands live on.`);
    return 1;
  }
  const keep = new Set(found.map((c) => c.name));
  for (const { name, text } of found) {
    const target = join(to, name, 'SKILL.md');
    if (isFile(target) && readFileSync(target, 'utf8') === text) {
      out(`unchanged ${name}`);
      continue;
    }
    mkdirSync(join(to, name), { recursive: true });
    writeFileSync(target, text);
    if (readFileSync(target, 'utf8') !== text) {
      err(`commands:copy: ${target} did not read back as written.`);
      return 1;
    }
    out(`copied ${name}`);
  }
  if (isDir(to)) {
    for (const name of readdirSync(to).sort()) {
      if (keep.has(name) || !COMMAND_NAME.test(name) || !isFile(join(to, name, 'SKILL.md'))) continue;
      rmSync(join(to, name), { recursive: true });
      if (existsSync(join(to, name))) {
        err(`commands:copy: ${join(to, name)} could not be removed.`);
        return 1;
      }
      out(`removed ${name}`);
    }
  }
  return 0;
}

/** `--home <folder>` and `--repo <folder>`; anything else is refused. */
export function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if ((flag === '--home' || flag === '--repo') && argv[i + 1]) opts[flag.slice(2)] = argv[(i += 1)];
    else throw new Error(`unknown argument ${JSON.stringify(flag)}; the only ones are --home <folder> and --repo <folder>`);
  }
  return opts;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`commands:copy: ${e.message}`);
    process.exit(2);
  }
  process.exit(copyCommands(opts));
}
