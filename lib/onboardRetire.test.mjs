// lib/onboardRetire.mjs (SP-252): which of a project's own tests its setup
// pull request retires, by a rule a reviewer can check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  RETIRE_RULE, RUN_ONE_TEST, RUN_ONE_TEST_ENV, TEST_FILE, namesIn, parseRetired, pickRetired, retireCandidates, retireVerdict, retiredLine, retiredSection,
} from './onboardRetire.mjs';

test('namesIn: a written file by its whole path, by its file name standing alone, or required without its ending', () => {
  const written = ['docs/LOOP_ENGINEERING.md', '.claude/skills/loop-build/SKILL.md', 'scripts/loop_runner.sh', 'scripts/lib/clickupCaller.cjs'];
  assert.deepEqual(namesIn("fs.readFileSync(path.join(ROOT, 'docs/LOOP_ENGINEERING.md'))", written), ['docs/LOOP_ENGINEERING.md']);
  assert.deepEqual(namesIn("path.join(dir, 'SKILL.md')", written), ['.claude/skills/loop-build/SKILL.md']);
  assert.deepEqual(namesIn('reads loop_runner.sh at start', written), ['scripts/loop_runner.sh']);
  assert.deepEqual(namesIn("require('../lib/clickupCaller')", written), ['scripts/lib/clickupCaller.cjs']);
  // Glued to other letters, it is another name.
  assert.deepEqual(namesIn("'my_loop_runner.sh' and 'SKILL.md.bak' and old-LOOP_ENGINEERING.md", written), []);
  assert.deepEqual(namesIn('the runner is loop_runner.sh.', written), ['scripts/loop_runner.sh'], 'a full stop ends the sentence');
  assert.deepEqual(namesIn(null, written), []);
});

test('retireCandidates: tests that name a written file, directly or through one file of the repository they name', () => {
  const files = {
    'scripts/builder/wipCap.test.js': "const skill = read('.claude/skills/loop-build/SKILL.md');",
    'scripts/builder/clickupCaller.test.js': "const { KINDS } = require('../lib/clickupCaller.cjs');",
    'scripts/lib/clickupCaller.cjs': "const SCHEDULED_LAUNCHERS = ['loop_runner.sh'];",
    'scripts/builder/themes.test.js': "const { theme } = require('../../lib/theme.js');",
    'lib/theme.js': 'module.exports = { theme: 1 };',
    // Two steps away: never followed.
    'scripts/builder/far.test.js': "require('./near.js')",
    'scripts/builder/near.js': "require('../lib/clickupCaller.cjs')",
    // The setup's own copy of a test: the loop's, never a candidate.
    'loop/lib/passClaim.test.js': "read('scripts/loop_runner.sh')",
    // Not a test file at all.
    'scripts/builder/notATest.js': "read('docs/LOOP_ENGINEERING.md')",
  };
  const repoFiles = Object.keys(files).filter((f) => !f.startsWith('loop/'));
  const written = ['.claude/skills/loop-build/SKILL.md', 'scripts/loop_runner.sh', 'docs/LOOP_ENGINEERING.md', 'loop/lib/passClaim.test.js'];
  const got = retireCandidates({ testFiles: [...repoFiles, 'loop/lib/passClaim.test.js'], repoFiles, written, read: (p) => files[p] ?? null });
  assert.deepEqual(got, [
    { file: 'scripts/builder/clickupCaller.test.js', names: ['scripts/loop_runner.sh'], via: ['scripts/lib/clickupCaller.cjs'] },
    { file: 'scripts/builder/wipCap.test.js', names: ['.claude/skills/loop-build/SKILL.md'], via: [] },
  ]);
});

test('retireVerdict: retired only when it fails on the setup branch and passes where the branch started', () => {
  assert.equal(retireVerdict({ setupCode: 1, baseCode: 0 }).retire, true);
  assert.deepEqual(retireVerdict({ setupCode: 0, baseCode: 0 }), { retire: false, why: 'passes on the setup branch' });
  assert.equal(retireVerdict({ setupCode: 1, baseCode: 1 }).retire, false);
  assert.match(retireVerdict({ setupCode: 1, baseCode: 1 }).why, /fails on the commit the setup started from too/);
  // A run that timed out has no exit code: never a pass.
  assert.equal(retireVerdict({ setupCode: 1, baseCode: null }).retire, false);
  assert.equal(retireVerdict({ setupCode: null, baseCode: 0 }).retire, true);
});

test('pickRetired: the base is made only when something fails on the setup branch, and only those run there', () => {
  const candidates = ['a.test.js', 'b.test.js', 'c.test.js'].map((file) => ({ file, names: ['CLAUDE.md'], via: [] }));
  const ran = [];
  let made = 0;
  const none = pickRetired({ candidates, runOnSetup: () => 0, runOnBase: () => { throw new Error('never'); }, beforeBase: () => { made += 1; } });
  assert.deepEqual(none, { retired: [], kept: [], failing: 0 });
  assert.equal(made, 0);
  const setup = { 'a.test.js': 1, 'b.test.js': 0, 'c.test.js': 1 };
  const base = { 'a.test.js': 0, 'c.test.js': 1 };
  const got = pickRetired({
    candidates,
    runOnSetup: (f) => setup[f],
    runOnBase: (f) => { ran.push(f); return base[f]; },
    beforeBase: (n) => { made += n; },
  });
  assert.deepEqual(got.retired.map((r) => r.file), ['a.test.js']);
  assert.deepEqual(got.kept.map((k) => k.file), ['c.test.js']);
  assert.equal(made, 2);
  assert.deepEqual(ran, ['a.test.js', 'c.test.js'], 'a test that passes on the setup branch never runs on the base');
});

test('pickRetired with real node --test runs: only the old-loop test that the setup breaks is retired', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'onboard-retire-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const put = (root, path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
  const testOf = (body) => `const test = require('node:test');\nconst assert = require('node:assert');\nconst fs = require('node:fs');\nconst path = require('node:path');\ntest('t', () => { ${body} });\n`;
  const tests = {
    // Reads the old loop's skill, which the setup replaces.
    'scripts/builder/wipCap.test.js': testOf("assert.match(fs.readFileSync(path.join(__dirname, '..', '..', '.claude', 'skills', 'loop-build', 'SKILL.md'), 'utf8'), /WIP cap/);"),
    // Names the skill but does not depend on its words.
    'scripts/builder/skillThere.test.js': testOf("assert.ok(fs.existsSync(path.join(__dirname, '..', '..', '.claude', 'skills', 'loop-build', 'SKILL.md')));"),
    // Broken on main already: never the setup's doing.
    'scripts/builder/brokenAlready.test.js': testOf("fs.readFileSync(path.join(__dirname, '..', '..', 'CLAUDE.md'), 'utf8'); assert.equal(1, 2);"),
  };
  const base = join(dir, 'base');
  const setup = join(dir, 'setup');
  for (const root of [base, setup]) {
    for (const [p, text] of Object.entries(tests)) put(root, p, text);
    put(root, 'CLAUDE.md', '# rules\n');
  }
  put(base, '.claude/skills/loop-build/SKILL.md', 'Old loop: the WIP cap is 3.\n');
  put(setup, '.claude/skills/loop-build/SKILL.md', 'Spirality loop-build.\n');
  const written = ['.claude/skills/loop-build/SKILL.md', 'CLAUDE.md'];
  const repoFiles = [...Object.keys(tests), 'CLAUDE.md', '.claude/skills/loop-build/SKILL.md'];
  const read = (p) => { try { return readFileSync(join(setup, p), 'utf8'); } catch { return null; } };
  const candidates = retireCandidates({ testFiles: repoFiles.filter((p) => TEST_FILE.test(p)), repoFiles, written, read });
  assert.equal(candidates.length, 3);
  const runOne = (root) => (file) => spawnSync(RUN_ONE_TEST[0], [...RUN_ONE_TEST.slice(1), file], { cwd: root, encoding: 'utf8', env: { ...process.env, ...RUN_ONE_TEST_ENV } }).status;
  const got = pickRetired({ candidates, runOnSetup: runOne(setup), runOnBase: runOne(base) });
  assert.deepEqual(got.retired.map((r) => r.file), ['scripts/builder/wipCap.test.js']);
  assert.deepEqual(got.kept, [{ file: 'scripts/builder/brokenAlready.test.js', why: 'fails on the commit the setup started from too, so the setup is not what breaks it' }]);
});

test('the pull request lists every retired file with what it names, and the rule; nothing when none were retired', () => {
  const retired = [
    { file: 'scripts/builder/wipCap.test.js', names: ['.claude/skills/loop-build/SKILL.md'], via: [] },
    { file: 'scripts/builder/clickupCaller.test.js', names: ['scripts/loop_runner.sh'], via: ['scripts/lib/clickupCaller.cjs'] },
    { file: 'scripts/builder/autoMergeLane.test.js', names: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], via: [] },
  ];
  assert.deepEqual(retiredSection([], { projectName: 'StarCaster' }), []);
  const text = retiredSection(retired, { projectName: 'StarCaster', base: '0eaf4b37abcdef' }).join('\n');
  for (const r of retired) assert.ok(text.includes(`- \`${r.file}\``), r.file);
  assert.ok(text.includes(RETIRE_RULE));
  assert.match(text, /`0eaf4b3`/);
  assert.match(text, /3 test file\(s\) of StarCaster's own/);
  assert.equal(retiredLine(retired[1]), '`scripts/builder/clickupCaller.test.js`: names `scripts/loop_runner.sh` (through `scripts/lib/clickupCaller.cjs`)');
  assert.match(retiredLine(retired[2]), /`e` and 2 more$/);
});

test('parseRetired: none saved is an empty list; a file that does not read as the list is null, never empty', () => {
  assert.deepEqual(parseRetired(null), []);
  const list = [{ file: 'a.test.js', names: ['CLAUDE.md'], via: [], base: 'abc' }];
  assert.deepEqual(parseRetired(JSON.stringify(list)), list);
  assert.equal(parseRetired('{not json'), null);
  assert.equal(parseRetired('{"file":"a"}'), null);
  assert.equal(parseRetired('[{"file":"a"}]'), null);
});
