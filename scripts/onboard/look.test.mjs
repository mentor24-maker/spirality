import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProjectConfig } from '../../lib/projectConfig.mjs';
import { resolveAnswers } from '../../lib/onboardAnswers.mjs';
import { seatsForConfig } from '../../tracker/signins.mjs';
import {
  BLOCKED, READY, UNKNOWN, WILL_DO, checkEnv, cloneFolder, exitCodeFor, formatRow, ghApiFailure, lastLines, look,
  readCheck, readCheckout, readClaude, readDoppler, readDopplerMe, readNode, readProtection,
  projectMismatch, readRepo, withoutSignIn, nodeNeedOf, samePathOnDisk, summaryLine, trackerRows,
} from './look.mjs';
import { normalRepo } from '../lib/repoCheck.mjs';
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseNodeNeed } from '../../lib/onboardAnswers.mjs';

const homeConfig = validateProjectConfig({
  manifestVersion: 2, workspaceId: '1', spaceId: '1', loopQueueListId: '1', operatorUserId: '1', machineUserId: '2',
  githubRepo: 'owner/home', dopplerProject: 'home', dopplerConfig: 'dev', launchdPrefix: 'com.home',
  logDir: '~/loop-logs', mergePhrases: ['merge'], governancePaths: ['CLAUDE.md'], autoMergeLanes: [],
  operatorName: 'Dane', projectSlug: 'home', legacyMachinePrefixes: [], projectScripts: {},
  trackerPrefix: 'SP', trackerPort: 4180, trackerDataDir: '~/t', tracker: 'api',
  trackerUrl: 'http://mini.local:4180', trackerApiUrl: 'http://127.0.0.1:4180',
});
const answers = resolveAnswers({
  projectName: 'Normie', githubRepo: 'mentor24-maker/normie', trackerPrefix: 'NO',
  checkoutDir: '/Users/dane/WebApps/normie', checkCommand: 'npm run verify:full', description: 'Polls.',
}, { homeConfig, homeRoot: '/Users/dane/WebApps/home' });

const ok = (stdout = '') => ({ status: 0, stdout, stderr: '', error: null, signal: null });
const failed = (status, stderr = '', stdout = '') => ({ status, stdout, stderr, error: null, signal: null });
const seatNames = seatsForConfig({ trackerPort: null, projectSlug: 'normie', operatorName: 'Dane' }).seats.map((s) => s.name);

test('every row names what it checked, and its verdict reads as the ticket says', () => {
  assert.equal(formatRow({ item: 'GitHub: repository x/y', verdict: READY, why: 'exists', detail: [] }), 'GitHub: repository x/y: ready (exists)');
  assert.equal(formatRow({ item: 'A', verdict: WILL_DO, why: 'absent', detail: [] }), 'A: will do (absent)');
  assert.equal(formatRow({ item: 'A', verdict: BLOCKED, why: 'no', detail: ['last'] }), 'A: BLOCKED: no\n      | last');
  assert.equal(formatRow({ item: 'A', verdict: UNKNOWN, why: 'down', detail: [] }), 'A: could not tell: down');
  assert.throws(() => formatRow({ item: 'A', verdict: 'fine', why: '', detail: [] }), /unknown verdict/);
});

test('exit 3 for anything BLOCKED, else 1 for anything unknown, else 0', () => {
  const r = (verdict) => ({ item: 'x', verdict, why: '', detail: [] });
  assert.equal(exitCodeFor([r(READY), r(WILL_DO)]), 0);
  assert.equal(exitCodeFor([r(READY), r(UNKNOWN)]), 1);
  assert.equal(exitCodeFor([r(UNKNOWN), r(BLOCKED)]), 3);
  assert.match(summaryLine([r(READY), r(WILL_DO)]), /nothing is BLOCKED\. 1 item\(s\) the setup will do, 1 already ready/);
  assert.match(summaryLine([r(UNKNOWN)]), /not a clean bill/);
  assert.match(summaryLine([r(BLOCKED)]), /1 BLOCKED/);
});

test('the last lines of output lose their colour codes and blank lines', () => {
  assert.deepEqual(lastLines('a\n\n\u001b[31mred\u001b[39m\n  \nb\n', 2), ['red', 'b']);
});

test('a git remote in any form is the same repository', () => {
  for (const r of ['https://github.com/Mentor24-Maker/normie.git', 'git@github.com:mentor24-maker/normie.git', 'ssh://git@github.com/mentor24-maker/normie', 'mentor24-maker/normie']) {
    assert.equal(normalRepo(r), 'mentor24-maker/normie', r);
  }
});

test('a sign-in part comes out of an address, whatever the host', () => {
  assert.equal(withoutSignIn('https://x-access-token:ghp_FAKE@github.com/a/b'), 'https://github.com/a/b');
  assert.equal(withoutSignIn('https://user:tok@gitlab.com/a/b.git'), 'https://gitlab.com/a/b.git');
  assert.equal(withoutSignIn('git@github.com:a/b.git'), 'git@github.com:a/b.git');
  assert.equal(withoutSignIn('https://github.com/a/b'), 'https://github.com/a/b');
});

test('--project must name the project the answers file is for', () => {
  assert.equal(projectMismatch(null, { projectSlug: 'normie' }, '/a.json'), null);
  assert.equal(projectMismatch('normie', { projectSlug: 'normie' }, '/a.json'), null);
  assert.match(projectMismatch('pressplay', { projectSlug: 'normie' }, '/a.json'), /\/a\.json is for the project "normie", not "pressplay"/);
});

test('the same folder through a symlink is the same folder; a folder beside it is not', () => {
  const base = mkdtempSync(join(tmpdir(), 'sp108-'));
  try {
    mkdirSync(join(base, 'real'));
    mkdirSync(join(base, 'other'));
    symlinkSync(join(base, 'real'), join(base, 'link'));
    assert.equal(samePathOnDisk(join(base, 'link'), `${join(base, 'real')}/`), true);
    assert.equal(samePathOnDisk(join(base, 'other'), join(base, 'real')), false);
    // On a disk that ignores case (macOS's), capitals typed differently are the same folder.
    if (existsSync(join(base, 'REAL'))) assert.equal(samePathOnDisk(join(base, 'REAL'), join(base, 'real')), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('the repository: exists and can push; missing is BLOCKED; gh not installed could not tell', () => {
  const view = readRepo(ok(JSON.stringify({ name: 'normie', visibility: 'PUBLIC', viewerPermission: 'ADMIN', defaultBranchRef: { name: 'main' } })), 'mentor24-maker/normie');
  assert.deepEqual(view.rows.map((r) => r.verdict), [READY, READY]);
  assert.deepEqual(view.info, { branch: 'main', visibility: 'public', permission: 'ADMIN' });
  const read = readRepo(ok(JSON.stringify({ visibility: 'PRIVATE', viewerPermission: 'READ', defaultBranchRef: { name: 'main' } })), 'a/b');
  assert.equal(read.rows[1].verdict, BLOCKED);
  const missing = readRepo(failed(1, "GraphQL: Could not resolve to a Repository with the name 'a/b'. (repository)"), 'a/b');
  assert.deepEqual(missing.rows.map((r) => r.verdict), [BLOCKED, UNKNOWN]);
  const noGh = readRepo({ status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }) }, 'a/b');
  assert.deepEqual(noGh.rows.map((r) => r.verdict), [UNKNOWN, UNKNOWN]);
  assert.equal(readRepo(failed(1, 'HTTP 502'), 'a/b').rows[0].verdict, UNKNOWN);
});

test('protection: protected with verify is ready, not protected is fine, "403 Upgrade" is BLOCKED', () => {
  assert.equal(readProtection(ok(JSON.stringify({ required_status_checks: { contexts: ['verify'] } })), 'main').verdict, READY);
  assert.equal(readProtection(ok(JSON.stringify({ required_status_checks: { checks: [{ context: 'build' }] } })), 'main').verdict, WILL_DO);
  const notProtected = failed(1, 'gh: Branch not protected (HTTP 404)', '{"message":"Branch not protected","status":"404"}');
  assert.deepEqual(ghApiFailure(notProtected), { status: 404, message: 'Branch not protected' });
  assert.equal(readProtection(notProtected, 'main').verdict, WILL_DO);
  const upgrade = failed(1, 'gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)',
    '{"message":"Upgrade to GitHub Pro or make this repository public to enable this feature.","status":"403"}');
  const r = readProtection(upgrade, 'main');
  assert.equal(r.verdict, BLOCKED);
  assert.match(r.why, /billing screen/);
  assert.equal(readProtection(failed(1, 'gh: Branch not found (HTTP 404)'), 'main').verdict, BLOCKED);
  assert.equal(readProtection(failed(1, 'gh: Server Error (HTTP 500)'), 'main').verdict, UNKNOWN);
});

test('the checkout: absent will do; a clean main of the repository is ready; anything else says why', () => {
  const at = { repo: 'mentor24-maker/normie', branch: 'main' };
  const dir = '/x/normie';
  assert.equal(readCheckout({ dir, present: false }, at).verdict, WILL_DO);
  const good = { dir, present: true, head: ok('main\n'), top: ok('/x/normie\n'), origin: ok('https://github.com/mentor24-maker/normie.git\n'), porcelain: ok('') };
  assert.equal(readCheckout(good, at).verdict, READY);
  assert.match(readCheckout({ ...good, head: ok('feature\n') }, at).why, /on branch feature, not main/);
  assert.match(readCheckout({ ...good, porcelain: ok(' M a.js\n?? b.js\n') }, at).why, /2 uncommitted change/);
  assert.match(readCheckout({ ...good, origin: ok('https://github.com/someone/else.git') }, at).why, /checkout of someone\/else, not mentor24-maker\/normie/);
  // An origin can carry a sign-in token: the row names the repository, never the token (rule 4).
  for (const origin of ['https://x-access-token:ghp_FAKE@github.com/other/repo', 'https://user:ghp_FAKE@gitlab.com/other/repo.git']) {
    const tokened = readCheckout({ ...good, origin: ok(`${origin}\n`) }, at);
    assert.equal(tokened.verdict, BLOCKED);
    assert.doesNotMatch(tokened.why, /ghp_FAKE|x-access-token|user:/);
    assert.match(tokened.why, /other\/repo/);
  }
  const notGit = failed(128, 'fatal: not a git repository (or any of the parent directories): .git');
  assert.match(readCheckout({ ...good, head: notGit, top: notGit, origin: notGit, porcelain: notGit }, at).why, /not a git checkout/);
  // An empty clone: the top folder answers, HEAD names no commit yet. It is a checkout, just not a clean main.
  const unborn = readCheckout({ ...good, head: failed(128, "fatal: ambiguous argument 'HEAD': unknown revision") }, at);
  assert.equal(unborn.verdict, BLOCKED);
  assert.match(unborn.why, /no commit on it yet \(an empty clone\)/);
  assert.doesNotMatch(unborn.why, /not a git checkout/);
  // Any other HEAD failure is not an empty clone: could not tell, with git's own last line.
  const broken = readCheckout({ ...good, head: failed(128, 'fatal: unable to read tree 1234abcd') }, at);
  assert.equal(broken.verdict, UNKNOWN);
  assert.match(broken.why, /unable to read tree/);
  assert.doesNotMatch(broken.why, /empty clone/);
  // GitHub could not say which branch is main: the checkout's branch cannot be judged, so it is never "ready".
  for (const head of [ok('feature-x\n'), ok('main\n')]) {
    const unknown = readCheckout({ ...good, head }, { ...at, branch: null });
    assert.equal(unknown.verdict, UNKNOWN);
    assert.match(unknown.why, /which branch is main is not known.*the checkout is on (feature-x|main)/);
  }
  assert.equal(readCheckout({ ...good, porcelain: failed(128, 'fatal: index broken') }, at).verdict, UNKNOWN);
  // A folder inside another checkout answers every git question for that checkout: not a checkout of its own.
  const inside = readCheckout({ ...good, top: ok('/x\n') }, at);
  assert.equal(inside.verdict, BLOCKED);
  assert.match(inside.why, /inside the checkout at \/x,/);
  assert.equal(readCheckout({ ...good, top: failed(128, 'fatal: broken') }, at).verdict, UNKNOWN);
  // The same folder by another spelling (a symlink, /private/tmp) is the same folder.
  assert.equal(readCheckout({ ...good, top: ok('/private/x/normie\n') }, { ...at, samePath: (a, b) => a.replace(/^\/private/, '') === b }).verdict, READY);
});

test("Node: the answers' version first, then .nvmrc, then engines; none written could not tell", () => {
  const files = { '/c/.nvmrc': '22\n', '/c/package.json': '{"engines":{"node":">=22.12"}}', '/d/package.json': '{"engines":{"node":">=24"}}' };
  const readText = (p) => files[p] ?? null;
  assert.equal(nodeNeedOf({ nodeVersion: '20' }, readText, '/c').text, '20');
  assert.deepEqual(nodeNeedOf({ nodeVersion: null }, readText, '/c').source, 'its .nvmrc');
  assert.equal(nodeNeedOf({ nodeVersion: null }, readText, '/d').source, 'its package.json engines.node');
  assert.equal(readNode('v22.23.3', nodeNeedOf({ nodeVersion: null }, readText, '/c'), { looked: true }).verdict, READY);
  assert.equal(readNode('v22.23.3', nodeNeedOf({ nodeVersion: null }, readText, '/d'), { looked: true }).verdict, BLOCKED);
  assert.equal(readNode('v22.23.3', nodeNeedOf({ nodeVersion: null }, readText, '/e'), { looked: true }).verdict, UNKNOWN);
  assert.equal(readNode('v22.23.3', nodeNeedOf({ nodeVersion: null }, readText, null), { looked: false }).verdict, UNKNOWN);
  assert.equal(readNode('v22.23.3', { need: parseNodeNeed('lts/*'), text: 'lts/*', source: 'its .nvmrc' }, { looked: true }).verdict, UNKNOWN);
  // This Mac's own version unreadable (a prerelease): could not tell, not BLOCKED.
  const pre = readNode('v23.0.0-rc.1', { need: parseNodeNeed('>=22'), text: '>=22', source: 'its .nvmrc' }, { looked: true });
  assert.equal(pre.verdict, UNKNOWN);
  assert.match(pre.why, /cannot be read as a version/);
});

test('claude and doppler: signed in is ready, signed out is BLOCKED, never an email printed', () => {
  const inRow = readClaude(ok(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'someone@example.com' })));
  assert.equal(inRow.verdict, READY);
  assert.ok(!formatRow(inRow).includes('@'));
  assert.equal(readClaude(failed(1, '', JSON.stringify({ loggedIn: false }))).verdict, BLOCKED);
  assert.equal(readClaude(ok('not json')).verdict, UNKNOWN);
  assert.equal(readDopplerMe(ok(JSON.stringify({ workplace: { name: 'Alphire' }, token_preview: 'dp.ct.xxx' }))).why, 'signed in to Alphire');
  assert.equal(readDopplerMe(failed(1, 'Doppler Error: you must log in')).verdict, BLOCKED);
  assert.equal(readDopplerMe(failed(1, 'Doppler Error: network down')).verdict, UNKNOWN);
});

test('Doppler: a missing project or config will be made; an unreadable list could not tell', () => {
  const at = { project: 'normie', config: 'dev' };
  const projects = ok(JSON.stringify([{ slug: 'spirality' }, { slug: 'normie' }]));
  assert.deepEqual(readDoppler(projects, ok(JSON.stringify([{ name: 'dev' }])), at).map((r) => r.verdict), [READY, READY]);
  assert.deepEqual(readDoppler(projects, ok(JSON.stringify([{ name: 'prd' }])), at).map((r) => r.verdict), [READY, WILL_DO]);
  assert.deepEqual(readDoppler(ok('[]'), null, at).map((r) => r.verdict), [WILL_DO, WILL_DO]);
  assert.deepEqual(readDoppler(failed(1, 'Doppler Error: down'), null, at).map((r) => r.verdict), [UNKNOWN, UNKNOWN]);
  assert.deepEqual(readDoppler(projects, failed(1, 'boom'), at).map((r) => r.verdict), [READY, UNKNOWN]);
});

/** A fake tracker answering the four GETs the look makes. */
function fakeTracker({ projects = [], actors = [], people = [{ id: 1, name: 'Dane' }], down = false } = {}) {
  return async (path) => {
    if (down) throw new Error('connect ECONNREFUSED');
    if (path === '/me') return { status: 200, json: { id: 9, name: 'hand-run', kind: 'machine' } };
    if (path === '/projects') return { status: 200, json: { projects } };
    if (path === '/search') return { status: 200, json: { filters: [{ key: 'createdBy', options: actors.map((name, i) => ({ value: String(i + 1), label: name })) }] } };
    if (path === '/people') return { status: 200, json: { people } };
    return { status: 404, json: null };
  };
}
const trackerArgs = { apiUrl: 'http://127.0.0.1:4180', pageUrl: 'http://mini.local:4180', answers, operatorName: 'Dane', seatNames, hasToken: true };

test('the tracker for a project already set up: every row ready', async () => {
  const rows = await trackerRows({
    ...trackerArgs,
    get: fakeTracker({ projects: [{ slug: 'spirality', name: 'Spirality', prefix: 'SP' }, { slug: 'normie', name: 'Normie', prefix: 'NO', repo: 'mentor24-maker/normie' }], actors: ['Dane', 'loop-build', ...seatNames] }),
  });
  assert.deepEqual(rows.map((r) => r.verdict), [READY, READY, READY, READY, READY]);
});

test('the tracker for a new project: project and sign-ins will do; a taken prefix is BLOCKED', async () => {
  const fresh = await trackerRows({ ...trackerArgs, get: fakeTracker({ projects: [{ slug: 'spirality', name: 'Spirality', prefix: 'SP' }], actors: ['Dane', 'normie loop-build'] }) });
  assert.deepEqual(fresh.map((r) => r.verdict), [READY, WILL_DO, READY, WILL_DO, READY]);
  assert.match(fresh[3].why, /1 of 5 exist/);
  const taken = await trackerRows({ ...trackerArgs, get: fakeTracker({ projects: [{ slug: 'nobody', name: 'Nobody', prefix: 'NO' }] }) });
  assert.equal(taken[2].verdict, BLOCKED);
  assert.match(taken[2].why, /NO is Nobody's \(nobody\)/);
});

test('the tracker: a project with another prefix or repository is BLOCKED; no operator is BLOCKED', async () => {
  const otherPrefix = await trackerRows({ ...trackerArgs, get: fakeTracker({ projects: [{ slug: 'normie', name: 'Normie', prefix: 'NM' }] }) });
  assert.equal(otherPrefix[1].verdict, BLOCKED);
  const otherRepo = await trackerRows({ ...trackerArgs, get: fakeTracker({ projects: [{ slug: 'normie', name: 'Normie', prefix: 'NO', repo: 'x/y' }] }) });
  assert.equal(otherRepo[1].verdict, BLOCKED);
  const noDane = await trackerRows({ ...trackerArgs, get: fakeTracker({ people: [{ id: 3, name: 'Someone' }] }) });
  assert.equal(noDane[4].verdict, BLOCKED);
});

test('the tracker down is BLOCKED and every row after it could not tell, never ready', async () => {
  const rows = await trackerRows({ ...trackerArgs, get: fakeTracker({ down: true }) });
  assert.equal(rows[0].verdict, BLOCKED);
  assert.ok(rows.slice(1).every((r) => r.verdict === UNKNOWN));
  const noToken = await trackerRows({ ...trackerArgs, hasToken: false, get: fakeTracker() });
  assert.ok(noToken.every((r) => r.verdict === UNKNOWN));
});

test("the project's check: passes ready; fails BLOCKED with its last lines; a timeout could not tell", () => {
  const base = { command: 'npm run verify', branch: 'main', clone: ok() };
  assert.equal(readCheck({ ...base, install: null, check: ok('all good\n') }).verdict, READY);
  const fail = readCheck({ ...base, install: null, check: failed(1, 'error: 2 tests failed\n', 'running\n') });
  assert.equal(fail.verdict, BLOCKED);
  assert.deepEqual(fail.detail, ['running', 'error: 2 tests failed']);
  assert.equal(readCheck({ ...base, install: { ...failed(1, 'ERESOLVE'), label: 'npm ci' }, check: null }).verdict, BLOCKED);
  assert.equal(readCheck({ ...base, install: null, check: { ...failed(null), signal: 'SIGTERM' } }).verdict, UNKNOWN);
  assert.equal(readCheck({ ...base, clone: failed(128, 'fatal: could not read') }).verdict, UNKNOWN);
});

test("the project's check never sees this process's keys", () => {
  const env = checkEnv({ PATH: '/bin', HOME: '/h', TRACKER_TOKEN_HAND_RUN: 'secret', DOPPLER_PROJECT: 'spirality', GITHUB_TOKEN: 'x' });
  assert.deepEqual(env, { CI: 'true', PATH: '/bin', HOME: '/h' });
});

// --- The whole look, against fakes that record every call -----------------

/**
 * Every call a read-only look may make. A command not matched here is a
 * write until shown otherwise. The clone, the install and the check may
 * only run inside the scratch folder.
 */
function readOnlyCall({ cmd, args, cwd }, scratch) {
  const inScratch = (p) => typeof p === 'string' && scratch && p.startsWith(`${scratch}/`);
  const a = args.join(' ');
  if (cmd === 'gh' && args[0] === 'repo' && args[1] === 'view') return true;
  if (cmd === 'gh' && args[0] === 'api') {
    return args.length === 2 && !/^-/.test(args[1]); // no --method, -X, -f, -F or --input: a GET
  }
  if (cmd === 'gh' && args[0] === 'repo' && args[1] === 'clone') return inScratch(args[3]);
  if (cmd === 'git' && args[0] === '--no-optional-locks' && args[1] === '-C') {
    return ['rev-parse --abbrev-ref HEAD', 'rev-parse --show-toplevel', 'remote get-url origin', 'status --porcelain'].includes(args.slice(3).join(' '));
  }
  if (cmd === 'claude') return a === 'auth status --json';
  if (cmd === 'doppler') return ['me --json --no-check-version', 'projects --json --no-check-version'].includes(a) || /^configs --project \S+ --json --no-check-version$/.test(a);
  if (cmd === 'npm' || cmd === 'sh') return inScratch(`${cwd}/`) || cwd === `${scratch}/normie`;
  return false;
}

function fakeWorld({ checkoutPresent = true, project = true, empty = false, noLock = false } = {}) {
  const calls = [];
  const requests = [];
  const removed = [];
  const scratch = '/tmp/onboard-normie-abc';
  const answer = (cmd, args) => {
    const a = args.join(' ');
    if (cmd === 'gh' && a.startsWith('repo view')) return ok(JSON.stringify({ name: 'normie', visibility: 'PUBLIC', viewerPermission: empty === 'write' ? 'WRITE' : 'ADMIN', defaultBranchRef: empty ? null : { name: 'main' } }));
    if (cmd === 'gh' && args[0] === 'api') return ok(JSON.stringify({ required_status_checks: { contexts: ['verify'] } }));
    if (cmd === 'gh' && a.startsWith('repo clone')) return ok();
    if (cmd === 'git' && a.endsWith('rev-parse --abbrev-ref HEAD')) return ok('main\n');
    if (cmd === 'git' && a.endsWith('rev-parse --show-toplevel')) return ok('/Users/dane/WebApps/normie\n');
    if (cmd === 'git' && a.endsWith('remote get-url origin')) return ok('https://github.com/mentor24-maker/normie.git\n');
    if (cmd === 'git' && a.endsWith('status --porcelain')) return ok('');
    if (cmd === 'claude') return ok(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }));
    if (cmd === 'doppler' && args[0] === 'me') return ok(JSON.stringify({ workplace: { name: 'Alphire' } }));
    if (cmd === 'doppler' && args[0] === 'projects') return ok(JSON.stringify(project ? [{ slug: 'normie' }] : [{ slug: 'spirality' }]));
    if (cmd === 'doppler' && args[0] === 'configs') return ok(JSON.stringify([{ name: 'dev' }]));
    if (cmd === 'npm' || cmd === 'sh') return ok('done\n');
    return failed(1, `unexpected ${cmd} ${a}`);
  };
  const projects = [{ slug: 'spirality', name: 'Spirality', prefix: 'SP' }, ...(project ? [{ slug: 'normie', name: 'Normie', prefix: 'NO', repo: 'mentor24-maker/normie' }] : [])];
  const tracker = fakeTracker({ projects, actors: project ? ['Dane', ...seatNames] : ['Dane'] });
  const deps = {
    run: (cmd, args, opts = {}) => { calls.push({ cmd, args, cwd: opts.cwd, env: opts.env }); return answer(cmd, args); },
    fetch: async (url, init) => {
      requests.push({ url, method: init?.method ?? 'GET', body: init?.body });
      const r = await tracker(new URL(url).pathname);
      return { status: r.status, text: async () => JSON.stringify(r.json) };
    },
    token: 'tok',
    exists: (p) => (p === '/Users/dane/WebApps/normie' ? checkoutPresent : p.startsWith(scratch) && (noLock ? /package\.json$/ : /package(-lock)?\.json$/).test(p)),
    readText: (p) => (p === `${scratch}/normie/.nvmrc` ? '22\n' : null),
    makeScratch: () => scratch,
    removeScratch: (dir) => removed.push(dir),
    nodeVersion: 'v22.23.3',
    env: { PATH: '/bin', HOME: '/Users/dane', TRACKER_TOKEN_HAND_RUN: 'secret' },
  };
  return { deps, calls, requests, removed, scratch };
}

test('a project already set up: every row ready, exit 0', async () => {
  const w = fakeWorld();
  const rows = await look({ answers, homeConfig, deps: w.deps });
  assert.deepEqual(rows.filter((r) => r.verdict !== READY).map(formatRow), []);
  assert.equal(exitCodeFor(rows), 0);
  assert.equal(rows.length, 15);
});

test('a new project: the tracker, Doppler and checkout rows say will do, exit 0', async () => {
  const w = fakeWorld({ checkoutPresent: false, project: false });
  const rows = await look({ answers, homeConfig, deps: w.deps });
  const willDo = rows.filter((r) => r.verdict === WILL_DO).map((r) => r.item);
  assert.deepEqual(willDo, [
    'Mini: checkout /Users/dane/WebApps/normie',
    'Tracker: project normie',
    `Tracker: loop sign-ins (${seatNames.join(', ')})`,
    'Doppler: project normie',
    'Doppler: config normie/dev',
  ]);
  assert.equal(exitCodeFor(rows), 0);
});

test('the look makes no write call: tracker, Doppler, gh, git or claude', async () => {
  for (const world of [fakeWorld(), fakeWorld({ checkoutPresent: false, project: false })]) {
    await look({ answers, homeConfig, deps: world.deps });
    assert.ok(world.calls.length >= 8, `only ${world.calls.length} calls seen`);
    for (const call of world.calls) {
      assert.ok(readOnlyCall(call, world.scratch), `not a read-only call: ${call.cmd} ${call.args.join(' ')} (in ${call.cwd ?? 'here'})`);
    }
    assert.ok(world.requests.length >= 4);
    for (const req of world.requests) {
      assert.equal(req.method, 'GET', req.url);
      assert.equal(req.body, undefined, req.url);
    }
    assert.deepEqual(world.removed, [world.scratch], 'the scratch clone is removed');
    for (const call of world.calls.filter((c) => c.cmd === 'npm' || c.cmd === 'sh')) {
      assert.equal(call.env.TRACKER_TOKEN_HAND_RUN, undefined, 'the check never gets a key');
    }
  }
});

test('--no-check makes no clone, and says so as could not tell', async () => {
  const w = fakeWorld();
  const rows = await look({ answers, homeConfig, runCheck: false, deps: w.deps });
  assert.ok(!w.calls.some((c) => c.args.includes('clone')));
  assert.deepEqual(w.removed, []);
  const check = rows.at(-1);
  assert.equal(check.verdict, UNKNOWN);
  assert.match(check.why, /skipped/);
  assert.equal(exitCodeFor(rows), 1);
});

test('the scratch clone is removed even when a later check throws', async () => {
  const w = fakeWorld();
  w.deps.fetch = async () => { throw new Error('boom'); };
  w.deps.run = ((run) => (cmd, args, opts) => { if (cmd === 'doppler' && args[0] === 'projects') throw new Error('crash'); return run(cmd, args, opts); })(w.deps.run);
  await assert.rejects(look({ answers, homeConfig, deps: w.deps }), /crash/);
  assert.deepEqual(w.removed, [w.scratch]);
});

test("the default checkout sits beside the tracker home's main checkout, even run from a worktree", async () => {
  const { mainCheckoutOf } = await import('./look.mjs');
  const run = (cmd, args) => (args[1] === '/W/spirality/.claude/worktrees/x' ? ok('/W/spirality/.git\n') : failed(128, 'fatal: not a git repository'));
  assert.equal(mainCheckoutOf('/W/spirality/.claude/worktrees/x', run), '/W/spirality');
  assert.equal(mainCheckoutOf('/elsewhere', run), '/elsewhere');
});

test('a main with a package.json but no package-lock.json is BLOCKED, with the fix named (SP-154)', async () => {
  const w = fakeWorld({ noLock: true });
  const rows = await look({ answers, homeConfig, deps: w.deps });
  const lock = rows.find((r) => r.item === 'GitHub: package-lock.json on main');
  assert.ok(lock, 'a lock row is there');
  assert.equal(lock.verdict, BLOCKED);
  assert.match(lock.why, /no package-lock\.json/);
  assert.match(lock.why, /npm install --package-lock-only/);
  assert.match(lock.why, /push it to main/);
  assert.equal(exitCodeFor(rows), 3);
  assert.deepEqual(rows.filter((r) => r.verdict === BLOCKED).map((r) => r.item), ['GitHub: package-lock.json on main']);
  // The check still runs (with npm install), so its own row still says whether verify passes.
  assert.ok(w.calls.some((c) => c.cmd === 'npm' && c.args[0] === 'install'));
  assert.equal(rows.at(-1).item.startsWith('Check:'), true);
  assert.equal(rows.at(-1).verdict, READY);
});

test('a main with a package-lock.json has no lock row', async () => {
  const rows = await look({ answers, homeConfig, deps: fakeWorld().deps });
  assert.equal(rows.some((r) => /package-lock/.test(r.item)), false);
});

// --- An empty repository (SP-154) ------------------------------------------

const freshAnswers = (more = {}) => resolveAnswers({
  projectName: 'Upwork Blaster', githubRepo: 'mentor24-maker/upwork-blaster', trackerPrefix: 'UB',
  checkoutDir: '/Users/dane/WebApps/normie', description: 'Blasts.', ...more,
}, { homeConfig, homeRoot: '/Users/dane/WebApps/home' });

test('an empty repository: nothing BLOCKED, exit 0; the protect, Node and check rows say they wait for the start step', async () => {
  const w = fakeWorld({ checkoutPresent: false, project: false, empty: true });
  const rows = await look({ answers: freshAnswers(), homeConfig, deps: w.deps });
  assert.deepEqual(rows.filter((r) => r.verdict === BLOCKED || r.verdict === UNKNOWN).map(formatRow), []);
  assert.equal(exitCodeFor(rows), 0);
  const by = (start) => rows.find((r) => r.item.startsWith(start));
  assert.match(formatRow(by('GitHub: repository')), /ready \(exists, public, main branch \(none: the repository is empty\)\)/);
  assert.equal(by('GitHub: protecting').verdict, WILL_DO);
  assert.match(by('GitHub: protecting').why, /waits for the first commit the setup's start step makes/);
  assert.equal(by('Mini: Node').verdict, WILL_DO);
  assert.match(by('Mini: Node').why, /names Node >=22 \(\.nvmrc 22\), from this Mac's v22\.23\.3/);
  assert.equal(by('Check:').verdict, WILL_DO);
  assert.match(by('Check:').why, /waits for the first commit the start step makes/);
  // Nothing to copy, so nothing is cloned and nothing installed or run.
  assert.ok(!w.calls.some((c) => c.cmd === 'npm' || c.cmd === 'sh' || (c.cmd === 'gh' && c.args[1] === 'clone')));
});

test('an empty repository whose answers name a Node version: that version is checked against this Mac, as for any project', async () => {
  const w = fakeWorld({ checkoutPresent: false, project: false, empty: true });
  const meets = await look({ answers: freshAnswers({ nodeVersion: '>=22' }), homeConfig, deps: w.deps });
  assert.equal(meets.find((r) => r.item === 'Mini: Node').verdict, READY);
  const fails = await look({ answers: freshAnswers({ nodeVersion: '>=24' }), homeConfig, deps: w.deps });
  assert.equal(fails.find((r) => r.item === 'Mini: Node').verdict, BLOCKED);
});

test('an empty repository with a checkCommand the starter does not answer to: BLOCKED, saying to take it out', async () => {
  const w = fakeWorld({ checkoutPresent: false, project: false, empty: true });
  const rows = await look({ answers: freshAnswers({ checkCommand: 'npm run verify:full' }), homeConfig, deps: w.deps });
  const check = rows.find((r) => r.item.startsWith('Check:'));
  assert.equal(check.verdict, BLOCKED);
  assert.match(check.why, /answers to `npm run verify` only, not `npm run verify:full`; take "checkCommand" out of the answers/);
});

test('an empty repository this Mac\'s gh may push to but not administer: protecting main is still BLOCKED', async () => {
  const w = fakeWorld({ checkoutPresent: false, project: false, empty: 'write' });
  const rows = await look({ answers: freshAnswers(), homeConfig, deps: w.deps });
  const protect = rows.find((r) => r.item.startsWith('GitHub: protecting'));
  assert.equal(protect.verdict, BLOCKED);
  assert.match(protect.why, /needs an admin/);
});

// SP-25's hand-run session (SP-229): StarCaster's taskRepo test checks its
// checkout's folder name, so the clean copy must not land in a folder named "repo".
test('the clean copy is cloned into a folder named for the repository, and the check runs there', async () => {
  assert.equal(cloneFolder('mentor24-maker/starcaster'), 'starcaster');
  assert.equal(cloneFolder('mentor24-maker/upwork-blaster.git'), 'upwork-blaster');
  assert.equal(cloneFolder(''), 'repo');
  const w = fakeWorld();
  await look({ answers, homeConfig, deps: w.deps });
  const clone = w.calls.find((c) => c.cmd === 'gh' && c.args[1] === 'clone');
  assert.equal(clone.args[3], `${w.scratch}/normie`);
  const check = w.calls.find((c) => c.cmd === 'sh');
  assert.equal(check.cwd, `${w.scratch}/normie`);
});
