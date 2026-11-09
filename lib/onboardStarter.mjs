/**
 * onboardStarter — the first commit the setup wizard's `start` step pushes to
 * an empty GitHub repository (SP-154, scripts/onboard/onboard.mjs).
 *
 * WHY. A repository made on GitHub with no files has no `main` branch: the
 * look cannot copy it to run its check, there is nothing to clone or protect,
 * and the setup's pull request has nothing to go into. And a README alone is
 * not enough: the setup runs `npm run verify` on main, which needs a
 * package.json. So the start step pushes the minimum the setup needs, and
 * nothing more (no framework, no stack): a package.json whose `verify` runs
 * the tests, `.nvmrc`, `.gitignore`, a README naming the project, one
 * placeholder test, and the package-lock.json `npm ci` (CI's install) needs.
 *
 * The files come from scripts/onboard/templates/starter/, `{{name}}` filled
 * from the answers. Nothing here names a project (rule 2).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from './onboardCopy.mjs';
import { parseNodeNeed } from './onboardAnswers.mjs';

/** Where the starter templates live, in Spirality's own checkout. */
export const STARTER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'onboard', 'templates', 'starter');

/**
 * Each template and the path it is written to in the new repository. The
 * dot files are kept without their dot under templates/, so Spirality's own
 * git and tools never read them as its own.
 */
export const STARTER_FILES = Object.freeze([
  { from: 'package.json', to: 'package.json' },
  { from: 'nvmrc', to: '.nvmrc' },
  { from: 'gitignore', to: '.gitignore' },
  { from: 'README.md', to: 'README.md' },
  { from: 'test/smoke.test.mjs', to: 'test/smoke.test.mjs' },
]);

/** The command the starter's package.json answers to: what the setup checks on main. */
export const STARTER_CHECK = 'npm run verify';

/**
 * The Node the starter names: the answers' `nodeVersion` when there is one
 * (as written, for engines.node), else this Mac's major version (`>=22`).
 * `.nvmrc` gets the major version either way. Null when neither can be read.
 */
export function starterNode(nodeVersion, thisNode) {
  const mine = parseNodeNeed(String(thisNode ?? '').replace(/^v/, ''));
  const mineMajor = mine && mine.min[0] > 0 ? mine.min[0] : null;
  if (nodeVersion) {
    const need = parseNodeNeed(nodeVersion);
    if (!need) return null;
    const major = need.min[0] > 0 ? need.min[0] : mineMajor;
    if (major == null) return null;
    return { engine: String(nodeVersion).trim(), major: String(major), source: 'the answers file' };
  }
  if (mineMajor == null) return null;
  return { engine: `>=${mineMajor}`, major: String(mineMajor), source: `this Mac's Node, ${thisNode}` };
}

/**
 * The starter's files, `[{ path, text }]`, in the order they are written.
 * `answers` gives projectSlug, projectName, githubRepo and nodeVersion;
 * `thisNode` is this Mac's Node ("v22.23.3"). Throws when the Node version
 * cannot be read, or a template does not render to what it must be.
 */
export function starterFiles(answers, thisNode, readTemplate = (name) => readFileSync(join(STARTER_DIR, name), 'utf8')) {
  const node = starterNode(answers.nodeVersion, thisNode);
  if (!node) throw new Error(`no Node version to write: the answers' nodeVersion is ${JSON.stringify(answers.nodeVersion ?? null)} and this Mac's Node is ${JSON.stringify(thisNode ?? null)}`);
  const vars = {
    projectSlug: answers.projectSlug,
    projectName: answers.projectName,
    githubRepo: answers.githubRepo,
    nodeEngine: node.engine,
    nodeMajor: node.major,
  };
  const files = STARTER_FILES.map(({ from, to }) => ({ path: to, text: render(readTemplate(from), vars, `the starter's ${from}`) }));
  const pkgText = files.find((f) => f.path === 'package.json').text;
  let pkg;
  try { pkg = JSON.parse(pkgText); } catch (err) { throw new Error(`the starter's package.json does not read as JSON once filled in (${err.message})`); }
  if (!pkg.scripts?.verify) throw new Error('the starter\'s package.json has no "verify" script');
  // What `npm install` writes for a package with no dependencies, so CI's
  // `npm ci` has a lock file to install from.
  const lock = {
    name: pkg.name,
    version: pkg.version,
    lockfileVersion: 3,
    requires: true,
    packages: { '': { name: pkg.name, version: pkg.version, engines: pkg.engines } },
  };
  files.push({ path: 'package-lock.json', text: `${JSON.stringify(lock, null, 2)}\n` });
  return files;
}

/** The first commit's message. */
export function starterMessage(answers) {
  return `Start ${answers.projectName}: the first commit Spirality's setup needs\n\nThe repository was empty. This is the minimum the setup runs on: a package.json whose\n\`npm run verify\` runs the tests, .nvmrc, .gitignore, a README and one placeholder test.\n`;
}

/**
 * GitHub's answer to `gh repo view <repo> --json isEmpty,defaultBranchRef`:
 * { empty, branch }, or null when it is not that answer.
 */
export function readEmptiness(text) {
  let v;
  try { v = JSON.parse(text); } catch { return null; }
  if (!v || typeof v !== 'object' || typeof v.isEmpty !== 'boolean') return null;
  return { empty: v.isEmpty, branch: v.defaultBranchRef?.name || null };
}
