'use strict';

/**
 * IS ANY PART OF THE GOVERNANCE MACHINERY AUTO-MERGEABLE?
 *
 * The sibling of `check:automerge-reach`, pointed the other way. That check
 * asks "has an auto-mergeable file reached the SERVER?", because Lane B's
 * safety argument is that no served route reaches `scripts/`. This one asks
 * "has an auto-mergeable file reached the machinery that GOVERNS merging?",
 * because Lane B's other safety argument is that a machine may never merge a
 * change to the machinery that governs it — the merge step, the referee that
 * decides what a review PASS is, and the gates. Ratified doctrine, criterion 4:
 *
 *   "A machine may never auto-merge a change to the machinery that governs
 *    machines ... CI workflows, git hooks, check_conventions, nodeRoles,
 *    .gitattributes, THE MERGE STEP ITSELF, or this document."
 *
 * WHY IT EXISTS (2026-09-06, task 86bbuzyra, the fourth catch-up merge).
 * `GOVERNANCE_STEMS` in `autoMergeLane.js` is a list maintained BY HAND, and a
 * hand-maintained list cannot cover a file that did not exist when it was
 * written. Between 2026-09-04 and 2026-09-06, six modules were lifted out of
 * the merge step into their own files — `mergeCompletion`, `mergeWindowLease`,
 * `mergeWindowLeaseFile`, `shipAlreadyLive`, `pipelineSweep`,
 * `strandedLocalWork` — and every one of them landed inside Lane B's folder
 * and outside the stem list. Measured on this branch the moment the catch-up
 * merge finished:
 *
 *     laneEligibility(['scripts/builder/mergeWindowLease.js'])
 *       -> { lane: 'B', reason: "all 1 changed file(s) are the pipeline's own
 *            tooling, tests or documents" }
 *
 * Nobody was careless. Refactoring behind a boundary is the normal way the
 * boundary expires, and it had already happened twice in one day to the
 * ClickUp client (see the `clickupRetry` and `clickupLedger` entries in
 * `autoMergeLane.js`). Dane predicted exactly this when he chose the boundary:
 *
 *   "A folder boundary is not permanent ... Otherwise this decision silently
 *    expires."                                          — Dane, 2026-09-04
 *
 * So the list stays by hand — a machine cannot be trusted to decide what
 * governs machines — but forgetting to extend it is no longer silent.
 *
 * TWO QUESTIONS, BECAUSE THEY FAIL DIFFERENTLY.
 *
 *   1. Can this file EXECUTE a merge? Structural and exact: it invokes
 *      `gh pr merge` or the GitHub merge endpoint. This is the strongest
 *      claim in the file and needs no judgement from anybody.
 *   2. Does the merge step DEPEND on it? A module the merge step imports
 *      decides what the merge step does, whether or not it runs `gh` itself.
 *      That is the extraction case above, and it is the one that actually
 *      happened.
 *
 * Question 2 carries a NAMED allowlist rather than a blanket rule, because a
 * blanket rule over-blocks: `pullRequestTitle.js` names a pull request and
 * cannot merge one. Three entries today. An entry is an exception and should
 * stay rare; a fourth is worth an argument, not a shrug.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { governanceReason, laneForFile } = require('./autoMergeLane.js');

const ROOT = path.resolve(__dirname, '..', '..');
const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');

/** Trees that can hold Node code able to reach `gh` or the GitHub API. */
const WALKED = ['scripts', 'lib'];

/**
 * Comments are stripped before ANY match. This repo has twice had a
 * source-anchored assertion measure a comment that quoted the very string it
 * was searching for, and it bites here immediately: `refusalClass.js` carries
 * the line "// `gh pr merge` failing once says nothing about the next
 * attempt", and `mergeCompletion.js` quotes six lines of `gh pr merge --help`
 * in its docstring. Both would be false positives, and a guard that cries
 * wolf on a comment gets its allowlist padded until it means nothing.
 */
function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * `gh pr merge` in either the shell-string form or the argv-array form, plus
 * the REST endpoint.
 *
 * Deliberately NOT matching a bare `--squash`: `git merge --squash` is an
 * ordinary local operation, and `repoStateShipped.test.js` runs one in a
 * fixture. Measured before narrowing it — the loose version reported that file
 * and `refusalClass.js` as merge executors, and both are wrong.
 */
const MERGE_CALL = [
  /\bgh\b[^\n]{0,40}\bpr\b[^\n]{0,20}\bmerge\b/,
  /(['"])pr\1\s*,\s*(['"])merge\2/,
  /pulls\/[^'"\n]*\/merge/,
];

function executesAMerge(src) {
  const code = stripComments(src);
  return MERGE_CALL.some((re) => re.test(code));
}

function sourceFilesUnder(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sourceFilesUnder(p, out);
    else if (/\.(js|mjs|cjs|ts)$/.test(e.name)) out.push(p);
  }
  return out;
}

function walkedSourceFiles() {
  const out = [];
  for (const tree of WALKED) sourceFilesUnder(path.join(ROOT, tree), out);
  return out;
}

/* ------------------------------------------------------------------ *
 * 1. A FILE THAT CAN EXECUTE A MERGE IS GOVERNANCE.
 * ------------------------------------------------------------------ */

test('every file that can execute a merge is governance-blocked', () => {
  const offenders = [];
  for (const abs of walkedSourceFiles()) {
    const file = rel(abs);
    if (!executesAMerge(fs.readFileSync(abs, 'utf8'))) continue;
    if (governanceReason(file)) continue;
    if (!laneForFile(file)) continue; // no lane carries it anyway
    offenders.push(file);
  }
  assert.deepEqual(offenders, [],
    'these files can run `gh pr merge` and a lane would carry them, so the '
    + 'machine could auto-merge a change to how it merges — add the stem to '
    + 'GOVERNANCE_STEMS in scripts/builder/autoMergeLane.js');
});

/*
 * THE DETECTOR MUST BE ABLE TO FIND SOMETHING, or the assertion above passes
 * for the wrong reason forever. Every shape is one that exists in this repo.
 */
test('the merge-executor detector can see a real merge call', () => {
  const real = [
    "  await run(['gh', 'pr', 'merge', String(pr), '--squash']);",
    '  execSync(`gh pr merge ${pr} --squash --delete-branch`);',
    "  await api(`/repos/${owner}/${repo}/pulls/${pr}/merge`, { method: 'PUT' });",
  ];
  for (const src of real) {
    assert.equal(executesAMerge(src), true, `should have detected: ${src}`);
  }
});

/*
 * ...AND MUST NOT FIRE ON THE TWO THINGS THAT ARE NOT A MERGE STEP. Both were
 * measured as false positives on the first, looser version of MERGE_CALL.
 */
test('the merge-executor detector ignores comments and local git merges', () => {
  assert.equal(
    executesAMerge('// `gh pr merge` failing once says nothing about the next attempt.\nconst x = 1;'),
    false, 'a comment quoting the command is not a merge call — refusalClass.js');
  assert.equal(
    executesAMerge('/**\n * "If required checks have passed, gh pr merge adds it to the queue."\n */\nconst y = 2;'),
    false, 'a docstring quoting `gh pr merge --help` is not a merge call — mergeCompletion.js');
  assert.equal(
    executesAMerge("  run(['merge', '--squash', branch]);"),
    false, 'a local `git merge --squash` is not a pull-request merge — repoStateShipped.test.js');
});

/*
 * THE WALK MUST REACH WHAT THE SENTENCE CLAIMS. A guard can go blind by
 * narrowing its walk, and a walk that quietly stops opening a folder looks
 * exactly like a repo with nothing wrong in it.
 */
test('the walk reaches both trees and the merge executors already in them', () => {
  const walked = walkedSourceFiles().map(rel);
  for (const tree of WALKED) {
    assert.ok(walked.some((f) => f.startsWith(`${tree}/`)),
      `the walk opened no file under ${tree}/ — it has narrowed and the guard is blind there`);
  }
  // Named rather than counted: a count drifts and says nothing about WHICH
  // file stopped being seen. Both of these really do run `gh pr merge` today.
  for (const known of ['scripts/clickup_direct.mjs', 'scripts/ship_thread.cjs']) {
    assert.ok(walked.includes(known), `the walk never opened ${known}`);
    assert.equal(executesAMerge(fs.readFileSync(path.join(ROOT, known), 'utf8')), true,
      `${known} no longer reads as a merge executor — either it changed or the detector did`);
  }
});

/* ------------------------------------------------------------------ *
 * 2. WHAT THE MERGE STEP DEPENDS ON IS THE MERGE STEP.
 * ------------------------------------------------------------------ */

/**
 * WHAT COUNTS AS GOVERNANCE MACHINERY — and therefore whose imports get asked
 * the question below.
 *
 * THREE KINDS, because `GOVERNANCE_STEMS` protects three kinds and says so in
 * its own section headings: the merge step, "the referee: what counts as a
 * review PASS", and the gates. Until 2026-09-06 only the FIRST of the three
 * had a guard, which review round 2 on task 86bbuzyra found. So the exact rot
 * this file exists to stop — a hand-kept list that cannot name a file
 * extracted after it was written — was still wide open for the other two, and
 * this branch is what newly exposes them: before Lane B, `scripts/` was
 * refused by accident. Measured on this branch before the fix:
 *
 *     laneEligibility(['scripts/builder/reviewGateClickup.js'])
 *       -> { lane: 'B' }   // decides whether the referee sees a passing verdict
 *
 * TWO OF THE THREE ARE DERIVED, NOT LISTED. The referee is found by stem and
 * the gates by the `scripts/check_` prefix — the same rules `governanceReason`
 * already uses to block them, so the two lists cannot disagree. Naming four
 * files here by hand, which is what the send-back suggested, would have
 * reproduced the original defect one door over: a sixteenth `scripts/check_*`
 * gate would be blocked on arrival and its dependencies still never asked.
 *
 * Deriving is not theory here — it found a file the hand list missed.
 * `scripts/pin_asset_versions.cjs` is imported by `check_asset_versions.cjs`
 * for `defaultHtmlTargets` and `hashFile`: it is that gate's target list and
 * its hash function, i.e. the gate's entire subject.
 *
 * The MERGE STEP stays a literal list because it shares no stem or prefix to
 * derive from. `every named root exists` below is what keeps it honest, and
 * the extraction guard is what catches the pieces it loses.
 *
 * `scripts/clickup_direct.mjs` is deliberately NOT a root even though it
 * performs the merge, and that carve-out survives this widening on purpose.
 * It is the 4000-line relay and imports 28 modules, most of them ordinary
 * ClickUp commands — `loopNote`, `operatorCard`, `buildStart`. Rooting here
 * would demand blocking all of them and would narrow Lane B far past the
 * boundary Dane actually chose, which is his call and not this test's. The
 * merge-step modules it imports are roots in their own right below, which is
 * where the real question lives.
 */
const MERGE_STEP_ROOTS = [
  'scripts/builder/mergeOnComment.js',
  'scripts/builder/mergeWindowLease.js',
  'scripts/builder/mergeWindowLeaseFile.js',
  'scripts/builder/mergeCompletion.js',
  'scripts/builder/shipAlreadyLive.js',
  'scripts/builder/branchCatchUp.js',
  'scripts/builder/waitForChecks.js',
  'scripts/builder/autoMergeLane.js',
  'scripts/ship_thread.cjs',
];

/**
 * The referee, by stem — the same three stems `GOVERNANCE_STEMS` files under
 * "what counts as a review PASS, and what a send-back is".
 *
 * Test files are excluded from the ROOTS (not from the blocking, which
 * `governanceReason` already does): a test decides nothing at run time, and
 * rooting on one drags its fixtures-only helpers into the question.
 */
const REFEREE_RE = /(^|\/)(reviewGate|review_gate|sendBackRounds)\.(js|mjs|cjs)$/;

/** The gates, by the prefix `GOVERNANCE_FILE_PREFIXES` already blocks. */
const GATE_PREFIX = 'scripts/check_';

const isTestFile = (f) => /\.test\.(js|mjs|cjs|ts|tsx)$/.test(f);

function refereeRoots() {
  return walkedSourceFiles().map(rel).filter((f) => REFEREE_RE.test(f) && !isTestFile(f));
}

function gateRoots() {
  return walkedSourceFiles().map(rel).filter((f) => f.startsWith(GATE_PREFIX) && !isTestFile(f));
}

/** Every root, in the order the three kinds are described above. */
function governedRoots() {
  return [...MERGE_STEP_ROOTS, ...refereeRoots(), ...gateRoots()];
}

/**
 * Dependencies of the merge step that a lane may still carry, each with why.
 *
 * An entry says: this file is imported by the merge step and cannot change
 * what the merge step DECIDES. Three today. It should stay small — if it is
 * growing, the honest reading is that the merge step has absorbed something,
 * not that the exceptions are getting more reasonable.
 */
const ALLOWED_DEPENDENCIES = new Map([
  ['scripts/builder/pullRequestTitle.js',
    'chooses the TITLE of a pull request. It cannot merge one, and a wrong '
    + 'title is visible to Dane in the deploy list rather than silent.'],
  ['scripts/builder/pullRequestCommit.js',
    'picks which commit subject a pull request is named after. Naming only, '
    + 'for the same reason as pullRequestTitle.'],
  ['scripts/lib/repo_state.cjs',
    'reads branch and worktree state (`git cherry`, worktree lists). It '
    + 'reports what the repo IS; nothing in it decides whether to merge.'],
  ['scripts/builder/checklessMessage.js',
    'WORDS ONLY, on a path that has already stopped. It builds the text ship '
    + 'prints when a pull request has no CI checks, and its single call site '
    + 'is the argument to `fail(...)` — pinned by "THE COUPLING" in '
    + 'shipThread.test.js — so it is reached only where the merge has already '
    + 'been refused. It cannot make ship merge anything; the worst a bad '
    + 'change here can do is give the operator advice that does not work, '
    + 'which is loud rather than silent.'],
]);

const EXTS = ['', '.js', '.mjs', '.cjs', '.json', '/index.js'];

/** Every require()/import specifier in a file, without executing it. */
function specifiersIn(src) {
  const out = [];
  const re = /(?:require\s*\(\s*|(?:^|[\s;}])(?:import|export)[\s\S]{0,200}?\bfrom\s*|import\s*\(\s*)(['"])([^'"]+)\1/g;
  let m;
  while ((m = re.exec(src))) out.push(m[2]);
  return out;
}

function resolveLocal(fromAbs, spec) {
  if (!spec.startsWith('.')) return null; // a package, not our code
  const base = path.resolve(path.dirname(fromAbs), spec);
  for (const ext of EXTS) {
    const cand = base + ext;
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
  }
  return null;
}

/** The direct dependencies of one file, as repo-relative paths. */
function directDependencies(file) {
  const abs = path.join(ROOT, file);
  const src = fs.readFileSync(abs, 'utf8');
  const out = new Set();
  for (const spec of specifiersIn(src)) {
    const next = resolveLocal(abs, spec);
    if (!next) continue;
    const r = rel(next);
    if (!r.startsWith('..')) out.add(r);
  }
  return [...out];
}

test('every named root exists and is itself governance-blocked', () => {
  for (const root of governedRoots()) {
    assert.ok(fs.existsSync(path.join(ROOT, root)),
      `${root} is named as governance machinery but does not exist — it was `
      + 'renamed or split, and this guard has been walking a file that is not there');
    assert.ok(governanceReason(root),
      `${root} is named as governance machinery but no lane rule blocks it`);
  }
});

/*
 * A DERIVED LIST FAILS DIFFERENTLY FROM A HAND-KEPT ONE. The hand-kept list
 * rots by omission, loudly, once somebody looks; a derivation that stops
 * matching returns an empty set and every assertion built on it passes
 * forever. That is the same shape as the blind walk above, so it gets the
 * same treatment: name what each rule must find rather than counting.
 */
test('the derived root rules still find the referee and the gates', () => {
  const referee = refereeRoots();
  for (const known of ['scripts/builder/reviewGate.js', 'scripts/review_gate.mjs']) {
    assert.ok(referee.includes(known),
      `the referee rule no longer matches ${known} — it has gone blind, and `
      + 'every dependency of the review gate is unasked');
  }
  const gates = gateRoots();
  for (const known of ['scripts/check_conventions.cjs', 'scripts/check_syntax.cjs']) {
    assert.ok(gates.includes(known),
      `the gate rule no longer matches ${known} — it has gone blind, and every `
      + 'dependency of the gates is unasked');
  }
  // The prefix is a family, not two files: `check_conventions` is the one
  // doctrine names by hand and the rest are the same kind of thing.
  assert.ok(gates.length >= 10, `expected the scripts/check_* family, found ${gates.length}`);

  // ...and a test file is NOT a root, or the fixtures-only helpers of every
  // gate's test get dragged into the question and the allowlist gets padded.
  assert.ok(!governedRoots().some(isTestFile),
    'a test decides nothing at run time and must not be a root');
});

test('every direct dependency of the merge step is blocked, or allowed by name', () => {
  const offenders = [];
  for (const root of governedRoots()) {
    for (const dep of directDependencies(root)) {
      if (governanceReason(dep)) continue;
      if (!laneForFile(dep)) continue; // outside every lane anyway
      if (ALLOWED_DEPENDENCIES.has(dep)) continue;
      offenders.push(`${dep}  (imported by ${root})`);
    }
  }
  assert.deepEqual(offenders, [],
    'the merge step, the referee or a gate imports these, so a change to one '
    + 'changes what that machinery decides — and a lane would carry it without '
    + 'Dane. Add the stem to GOVERNANCE_STEMS, or record it in '
    + 'ALLOWED_DEPENDENCIES with a reason.');
});

/*
 * A recorded allowance that is no longer a dependency is stale bookkeeping,
 * and a stale allowance is how an exception outlives its reason.
 */
test('every allowance is still a real dependency of governance machinery', () => {
  const deps = new Set(governedRoots().flatMap(directDependencies));
  for (const [dep, why] of ALLOWED_DEPENDENCIES) {
    assert.ok(deps.has(dep),
      `${dep} is allowed as a governance-machinery dependency but nothing in `
      + 'the merge step, the referee or a gate imports it any more — delete the '
      + 'entry rather than leaving it to excuse the file if it ever comes back');
    assert.ok(why && why.length > 20, `${dep} must say WHY it is allowed`);
  }
});

/*
 * THE DEPENDENCY DETECTOR MUST BE ABLE TO FIND SOMETHING TOO. This is the
 * exact shape of the failure that produced this file: a module extracted out
 * of the merge step, imported straight back in, and auto-mergeable.
 */
test('the dependency detector can see a freshly extracted module', () => {
  const src = "const { didItMerge } = require('./mergeCompletion.js');\n"
    + "const { pick } = require('./pullRequestTitle.js');\n";
  const tmp = path.join(ROOT, 'scripts', 'builder', '__merge_guard_probe.js');
  fs.writeFileSync(tmp, src);
  try {
    const deps = directDependencies('scripts/builder/__merge_guard_probe.js');
    assert.ok(deps.includes('scripts/builder/mergeCompletion.js'),
      'the specifier scan no longer resolves a plain require() — it is blind');
    assert.ok(deps.includes('scripts/builder/pullRequestTitle.js'));
    // ...and the two halves of the verdict really do differ, which is what
    // makes the assertion above meaningful rather than uniformly true.
    assert.ok(governanceReason('scripts/builder/mergeCompletion.js'),
      'mergeCompletion must be blocked — it is the merge step');
    assert.equal(governanceReason('scripts/builder/pullRequestTitle.js'), null,
      'pullRequestTitle must NOT be blocked, or the allowlist above is dead '
      + 'code and this guard is quietly blocking everything it walks');
  } finally {
    fs.unlinkSync(tmp);
  }
});
