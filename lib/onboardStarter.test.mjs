import test from 'node:test';
import assert from 'node:assert/strict';
import { readEmptiness, STARTER_FILES, starterFiles, starterNode } from './onboardStarter.mjs';

const answers = { projectSlug: 'upwork-blaster', projectName: 'Upwork Blaster', githubRepo: 'mentor24-maker/upwork-blaster', nodeVersion: null };

test('starterNode: the answers\' version as written, else this Mac\'s major; .nvmrc the major either way', () => {
  assert.deepEqual(starterNode(null, 'v22.23.3'), { engine: '>=22', major: '22', source: "this Mac's Node, v22.23.3" });
  assert.equal(starterNode('>=22.12', 'v24.1.0').engine, '>=22.12');
  assert.equal(starterNode('>=22.12', 'v24.1.0').major, '22');
  assert.equal(starterNode('20', 'v22.1.0').major, '20');
  // "<23" names no lower bound: .nvmrc takes this Mac's major.
  assert.equal(starterNode('<23', 'v22.1.0').major, '22');
  assert.equal(starterNode('lts/*', 'v22.1.0'), null);
  assert.equal(starterNode(null, 'not a version'), null);
});

test('starterFiles: every template filled from the answers, nothing left in braces, plus the lock file npm ci needs', () => {
  const files = starterFiles(answers, 'v22.23.3');
  assert.deepEqual(files.map((f) => f.path), [...STARTER_FILES.map((f) => f.to), 'package-lock.json']);
  for (const f of files) assert.doesNotMatch(f.text, /\{\{/, f.path);
  const pkg = JSON.parse(files.find((f) => f.path === 'package.json').text);
  assert.equal(pkg.name, 'upwork-blaster');
  assert.equal(pkg.engines.node, '>=22');
  assert.ok(pkg.scripts.verify);
  const lock = JSON.parse(files.find((f) => f.path === 'package-lock.json').text);
  assert.equal(lock.packages[''].name, 'upwork-blaster');
  assert.match(files.find((f) => f.path === 'README.md').text, /^# Upwork Blaster\n/);
  assert.equal(files.find((f) => f.path === '.nvmrc').text, '22\n');
});

test('starterFiles refuses when there is no Node version to write', () => {
  assert.throws(() => starterFiles({ ...answers, nodeVersion: 'lts/*' }, 'v22.1.0'), /no Node version to write/);
});

test('readEmptiness reads gh repo view\'s answer, and nothing else', () => {
  assert.deepEqual(readEmptiness('{"isEmpty":true,"defaultBranchRef":null}'), { empty: true, branch: null });
  assert.deepEqual(readEmptiness('{"isEmpty":false,"defaultBranchRef":{"name":"main"}}'), { empty: false, branch: 'main' });
  assert.equal(readEmptiness('{}'), null);
  assert.equal(readEmptiness('nope'), null);
});
