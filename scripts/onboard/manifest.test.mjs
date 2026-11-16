// scripts/onboard/manifest.json against Spirality as it stands (SP-110): any
// file it names is there, any edit still matches exactly once, and, since
// SP-273, no loop file is copied into a project at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { needs, planCopies, templateVars, render } from '../../lib/onboardCopy.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'scripts/onboard/manifest.json'), 'utf8'));
const read = (p) => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), 'utf8') : null);
const from = new Set(manifest.files.map((f) => f.from));
const to = new Set([...manifest.files.map((f) => f.to), ...manifest.made.map((m) => m.to)]);

// Normie's answers, as the look's own tests and the Mini's answers file have them.
const NORMIE = {
  projectName: 'Normie', githubRepo: 'mentor24-maker/normie', projectSlug: 'normie', trackerPrefix: 'NO',
  dopplerProject: 'normie', dopplerConfig: 'dev', launchdPrefix: 'com.normie', checkoutDir: '/Users/x/WebApps/normie',
  checkCommand: 'npm run verify:full', nodeVersion: '22', mergePhrases: ['merge', 'merge it', 'ship it', 'approve'],
  autoMergeLanes: [], extraGovernancePaths: ['.cursorrules'], hosting: 'Vercel', description: 'A website.',
};
const HOME = { logDir: '~/loop-logs', trackerUrl: 'http://mac-mini.local:4180', githubRepo: 'mentor24-maker/spirality' };
const vars = templateVars(NORMIE, HOME, { spiralityCommit: 'abc1234', visibility: 'PUBLIC' });

test('every file the manifest copies is in Spirality', () => {
  const missing = manifest.files.filter((f) => read(f.from) == null).map((f) => f.from);
  assert.deepEqual(missing, []);
});

test('every edit still matches its Spirality file exactly once, and every template renders', () => {
  const planned = planCopies(manifest, { readSpirality: read, vars });
  assert.equal(planned.length, manifest.files.length + manifest.made.filter((m) => m.template && m.to !== 'CLAUDE.md').length);
  for (const f of planned) assert.doesNotMatch(f.content, /\{\{[a-zA-Z]+\}\}/, `${f.to} has an unfilled placeholder`);
  render(read('scripts/onboard/templates/CLAUDE-sections.md'), vars);
});

test('no file the setup writes, docs aside, carries a machine path (SP-252: StarCaster\'s own conventions check refused one)', () => {
  const found = [];
  for (const f of planCopies(manifest, { readSpirality: read, vars })) {
    if (/\.md$/.test(f.to)) continue;
    String(f.content ?? read(f.from) ?? '').split('\n').forEach((line, i) => {
      if (/\/Users\/[A-Za-z]|\/home\/[a-z]/.test(line)) found.push(`${f.to}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(found, []);
});

test('nothing the ticket door, the runners or the copied tests need is left out', () => {
  const roots = manifest.files.filter((f) => /\.(?:m|c)?js$|\.sh$/.test(f.from)).map((f) => f.from);
  const { files, missing } = needs(roots, read);
  assert.deepEqual(missing, [], 'a file imports or sources something Spirality does not have');
  const left = files.filter((f) => !from.has(f));
  assert.deepEqual(left, [], 'these are needed by a copied file but not in the manifest: add them');
});

// SP-273: loop code lives only in Spirality (docs/INTEGRATION.md). A
// project's setup pull request holds its manifest and its gate, plus the
// .gitignore line and CLAUDE.md sections its lanes need; never the door, the
// runners, the libraries, the watchdogs, the skills or the hooks.
const LOOP_PATH = /^(?:loop\/|\.claude\/|scripts\/|lib\/|plugin\/)/;

test('the setup copies no loop file: no door, runner, library, watchdog, skill or hook (SP-273)', () => {
  assert.deepEqual(manifest.files.map((f) => f.to), [], 'a file the manifest copies');
  assert.deepEqual([...to].filter((p) => LOOP_PATH.test(p)), [], 'a loop path the setup writes');
  assert.deepEqual(manifest.npmScripts, {}, 'no npm command runs a copied loop file');
  assert.equal(manifest.made.filter((m) => m.mergeFrom).length, 0, '.claude/settings.json is neither copied nor merged: a lane\'s pass gets Spirality\'s hooks');
  assert.deepEqual([...to].sort(), ['.github/workflows/verify.yml', '.gitignore', 'CLAUDE.md', 'package.json', 'spirality.project.json']);
  assert.deepEqual(planCopies(manifest, { readSpirality: read, vars }), [], 'the dry run lists nothing to copy');
});

test('the gate a new project gets is its own check, with no copied loop tests (SP-121, SP-273)', () => {
  assert.equal(render(manifest.verifyIfAbsent, vars), 'npm run verify:full');
  assert.doesNotMatch(JSON.stringify(manifest), /test:loop/);
  assert.match(render(read('scripts/onboard/templates/CLAUDE-sections.md'), vars), /`npm run verify` is the definition of done\./);
});

// Every file Normie's setup pull requests wrote (gh pr view <n> --repo
// mentor24-maker/normie --json files, for #62, #64, #65 and #66). Those were
// the wizard copy; a new project now gets only the files below from them.
const NORMIE_RECEIVED = {
  62: ['spirality.project.json'],
  64: ['eslint.config.mjs', 'loop/README.md', 'loop/lib/branchCatchUp.js', 'loop/scripts/clickup.mjs', 'loop/scripts/with_doppler.mjs', 'package.json'],
  65: ['.claude/settings.json', '.claude/skills/loop-build/SKILL.md', '.claude/skills/loop-intake/SKILL.md',
    '.claude/skills/loop-review/SKILL.md', '.claude/skills/loop-spec/SKILL.md', 'CLAUDE.md', 'docs/LOOP_ENGINEERING.md',
    'scripts/hooks/block_edits_on_main.cjs'],
  66: ['scripts/install_loop_runner.sh', 'scripts/lib/launchd_reload.sh', 'scripts/loop_runner.sh', 'scripts/project_config.mjs',
    'scripts/run_relay.sh', 'scripts/run_with_time_limit.sh'],
};

test('of what Normie\'s wizard copy received, a new project gets only its settings, package.json and CLAUDE.md', () => {
  const still = Object.values(NORMIE_RECEIVED).flat().filter((p) => to.has(p)).sort();
  assert.deepEqual(still, ['CLAUDE.md', 'package.json', 'spirality.project.json']);
  for (const p of Object.values(NORMIE_RECEIVED).flat().filter((x) => LOOP_PATH.test(x))) {
    assert.ok(!to.has(p), `${p} is the loop's, and Spirality runs it from its own folder`);
  }
});

test('the files the wizard copy carried are still Spirality\'s, where its lanes run them for a project', () => {
  for (const p of ['scripts/install_loop_runner.sh', 'scripts/loop_runner.sh', 'scripts/run_relay.sh', 'scripts/clickup.mjs',
    'scripts/with_doppler.mjs', 'scripts/heartbeat.mjs', 'scripts/hooks/block_edits_on_main.cjs', 'scripts/hooks/door_from_spirality.cjs',
    'plugin/hooks/hooks.json', '.claude/skills/loop-build/SKILL.md']) {
    assert.ok(read(p) != null, `${p} is not in Spirality`);
  }
});

test('rendered for another project, the CLAUDE.md sections keep none of Spirality\'s own names', () => {
  const pressplay = {
    ...NORMIE, projectName: 'PressPlay', projectSlug: 'pressplay', trackerPrefix: 'PP', dopplerProject: 'pressplay',
    launchdPrefix: 'com.pressplay', checkoutDir: '~/WebApps/pressplay', checkCommand: 'npm run build',
    mergePhrases: ['merge', 'ship it'], hosting: null,
  };
  const v = templateVars(pressplay, HOME, { spiralityCommit: 'abc1234', visibility: 'PRIVATE' });
  const claude = render(read('scripts/onboard/templates/CLAUDE-sections.md'), v);
  assert.doesNotMatch(claude, /com\.spirality\./, 'names one of Spirality\'s own launchd jobs');
  assert.doesNotMatch(claude, /`merge it`|`approve`/, 'lists Spirality\'s merge phrases');
  assert.doesNotMatch(claude, /spirality-loop-|~\/WebApps\/spirality\b/, 'names Spirality\'s logs or folder');
  assert.doesNotMatch(claude, /\bSP-\d+\b/, 'cites one of Spirality\'s own tickets');
  assert.doesNotMatch(claude, /`loop\/`|loop\/README\.md/, 'names a copy of the loop the project no longer has');
  assert.match(claude, /^## Loop rules$/m, 'the section the loop skills name');
  assert.match(claude, /SPIRALITY_PROJECT=~\/WebApps\/pressplay/, 'says how to reach Spirality\'s door by hand');
  for (const m of claude.matchAll(/\[`(docs\/[\w./-]+\.md)`\]\(https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/blob\/main\/(docs\/[\w./-]+\.md)\)/g)) {
    assert.equal(m[1], m[3], `a link named ${m[1]} opens ${m[3]}`);
    assert.equal(m[2], HOME.githubRepo, `a link to ${m[1]} is not in Spirality's repository`);
    assert.ok(read(m[3]) != null, `a link to ${m[3]}, which Spirality does not have`);
  }
});

test('the template types no repository address: it comes from the settings file', () => {
  assert.doesNotMatch(read('scripts/onboard/templates/CLAUDE-sections.md'), /github\.com\/[\w-]+\/[\w-]+/);
});

test('the setup makes the project ignore the lanes\' working copies (SP-120)', () => {
  const entry = manifest.made.find((m) => m.to === '.gitignore');
  assert.ok(entry, 'the manifest makes a .gitignore');
  assert.ok(entry.ignoreLines.includes('.claude/worktrees/'));
  assert.ok(read('.gitignore').split('\n').includes('.claude/worktrees/'), 'Spirality ignores it too');
});
