/**
 * onboardCopy — the pure parts of the setup wizard's copy step (SP-110,
 * scripts/onboard/copy.mjs): what a project gets from Spirality in its ONE
 * setup pull request, rendered from scripts/onboard/manifest.json and the
 * answers, and compared with what the project already has.
 *
 * WHY ONE PULL REQUEST (SETUP_REVIEW.md hold-up 3). Normie's setup copied
 * Spirality's files in three pull requests (NO-3, NO-4, NO-5), each with its
 * own "go", review and "merge", plus NO-6's runners. A copy checked by
 * machine needs one: every "copy as is" file is compared byte for byte with
 * the Spirality commit it came from, and every adapted one is made by named
 * edits that must each match exactly once.
 *
 * Nothing here names a project: every project value comes from the answers
 * (lib/onboardAnswers.mjs) and the tracker home's settings file.
 */
import { dirname, join, normalize } from 'node:path';

/** The branch the setup pull request is made on, in the project's repository. */
export const SETUP_BRANCH = 'spirality-setup';

export class CopyError extends Error {
  constructor(message) { super(message); this.name = 'CopyError'; }
}

const PLACEHOLDER = /\{\{([a-zA-Z]+)\}\}/g;

/** `{{name}}` filled from `vars`; an unknown name is an error, never left in. */
export function render(template, vars, where = 'a template') {
  return String(template).replace(PLACEHOLDER, (_, name) => {
    if (!Object.hasOwn(vars, name) || vars[name] == null) throw new CopyError(`${where}: no value for {{${name}}}`);
    return String(vars[name]);
  });
}

/**
 * Spirality's text with the manifest's edits made. Each `find` must appear
 * exactly once: zero means Spirality's wording changed and the edit no longer
 * applies, two means it would change the wrong place. Either stops the copy.
 */
export function applyEdits(text, edits, vars, where) {
  let out = String(text);
  for (const { find, replace } of edits) {
    const count = out.split(find).length - 1;
    if (count !== 1) {
      const first = find.split('\n')[0].slice(0, 80);
      throw new CopyError(`${where}: an edit expects "${first}" exactly once and found it ${count} times; Spirality's file changed, so update scripts/onboard/manifest.json`);
    }
    out = out.replace(find, () => render(replace, vars, where));
  }
  return out;
}

/**
 * The values the templates and edits use. `visibility` is GitHub's word for
 * the repository ("PUBLIC" or "PRIVATE"); `spiralityCommit` the commit every
 * file is copied from. `ownVerify` is the project's own `verify` script when it
 * has one (null when the setup adds it, see verifyScriptFor).
 */
export function templateVars(answers, homeConfig, { spiralityCommit, visibility, ownVerify = null }) {
  const [firstMergePhrase, ...others] = answers.mergePhrases;
  const quoted = answers.mergePhrases.map((p) => `\`${p}\``);
  const mergePhrasesText = quoted.length > 1 ? `${quoted.slice(0, -1).join(', ')} or ${quoted[quoted.length - 1]}` : quoted[0];
  const name = answers.productName;
  const reviewSurface = answers.hosting
    ? `${name} is a website, so the surface is usually a page: give the PR's\npreview link (${answers.hosting}; it is on the PR's checks), the exact\npage on it and the clicks. For tooling with no page (CI, the loop's own\nfiles), give the exact command to paste and the output it prints.`
    : `${name}'s surface is usually a command: give the exact command to paste\nand the output it prints. If there is a page, give its URL.`;
  return {
    productName: name,
    productSlug: answers.productSlug,
    trackerPrefix: answers.trackerPrefix,
    dopplerProject: answers.dopplerProject,
    launchdPrefix: answers.launchdPrefix,
    checkoutDir: answers.checkoutDir,
    checkCommand: answers.checkCommand,
    logDir: homeConfig.logDir,
    trackerUrl: homeConfig.trackerUrl,
    spiralityRepo: homeConfig.githubRepo,
    spiralityCommit,
    mergePhrasesText,
    firstMergePhrase,
    otherMergePhrases: others.length ? `or ${others.map((p) => `\`${p}\``).join(', ')}` : 'the whole comment',
    visibilityLine: String(visibility).toUpperCase() === 'PUBLIC'
      ? 'This repository is public.'
      : 'This repository is private, but Spirality\'s pages are public: never copy its code or keys into a Spirality ticket, page or pull request.',
    reviewSurface,
    verifyMeaning: ownVerify
      ? `It is ${name}'s own \`verify\` script (\`${ownVerify}\`). CI's \`verify\` check runs \`${answers.checkCommand}\`, then the copied loop tests (\`npm run test:loop\`)`
      : `It runs \`${answers.checkCommand}\`, then the copied loop tests (\`npm run test:loop\`), the same thing CI's \`verify\` check runs`,
  };
}

const IMPORT_RE = /(?:\bfrom\s+|\brequire\(\s*|\bimport\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
const SOURCE_RE = /^\s*(?:source|\.)\s+"\$REPO\/([^"]+)"/gm;
const RUN_RE = /"\$REPO\/(scripts\/[^"\s]+\.(?:sh|mjs|cjs|js))"/g;

/**
 * Every Spirality file the given files need, following relative imports and
 * requires (an extensionless require is `.js`, as Node reads it) and the
 * runners' `source "$REPO/…"` and `"$REPO/scripts/…"` lines. `read(path)`
 * returns a file's text or null when it does not exist.
 */
export function needs(paths, read) {
  const seen = new Set();
  const missing = [];
  const queue = [...paths];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    const text = read(file);
    if (text == null) { missing.push(file); continue; }
    seen.add(file);
    if (/\.(?:m|c)?js$/.test(file)) {
      for (const m of text.matchAll(IMPORT_RE)) {
        let target = normalize(join(dirname(file), m[1]));
        if (!/\.[a-z]+$/.test(target)) target += '.js';
        queue.push(target);
      }
    }
    if (/\.sh$/.test(file)) {
      for (const m of text.matchAll(SOURCE_RE)) queue.push(m[1]);
      for (const m of text.matchAll(RUN_RE)) queue.push(m[1]);
    }
  }
  return { files: [...seen].sort(), missing: missing.sort() };
}

/**
 * The `verify` npm script the setup adds (SP-121), so "run `npm run verify`"
 * in every copied skill is true: the project's check, then the loop's copied
 * tests, the same as CI. A project with its own `verify` keeps it, untouched.
 * Returns { add: the command to add or null, own: the project's or null }.
 */
export function verifyScriptFor(pkgText, template, vars) {
  let pkg;
  try { pkg = JSON.parse(pkgText); } catch (e) { throw new CopyError(`the project's package.json does not parse: ${e.message}`); }
  const own = pkg.scripts && typeof pkg.scripts === 'object' && Object.hasOwn(pkg.scripts, 'verify') ? String(pkg.scripts.verify) : null;
  const ours = render(template, vars, 'manifest.json verifyIfAbsent');
  // Exactly the one the setup writes (an earlier run, or added by hand): it is the setup's, so a rerun says the same.
  if (own === ours) return { add: ours, own: null };
  if (own != null) return { add: null, own };
  if (/^npm run verify(?:\s|$)/.test(String(vars.checkCommand).trim())) {
    throw new CopyError(`the check command is "${vars.checkCommand}", but package.json has no verify script for it to run`);
  }
  return { add: ours, own: null };
}

/**
 * The workflow a project without a `verify` check gets: one job, named
 * verify. With `verifyAdded` (the setup gave it its `verify` script) the job
 * runs that one script, so CI and a pass run the same command; otherwise the
 * check and the loop's tests, as two steps.
 */
export function verifyWorkflow({ nodeVersion, checkCommand }, { verifyAdded = false } = {}) {
  const steps = verifyAdded
    ? `      - name: The project's check and the loop's copied tests
        run: npm run verify
`
    : `      - name: The project's check
        run: ${checkCommand}
      - name: The loop's copied tests
        run: npm run test:loop
`;
  return `name: verify

# Written by Spirality's setup wizard (scripts/onboard/copy.mjs). One job,
# named verify: the check main is protected by, and the one the loops run.

on:
  pull_request:
  push:
    branches: [main]

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${JSON.stringify(String(nodeVersion || '22'))}
          cache: npm
      - run: npm ci
${steps}`;
}

/** Does any of these workflow texts already have a job named `verify`? */
export function hasVerifyJob(workflowTexts) {
  return workflowTexts.some((t) => /^jobs:\s*$[\s\S]*?^ {2}verify:\s*$/m.test(String(t)));
}

/**
 * The project's package.json with `scripts` added. A script it already has
 * with the same command is kept; with a different command it is a conflict,
 * reported, never overwritten. Nothing of its own is removed.
 */
export function mergeNpmScripts(pkgText, scripts) {
  let pkg;
  try { pkg = JSON.parse(pkgText); } catch (e) { throw new CopyError(`the project's package.json does not parse: ${e.message}`); }
  const have = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const added = [], kept = [], conflicts = [];
  const next = { ...have };
  for (const [name, command] of Object.entries(scripts)) {
    if (!Object.hasOwn(have, name)) { next[name] = command; added.push(name); }
    else if (have[name] === command) kept.push(name);
    else conflicts.push({ name, theirs: have[name], ours: command });
  }
  const indent = /^(\s+)"/m.exec(pkgText)?.[1] || '  ';
  const text = `${JSON.stringify({ ...pkg, scripts: next }, null, indent)}\n`;
  return { text, added, kept, conflicts };
}

/** The project's CLAUDE.md with the loop's sections appended, unless they are there. */
export function withClaudeSections(existing, sections) {
  const text = existing == null ? '' : String(existing);
  if (/^## Where the work is tracked\s*$/m.test(text)) return { text, added: false };
  const head = text.trim() ? `${text.replace(/\s+$/, '')}\n\n` : '';
  return { text: `${head}${sections.replace(/\s+$/, '')}\n`, added: true };
}

/**
 * Every file the setup pull request writes, as { to, content, kind, from }:
 * kind "copy" (byte for byte from Spirality), "adapted" (Spirality's with the
 * manifest's edits) or "made" (from a template or the answers). The settings
 * file, package.json, CLAUDE.md and the workflow need the project's own
 * files, so copy.mjs adds them; this covers what Spirality alone decides.
 */
export function planCopies(manifest, { readSpirality, vars }) {
  const out = [];
  for (const entry of manifest.files) {
    const text = readSpirality(entry.from);
    if (text == null) throw new CopyError(`${entry.from} is in scripts/onboard/manifest.json but not in Spirality`);
    if (entry.edits?.length) out.push({ to: entry.to, from: entry.from, kind: 'adapted', why: entry.why, content: applyEdits(text, entry.edits, vars, entry.from) });
    else out.push({ to: entry.to, from: entry.from, kind: 'copy', content: text });
  }
  for (const entry of manifest.made.filter((m) => m.template && m.to !== 'CLAUDE.md')) {
    const template = readSpirality(entry.template);
    if (template == null) throw new CopyError(`${entry.template} is missing`);
    out.push({ to: entry.to, from: entry.template, kind: 'made', content: render(template, vars, entry.template) });
  }
  const seen = new Set();
  for (const f of out) {
    if (seen.has(f.to)) throw new CopyError(`${f.to} is written twice by the manifest`);
    seen.add(f.to);
  }
  return out;
}

/**
 * What each planned file does to the project: "new", "identical" or
 * "replaces" (the project has a different file there). `readProduct(path)`
 * returns the project's text or null.
 */
export function compareWithProduct(planned, readProduct) {
  return planned.map((f) => {
    const theirs = readProduct(f.to);
    const status = theirs == null ? 'new' : theirs === f.content ? 'identical' : 'replaces';
    return { ...f, status };
  });
}

/**
 * CI's word on the pull request, from `gh pr checks <url> --json
 * name,bucket,state` (one array, read once, never the --watch table: piped,
 * --watch prints its table again on every refresh, and its first `verify`
 * line is "pending" on any run where CI is still going). Returns
 * { verdict: 'pass' | 'fail' | 'pending' | 'none', why }.
 */
export function ciVerdict(checks, name = 'verify') {
  if (!Array.isArray(checks) || !checks.length) return { verdict: 'none', why: 'GitHub reports no checks on the pull request yet' };
  const mine = checks.filter((c) => c && c.name === name);
  if (!mine.length) return { verdict: 'none', why: `no check named ${name} yet (there are: ${checks.map((c) => c.name).join(', ')})` };
  const buckets = mine.map((c) => String(c.bucket || '').toLowerCase());
  if (buckets.some((b) => b === 'fail' || b === 'cancel')) return { verdict: 'fail', why: `${name} ${mine.map((c) => c.state).join(', ')}` };
  if (buckets.some((b) => b === 'pending')) return { verdict: 'pending', why: `${name} is still running` };
  if (buckets.every((b) => b === 'pass')) return { verdict: 'pass', why: `${name} passed` };
  return { verdict: 'fail', why: `${name} ended ${mine.map((c) => c.state).join(', ')}` };
}

/** Does `whoami` answer as this project's own hand-run seat? */
export function answersAsHandRun(whoamiOut, productSlug) {
  const m = /Acting as:\s+(\S+)\s+hand-run\b/.exec(String(whoamiOut || ''));
  return Boolean(m) && m[1].toLowerCase() === String(productSlug).toLowerCase();
}
