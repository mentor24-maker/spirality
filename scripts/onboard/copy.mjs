#!/usr/bin/env node
/**
 * The setup wizard's copy step (SP-110): everything a product needs from
 * Spirality arrives in ONE pull request in its repository, every copied file
 * checked byte for byte against the Spirality commit it came from
 * (SETUP_REVIEW.md part 3, step 4; Dane's answer to question 7).
 *
 *   npm run onboard:copy -- --answers <file> --config <settings file> [--allow-replace]
 *   npm run onboard:copy -- --answers <file> [--config <file>] --dry-run
 *
 * Run from Spirality's own folder, on a clean checkout of a commit that is on
 * origin's main (the pull request names it). What goes in is
 * scripts/onboard/manifest.json, rendered by lib/onboardCopy.mjs. The settings
 * file is the one given as --config (SP-109 writes it; SP-112 passes it in).
 *
 * In order, each step skipped when already done, so a rerun picks up where a
 * failed one stopped:
 *   1. look     the product's checkout and repository; what every file would
 *               do there (new / identical / replaces). A file of the
 *               product's own that would be replaced stops the run, unless
 *               --allow-replace. --dry-run prints this and stops.
 *   2. write    a worktree on branch spirality-setup off origin's main, kept
 *               beside the answers file (never inside the product's
 *               checkout, which the lanes need clean): the files, the
 *               settings file, the npm scripts, the CLAUDE.md sections, the
 *               .gitignore lines the lanes need (SP-120) and,
 *               if it has no verify check yet, the CI workflow.
 *   3. check    every "copy as is" file compared with `cmp` against the
 *               Spirality commit; any difference stops it before commit.
 *   4. pr       commit, push and one pull request; its body names the
 *               Spirality commit and lists every file with its check.
 *   5. readback from the worktree: `npm run doctor`, `npm run clickup --
 *               whoami` (the product's hand-run seat) and `queue`; then CI's
 *               verify on the pull request.
 *
 * It never touches the product's main and never merges: SP-111's lanes step
 * installs the lanes from the branch, and the product's own relay merges it
 * on Dane's word. A failed step prints `FAILED: <step>: <what was seen>` and
 * the rerun command (rule 6); no secret is ever printed (rule 4).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadProjectConfig, findConfigFile } from '../../lib/projectConfig.mjs';
import { loadAnswers, onboardDir, expandHome } from '../../lib/onboardAnswers.mjs';
import {
  planCopies, compareWithProduct, templateVars, mergeNpmScripts, withClaudeSections, withIgnoreLines,
  verifyWorkflow, hasVerifyJob, render, ciVerdict, answersAsHandRun, SETUP_BRANCH,
} from '../../lib/onboardCopy.mjs';

const BRANCH = SETUP_BRANCH;
const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const flag = (name) => argv.includes(`--${name}`);
const dryRun = flag('dry-run');
const rerun = `npm run onboard:copy -- ${argv.join(' ')}`;

function fail(step, seen) {
  console.error(`\nFAILED: ${step}: ${seen}`);
  console.error(`Nothing after this step ran. Fix it, then rerun:\n  ${rerun}`);
  process.exit(1);
}
const say = (step, line) => console.log(`${step.padEnd(8)} ${line}`);
const last = (text, n = 6) => String(text || '').split('\n').filter(Boolean).slice(-n).join(' | ');
function run(cmd, args, { cwd, input, env } = {}) {
  const r = spawnSync(cmd, args, { cwd, input, encoding: 'utf8', env: env ? { ...process.env, ...env } : process.env });
  return { ok: r.status === 0, code: r.status, out: String(r.stdout || '').trim(), err: String(r.stderr || r.error || '').trim() };
}

if (!arg('answers') || (!dryRun && !arg('config'))) {
  console.error('usage: npm run onboard:copy -- --answers <file> --config <settings file> [--allow-replace] [--dry-run]');
  process.exit(2);
}
if (dryRun) console.log('Dry run: every check runs and nothing is written or opened (git fetch only refreshes what the checkout knows of origin).\n');

// ── 1. look ────────────────────────────────────────────────────────────────
const spirality = process.cwd();
let homeConfig, answers;
try {
  homeConfig = loadProjectConfig({ cwd: spirality, env: {} });
  answers = loadAnswers(arg('answers'), { homeConfig, homeRoot: dirname(findConfigFile(spirality)) });
} catch (e) { fail('look', e.message); }

const sgit = (...a) => run('git', a, { cwd: spirality });
if (sgit('status', '--porcelain').out) fail('look', `Spirality's folder ${spirality} has uncommitted changes; the copy must come from a commit`);
const commit = sgit('rev-parse', 'HEAD').out;
sgit('fetch', '-q', 'origin');
if (!sgit('merge-base', '--is-ancestor', commit, 'origin/main').ok) {
  if (!dryRun) fail('look', `Spirality's ${commit.slice(0, 7)} is not on origin's main; copy from a merged commit, so the pull request can name it`);
  say('look', `Spirality ${commit.slice(0, 7)} is not on origin's main (fine for a dry run; a real run refuses it)`);
}
// Raw bytes, never run()'s trimmed text: these are compared byte for byte.
const rawSpirality = (path) => {
  const r = spawnSync('git', ['show', `${commit}:${path}`], { cwd: spirality });
  return r.status === 0 ? r.stdout : null;
};
const modeOf = (path) => (sgit('ls-tree', commit, '--', path).out.split(/\s/)[0] || '100644');
const textOf = (path) => { const b = rawSpirality(path); return b == null ? null : b.toString('utf8'); };

const checkout = expandHome(answers.checkoutDir);
const pgit = (...a) => run('git', a, { cwd: checkout });
if (!existsSync(checkout)) fail('look', `the product's checkout ${checkout} does not exist (the look, SP-108, says how to clone it)`);
if (!pgit('fetch', '-q', 'origin').ok) fail('look', `git fetch in ${checkout} failed`);
const origin = pgit('remote', 'get-url', 'origin').out;
if (!origin.toLowerCase().includes(answers.githubRepo.toLowerCase())) fail('look', `${checkout}'s origin is not ${answers.githubRepo}`);
const readProduct = (path) => {
  const r = spawnSync('git', ['show', `origin/main:${path}`], { cwd: checkout });
  return r.status === 0 ? r.stdout.toString('utf8') : null;
};
const repoView = run('gh', ['repo', 'view', answers.githubRepo, '--json', 'visibility', '-q', '.visibility']);
if (!repoView.ok) fail('look', `could not read ${answers.githubRepo} from GitHub: ${last(repoView.err)}`);

const manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));
const vars = templateVars(answers, homeConfig, { spiralityCommit: commit.slice(0, 7), visibility: repoView.out });
let planned;
try {
  planned = compareWithProduct(planCopies(manifest, { readSpirality: textOf, vars }), readProduct);
} catch (e) { fail('look', e.message); }

// The files made from the product's own.
const pkgText = readProduct('package.json');
if (pkgText == null) fail('look', `${answers.githubRepo} has no package.json on main`);
let npm;
try { npm = mergeNpmScripts(pkgText, manifest.npmScripts); } catch (e) { fail('look', e.message); }
if (npm.conflicts.length) {
  fail('look', `package.json already has ${npm.conflicts.map((c) => `"${c.name}" as "${c.theirs}" (the loop needs "${c.ours}")`).join('; ')}`);
}
const sectionsTemplate = textOf('scripts/onboard/templates/CLAUDE-sections.md');
const claude = withClaudeSections(readProduct('CLAUDE.md'), render(sectionsTemplate, vars, 'CLAUDE-sections.md'));
const ignoreEntry = manifest.made.find((m) => m.to === '.gitignore');
const ignore = withIgnoreLines(readProduct('.gitignore'), ignoreEntry?.ignoreLines || []);
const workflows = pgit('ls-tree', '--name-only', 'origin/main', '.github/workflows/').out.split('\n').filter(Boolean);
const haveVerify = hasVerifyJob(workflows.map((w) => readProduct(w) || ''));
let settingsText = null;
if (arg('config')) {
  try {
    const c = loadProjectConfig({ file: arg('config'), env: {} });
    if (c.githubRepo.toLowerCase() !== answers.githubRepo.toLowerCase()) throw new Error(`it names ${c.githubRepo}, the answers ${answers.githubRepo}`);
    if (c.productSlug !== answers.productSlug) throw new Error(`its productSlug is ${c.productSlug}, the answers' ${answers.productSlug}`);
    settingsText = readFileSync(arg('config'), 'utf8');
  } catch (e) { fail('look', `the settings file ${arg('config')}: ${e.message}`); }
}
const extra = [
  ...(settingsText == null ? [] : [{ to: 'spirality.project.json', kind: 'made', from: arg('config'), content: settingsText }]),
  { to: 'package.json', kind: 'made', from: `the product's own, plus ${npm.added.length ? npm.added.join(', ') : 'nothing'}`, content: npm.text },
  { to: '.gitignore', kind: 'made', from: ignore.added.length ? `the product's own, plus ${ignore.added.join(', ')}` : 'the product\'s own (it already ignores what the lanes need)', content: ignore.text },
  { to: 'CLAUDE.md', kind: 'made', from: claude.added ? 'the product\'s own, plus the loop\'s sections' : 'the product\'s own (the loop\'s sections are already there)', content: claude.text },
  ...(haveVerify ? [] : [{ to: '.github/workflows/verify.yml', kind: 'made', from: 'the answers\' check command', content: verifyWorkflow(answers) }]),
];
const all = [...planned, ...compareWithProduct(extra, readProduct)];

const width = Math.max(...all.map((f) => f.to.length));
console.log(`What ${answers.productName}'s setup pull request holds, from Spirality ${commit.slice(0, 7)}:\n`);
for (const f of all) console.log(`  ${f.to.padEnd(width)}  ${f.kind.padEnd(7)}  ${f.status}`);
console.log(`\n  ${all.filter((f) => f.status === 'identical').length} identical, ${all.filter((f) => f.status === 'new').length} new, ${all.filter((f) => f.status === 'replaces').length} replace what the product has`);
if (haveVerify) console.log('  The product already has a CI job named verify; no workflow is added.');
if (settingsText == null) console.log('  No --config given, so the settings file is not compared.');

// The product's own files are never replaced unasked. The door and the
// loop's own files (made by an earlier setup) are the loop's to update.
const theirs = all.filter((f) => f.status === 'replaces' && !['package.json', 'CLAUDE.md', '.gitignore'].includes(f.to) && !f.to.startsWith('loop/'));
if (dryRun) {
  if (theirs.length) console.log(`\nA real run would stop here unless --allow-replace: it would replace ${theirs.map((f) => f.to).join(', ')}.`);
  console.log('\nDry run done: nothing was written or opened.');
  process.exit(0);
}
if (theirs.length && !flag('allow-replace')) {
  fail('look', `it would replace files the product already has: ${theirs.map((f) => f.to).join(', ')}. Check them, then rerun with --allow-replace`);
}

// ── 2. write ───────────────────────────────────────────────────────────────
const worktree = join(onboardDir(homeConfig), `${answers.productSlug}-setup`);
if (!existsSync(worktree)) {
  mkdirSync(dirname(worktree), { recursive: true });
  const onOrigin = pgit('rev-parse', '--verify', '-q', `refs/remotes/origin/${BRANCH}`).ok;
  const add = onOrigin
    ? pgit('worktree', 'add', '-q', '-B', BRANCH, worktree, `origin/${BRANCH}`)
    : pgit('worktree', 'add', '-q', '-b', BRANCH, worktree, 'origin/main');
  if (!add.ok) fail('write', `git worktree add ${worktree}: ${last(add.err)}`);
}
const wgit = (...a) => run('git', a, { cwd: worktree });
if (wgit('rev-parse', '--abbrev-ref', 'HEAD').out !== BRANCH) fail('write', `${worktree} is not on ${BRANCH}`);
for (const f of all) {
  const target = join(worktree, f.to);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, f.kind === 'copy' ? rawSpirality(f.from) : f.content);
  if (f.kind !== 'made') chmodSync(target, modeOf(f.from) === '100755' ? 0o755 : 0o644);
}
say('write', `${all.length} files written in ${worktree}`);

// ── 3. check ───────────────────────────────────────────────────────────────
const scratch = mkdtempSync(join(tmpdir(), 'onboard-copy-'));
const differ = [];
try {
  for (const f of all.filter((x) => x.kind === 'copy')) {
    const original = join(scratch, 'original');
    writeFileSync(original, rawSpirality(f.from));
    if (!run('cmp', ['-s', original, join(worktree, f.to)]).ok) differ.push(f.to);
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }
if (differ.length) fail('check', `these differ from Spirality ${commit.slice(0, 7)} after the copy: ${differ.join(', ')}`);
say('check', `${all.filter((f) => f.kind === 'copy').length} files identical to Spirality ${commit.slice(0, 7)} (cmp)`);

// ── 4. pr ──────────────────────────────────────────────────────────────────
wgit('add', '-A');
if (wgit('status', '--porcelain').out) {
  const msg = `${answers.productName} gets the loop from Spirality ${commit.slice(0, 7)}: settings, verify check, ticket door, skills and lanes\n\nWritten by Spirality's setup wizard (scripts/onboard/copy.mjs). Every\n"copy" file is byte for byte Spirality ${commit}.`;
  const c = wgit('commit', '-q', '-m', msg);
  if (!c.ok) fail('pr', `git commit: ${last(c.err)}`);
  say('pr', `committed ${wgit('rev-parse', '--short', 'HEAD').out}`);
  // What git stored, not what was written: a product's .gitattributes (line
  // endings, filters) could change the bytes on the way in.
  const stored = all.filter((f) => f.kind === 'copy').filter((f) => {
    const r = spawnSync('git', ['show', `HEAD:${f.to}`], { cwd: worktree });
    return r.status !== 0 || !Buffer.from(r.stdout).equals(Buffer.from(rawSpirality(f.from)));
  }).map((f) => f.to);
  if (stored.length) fail('check', `after the commit these differ from Spirality ${commit.slice(0, 7)} (a .gitattributes rule?): ${stored.join(', ')}`);
  say('check', 'the commit holds every copied file byte for byte'); 
} else {
  say('pr', 'nothing new to commit');
}
const push = wgit('push', '-q', '-u', 'origin', BRANCH);
if (!push.ok) fail('pr', `git push: ${last(push.err)}`);
if (wgit('rev-parse', 'HEAD').out !== wgit('rev-parse', `origin/${BRANCH}`).out) fail('pr', `origin's ${BRANCH} does not read back as the commit just pushed`);

const title = `${answers.productName} cannot run Spirality's loop yet: add its settings, verify check, ticket door, loop skills and lanes`;
const rows = all.map((f) => `| \`${f.to}\` | ${f.kind === 'copy' ? `copy of \`${f.from}\`, cmp identical` : f.kind === 'adapted' ? `\`${f.from}\` with the manifest's edits: ${f.why}` : f.from} | ${f.status} |`);
const body = [
  `Everything ${answers.productName} needs to run Spirality's loop, in one pull request, written by Spirality's setup wizard.`,
  '',
  `**Spirality commit:** [\`${commit.slice(0, 7)}\`](https://github.com/${homeConfig.githubRepo}/commit/${commit}). Every "copy" file below was compared with \`cmp\` against that commit and is byte for byte identical. "Adapted" files are that commit's file with the named edits from \`scripts/onboard/manifest.json\`, each of which had to match exactly once.`,
  '',
  '| File | From, and how it was checked | Here before |',
  '|---|---|---|',
  ...rows,
  '',
  'After this merges, `loop/` is never edited here: a change is made in Spirality first and copied in.',
  '',
  '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
].join('\n');
let prUrl = run('gh', ['pr', 'list', '--repo', answers.githubRepo, '--head', BRANCH, '--state', 'open', '--json', 'url', '-q', '.[0].url']).out;
const bodyFile = join(dirname(worktree), `${answers.productSlug}-setup-pr.md`);
writeFileSync(bodyFile, body);
if (prUrl) {
  // A rerun: keep the PR, refresh its file list. A Ticket: line the lanes step added is kept.
  const old = run('gh', ['pr', 'view', prUrl, '--json', 'body', '-q', '.body']).out;
  const ticket = old.split('\n').find((l) => /^Ticket: /.test(l.trim()));
  if (ticket) writeFileSync(bodyFile, `${body}\n\n${ticket.trim()}\n`);
  const e = run('gh', ['pr', 'edit', prUrl, '--body-file', bodyFile]);
  if (!e.ok) fail('pr', `refreshing ${prUrl}: ${last(e.err)}`);
  say('pr', `${prUrl} already open; its file list is refreshed`);
} else {
  const p = run('gh', ['pr', 'create', '--repo', answers.githubRepo, '--base', 'main', '--head', BRANCH, '--title', title, '--body-file', bodyFile]);
  if (!p.ok) fail('pr', `gh pr create: ${last(p.err)}`);
  prUrl = p.out.split('\n').pop();
  say('pr', `opened ${prUrl}`);
}
const readBack = run('gh', ['pr', 'view', prUrl, '--json', 'headRefName,body', '-q', '.headRefName + " " + (.body | contains("' + commit.slice(0, 7) + '") | tostring)']).out;
if (readBack !== `${BRANCH} true`) fail('pr', `${prUrl} does not read back as ${BRANCH} naming ${commit.slice(0, 7)} (got "${readBack}")`);

// ── 5. readback ────────────────────────────────────────────────────────────
const door = (...a) => run('npm', ['run', '--silent', ...a], { cwd: worktree });
const doctor = door('doctor');
if (!doctor.ok) fail('readback', `npm run doctor in ${worktree}: ${last(doctor.out || doctor.err)}`);
say('readback', 'npm run doctor passes');
const who = door('clickup', '--', 'whoami');
if (!who.ok || !answersAsHandRun(who.out, answers.productSlug)) fail('readback', `npm run clickup -- whoami did not answer as ${answers.productSlug}'s hand-run seat: ${last(who.out || who.err)}`);
say('readback', `whoami: ${last(who.out, 1)}`);
const queue = door('clickup', '--', 'queue');
if (!queue.ok) fail('readback', `npm run clickup -- queue: ${last(queue.err || queue.out)}`);
say('readback', `queue: ${last(queue.out, 1)}`);
// CI's verify, read as JSON until it settles: up to 2 minutes for GitHub to
// register the check on a pull request just opened, then up to 30 for it to finish.
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const ci = () => {
  const r = run('gh', ['pr', 'checks', prUrl, '--json', 'name,bucket,state']);
  try { return ciVerdict(JSON.parse(r.out || '[]')); } catch { return { verdict: 'none', why: last(r.err || r.out) || 'gh gave no answer' }; }
};
const appearBy = Date.now() + 2 * 60 * 1000, finishBy = Date.now() + 30 * 60 * 1000;
let verdict = ci();
while (verdict.verdict === 'none' && Date.now() < appearBy) { sleep(10000); verdict = ci(); }
if (verdict.verdict === 'none') fail('readback', `after 2 minutes, ${prUrl} still has no verify check: ${verdict.why}`);
while (verdict.verdict === 'pending' && Date.now() < finishBy) { sleep(20000); verdict = ci(); }
if (verdict.verdict !== 'pass') fail('readback', `CI's verify on ${prUrl} did not pass: ${verdict.why}${verdict.verdict === 'pending' ? ' after 30 minutes' : ''}`);
say('readback', `CI's verify passed on ${prUrl}`);

console.log(`\nDone: ${prUrl} on branch ${BRANCH}. Next, the lanes step installs from it:`);
console.log(`  npm run onboard:lanes -- --checkout ${checkout} --branch ${BRANCH} --pr ${prUrl}`);
