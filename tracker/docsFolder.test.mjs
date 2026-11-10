import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { docTitle, listDocs, readDoc, safeDocPath } from './docsFolder.mjs';

function folder() {
  const dir = mkdtempSync(join(tmpdir(), 'docs-folder-'));
  const docs = join(dir, 'docs');
  mkdirSync(join(docs, 'work-log'), { recursive: true });
  writeFileSync(join(docs, 'PLAN.md'), '# The Plan\n\ntext\n');
  writeFileSync(join(docs, 'work-log', '2026-11-10-x.md'), '## 2026-11-10 — X (#1)\n');
  writeFileSync(join(dir, 'outside.md'), '# Outside\n');
  return { dir, docs, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('safeDocPath takes plain pieces ending in .md, never a dot piece, an absolute path or an empty piece', () => {
  for (const ok of ['PLAN.md', 'work-log/2026-11-10-x.md', 'onboarding/WIZARD.md']) assert.equal(safeDocPath(ok), true, ok);
  for (const bad of ['', 'PLAN', 'PLAN.txt', '../outside.md', 'a/../PLAN.md', '/etc/x.md', 'a//b.md', '.hidden.md', './PLAN.md', 'a\\b.md', 'a b.md', `${'a'.repeat(300)}.md`]) {
    assert.equal(safeDocPath(bad), false, bad);
  }
});

test('docTitle is the first "# " heading, else the file name', () => {
  assert.equal(docTitle('intro\n# Loop Contract #\n# Later\n', 'LOOP_CONTRACT.md'), 'Loop Contract');
  assert.equal(docTitle('## Only a second level\n', 'work-log/2026-11-10-x.md'), '2026-11-10-x');
  // A "# comment" inside fenced code is never the title, in either fence style.
  assert.equal(docTitle('```bash\n# install it\nnpm ci\n```\n# Setup\n', 'SETUP.md'), 'Setup');
  assert.equal(docTitle('~~~\n# not this\n~~~\n', 'NOTES.md'), 'NOTES');
  assert.equal(docTitle('````\n```\n# still code\n````\n# Real\n', 'X.md'), 'Real', 'a shorter run does not close a longer fence');
});

test('listDocs lists the folder\'s own files first, then each subfolder\'s, and never a link', () => {
  const f = folder();
  try {
    symlinkSync(join(f.dir, 'outside.md'), join(f.docs, 'linked.md'));
    symlinkSync(f.dir, join(f.docs, 'up'));
    assert.deepEqual(listDocs(f.docs), [
      { path: 'PLAN.md', title: 'The Plan' },
      { path: 'work-log/2026-11-10-x.md', title: '2026-11-10-x' },
    ]);
    assert.deepEqual(listDocs(join(f.dir, 'missing')), []);
  } finally { f.done(); }
});

test('readDoc answers a file inside the folder and opens nothing outside it', () => {
  const f = folder();
  const opened = [];
  const real = fs.readFileSync;
  fs.readFileSync = (path, ...rest) => { opened.push(String(path)); return real(path, ...rest); };
  syncBuiltinESMExports();
  try {
    symlinkSync(join(f.dir, 'outside.md'), join(f.docs, 'linked.md'));
    symlinkSync(f.dir, join(f.docs, 'up'));
    assert.deepEqual(readDoc(f.docs, 'PLAN.md'), { path: 'PLAN.md', title: 'The Plan', text: '# The Plan\n\ntext\n' });
    assert.ok(opened.some((p) => p.endsWith('PLAN.md')), 'the watch on reads sees a real read');
    opened.length = 0;
    for (const bad of ['../outside.md', join(f.dir, 'outside.md'), 'linked.md', 'up/outside.md', 'work-log', 'missing.md', 'work-log/../../outside.md']) {
      assert.equal(readDoc(f.docs, bad), null, bad);
    }
    assert.deepEqual(opened, [], 'no read was attempted for any refused path');
  } finally {
    fs.readFileSync = real;
    syncBuiltinESMExports();
    f.done();
  }
});
