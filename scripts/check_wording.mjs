#!/usr/bin/env node
/**
 * Fails when the word the loop replaced with "project" (SP-128, SP-156)
 * comes back, as a whole word, in any file of the repository outside the
 * work log, naming each file and line (scripts/lib/wordingScan.mjs says what
 * it looks for and the few old names it lets through). Checks tracked files
 * plus new files not yet committed, as check:secrets does, so it catches the
 * word before the commit.
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { findWording } from './lib/wordingScan.mjs';

const r = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' });
if (r.status !== 0) {
  console.error(`check:wording could not list files with git: ${(r.stderr || r.error?.message || '').trim()}`);
  process.exit(1);
}
const files = r.stdout.split('\0').filter(Boolean);
if (!files.length) {
  console.error('check:wording found no files — that is a failure, not a pass.');
  process.exit(1);
}

let bad = 0;
let read = 0;
for (const file of files) {
  let text = null;
  try {
    const buf = readFileSync(file);
    if (!buf.includes(0)) text = buf.toString('utf8'); // skip binary files' contents
    read += 1;
  } catch {
    continue; // listed by git but deleted in the working tree
  }
  for (const hit of findWording(file, text)) {
    bad += 1;
    console.error(`${file}:${hit.line}: "${hit.word}" — ${hit.text}`);
  }
}
if (bad) {
  console.error(`check:wording FAILED: ${bad} use(s) in ${read} file(s) scanned. Say "project" (and "projects") instead; the work log is the only place the old word stays.`);
  process.exit(1);
}
console.log(`check:wording passed: ${read} file(s) scanned, every one says "project".`);
