#!/usr/bin/env node
/**
 * The repository is public, so a key in any file is a leaked key. Fails if a
 * file in the repository is a .env file, or contains something shaped like a
 * ClickUp pk_ token or a Supabase service key. Checks tracked files plus new
 * files not yet committed (but not git-ignored ones, like a local .env), so
 * it catches a key before the commit, not after.
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { findSecrets } from './lib/secretScan.mjs';

const r = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' });
if (r.status !== 0) {
  console.error(`check:secrets could not list files with git: ${r.stderr.trim()}`);
  process.exit(1);
}
const files = r.stdout.split('\0').filter(Boolean);
if (!files.length) {
  console.error('check:secrets found no files — that is a failure, not a pass.');
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
  for (const hit of findSecrets(file, text)) {
    bad += 1;
    console.error(`${file}: ${hit}`);
  }
}
console.log(`check:secrets: ${read} file(s) scanned, ${bad} possible secret(s).`);
if (bad) console.error('Remove it, and if it was a real key, rotate it in its own dashboard: the repository is public.');
process.exit(bad ? 1 : 0);
