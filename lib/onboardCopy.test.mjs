import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CopyError, render, applyEdits, templateVars, needs, verifyWorkflow, hasVerifyJob, verifyScriptFor,
  mergeNpmScripts, withClaudeSections, withIgnoreLines, planCopies, compareWithProject, ciVerdict, answersAsHandRun, oldCopyLists,
} from './onboardCopy.mjs';

const ANSWERS = {
  projectName: 'PressPlay', projectSlug: 'pressplay', trackerPrefix: 'PP', dopplerProject: 'pressplay',
  launchdPrefix: 'com.pressplay', checkoutDir: '/Users/x/WebApps/pressplay', checkCommand: 'npm run build',
  nodeVersion: '22', mergePhrases: ['merge', 'ship it'], hosting: null,
};
const HOME = { logDir: '~/loop-logs', trackerUrl: 'http://t.example:4180', githubRepo: 'o/spirality' };

test('render fills every placeholder and refuses an unknown one', () => {
  assert.equal(render('{{a}} and {{b}}', { a: 1, b: 'two' }), '1 and two');
  assert.throws(() => render('{{nope}}', {}, 'x.md'), (e) => e instanceof CopyError && /x\.md: no value for \{\{nope\}\}/.test(e.message));
  assert.throws(() => render('{{a}}', { a: null }), CopyError);
});

test('an edit must match exactly once; zero or two stops the copy, naming the file', () => {
  assert.equal(applyEdits('one Spirality two', [{ find: 'Spirality', replace: '{{n}}' }], { n: 'PressPlay' }, 'f'), 'one PressPlay two');
  assert.throws(() => applyEdits('nothing here', [{ find: 'Spirality', replace: 'x' }], {}, 'skills/a.md'), /skills\/a\.md: .*found it 0 times.*manifest\.json/);
  assert.throws(() => applyEdits('Spirality Spirality', [{ find: 'Spirality', replace: 'x' }], {}, 'f'), /found it 2 times/);
  // A "$&" in a value is text, not a replacement pattern.
  assert.equal(applyEdits('a X b', [{ find: 'X', replace: '{{v}}' }], { v: 'cost $&1' }, 'f'), 'a cost $&1 b');
});

test('the template values follow the answers: merge phrases, surface, visibility', () => {
  const v = templateVars(ANSWERS, HOME, { spiralityCommit: 'abc1234', visibility: 'PRIVATE' });
  assert.equal(v.firstMergePhrase, 'merge');
  assert.equal(v.otherMergePhrases, 'or `ship it`');
  assert.match(v.visibilityLine, /private, but Spirality's pages are public/);
  assert.match(v.reviewSurface, /^PressPlay's surface is usually a command/);
  assert.equal(v.logDir, '~/loop-logs');
  assert.equal(v.mergePhrasesText, '`merge` or `ship it`');
  assert.equal(v.spiralityRepo, 'o/spirality');
  const site = templateVars({ ...ANSWERS, hosting: 'Vercel', mergePhrases: ['merge'] }, HOME, { spiralityCommit: 'a', visibility: 'PUBLIC' });
  assert.equal(site.visibilityLine, 'This repository is public.');
  assert.match(site.reviewSurface, /^PressPlay is a website.*\n.*Vercel/);
  assert.equal(site.otherMergePhrases, 'the whole comment');
});

test('needs follows imports, extensionless requires and the runners\' source lines', () => {
  const files = {
    'scripts/clickup.mjs': "import { a } from '../lib/a.js';\nimport b from './lib/b.mjs';",
    'lib/a.js': "const c = require('./c');",
    'lib/c.js': '',
    'scripts/lib/b.mjs': '',
    'scripts/loop_runner.sh': 'source "$REPO/scripts/lib/helper.sh"\n"$REPO/scripts/run_with_time_limit.sh" 10 -- x',
    'scripts/lib/helper.sh': '',
    'scripts/run_with_time_limit.sh': '',
  };
  const read = (p) => (p in files ? files[p] : null);
  assert.deepEqual(needs(['scripts/clickup.mjs', 'scripts/loop_runner.sh'], read), {
    files: ['lib/a.js', 'lib/c.js', 'scripts/clickup.mjs', 'scripts/lib/b.mjs', 'scripts/lib/helper.sh', 'scripts/loop_runner.sh', 'scripts/run_with_time_limit.sh'],
    missing: [],
  });
  assert.deepEqual(needs(['lib/x.js'], (p) => (p === 'lib/x.js' ? "require('./gone')" : null)).missing, ['lib/gone.js']);
});

test('the workflow is one job named verify, running the check and the loop tests', () => {
  const yml = verifyWorkflow(ANSWERS);
  assert.match(yml, /^jobs:\n {2}verify:\n/m);
  assert.match(yml, /run: npm run build\n/);
  assert.match(yml, /run: npm run test:loop\n/);
  assert.match(yml, /node-version: "22"/);
  assert.ok(hasVerifyJob([yml]));
  assert.ok(hasVerifyJob(['name: CI\njobs:\n  lint:\n    x: 1\n  verify:\n    runs-on: u\n']));
  assert.ok(!hasVerifyJob(['name: CI\njobs:\n  build:\n    steps:\n      - name: verify\n']));
});

test('a project with no verify gets one: its check, then the loop tests, and CI runs it (SP-121)', () => {
  const manifest = JSON.parse(readFileSync(new URL('../scripts/onboard/manifest.json', import.meta.url), 'utf8'));
  const pkg = '{\n  "name": "pressplay",\n  "scripts": {\n    "build": "vite build"\n  }\n}\n';
  const v = verifyScriptFor(pkg, manifest.verifyIfAbsent, ANSWERS);
  assert.deepEqual(v, { add: 'npm run build && npm run test:loop', own: null });
  const merged = mergeNpmScripts(pkg, { ...manifest.npmScripts, verify: v.add });
  assert.equal(JSON.parse(merged.text).scripts.verify, 'npm run build && npm run test:loop');
  assert.equal(JSON.parse(merged.text).scripts.build, 'vite build');
  const yml = verifyWorkflow(ANSWERS, { verifyAdded: true });
  assert.match(yml, /^ {8}run: npm run verify\n/m);
  assert.doesNotMatch(yml, /run: npm run build|run: npm run test:loop/, 'one command, the same one a pass runs');
  assert.match(templateVars(ANSWERS, HOME, { spiralityCommit: 'a', visibility: 'PUBLIC' }).verifyMeaning, /^It runs `npm run build`, then the copied loop tests/);
  // A verify that is already exactly this one (an earlier setup run) is the setup's, and kept as it is.
  const again = '{"scripts":{"build":"vite build","verify":"npm run build && npm run test:loop"}}';
  assert.deepEqual(verifyScriptFor(again, manifest.verifyIfAbsent, ANSWERS), { add: 'npm run build && npm run test:loop', own: null });
  assert.deepEqual(mergeNpmScripts(again, { verify: 'npm run build && npm run test:loop' }).kept, ['verify']);
  // A check that is itself npm run verify, with no verify script, has nothing to run.
  assert.throws(() => verifyScriptFor(pkg, manifest.verifyIfAbsent, { ...ANSWERS, checkCommand: 'npm run verify' }), /no verify script/);
});

test('a project with its own verify keeps it untouched, and CI runs the check and the loop tests as before', () => {
  const manifest = JSON.parse(readFileSync(new URL('../scripts/onboard/manifest.json', import.meta.url), 'utf8'));
  const pkg = '{"scripts":{"build":"vite build","verify":"npm run lint && npm run build"}}';
  const v = verifyScriptFor(pkg, manifest.verifyIfAbsent, ANSWERS);
  assert.deepEqual(v, { add: null, own: 'npm run lint && npm run build' });
  const merged = mergeNpmScripts(pkg, manifest.npmScripts);
  assert.equal(JSON.parse(merged.text).scripts.verify, 'npm run lint && npm run build');
  assert.ok(!merged.added.includes('verify'));
  assert.equal(verifyWorkflow(ANSWERS), verifyWorkflow(ANSWERS, { verifyAdded: false }));
  assert.match(templateVars(ANSWERS, HOME, { spiralityCommit: 'a', visibility: 'PUBLIC', ownVerify: v.own }).verifyMeaning, /^It is PressPlay's own `verify` script \(`npm run lint && npm run build`\)/);
  assert.throws(() => verifyScriptFor('{', '', ANSWERS), /does not parse/);
});

test('npm scripts are added, never changed or removed', () => {
  const pkg = '{\n  "name": "p",\n  "scripts": {\n    "build": "next build",\n    "doctor": "node loop/scripts/doctor.mjs"\n  }\n}\n';
  const r = mergeNpmScripts(pkg, { doctor: 'node loop/scripts/doctor.mjs', clickup: 'node c.mjs' });
  assert.deepEqual(r.added, ['clickup']);
  assert.deepEqual(r.kept, ['doctor']);
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(JSON.parse(r.text).scripts, { build: 'next build', doctor: 'node loop/scripts/doctor.mjs', clickup: 'node c.mjs' });
  assert.ok(r.text.endsWith('}\n'));
  const clash = mergeNpmScripts('{"scripts":{"doctor":"something else"}}', { doctor: 'node d.mjs' });
  assert.deepEqual(clash.conflicts, [{ name: 'doctor', theirs: 'something else', ours: 'node d.mjs' }]);
  assert.throws(() => mergeNpmScripts('{', {}), /does not parse/);
});

test('the CLAUDE.md sections are appended once, keeping the project\'s own guide', () => {
  const sections = '## How to work with Dane\n\nx\n\n## Where the work is tracked\n\ny\n';
  const first = withClaudeSections('# PressPlay\n\nIts own guide.\n', sections);
  assert.equal(first.added, true);
  assert.equal(first.text, `# PressPlay\n\nIts own guide.\n\n${sections}`);
  assert.deepEqual(withClaudeSections(first.text, sections), { text: first.text, added: false });
  assert.equal(withClaudeSections(null, sections).text, sections);
});

test('the plan marks copies, adaptations and templates, and how each meets the project', () => {
  const manifest = {
    files: [
      { from: 'lib/a.js', to: 'loop/lib/a.js' },
      { from: 'skill.md', to: 'skill.md', why: 'name', edits: [{ find: 'Spirality queue', replace: '{{projectName}} queue' }] },
    ],
    made: [{ to: 'loop/README.md', template: 't.md' }, { to: 'CLAUDE.md', template: 'c.md' }],
  };
  const spirality = { 'lib/a.js': 'a\n', 'skill.md': 'the Spirality queue', 't.md': '# {{projectName}}\n', 'c.md': 'x' };
  const planned = planCopies(manifest, { readSpirality: (p) => spirality[p] ?? null, vars: { projectName: 'PressPlay' } });
  assert.deepEqual(planned.map((f) => [f.to, f.kind, f.content]), [
    ['loop/lib/a.js', 'copy', 'a\n'],
    ['skill.md', 'adapted', 'the PressPlay queue'],
    ['loop/README.md', 'made', '# PressPlay\n'],
  ]);
  const project = { 'loop/lib/a.js': 'a\n', 'skill.md': 'their own skill' };
  assert.deepEqual(compareWithProject(planned, (p) => project[p] ?? null).map((f) => f.status), ['identical', 'replaces', 'new']);
  assert.throws(() => planCopies({ files: [{ from: 'gone.js', to: 'x' }], made: [] }, { readSpirality: () => null, vars: {} }), /gone\.js is in scripts\/onboard\/manifest\.json but not in Spirality/);
  assert.throws(() => planCopies({ files: [{ from: 'a', to: 'x' }, { from: 'b', to: 'x' }], made: [] }, { readSpirality: () => '', vars: {} }), /x is written twice/);
});

test('CI is read once as JSON: pending, pass, fail, or no check yet', () => {
  assert.equal(ciVerdict([]).verdict, 'none');
  assert.match(ciVerdict([{ name: 'Vercel', bucket: 'pass', state: 'SUCCESS' }]).why, /no check named verify yet \(there are: Vercel\)/);
  assert.equal(ciVerdict([{ name: 'verify', bucket: 'pending', state: 'IN_PROGRESS' }]).verdict, 'pending');
  assert.equal(ciVerdict([{ name: 'verify', bucket: 'pass', state: 'SUCCESS' }, { name: 'Vercel', bucket: 'fail', state: 'FAILURE' }]).verdict, 'pass', 'only verify is judged');
  assert.equal(ciVerdict([{ name: 'verify', bucket: 'fail', state: 'FAILURE' }]).verdict, 'fail');
  assert.equal(ciVerdict([{ name: 'verify', bucket: 'cancel', state: 'CANCELLED' }]).verdict, 'fail');
  // Two runs of verify (a push and a pull_request): one still going is pending, one failed is a fail.
  assert.equal(ciVerdict([{ name: 'verify', bucket: 'pass', state: 'SUCCESS' }, { name: 'verify', bucket: 'pending', state: 'QUEUED' }]).verdict, 'pending');
  assert.equal(ciVerdict([{ name: 'verify', bucket: 'pass', state: 'SUCCESS' }, { name: 'verify', bucket: 'fail', state: 'FAILURE' }]).verdict, 'fail');
  assert.equal(ciVerdict([{ name: 'verify', bucket: 'skipping', state: 'SKIPPED' }]).verdict, 'fail', 'a skipped verify is not a pass');
});

test('whoami must answer as this project\'s own hand-run seat', () => {
  const normie = 'Token valid. Acting as: normie hand-run <machine actor in the tracker> (id 12)';
  assert.equal(answersAsHandRun(normie, 'normie'), true);
  assert.equal(answersAsHandRun(normie, 'pressplay'), false, 'another project\'s seat');
  assert.equal(answersAsHandRun('Token valid. Acting as: hand-run <machine actor> (id 6)', 'pressplay'), false, 'Spirality\'s own seat');
  assert.equal(answersAsHandRun('Token valid. Acting as: pressplay loop-build (id 20)', 'pressplay'), false);
});

test('withIgnoreLines makes a .gitignore with the lanes\' lines when the project has none', () => {
  assert.deepEqual(withIgnoreLines(null, ['.claude/worktrees/']), { text: '.claude/worktrees/\n', added: ['.claude/worktrees/'] });
  assert.deepEqual(withIgnoreLines('', ['.claude/worktrees/']), { text: '.claude/worktrees/\n', added: ['.claude/worktrees/'] });
});

test('withIgnoreLines appends a missing line after the project\'s own, in order', () => {
  const theirs = 'node_modules/\n# build\ndist\n.env';
  const r = withIgnoreLines(theirs, ['.claude/worktrees/']);
  assert.equal(r.text, 'node_modules/\n# build\ndist\n.env\n.claude/worktrees/\n');
  assert.deepEqual(r.added, ['.claude/worktrees/']);
  assert.ok(r.text.startsWith(theirs), 'the project\'s lines are kept as they were');
});

test('withIgnoreLines leaves a .gitignore that already has the line identical', () => {
  for (const have of ['.claude/worktrees/', '/.claude/worktrees/', '.claude/worktrees', '  .claude/worktrees/  ']) {
    const text = `node_modules/\n${have}\n.env\n`;
    assert.deepEqual(withIgnoreLines(text, ['.claude/worktrees/']), { text, added: [] }, have);
  }
  assert.deepEqual(withIgnoreLines('a\n', []), { text: 'a\n', added: [] });
  assert.deepEqual(withIgnoreLines(null, ['x/', 'x']).added, ['x/'], 'a line is added once');
});

test('oldCopyLists: the old copy\'s files it replaces, and the old files beside them it leaves in place (SP-159)', () => {
  const all = [
    { to: 'scripts/loop_runner.sh', status: 'replaces' },
    { to: 'scripts/install_loop_runner.sh', status: 'replaces' },
    { to: '.claude/skills/loop-build/SKILL.md', status: 'replaces' },
    { to: 'loop/scripts/clickup.mjs', status: 'new' },
    { to: 'loop/lib/a.js', status: 'new' },
    { to: 'CLAUDE.md', status: 'replaces' },
    { to: 'scripts/hooks/block_edits_on_main.cjs', status: 'identical' },
  ];
  const projectFiles = [
    'scripts/loop_runner.sh', 'scripts/install_loop_runner.sh', 'scripts/clickup.mjs', 'scripts/merge_lane.sh',
    'scripts/hooks/old_hook.cjs', 'scripts/lib/handoff.mjs', '.claude/skills/loop-build/SKILL.md',
    '.claude/skills/loop-handoff/SKILL.md', 'loop/old.js', 'app/page.tsx', 'README.md', 'CLAUDE.md', '',
  ];
  const { replaced, leftInPlace } = oldCopyLists(all, projectFiles);
  assert.deepEqual(replaced, ['.claude/skills/loop-build/SKILL.md', 'CLAUDE.md', 'scripts/install_loop_runner.sh', 'scripts/loop_runner.sh']);
  // scripts/lib is not a folder the setup writes into here; the top folder, app/ and loop/ never count.
  assert.deepEqual(leftInPlace, ['.claude/skills/loop-handoff/SKILL.md', 'scripts/clickup.mjs', 'scripts/hooks/old_hook.cjs', 'scripts/merge_lane.sh']);
  assert.deepEqual(oldCopyLists([], []), { replaced: [], leftInPlace: [] });
});
