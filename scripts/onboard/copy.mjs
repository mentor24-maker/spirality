#!/usr/bin/env node
/**
 * The setup wizard's copy step (SP-110): everything a project needs from
 * Spirality arrives in ONE pull request in its repository, every copied file
 * checked byte for byte against the Spirality commit it came from
 * (SETUP_REVIEW.md part 3, step 4; Dane's answer to question 7).
 *
 *   npm run onboard:copy -- --answers <file> --config <settings file> [--allow-replace] [--check-only]
 *   npm run onboard:copy -- --answers <file> [--config <file>] --dry-run
 *
 * Run from Spirality's own folder, on a clean checkout of a commit that is on
 * origin's main (the pull request names it). What goes in is
 * scripts/onboard/manifest.json, rendered by lib/onboardCopy.mjs. The settings
 * file is the one given as --config (SP-109 writes it; SP-112 passes it in).
 *
 * In order, each step skipped when already done, so a rerun picks up where a
 * failed one stopped:
 *   1. look     the project's checkout and repository; what every file would
 *               do there (new / identical / replaces). A file of the
 *               project's own that would be replaced stops the run, unless
 *               --allow-replace. So does an npm command of its own
 *               the loop needs under the same name (its old loop's
 *               `clickup`, `doctor`): --allow-replace writes the loop's
 *               and the pull request lists what each was (SP-172); its
 *               own `verify` is always kept. --dry-run prints this and stops.
 *   2. write    a worktree on branch spirality-setup off origin's main, kept
 *               beside the answers file (never inside the project's
 *               checkout, which the lanes need clean): the files, the
 *               settings file, the npm scripts (with a `verify` that runs
 *               the check and the loop's tests, if it has no verify script),
 *               the CLAUDE.md sections, the .gitignore lines the lanes need
 *               (SP-120) and, if it has no verify check yet, the CI workflow
 *               (running `npm run verify` when that was added).
 *   3. check    every "copy as is" file compared with `cmp` against the
 *               Spirality commit; any difference stops it before commit.
 *   4. commit   SP-252: the project's packages installed in the worktree
 *               first (`npm ci`, when it has a package-lock.json), so its own
 *               git hooks can run on the commit; never `--no-verify`.
 *   5. verify   SP-252: the project's own `npm run verify`, run on the setup
 *               branch in the worktree. For a project already on ClickUp, a
 *               red verify first retires the old loop's tests that check
 *               the files the setup writes, by lib/onboardRetire.mjs's rule
 *               (fails alone here, passes alone where the branch started,
 *               names a file the setup writes), in a commit of its own; then
 *               verify runs again, the rule applied again to what fails next
 *               (up to three rounds). Still red stops the run. Skipped when it
 *               passed before on the same commit, and for a new project
 *               (CI runs its verify on the pull request, as before).
 *               `--check-only` stops here: nothing pushed, no pull request.
 *               The wizard runs it so before it stops a project's old loops.
 *   6. pr       push and one pull request; its body names the
 *               Spirality commit and lists every file with its check. For a
 *               project already on ClickUp (SP-159: its answers name a
 *               clickupListId) it also lists every file of the old copy it
 *               replaces, every file beside them it does not touch, and
 *               every test it retired, with why.
 *   7. readback from the worktree: `npm run doctor`, `npm run clickup --
 *               whoami` (the project's hand-run seat) and `queue`; then CI's
 *               verify on the pull request.
 *
 * It never touches the project's main and never merges: SP-111's lanes step
 * installs the lanes from the branch, and the project's own relay merges it
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
  RUN_ONE_TEST, RUN_ONE_TEST_ENV, TEST_FILE, parseRetired, pickRetired, retireCandidates, retiredLine, retiredSection,
} from '../../lib/onboardRetire.mjs';
import {
  planCopies, compareWithProject, templateVars, mergeNpmScripts, withClaudeSections, withIgnoreLines,
  verifyWorkflow, hasVerifyJob, verifyScriptFor, render, ciVerdict, answersAsHandRun, SETUP_BRANCH, oldCopyLists,
  npmConflictMessage, replacedScriptLines,
} from '../../lib/onboardCopy.mjs';

const BRANCH = SETUP_BRANCH;
const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const flag = (name) => argv.includes(`--${name}`);
const dryRun = flag('dry-run');
const allowReplace = flag('allow-replace');
const checkOnly = flag('check-only');
const rerun = `npm run onboard:copy -- ${argv.join(' ')}`;

function fail(step, seen) {
  console.error(`\nFAILED: ${step}: ${seen}`);
  console.error(`Nothing after this step ran. Fix it, then rerun:\n  ${rerun}`);
  process.exit(1);
}
const say = (step, line) => console.log(`${step.padEnd(8)} ${line}`);
const last = (text, n = 6) => String(text || '').split('\n').filter(Boolean).slice(-n).join(' | ');
// A project's verify can print a lot; spawnSync's 1 MB default would kill it.
function run(cmd, args, { cwd, input, env, timeout } = {}) {
  const r = spawnSync(cmd, args, { cwd, input, encoding: 'utf8', env: env ? { ...process.env, ...env } : process.env, timeout, maxBuffer: 256 * 1024 * 1024 });
  return { ok: r.status === 0, code: r.status, out: String(r.stdout || '').trim(), err: String(r.stderr || r.error || '').trim() };
}
const MINUTE = 60 * 1000;
// How many times the retire rule is applied before a red verify stops the run.
const RETIRE_ROUNDS = 3;

if (!arg('answers') || (!dryRun && !arg('config'))) {
  console.error('usage: npm run onboard:copy -- --answers <file> --config <settings file> [--allow-replace] [--check-only] [--dry-run]');
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
if (!existsSync(checkout)) fail('look', `the project's checkout ${checkout} does not exist (the look, SP-108, says how to clone it)`);
if (!pgit('fetch', '-q', 'origin').ok) fail('look', `git fetch in ${checkout} failed`);
const origin = pgit('remote', 'get-url', 'origin').out;
if (!origin.toLowerCase().includes(answers.githubRepo.toLowerCase())) fail('look', `${checkout}'s origin is not ${answers.githubRepo}`);
const readProject = (path) => {
  const r = spawnSync('git', ['show', `origin/main:${path}`], { cwd: checkout });
  return r.status === 0 ? r.stdout.toString('utf8') : null;
};
const repoView = run('gh', ['repo', 'view', answers.githubRepo, '--json', 'visibility', '-q', '.visibility']);
if (!repoView.ok) fail('look', `could not read ${answers.githubRepo} from GitHub: ${last(repoView.err)}`);

const manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));
const pkgText = readProject('package.json');
if (pkgText == null) fail('look', `${answers.githubRepo} has no package.json on main`);
const varsFor = (ownVerify) => templateVars(answers, homeConfig, { spiralityCommit: commit.slice(0, 7), visibility: repoView.out, ownVerify });
// Its own verify is kept; with none, it gets the check plus the loop's tests (SP-121).
let verify;
try { verify = verifyScriptFor(pkgText, manifest.verifyIfAbsent, varsFor(null)); } catch (e) { fail('look', e.message); }
const vars = varsFor(verify.own);
let planned;
try {
  planned = compareWithProject(planCopies(manifest, { readSpirality: textOf, vars }), readProject);
} catch (e) { fail('look', e.message); }

// The files made from the project's own. With --allow-replace the loop's
// npm commands replace the project's own (SP-172: a project that ran its own
// copy of the loop has `clickup` and `doctor`); its verify is always kept.
let npm;
try {
  npm = mergeNpmScripts(pkgText, { ...manifest.npmScripts, ...(verify.add ? { verify: verify.add } : {}) }, { replace: allowReplace });
} catch (e) { fail('look', e.message); }
if (npm.conflicts.length && !dryRun) fail('look', npmConflictMessage(npm.conflicts));
const sectionsTemplate = textOf('scripts/onboard/templates/CLAUDE-sections.md');
const claude = withClaudeSections(readProject('CLAUDE.md'), render(sectionsTemplate, vars, 'CLAUDE-sections.md'));
const ignoreEntry = manifest.made.find((m) => m.to === '.gitignore');
const ignore = withIgnoreLines(readProject('.gitignore'), ignoreEntry?.ignoreLines || []);
const workflows = pgit('ls-tree', '--name-only', 'origin/main', '.github/workflows/').out.split('\n').filter(Boolean);
const haveVerify = hasVerifyJob(workflows.map((w) => readProject(w) || ''));
let settingsText = null;
if (arg('config')) {
  try {
    const c = loadProjectConfig({ file: arg('config'), env: {} });
    if (c.githubRepo.toLowerCase() !== answers.githubRepo.toLowerCase()) throw new Error(`it names ${c.githubRepo}, the answers ${answers.githubRepo}`);
    if (c.projectSlug !== answers.projectSlug) throw new Error(`its projectSlug is ${c.projectSlug}, the answers' ${answers.projectSlug}`);
    settingsText = readFileSync(arg('config'), 'utf8');
  } catch (e) { fail('look', `the settings file ${arg('config')}: ${e.message}`); }
}
const extra = [
  ...(settingsText == null ? [] : [{ to: 'spirality.project.json', kind: 'made', from: arg('config'), content: settingsText }]),
  { to: 'package.json', kind: 'made', from: `the project's own, plus ${npm.added.length ? npm.added.join(', ') : 'nothing'}${npm.replaced.length ? `; ${npm.replaced.map((r) => r.name).join(', ')} replaced (--allow-replace)` : ''}`, content: npm.text },
  { to: '.gitignore', kind: 'made', from: ignore.added.length ? `the project's own, plus ${ignore.added.join(', ')}` : 'the project\'s own (it already ignores what the lanes need)', content: ignore.text },
  { to: 'CLAUDE.md', kind: 'made', from: claude.added ? 'the project\'s own, plus the loop\'s sections' : 'the project\'s own (the loop\'s sections are already there)', content: claude.text },
  ...(haveVerify ? [] : [{
    to: '.github/workflows/verify.yml', kind: 'made',
    from: verify.add ? 'runs npm run verify, which the setup adds' : 'the answers\' check command, then the loop\'s tests',
    content: verifyWorkflow(answers, { verifyAdded: Boolean(verify.add) }),
  }]),
];
const all = [...planned, ...compareWithProject(extra, readProject)];

const width = Math.max(...all.map((f) => f.to.length));
console.log(`What ${answers.projectName}'s setup pull request holds, from Spirality ${commit.slice(0, 7)}:\n`);
for (const f of all) console.log(`  ${f.to.padEnd(width)}  ${f.kind.padEnd(7)}  ${f.status}`);
console.log(`\n  ${all.filter((f) => f.status === 'identical').length} identical, ${all.filter((f) => f.status === 'new').length} new, ${all.filter((f) => f.status === 'replaces').length} replace what the project has`);
if (haveVerify) console.log('  The project already has a CI job named verify; no workflow is added.');
console.log(verify.add
  ? `  package.json ${npm.added.includes('verify') ? 'gets' : 'already has'} "verify": "${verify.add}", the same thing CI runs.`
  : `  package.json already has its own verify ("${verify.own}"); it is kept as it is.`);
if (settingsText == null) console.log('  No --config given, so the settings file is not compared.');
if (npm.replaced.length) {
  console.log('  --allow-replace: these npm commands of the project\'s are replaced with the loop\'s:');
  for (const line of replacedScriptLines(npm.replaced)) console.log(`    ${line}`);
}

// The project's own files are never replaced unasked. The door and the
// loop's own files (made by an earlier setup) are the loop's to update.
const theirs = all.filter((f) => f.status === 'replaces' && !['package.json', 'CLAUDE.md', '.gitignore'].includes(f.to) && !f.to.startsWith('loop/'));
if (dryRun) {
  if (theirs.length && !allowReplace) console.log(`\nA real run would stop here unless --allow-replace: it would replace ${theirs.map((f) => f.to).join(', ')}.`);
  if (npm.conflicts.length) console.log(`\nA real run would stop here: ${npmConflictMessage(npm.conflicts)}.`);
  console.log('\nDry run done: nothing was written or opened.');
  process.exit(0);
}
if (theirs.length && !allowReplace) {
  fail('look', `it would replace files the project already has: ${theirs.map((f) => f.to).join(', ')}. Check them, then rerun with --allow-replace`);
}

// ── 2. write ───────────────────────────────────────────────────────────────
const worktree = join(onboardDir(homeConfig), `${answers.projectSlug}-setup`);
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

// ── 4. commit ──────────────────────────────────────────────────────────────
// The project's own git hooks run on this commit (StarCaster's pre-commit
// needs esbuild), so its packages go in first. Never --no-verify.
const installPackages = (dir, step) => {
  if (!existsSync(join(dir, 'package-lock.json')) || existsSync(join(dir, 'node_modules', '.package-lock.json'))) return;
  say(step, `installing ${answers.projectName}'s packages in ${dir} (npm ci), so its own hooks and checks can run there`);
  const i = run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: dir, timeout: 30 * MINUTE });
  if (!i.ok) fail(step, `npm ci in ${dir}: ${last(i.err || i.out)}`);
};
const commitStep = (message, step) => {
  const c = wgit('commit', '-q', '-m', message);
  if (!c.ok) fail(step, `git commit in ${worktree} (the project's own hooks run on it): ${last(c.err || c.out)}`);
  say(step, `committed ${wgit('rev-parse', '--short', 'HEAD').out}`);
};
// node_modules is never part of it, even in a project that does not ignore it.
wgit('add', '-A', '--', '.', ':(exclude)node_modules');
installPackages(worktree, 'commit');
if (!wgit('diff', '--cached', '--quiet').ok) {
  const msg = `${answers.projectName} gets the loop from Spirality ${commit.slice(0, 7)}: settings, verify check, ticket door, skills and lanes\n\nWritten by Spirality's setup wizard (scripts/onboard/copy.mjs). Every\n"copy" file is byte for byte Spirality ${commit}.`;
  commitStep(msg, 'commit');
  // What git stored, not what was written: a project's .gitattributes (line
  // endings, filters) could change the bytes on the way in.
  const stored = all.filter((f) => f.kind === 'copy').filter((f) => {
    const r = spawnSync('git', ['show', `HEAD:${f.to}`], { cwd: worktree });
    return r.status !== 0 || !Buffer.from(r.stdout).equals(Buffer.from(rawSpirality(f.from)));
  }).map((f) => f.to);
  if (stored.length) fail('check', `after the commit these differ from Spirality ${commit.slice(0, 7)} (a .gitattributes rule?): ${stored.join(', ')}`);
  say('check', 'the commit holds every copied file byte for byte');
} else {
  say('commit', 'nothing new to commit');
}

// ── 5. verify (SP-252) ─────────────────────────────────────────────────────
const retiredFile = join(dirname(worktree), `${answers.projectSlug}-setup-retired.json`);
const verifiedFile = join(dirname(worktree), `${answers.projectSlug}-setup-verified`);
const readRetired = () => {
  const list = parseRetired(existsSync(retiredFile) ? readFileSync(retiredFile, 'utf8') : null);
  if (list == null) fail('verify', `${retiredFile} does not read as the list of retired tests; look at it, remove it, then rerun`);
  return list;
};
let retired = readRetired();
const head = () => wgit('rev-parse', 'HEAD').out;
// Where the setup branch started: the commit the old loop's tests must pass on.
const baseCommit = () => {
  const b = wgit('merge-base', 'HEAD', 'origin/main');
  if (!b.ok || !b.out) fail('verify', `git merge-base HEAD origin/main in ${worktree}: ${last(b.err) || 'no answer'}`);
  return b.out;
};
const projectVerify = () => run('npm', ['run', 'verify'], { cwd: worktree, timeout: 60 * MINUTE });
const showTail = (r, n = 25) => {
  for (const line of `${r.out}\n${r.err}`.split('\n').filter((l) => l.trim()).slice(-n)) console.log(`         | ${line}`);
};
const runOne = (dir, file) => run(RUN_ONE_TEST[0], [...RUN_ONE_TEST.slice(1), file], { cwd: dir, env: RUN_ONE_TEST_ENV, timeout: 5 * MINUTE }).code;
// The old loop's tests, by lib/onboardRetire.mjs's rule, each part run here.
const findRetirable = () => {
  const base = baseCommit();
  const tree = wgit('ls-tree', '-r', '--name-only', base);
  if (!tree.ok) fail('verify', `git ls-tree ${base.slice(0, 7)} in ${worktree}: ${last(tree.err)}`);
  const repoFiles = tree.out.split('\n').filter(Boolean);
  const read = (p) => { try { return readFileSync(join(worktree, p), 'utf8'); } catch { return null; } };
  const candidates = retireCandidates({ testFiles: repoFiles.filter((p) => TEST_FILE.test(p)), repoFiles, written: all.map((f) => f.to), read });
  say('verify', `${candidates.length} test file(s) of ${answers.projectName}'s own name a file this setup writes; running each alone on the setup branch (${RUN_ONE_TEST.join(' ')} <file>)`);
  const baseDir = join(dirname(worktree), `${answers.projectSlug}-setup-base`);
  const dropBase = () => { if (existsSync(baseDir)) pgit('worktree', 'remove', '--force', baseDir); };
  try {
    const { retired: found, kept } = pickRetired({
      candidates,
      runOnSetup: (file) => runOne(worktree, file),
      beforeBase: (n) => {
        say('verify', `${n} of them fail here; running those alone on ${base.slice(0, 7)}, where the setup branch started`);
        dropBase();
        const add = pgit('worktree', 'add', '-q', '--detach', baseDir, base);
        if (!add.ok) fail('verify', `git worktree add ${baseDir} ${base.slice(0, 7)}: ${last(add.err)}`);
        installPackages(baseDir, 'verify');
      },
      runOnBase: (file) => runOne(baseDir, file),
    });
    for (const k of kept) say('verify', `not retired: ${k.file} ${k.why}`);
    return found.map((c) => ({ ...c, base }));
  } finally {
    dropBase();
    if (existsSync(baseDir)) say('verify', `(could not remove the scratch worktree ${baseDir}; remove it by hand)`);
  }
};
if (!answers.clickupListId && !checkOnly) {
  say('verify', `${answers.projectName} is a new project, so its verify runs in CI on the pull request`);
} else if (existsSync(verifiedFile) && readFileSync(verifiedFile, 'utf8').trim() === head()) {
  say('verify', `${answers.projectName}'s npm run verify passed before on this commit (${head().slice(0, 7)})`);
} else {
  say('verify', `running ${answers.projectName}'s own npm run verify on the setup branch in ${worktree} (it can take minutes)`);
  let v = projectVerify();
  // Retiring a test can break a guard that checks the tests themselves
  // (StarCaster's clickupReserveDoor test looks for the tests it retires),
  // so the rule is applied again to what fails next, a few rounds at most.
  for (let round = 1; !v.ok && answers.clickupListId && round <= RETIRE_ROUNDS; round += 1) {
    showTail(v, 8);
    say('verify', `it fails; looking for the old loop's tests that only check the files this setup writes${round > 1 ? ` (round ${round}: a test can fail once the ones it checks are retired)` : ''}`);
    const found = findRetirable();
    if (!found.length) break;
    for (const r of found) say('verify', `retiring ${retiredLine(r)}`);
    const rm = wgit('rm', '-q', '--', ...found.map((r) => r.file));
    if (!rm.ok) fail('verify', `git rm in ${worktree}: ${last(rm.err)}`);
    commitStep([
      `Retire ${found.length} of ${answers.projectName}'s old-loop tests that check files this setup replaces`,
      '',
      'Each one fails alone on this branch, passes alone where it started, and',
      'names a file the setup writes (lib/onboardRetire.mjs, SP-252):',
      '',
      ...found.map((r) => `- ${retiredLine(r).replace(/`/g, '')}`),
    ].join('\n'), 'verify');
    const next = [...retired.filter((r) => !found.some((f) => f.file === r.file)), ...found];
    const text = `${JSON.stringify(next, null, 2)}\n`;
    writeFileSync(retiredFile, text);
    if (readFileSync(retiredFile, 'utf8') !== text) fail('verify', `${retiredFile} did not read back as written`);
    retired = next;
    say('verify', `running npm run verify again, with ${retired.length} test file(s) retired`);
    v = projectVerify();
  }
  if (!v.ok) {
    showTail(v);
    fail('verify', `${answers.projectName}'s own npm run verify fails on the setup branch (exit ${v.code}; its last lines are above)${retired.length ? `, with ${retired.length} old-loop test file(s) retired` : ''}. Nothing was pushed`);
  }
  writeFileSync(verifiedFile, `${head()}\n`);
  say('verify', `${answers.projectName}'s npm run verify passes on the setup branch (${head().slice(0, 7)})`);
}
// Every retired file is gone from the branch, and nothing else the project had is.
const gone = wgit('diff', '--name-only', '--diff-filter=D', `${baseCommit()}..HEAD`).out.split('\n').filter(Boolean).sort();
const listed = retired.map((r) => r.file).sort();
if (gone.join('\n') !== listed.join('\n')) fail('verify', `the setup branch deletes ${gone.length ? gone.join(', ') : 'nothing'}, but ${retiredFile} lists ${listed.length ? listed.join(', ') : 'nothing'}`);
if (checkOnly) {
  console.log(`\nDone (check only): ${answers.projectName}'s verify passes on ${BRANCH} in ${worktree}${retired.length ? `, with ${retired.length} old-loop test file(s) retired` : ''}. Nothing was pushed.`);
  process.exit(0);
}

// ── 6. pr ──────────────────────────────────────────────────────────────────
const push = wgit('push', '-q', '-u', 'origin', BRANCH);
if (!push.ok) fail('pr', `git push: ${last(push.err)}`);
if (wgit('rev-parse', 'HEAD').out !== wgit('rev-parse', `origin/${BRANCH}`).out) fail('pr', `origin's ${BRANCH} does not read back as the commit just pushed`);

const title = `${answers.projectName} cannot run Spirality's loop yet: add its settings, verify check, ticket door, loop skills and lanes`;
// A project that ran its own copy of the loop (SP-159): what of it this
// replaces, and what it leaves in place, said in the pull request.
let oldCopy = [];
if (answers.clickupListId) {
  const tree = pgit('ls-tree', '-r', '--name-only', 'origin/main');
  if (!tree.ok) fail('pr', `git ls-tree origin/main in ${checkout}: ${last(tree.err)}`);
  const retiredSet = new Set(retired.map((r) => r.file));
  const { replaced, leftInPlace } = oldCopyLists(all, tree.out.split('\n').filter((p) => !retiredSet.has(p)));
  const list = (paths) => (paths.length ? paths.map((p) => `- \`${p}\``) : ['- (none)']);
  oldCopy = [
    `**The old copy of the loop.** ${answers.projectName} ran its own copy of the loop, on ClickUp list ${answers.clickupListId}. This replaces these of its files (each is "replaces" in the table above):`,
    '',
    ...list(replaced),
    '',
    'These files of the project sit in the same folders as the files it writes. It does not touch them, and nothing is deleted; they are listed so a reviewer can see what the setup sits beside:',
    '',
    ...list(leftInPlace),
    '',
  ];
}
// What --allow-replace replaced in package.json, with what each command was,
// so a reviewer can put a still-wanted one back under another name.
const replacedNpm = npm.replaced.length ? [
  `**npm commands replaced.** \`--allow-replace\` replaced these of ${answers.projectName}'s own npm commands in \`package.json\` with the loop's:`,
  '',
  ...replacedScriptLines(npm.replaced).map((l) => `- ${l}`),
  '',
] : [];
const rows = all.map((f) => `| \`${f.to}\` | ${f.kind === 'copy' ? `copy of \`${f.from}\`, cmp identical` : f.kind === 'adapted' ? `\`${f.from}\` with the manifest's edits: ${f.why}` : f.from} | ${f.status} |`);
const body = [
  `Everything ${answers.projectName} needs to run Spirality's loop, in one pull request, written by Spirality's setup wizard.`,
  '',
  `**Spirality commit:** [\`${commit.slice(0, 7)}\`](https://github.com/${homeConfig.githubRepo}/commit/${commit}). Every "copy" file below was compared with \`cmp\` against that commit and is byte for byte identical. "Adapted" files are that commit's file with the named edits from \`scripts/onboard/manifest.json\`, each of which had to match exactly once.`,
  '',
  '| File | From, and how it was checked | Here before |',
  '|---|---|---|',
  ...rows,
  '',
  ...oldCopy,
  ...retiredSection(retired, { projectName: answers.projectName, base: retired[0]?.base }),
  ...replacedNpm,
  'After this merges, `loop/` is never edited here: a change is made in Spirality first and copied in.',
  '',
  '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
].join('\n');
let prUrl = run('gh', ['pr', 'list', '--repo', answers.githubRepo, '--head', BRANCH, '--state', 'open', '--json', 'url', '-q', '.[0].url']).out;
const bodyFile = join(dirname(worktree), `${answers.projectSlug}-setup-pr.md`);
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

// ── 7. readback ────────────────────────────────────────────────────────────
const door = (...a) => run('npm', ['run', '--silent', ...a], { cwd: worktree });
const doctor = door('doctor');
if (!doctor.ok) fail('readback', `npm run doctor in ${worktree}: ${last(doctor.out || doctor.err)}`);
say('readback', 'npm run doctor passes');
const who = door('clickup', '--', 'whoami');
if (!who.ok || !answersAsHandRun(who.out, answers.projectSlug)) fail('readback', `npm run clickup -- whoami did not answer as ${answers.projectSlug}'s hand-run seat: ${last(who.out || who.err)}`);
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
