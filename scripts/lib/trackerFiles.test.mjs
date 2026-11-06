// scripts/lib/trackerFiles.mjs (SP-150): the files the tracker server loads,
// from its imports, so a pull that changes any of them restarts it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ALSO_WATCHED, importGraph, relativeSpecifiers, SERVER_ENTRY, watchList } from './trackerFiles.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'tracker-files-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

test('it reads every relative specifier form and skips packages', () => {
  const text = [
    "import a from './a.mjs';",
    "import { b } from \"../lib/b.js\";",
    "export { c } from './c.mjs';",
    "import './side.mjs';",
    "const d = await import('./d.mjs');",
    "const e = require('./e');",
    "import { readFileSync } from 'node:fs';",
    "const x = require('some-package');",
  ].join('\n');
  assert.deepEqual(relativeSpecifiers(text), ['./a.mjs', '../lib/b.js', './c.mjs', './side.mjs', './d.mjs', './e']);
});

test('it follows imports through files outside tracker/, including require without an extension', () => {
  const root = tree({
    'tracker/server.mjs': "import x from '../lib/one.js';\nimport { p } from './page.mjs';\n",
    'tracker/page.mjs': "import { q } from '../scripts/lib/two.mjs';\n",
    'lib/one.js': "const t = require('./three');\nmodule.exports = t;\n",
    'lib/three.js': 'module.exports = 3;\n',
    'scripts/lib/two.mjs': 'export const q = 2;\n',
    'lib/unused.js': 'module.exports = 0;\n',
  });
  assert.deepEqual(importGraph(root), [
    'lib/one.js', 'lib/three.js', 'scripts/lib/two.mjs', 'tracker/page.mjs', 'tracker/server.mjs',
  ]);
  assert.deepEqual(watchList(root), ['tracker/', 'lib/one.js', 'lib/three.js', 'scripts/lib/two.mjs', ...ALSO_WATCHED]);
});

test('an import that resolves to nothing is still listed, so the file counts once it appears', () => {
  const root = tree({ 'tracker/server.mjs': "import x from '../lib/later.mjs';\n" });
  assert.deepEqual(importGraph(root), ['lib/later.mjs', 'tracker/server.mjs']);
});

test('a checkout with no server is an error, never an empty list', () => {
  const root = tree({ 'lib/one.js': '' });
  assert.throws(() => importGraph(root), /tracker\/server\.mjs not found/);
  const r = spawnSync(process.execPath, [join(HERE, 'trackerFiles.mjs'), root], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /could not work out what the tracker server loads/);
});

test('the real server: its modules outside tracker/ and the project config are on the list', () => {
  const list = watchList(REPO);
  // Files that merges changed without touching tracker/ (c98f872 changed
  // lib/onboardAnswers.mjs and scripts/lib/repoCheck.mjs).
  for (const f of ['tracker/', 'lib/projectConfig.mjs', 'lib/loopStatuses.js', 'lib/onboardAnswers.mjs',
    'lib/waitingOnOperator.js', 'scripts/lib/loopStatuses.mjs', 'scripts/onboard/onboard.mjs',
    'spirality.project.json', 'package-lock.json']) {
    assert.ok(list.includes(f), `${f} is watched`);
  }
});

test('the real server: every relative import of every file it reaches is on the list', () => {
  // The guard that fails the day the server gains an import the walk misses.
  const list = new Set(watchList(REPO));
  const reached = importGraph(REPO);
  assert.ok(reached.includes(SERVER_ENTRY));
  for (const file of reached) {
    if (!/\.(m|c)?js$/.test(file)) continue;
    for (const spec of relativeSpecifiers(readFileSync(join(REPO, file), 'utf8'))) {
      const target = join(dirname(file), spec).split('\\').join('/');
      if (target.startsWith('tracker/')) continue;
      const hit = [target, `${target}.js`, `${target}.mjs`].some((t) => list.has(t));
      assert.ok(hit, `${file} imports ${spec}, which is not watched`);
    }
  }
});

test('the real server: every file Node actually loads for it is on the list', () => {
  // An independent check, not the walk checking itself: import the server
  // under a load hook and record every file Node loads (ESM through the hook,
  // CommonJS through require.cache). Importing does not start it: server.mjs
  // listens only when run as the main script.
  const dir = mkdtempSync(join(tmpdir(), 'tracker-loads-'));
  const out = join(dir, 'loaded');
  writeFileSync(join(dir, 'hooks.mjs'), [
    "import { appendFileSync } from 'node:fs';",
    'export async function load(url, context, next) {',
    "  if (url.startsWith('file:')) appendFileSync(process.env.TRACE_OUT, url + '\\n');",
    '  return next(url, context);',
    '}',
  ].join('\n'));
  writeFileSync(join(dir, 'main.mjs'), [
    "import { register, createRequire } from 'node:module';",
    "import { appendFileSync } from 'node:fs';",
    "import { pathToFileURL } from 'node:url';",
    "register(pathToFileURL(process.argv[2]).href);",
    'await import(pathToFileURL(process.argv[3]).href);',
    'const cache = Object.keys(createRequire(import.meta.url).cache);',
    "appendFileSync(process.env.TRACE_OUT, cache.map((f) => pathToFileURL(f).href).join('\\n') + '\\n');",
  ].join('\n'));
  const r = spawnSync(process.execPath, [join(dir, 'main.mjs'), join(dir, 'hooks.mjs'), join(REPO, SERVER_ENTRY)], {
    cwd: REPO, encoding: 'utf8', env: { ...process.env, TRACE_OUT: out },
  });
  assert.equal(r.status, 0, r.stderr);
  const root = `${pathToFileURL(REPO).href}/`;
  const loaded = [...new Set(readFileSync(out, 'utf8').split('\n').filter((u) => u.startsWith(root)))]
    .map((u) => decodeURIComponent(u.slice(root.length)));
  const list = new Set(watchList(REPO));
  const outside = loaded.filter((f) => !f.startsWith('tracker/') && !f.startsWith('node_modules/'));
  assert.ok(outside.includes('lib/projectConfig.mjs'), `the trace saw the server's imports: ${outside.join(', ')}`);
  for (const f of outside) assert.ok(list.has(f), `the server loads ${f}, which is not watched`);
});

test('the CLI prints the watch list one path per line', () => {
  const r = spawnSync(process.execPath, [join(HERE, 'trackerFiles.mjs'), REPO], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n'), watchList(REPO));
});
