#!/usr/bin/env node
/**
 * Parse every script in scripts/ with `node --check`. A syntax error in a
 * script that only runs on a schedule, or only on another machine, is a
 * script that quietly never runs — this makes it a red CI line instead.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(mjs|cjs|js)$/.test(name)) out.push(full);
  }
  return out;
}

const files = walk('scripts');
let failed = 0;
for (const file of files) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) {
    failed += 1;
    console.error(`SYNTAX ERROR in ${file}\n${r.stderr}`);
  }
}
if (!files.length) {
  console.error('check:syntax found no files under scripts/ — that is a failure, not a pass.');
  process.exit(1);
}
console.log(`check:syntax: ${files.length - failed} of ${files.length} files parse${failed ? ` — ${failed} FAILED` : ''}.`);
process.exit(failed ? 1 : 0);
