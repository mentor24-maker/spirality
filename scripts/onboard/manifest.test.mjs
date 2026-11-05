// scripts/onboard/manifest.json against Spirality as it stands: every file is
// there, every edit still matches exactly once, nothing the door or the
// runners need is left out, and every file Normie's setup received is
// accounted for (SP-110).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { needs, planCopies, templateVars, render } from '../../lib/onboardCopy.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'scripts/onboard/manifest.json'), 'utf8'));
const read = (p) => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), 'utf8') : null);
const from = new Set(manifest.files.map((f) => f.from));
const to = new Set([...manifest.files.map((f) => f.to), ...manifest.made.map((m) => m.to)]);

// Normie's answers, as the look's own tests and the Mini's answers file have them.
const NORMIE = {
  productName: 'Normie', githubRepo: 'mentor24-maker/normie', productSlug: 'normie', trackerPrefix: 'NO',
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

test('nothing the ticket door, the runners or the copied tests need is left out', () => {
  const roots = manifest.files.filter((f) => /\.(?:m|c)?js$|\.sh$/.test(f.from)).map((f) => f.from);
  const { files, missing } = needs(roots, read);
  assert.deepEqual(missing, [], 'a file imports or sources something Spirality does not have');
  const left = files.filter((f) => !from.has(f));
  assert.deepEqual(left, [], 'these are needed by a copied file but not in the manifest: add them');
});

test('the door\'s commands are among the copies the npm scripts run', () => {
  for (const command of Object.values(manifest.npmScripts)) {
    for (const m of command.matchAll(/node (loop\/\S+\.mjs)/g)) assert.ok(to.has(m[1]), `${m[1]} is run but not copied`);
  }
});

// Every file Normie's setup pull requests wrote (gh pr view <n> --repo
// mentor24-maker/normie --json files, for #62, #64, #65 and #66), and where
// each one comes from now.
const NORMIE_RECEIVED = {
  62: ['spirality.project.json'],
  64: ['eslint.config.mjs', 'loop/README.md', 'loop/lib/branchCatchUp.js', 'loop/lib/busFallback.js', 'loop/lib/busRelayPlan.js',
    'loop/lib/clickupTicketLink.js', 'loop/lib/commentPages.js', 'loop/lib/commentPages.test.js', 'loop/lib/conflictWork.js',
    'loop/lib/costlyAsk.js', 'loop/lib/costlyAsk.test.js', 'loop/lib/humanHours.js', 'loop/lib/loopStatuses.js',
    'loop/lib/machineComment.js', 'loop/lib/mainMoved.js', 'loop/lib/mergeOnComment.js', 'loop/lib/nextSlice.js',
    'loop/lib/operatorCard.js', 'loop/lib/package.json', 'loop/lib/projectConfig.mjs', 'loop/lib/refusalClass.js',
    'loop/lib/relayLane.js', 'loop/lib/relayLane.test.js', 'loop/lib/substrateConfig.js', 'loop/lib/waitsOn.js',
    'loop/lib/waitsOn.test.js', 'loop/scripts/clickup.mjs', 'loop/scripts/doctor.mjs', 'loop/scripts/lib/expectedSecrets.mjs',
    'loop/scripts/lib/loopStatuses.mjs', 'loop/scripts/lib/loopStatuses.test.mjs', 'loop/scripts/lib/loopTrail.mjs',
    'loop/scripts/lib/loopTrail.test.mjs', 'loop/scripts/lib/machineComment.mjs', 'loop/scripts/lib/machineComment.test.mjs',
    'loop/scripts/lib/operatorCard.mjs', 'loop/scripts/lib/operatorCard.test.mjs', 'loop/scripts/lib/repoCheck.mjs',
    'loop/scripts/lib/repoCheck.test.mjs', 'loop/scripts/tracker/apiTracker.mjs', 'loop/scripts/tracker/clickupTracker.mjs',
    'loop/scripts/tracker/clickupTracker.test.mjs', 'loop/scripts/with_doppler.mjs', 'package.json'],
  65: ['.claude/settings.json', '.claude/skills/loop-build/SKILL.md', '.claude/skills/loop-intake/SKILL.md',
    '.claude/skills/loop-review/SKILL.md', '.claude/skills/loop-spec/SKILL.md', 'CLAUDE.md', 'docs/LOOP_ENGINEERING.md',
    'docs/work-log/2026-11-03-no-5-loop.md', 'docs/work-log/README.md', 'scripts/hooks/block_edits_on_main.cjs'],
  66: ['docs/work-log/2026-11-03-no-6-lanes.md', 'scripts/install_loop_runner.sh', 'scripts/lib/launchd_reload.sh',
    'scripts/loop_runner.sh', 'scripts/project_config.mjs', 'scripts/run_relay.sh', 'scripts/run_with_time_limit.sh'],
};
// Normie's own, not the loop's: its lint settings learned to skip loop/, and
// the work log is written by each pull request about itself.
const NOT_THE_LOOPS = new Set(['eslint.config.mjs', 'docs/work-log/2026-11-03-no-5-loop.md', 'docs/work-log/README.md', 'docs/work-log/2026-11-03-no-6-lanes.md']);

test('every file Normie received is in the manifest, or is Normie\'s own', () => {
  const checked = [];
  for (const [pr, paths] of Object.entries(NORMIE_RECEIVED)) {
    for (const p of paths) {
      if (NOT_THE_LOOPS.has(p)) continue;
      assert.ok(to.has(p), `Normie PR #${pr} received ${p}, and the manifest writes nothing there`);
      checked.push(p);
    }
  }
  assert.equal(checked.length, 58, 'the number of Normie files checked against the manifest');
});

test('the review and build skills tell a lane\'s pass it is the lane (hold-up 14)', () => {
  const planned = planCopies(manifest, { readSpirality: read, vars });
  for (const skill of ['loop-build', 'loop-review']) {
    const text = planned.find((f) => f.to === `.claude/skills/${skill}/SKILL.md`).content;
    assert.match(text, /LOOP_RUNNER_PID/, `${skill} checks the runner's mark`);
    assert.match(text, new RegExp(`\\$LOG_DIR/\\$SLUG-${skill}\\.lock`), `${skill} names its own lock`);
    assert.match(text, /^- \*\*Whenever you stop for this reason\*\*, the first line of your report is\n {2}exactly `LANE STOOD DOWN: /m, `${skill} prints the fixed stand-down line`);
    assert.doesNotMatch(text, /Spirality (?:queue|development loop|has no scheduled runner)/, `${skill} still speaks as Spirality`);
  }
  const review = planned.find((f) => f.to === '.claude/skills/loop-review/SKILL.md').content;
  assert.match(review, /com\.normie\.loop-review/);
  assert.match(review, /Re-run the gates: `npm run verify:full`\./);
  assert.match(review, /Normie is a website, so the surface is usually a page/);
});

test('rendered for another product, no adapted or made file keeps Spirality\'s own names', () => {
  const pressplay = {
    ...NORMIE, productName: 'PressPlay', productSlug: 'pressplay', trackerPrefix: 'PP', dopplerProject: 'pressplay',
    launchdPrefix: 'com.pressplay', checkoutDir: '~/WebApps/pressplay', checkCommand: 'npm run build',
    mergePhrases: ['merge', 'ship it'], hosting: null,
  };
  const v = templateVars(pressplay, HOME, { spiralityCommit: 'abc1234', visibility: 'PRIVATE' });
  const rendered = planCopies(manifest, { readSpirality: read, vars: v }).filter((f) => f.kind !== 'copy');
  rendered.push({ to: 'CLAUDE.md', content: render(read('scripts/onboard/templates/CLAUDE-sections.md'), v) });
  for (const f of rendered) {
    assert.doesNotMatch(f.content, /com\.spirality\./, `${f.to} still names one of Spirality's own launchd jobs`);
    assert.doesNotMatch(f.content, /`merge it`|`approve`/, `${f.to} still lists Spirality's merge phrases`);
    assert.doesNotMatch(f.content, /spirality-loop-|~\/WebApps\/spirality\b/, `${f.to} still names Spirality's logs or folder`);
  }
  const review = rendered.find((f) => f.to === '.claude/skills/loop-review/SKILL.md').content;
  assert.match(review, /`merge` or `ship it` \(the/);
  assert.match(review, /\(`com\.pressplay\.relay`, every 10 minutes\)/);
});

test('the templates type no repository address: it comes from the settings file', () => {
  for (const t of ['CLAUDE-sections.md', 'loop-README.md', 'LOOP_ENGINEERING.md']) {
    assert.doesNotMatch(read(`scripts/onboard/templates/${t}`), /github\.com\/[\w-]+\/[\w-]+/, `${t} types a repository address`);
  }
});

test('the setup makes the product ignore the lanes\' working copies (SP-120)', () => {
  const entry = manifest.made.find((m) => m.to === '.gitignore');
  assert.ok(entry, 'the manifest makes a .gitignore');
  assert.ok(entry.ignoreLines.includes('.claude/worktrees/'));
  assert.ok(read('.gitignore').split('\n').includes('.claude/worktrees/'), 'Spirality ignores it too');
});
