import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { validateProjectConfig } from '../../lib/projectConfig.mjs';
import { settingsDraft, resolveAnswers } from '../../lib/onboardAnswers.mjs';
import {
  DANE_FIELDS, STEPS, answerValue, fieldNamed, loggedDone, mainVerifyVerdict, mountainStamp, onboard,
  cloneAddress, parseOnboardArgs, pasteBlock, protectionDropped, protectionGaps, protectionRequest, rerunCommand, shellQuote,
  unanswered, worktreesOnBranch,
} from './onboard.mjs';

const GOOD_PROTECTION = {
  required_status_checks: { strict: true, contexts: ['verify'], checks: [{ context: 'verify' }] },
  enforce_admins: { enabled: true },
  allow_force_pushes: { enabled: false },
  allow_deletions: { enabled: false },
};

// --- The pure parts ------------------------------------------------------

test('protectionGaps names each rule that is off, and nothing for a main protected as the setup protects it', () => {
  assert.deepEqual(protectionGaps(GOOD_PROTECTION), []);
  assert.deepEqual(protectionGaps(null), ['no protection']);
  const loose = {
    required_status_checks: { strict: false, contexts: ['vercel'] },
    enforce_admins: { enabled: false },
    allow_force_pushes: { enabled: true },
    allow_deletions: { enabled: true },
    required_pull_request_reviews: { required_approving_review_count: 1 },
  };
  assert.equal(protectionGaps(loose).length, 6);
});

test('protectionRequest keeps the required checks already there, and adds verify', () => {
  const body = protectionRequest({ required_status_checks: { contexts: ['vercel'], checks: [{ context: 'vercel' }] } });
  assert.deepEqual(body.required_status_checks, { strict: true, contexts: ['verify', 'vercel'] });
  assert.equal(body.enforce_admins, true);
  assert.equal(body.required_pull_request_reviews, null);
  assert.equal(body.allow_force_pushes, false);
  assert.equal(body.allow_deletions, false);
  assert.deepEqual(protectionRequest(null).required_status_checks.contexts, ['verify']);
});

test('mainVerifyVerdict reads verify on a commit: pass, pending, fail, or none at all', () => {
  const r = (status, conclusion, name = 'verify') => ({ check_runs: [{ name, status, conclusion }] });
  assert.equal(mainVerifyVerdict(r('completed', 'success')).verdict, 'pass');
  assert.equal(mainVerifyVerdict(r('in_progress', null)).verdict, 'pending');
  assert.equal(mainVerifyVerdict(r('completed', 'failure')).verdict, 'fail');
  assert.equal(mainVerifyVerdict(r('completed', 'success', 'vercel')).verdict, 'none');
  assert.equal(mainVerifyVerdict(null).verdict, 'none');
});

test('a typed answer: blank takes the default, lists split on commas, "none" is an empty list', () => {
  const list = DANE_FIELDS.find((f) => f.key === 'mergePhrases');
  const name = DANE_FIELDS.find((f) => f.key === 'productName');
  assert.equal(answerValue(name, '  PressPlay '), 'PressPlay');
  assert.equal(answerValue(name, ''), null);
  assert.deepEqual(answerValue(list, 'merge, ship it ,'), ['merge', 'ship it']);
  assert.deepEqual(answerValue(list, 'None'), []);
  assert.equal(answerValue(list, ' '), null);
});

test('only the fields that are Dane\'s decisions are asked, and one set to null counts as answered', () => {
  assert.deepEqual(DANE_FIELDS.map((f) => f.key), ['productName', 'githubRepo', 'trackerPrefix', 'mergePhrases', 'autoMergeLanes', 'extraGovernancePaths', 'description']);
  assert.deepEqual(unanswered({ productName: 'X', trackerPrefix: null }).map((f) => f.key), ['githubRepo', 'mergePhrases', 'autoMergeLanes', 'extraGovernancePaths', 'description']);
  assert.equal(fieldNamed('/x.json: "githubRepo" must be owner/name'), 'githubRepo');
});

test('the paste block makes the Doppler project only when it is missing, and quotes what it must', () => {
  const answers = { dopplerProject: 'pressplay', dopplerConfig: 'dev', productName: "Press Play's", trackerPrefix: 'PP' };
  const base = { spiralityDir: '/Users/d/WebApps/spirality', answers, settingsFile: '/Users/d/loop-logs/onboard/pressplay-settings/spirality.project.json', trackerDb: '/Users/d/spirality-tracker/tracker.db' };
  const fresh = pasteBlock({ ...base, projectExists: false, configExists: false });
  assert.deepEqual(fresh, [
    'cd /Users/d/WebApps/spirality',
    'doppler projects create pressplay',
    "TRACKER_DB=/Users/d/spirality-tracker/tracker.db npm run tracker:signins -- create --name 'Press Play'\\''s' --prefix PP --config /Users/d/loop-logs/onboard/pressplay-settings/spirality.project.json",
  ]);
  const there = pasteBlock({ ...base, projectExists: true, configExists: true });
  assert.equal(there.length, 2);
  assert.ok(!there.some((l) => l.startsWith('doppler')));
  const branchConfig = pasteBlock({ ...base, answers: { ...answers, dopplerConfig: 'dev_loop' }, projectExists: true, configExists: false });
  assert.ok(branchConfig.includes('doppler configs create dev_loop --project pressplay --environment dev'));
  assert.equal(shellQuote('a b'), "'a b'");
});

test('the step log: Mountain time, and a done step is found by name', () => {
  assert.match(mountainStamp(new Date('2026-11-05T05:00:00Z')), /^2026-11-04 22:00:00 MT$/);
  const log = '2026-11-04 22:00:00 MT | look | done | nothing is BLOCKED\n2026-11-04 22:01:00 MT | settings | FAILED | x\n';
  assert.equal(loggedDone(log, 'look'), true);
  assert.equal(loggedDone(log, 'settings'), false);
  assert.equal(loggedDone(null, 'look'), false);
});

test('the arguments: --product is a slug, the merge wait a positive number', () => {
  assert.deepEqual(parseOnboardArgs(['--product', 'pressplay']).opts, { product: 'pressplay', allowReplace: false, mergeWaitMinutes: 60, noPrompt: false });
  assert.equal(parseOnboardArgs(['--product', 'pressplay', '--no-prompt']).opts.noPrompt, true);
  assert.equal(parseOnboardArgs(['--product', 'pressplay', '--allow-replace', '--merge-wait-minutes', '5']).opts.mergeWaitMinutes, 5);
  assert.match(parseOnboardArgs([]).error, /--product/);
  assert.match(parseOnboardArgs(['--product', 'Press Play']).error, /not a slug/);
  assert.match(parseOnboardArgs(['--product', 'x', '--merge-wait-minutes', '0']).error, /greater than 0/);
  assert.match(parseOnboardArgs(['--product', 'x', '--nope']).error, /unknown/);
});

test('worktreesOnBranch finds the worktrees holding a branch, never the checkout itself', () => {
  const porcelain = [
    'worktree /p/pressplay\nHEAD aaa\nbranch refs/heads/main',
    'worktree /logs/onboard/pressplay-setup\nHEAD bbb\nbranch refs/heads/spirality-setup',
    'worktree /tmp/other\nHEAD ccc\ndetached',
  ].join('\n\n') + '\n';
  assert.deepEqual(worktreesOnBranch(porcelain, 'spirality-setup'), ['/logs/onboard/pressplay-setup']);
  assert.deepEqual(worktreesOnBranch(porcelain, 'spirality-setup-2'), []);
  assert.deepEqual(worktreesOnBranch('worktree /p/pressplay\nHEAD a\nbranch refs/heads/spirality-setup\n', 'spirality-setup'), [], 'the checkout already on it is not in the way');
  assert.deepEqual(worktreesOnBranch('', 'x'), []);
});

test('cloneAddress takes only the kind of address from the home\'s origin, never its sign-in', () => {
  assert.equal(cloneAddress('https://x-access-token:SECRET@github.com/mentor24-maker/spirality.git', 'mentor24-maker/PressPlay'), 'https://github.com/mentor24-maker/pressplay.git');
  assert.equal(cloneAddress('git@github.com:mentor24-maker/spirality.git', 'mentor24-maker/pressplay'), 'git@github.com:mentor24-maker/pressplay.git');
  assert.equal(cloneAddress('ssh://git@github.com/mentor24-maker/spirality', 'mentor24-maker/pressplay'), 'git@github.com:mentor24-maker/pressplay.git');
  assert.equal(cloneAddress(null, 'mentor24-maker/pressplay'), 'https://github.com/mentor24-maker/pressplay.git');
});

test('rerunCommand keeps every flag the run was started with', () => {
  assert.equal(rerunCommand({ product: 'pressplay', allowReplace: false, mergeWaitMinutes: 60 }), 'npm run onboard -- --product pressplay');
  assert.equal(rerunCommand({ product: 'pressplay', allowReplace: true, mergeWaitMinutes: 240 }), 'npm run onboard -- --product pressplay --allow-replace --merge-wait-minutes 240');
  assert.equal(rerunCommand({ product: 'pressplay', allowReplace: false, mergeWaitMinutes: 60, noPrompt: true }), 'npm run onboard -- --product pressplay --no-prompt');
});

test('protectionDropped names the stricter settings the PUT switches off', () => {
  assert.deepEqual(protectionDropped(GOOD_PROTECTION), []);
  assert.deepEqual(protectionDropped(null), []);
  assert.deepEqual(protectionDropped({ ...GOOD_PROTECTION, required_linear_history: { enabled: true }, restrictions: { users: [] } }), ['linear history required', 'only some people may push']);
});

// --- The wizard, against a fake world ------------------------------------

const PR = 'https://github.com/mentor24-maker/pressplay/pull/1';
const DANE_ANSWERS = {
  'Project name': 'PressPlay',
  'GitHub repository': 'mentor24-maker/pressplay',
  'Ticket prefix': 'PP',
  'Merge phrases': '',
  'Lanes that may merge': 'none',
  'Extra protected files': '',
  'What the project is': 'PressPlay plays things.',
};

function makeWorld(t) {
  const dir = mkdtempSync(join(tmpdir(), 'onboard-wizard-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const homeConfig = validateProjectConfig({
    workspaceId: '0', spaceId: '0', loopQueueListId: '0', operatorUserId: '1', machineUserId: '2',
    githubRepo: 'mentor24-maker/spirality', dopplerProject: 'spirality', dopplerConfig: 'dev', launchdPrefix: 'com.spirality',
    logDir: join(dir, 'logs'), mergePhrases: ['merge', 'ship it'], governancePaths: ['CLAUDE.md'], autoMergeLanes: [],
    operatorName: 'Dane', productSlug: 'spirality', legacyMachinePrefixes: [], productScripts: {}, trackerPrefix: 'SP',
    trackerPort: 4180, trackerHost: '0.0.0.0', trackerDataDir: join(dir, 'tracker'), tracker: 'api',
    trackerUrl: 'http://mac-mini.local:4180', trackerApiUrl: 'http://127.0.0.1:4180',
  });
  const homeRoot = join(dir, 'WebApps', 'spirality');
  // The project is not on this Mac yet: the clone step makes its checkout.
  const checkout = join(dir, 'WebApps', 'pressplay');
  const makeCheckout = () => {
    mkdirSync(join(checkout, '.git'), { recursive: true });
    writeFileSync(join(checkout, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  };

  // What the world is like; a test sets `fail` to the step that breaks.
  const w = {
    dir, homeConfig, homeRoot, checkout, fail: null,
    signinsMade: false, prOpen: false, ticket: null, lanesLoaded: false, merged: false,
    protection: null, mergeAfterPolls: 1, polls: 0, dopplerProject: false,
    calls: [], asked: [], paused: 0, printed: [],
    // onboard:copy's worktree, on the setup branch; true once copy has run (as the real one keeps it).
    setupWorktree: false, worktreeRemoveRefused: false,
    // The tracker home's origin, with a sign-in token in it as a real one can carry.
    homeOrigin: 'https://x-access-token:SECRET-TOKEN@github.com/mentor24-maker/spirality.git',
    clonedFrom: null, cloneOrigin: 'https://github.com/mentor24-maker/pressplay.git', cloneBranch: 'main', cloneDirty: '',
  };
  const setupWorktreePath = join(homeConfig.logDir, 'onboard', 'pressplay-setup');
  const settingsFile = join(homeConfig.logDir, 'onboard', 'pressplay-settings', 'spirality.project.json');
  const answersPath = join(homeConfig.logDir, 'onboard', 'pressplay.answers.json');
  const settings = (machineUserId) => {
    const answers = resolveAnswers(JSON.parse(readFileSync(answersPath, 'utf8')), { homeConfig, homeRoot });
    return { ...settingsDraft(answers, homeConfig), operatorUserId: '1', machineUserId };
  };
  const ok = (out = '') => ({ code: 0, out, err: '' });
  const no = (err = 'no', code = 1) => ({ code, out: '', err });
  const breaks = (step) => w.fail === step;

  const run = (cmd, args, o = {}) => {
    const line = [cmd, ...args].join(' ');
    w.calls.push(line);
    if (cmd === 'git') {
      if (args[0] === 'remote' && o.cwd === homeRoot) return w.homeOrigin == null ? no('error: No such remote', 2) : ok(w.homeOrigin);
      if (args[0] === 'remote' && o.cwd === checkout) return ok(w.cloneOrigin);
      if (args[0] === 'clone') {
        if (breaks('clone')) return no('remote: Repository not found.\nfatal: repository not found', 128);
        w.clonedFrom = args.at(-2);
        makeCheckout();
        return ok();
      }
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return ok(w.cloneBranch);
      if (args[0] === 'status') return ok(w.cloneDirty);
      if (args[0] === 'fetch') return ok();
      if (args[0] === 'show') return w.merged ? ok(JSON.stringify(settings('9'))) : no('fatal: path does not exist', 128);
      if (args[0] === 'merge-base') return w.merged ? ok() : no();
      if (args[0] === 'rev-parse') return ok('abc1234def');
      if (args[0] === 'worktree' && args[1] === 'list') {
        const blocks = [`worktree ${checkout}\nHEAD abc\nbranch refs/heads/main`];
        if (w.setupWorktree) blocks.push(`worktree ${setupWorktreePath}\nHEAD def\nbranch refs/heads/spirality-setup`);
        return ok(blocks.join('\n\n'));
      }
      if (args[0] === 'worktree' && args[1] === 'remove' && args[2] === setupWorktreePath) {
        if (w.worktreeRemoveRefused) return no(`fatal: '${setupWorktreePath}' contains modified or untracked files, use --force to delete it`, 128);
        w.setupWorktree = false;
        return ok();
      }
    }
    if (cmd === 'npm') {
      const [, , script, , ...rest] = args;
      if (script === 'onboard:look') return breaks('look') ? no('BLOCKED', 3) : ok();
      if (script === 'onboard:settings' && rest[0] === 'write') {
        if (breaks('settings')) return no();
        mkdirSync(dirname(settingsFile), { recursive: true });
        writeFileSync(settingsFile, JSON.stringify(settings('0')));
        return ok();
      }
      if (script === 'onboard:settings' && rest[0] === 'fill-machine-user') {
        writeFileSync(settingsFile, JSON.stringify(settings('9')));
        return ok();
      }
      if (script === 'tracker:signins') return w.signinsMade ? ok('all answer as themselves') : no('Could not find requested project');
      if (script === 'onboard:copy') {
        if (breaks('copy')) return no();
        w.prOpen = true;
        w.setupWorktree = true;
        return ok();
      }
      if (script === 'onboard:lanes') {
        if (breaks('lanes')) return no();
        // As git does: the branch cannot be checked out here while a worktree holds it.
        if (w.setupWorktree) return no(`fatal: 'spirality-setup' is already used by worktree at '${setupWorktreePath}'`, 128);
        w.ticket = 'PP-1';
        w.lanesLoaded = true;
        return ok();
      }
    }
    if (cmd === 'doppler') return w.dopplerProject ? ok('{}') : no();
    if (cmd === 'bash') {
      return ok(w.lanesLoaded ? ['relay', 'loop-build', 'loop-review', 'loop-intake'].map((l) => `── ${l}\nschedule: INSTALLED\nloaded:   yes`).join('\n') : '');
    }
    if (cmd === 'gh') {
      if (args[0] === 'pr' && args[1] === 'list') return ok(JSON.stringify(w.prOpen && !w.merged ? [{ url: PR }] : []));
      if (args[0] === 'pr' && args[1] === 'checks') return ok(JSON.stringify([{ name: 'verify', bucket: 'pass', state: 'SUCCESS' }]));
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('body')) {
        return ok(JSON.stringify({ body: w.ticket ? `Setup.\n\nTicket: http://mac-mini.local:4180/t/${w.ticket}\n` : 'Setup.' }));
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        w.polls += 1;
        if (!breaks('merge') && w.polls >= w.mergeAfterPolls) w.merged = true;
        return ok(JSON.stringify({ state: w.merged ? 'MERGED' : 'OPEN', mergeCommit: w.merged ? { oid: 'abc1234def' } : null }));
      }
      if (args[0] === 'api' && args[1] === '-X') {
        if (breaks('protect')) return no('HTTP 403');
        w.protection = GOOD_PROTECTION;
        return ok('{}');
      }
      if (args[0] === 'api' && args[1].endsWith('/protection')) return w.protection ? ok(JSON.stringify(w.protection)) : no('gh: Branch not protected (HTTP 404)');
      if (args[0] === 'api' && args[1].endsWith('/check-runs')) return ok(JSON.stringify({ check_runs: [{ name: 'verify', status: 'completed', conclusion: 'success' }] }));
    }
    throw new Error(`the fake world does not know: ${line}`);
  };

  let clock = Date.parse('2026-11-04T12:00:00Z');
  const deps = (over = {}) => ({
    homeConfig, homeRoot, spiralityDir: homeRoot, run,
    ask: async (q) => {
      w.asked.push(q);
      const key = Object.keys(DANE_ANSWERS).find((k) => q.startsWith(k));
      return key ? DANE_ANSWERS[key] : '';
    },
    pause: async () => { w.paused += 1; w.signinsMade = true; w.dopplerProject = true; return true; },
    print: (line) => w.printed.push(line),
    exists: (p) => existsSync(p),
    readText: (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } },
    writeText: (p, text) => writeFileSync(p, text),
    appendText: (p, text) => { mkdirSync(dirname(p), { recursive: true }); appendFileSync(p, text); },
    mkdir: (d) => mkdirSync(d, { recursive: true }),
    rename: (from, to) => renameSync(from, to),
    remove: (p) => rmSync(p, { force: true }),
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    ...over,
  });
  const opts = { product: 'pressplay', allowReplace: false, mergeWaitMinutes: 60 };
  const go = (over) => onboard(opts, deps(over));
  const homeOpts = (more, over) => onboard({ ...opts, ...more }, deps(over));
  const reset = () => { w.calls = []; w.asked = []; w.paused = 0; w.printed = []; w.polls = 0; };
  const answersFile = answersPath;
  // The answers in place, written as the wizard would, with a checkout path in this scratch folder.
  const seedAnswers = () => {
    mkdirSync(dirname(answersPath), { recursive: true });
    writeFileSync(answersPath, JSON.stringify({ productSlug: 'pressplay', productName: 'PressPlay', githubRepo: 'mentor24-maker/pressplay', trackerPrefix: 'PP', mergePhrases: null, autoMergeLanes: [], extraGovernancePaths: null, description: 'PressPlay plays things.', checkoutDir: checkout }));
  };
  const statePath = join(homeConfig.logDir, 'onboard', 'pressplay.state.json');
  return { w, go, homeOpts, run, reset, checkout, makeCheckout, setupWorktreePath, answersFile, settingsFile, seedAnswers, statePath, logFile: join(homeConfig.logDir, 'pressplay-onboard.log') };
}

const out = (w) => w.printed.join('\n');

test('a first run asks Dane only his answers, stops for the paste block and the merge phrase, and ends set up', async (t) => {
  const { w, go, answersFile, logFile } = makeWorld(t);
  // The checkout folder is not asked: it defaults beside the home's, in this scratch folder.
  const code = await go();
  assert.equal(code, 0, out(w));
  assert.equal(w.asked.length, DANE_FIELDS.length, 'one question per Dane field');
  assert.equal(w.paused, 1, 'one wait, for the paste block');
  assert.match(out(w), /Your move, Dane \(real secret values\)/);
  assert.match(out(w), /doppler projects create pressplay/);
  assert.match(out(w), /Your move, Dane \(a decision\).*"merge", "ship it".*PP-1: http:\/\/mac-mini\.local:4180\/t\/PP-1/);
  assert.equal((out(w).match(/Your move, Dane/g) || []).length, 2, 'exactly two stops beyond the questions');
  assert.match(out(w), /Done: pressplay is set up\. Its tickets: http:\/\/mac-mini\.local:4180\/list\/pressplay/);
  const answers = JSON.parse(readFileSync(answersFile, 'utf8'));
  assert.equal(answers.productSlug, 'pressplay');
  assert.equal(answers.trackerPrefix, 'PP');
  assert.equal(answers.mergePhrases, null, 'a blank answer takes the default');
  assert.deepEqual(answers.autoMergeLanes, []);
  const log = readFileSync(logFile, 'utf8');
  for (const step of STEPS) assert.match(log, new RegExp(`\\| ${step} \\| done \\|`), step);
  assert.match(log, /MT \|/);
  // Every write read back: the protection was read again after the PUT.
  const put = w.calls.findIndex((c) => c.includes('-X PUT'));
  assert.ok(w.calls.slice(put + 1).some((c) => c.endsWith('/branches/main/protection')));
});

test('a rerun once everything is done says each step is already done and asks nothing', async (t) => {
  const { w, go, reset } = makeWorld(t);
  assert.equal(await go(), 0, out(w));
  reset();
  assert.equal(await go(), 0, out(w));
  assert.equal(w.asked.length, 0);
  assert.equal(w.paused, 0);
  for (const step of STEPS) assert.match(out(w), new RegExp(`^${step}\\s+already done`, 'm'), step);
  assert.ok(!w.calls.some((c) => c.startsWith('npm') || c.includes('-X PUT')), 'no step script ran and nothing was written');
});

test('a project already set up (its settings on main, main protected) with an answers file: every step already done, nothing asked', async (t) => {
  const { w, go, seedAnswers, makeCheckout } = makeWorld(t);
  seedAnswers();
  makeCheckout();
  w.merged = true;
  w.protection = GOOD_PROTECTION;
  assert.equal(await go(), 0, out(w));
  assert.equal(w.asked.length, 0);
  for (const step of STEPS) assert.match(out(w), new RegExp(`^${step}\\s+already done`, 'm'), step);
});

// A failure at each step, then a rerun that resumes there.
const LATER = { look: 'onboard:look', clone: 'git clone', settings: 'onboard:settings -- write', copy: 'onboard:copy', lanes: 'onboard:lanes', protect: '-X PUT' };
for (const failing of ['look', 'clone', 'settings', 'copy', 'lanes', 'protect']) {
  test(`a failure at ${failing}: FAILED, nothing after it runs, and the rerun resumes there asking nothing again`, async (t) => {
    const { w, go, reset } = makeWorld(t);
    w.fail = failing;
    assert.equal(await go(), 1, out(w));
    assert.match(out(w), new RegExp(`^FAILED: ${failing}: `, 'm'));
    assert.match(out(w), /npm run onboard -- --product pressplay/);
    const after = STEPS.slice(STEPS.indexOf(failing) + 1);
    for (const step of after) {
      if (LATER[step]) assert.ok(!w.calls.some((c) => c.includes(LATER[step])), `${step} did not run`);
    }
    assert.ok(!out(w).includes('Done:'), 'no success line over a failed step');

    w.fail = null;
    reset();
    assert.equal(await go(), 0, out(w));
    assert.equal(w.asked.length, 0, 'no answer asked twice');
    for (const step of STEPS.slice(0, STEPS.indexOf(failing))) assert.match(out(w), new RegExp(`^${step}\\s+already done`, 'm'), step);
    assert.ok(!new RegExp(`^${failing}\\s+already done`, 'm').test(out(w)), `${failing} runs again`);
  });
}

test('a failure at answers: an answer that does not check out is taken back out, and the rerun asks only that one', async (t) => {
  const { w, go, reset, answersFile } = makeWorld(t);
  const bad = async (q) => { w.asked.push(q); return q.startsWith('GitHub repository') ? 'not a repo' : (Object.entries(DANE_ANSWERS).find(([k]) => q.startsWith(k))?.[1] ?? ''); };
  assert.equal(await go({ ask: bad }), 1, out(w));
  assert.match(out(w), /^FAILED: answers: .*githubRepo.*asks "githubRepo" again/m);
  assert.ok(!Object.hasOwn(JSON.parse(readFileSync(answersFile, 'utf8')), 'githubRepo'));
  assert.ok(!w.calls.some((c) => c.startsWith('npm')), 'nothing after the answers ran');
  reset();
  assert.equal(await go(), 0, out(w));
  assert.deepEqual(w.asked.map((q) => q.split(',')[0]), ['GitHub repository']);
});

test('no Terminal to ask in: STOPPED at answers, naming what is still to answer', async (t) => {
  const { w, go } = makeWorld(t);
  assert.equal(await go({ ask: async () => null }), 3);
  assert.match(out(w), /^STOPPED: answers: no Terminal to ask in; still to answer: productName, githubRepo/m);
});

test('a failure at signins: the block ran but the sign-ins still do not answer — FAILED, and the rerun shows the block again', async (t) => {
  const { w, go, reset } = makeWorld(t);
  assert.equal(await go({ pause: async () => { w.paused += 1; return true; } }), 1, out(w));
  assert.match(out(w), /^FAILED: signins: tracker:signins check does not pass yet/m);
  assert.ok(!w.calls.some((c) => c.includes('onboard:copy')), 'copy did not run');
  reset();
  assert.equal(await go(), 0, out(w));
  assert.equal(w.paused, 1, 'the paste block is shown again');
  assert.equal(w.asked.length, 0);
  assert.match(out(w), /^settings\s+already done/m);
});

test('no Terminal to wait in at the paste block: STOPPED at signins, the block still printed', async (t) => {
  const { w, go } = makeWorld(t);
  assert.equal(await go({ pause: async () => null }), 3);
  assert.match(out(w), /tracker:signins -- create --name PressPlay --prefix PP --config /);
  assert.match(out(w), /^STOPPED: signins: waiting on you/m);
});

test('a merge not made in time: STOPPED at merge; the rerun waits again and finishes once it is merged', async (t) => {
  const { w, go, reset } = makeWorld(t);
  w.fail = 'merge';
  assert.equal(await go(), 3, out(w));
  assert.match(out(w), /^STOPPED: merge: .*not merged yet; it waits on your merge phrase on PP-1/m);
  assert.ok(!w.calls.some((c) => c.includes('-X PUT')), 'main not protected before the merge');
  w.fail = null;
  reset();
  assert.equal(await go(), 0, out(w));
  assert.match(out(w), /^lanes\s+already done/m);
  assert.match(out(w), /^merge\s+.*merged as abc1234/m);
});

test('a setup pull request closed without merging: FAILED at merge, main left unprotected', async (t) => {
  const { w, go, run } = makeWorld(t);
  const closed = (cmd, args, o) => (cmd === 'gh' && args[1] === 'view' && args.includes('state,mergeCommit')
    ? { code: 0, out: JSON.stringify({ state: 'CLOSED', mergeCommit: null }), err: '' }
    : run(cmd, args, o));
  assert.equal(await go({ run: closed }), 1, out(w));
  assert.match(out(w), /^FAILED: merge: .*is CLOSED, not merged/m);
  assert.ok(!w.calls.some((c) => c.includes('-X PUT')));
});

test('lanes runs only once copy\'s worktree no longer holds the setup branch, removed and read back', async (t) => {
  const { w, go, setupWorktreePath } = makeWorld(t);
  assert.equal(await go(), 0, out(w));
  const removed = w.calls.findIndex((c) => c === `git worktree remove ${setupWorktreePath}`);
  const lanes = w.calls.findIndex((c) => c.includes('onboard:lanes'));
  assert.ok(removed >= 0, 'the worktree was removed');
  assert.ok(removed < lanes, 'before lanes ran');
  assert.ok(w.calls.slice(removed + 1, lanes).some((c) => c === 'git worktree list --porcelain'), 'read back before lanes');
  assert.match(out(w), /^lanes\s+removed onboard:copy's worktree/m);
});

test('a setup worktree git will not remove: FAILED at lanes naming it, lanes not run, and the rerun resumes once it is gone', async (t) => {
  const { w, go, reset, setupWorktreePath } = makeWorld(t);
  w.worktreeRemoveRefused = true;
  assert.equal(await go(), 1, out(w));
  assert.match(out(w), new RegExp(`^FAILED: lanes: the setup worktree ${setupWorktreePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} holds spirality-setup.*modified or untracked`, 'm'));
  assert.ok(!w.calls.some((c) => c.includes('onboard:lanes')), 'lanes did not run');
  w.worktreeRemoveRefused = false;
  reset();
  assert.equal(await go(), 0, out(w));
  assert.match(out(w), /^copy\s+already done/m);
  assert.equal(w.asked.length, 0);
});

test('a stop after a run started with a longer merge wait: the rerun line keeps it', async (t) => {
  const { w, homeOpts } = makeWorld(t);
  w.fail = 'merge';
  assert.equal(await homeOpts({ mergeWaitMinutes: 240 }), 3, out(w));
  assert.match(out(w), /^  npm run onboard -- --product pressplay --merge-wait-minutes 240$/m);
});

test('an answer taken back out but the answers file cannot be written: FAILED says so, not that the rerun asks again', async (t) => {
  const { w, go, answersFile } = makeWorld(t);
  let writes = 0;
  const bad = async (q) => { w.asked.push(q); return q.startsWith('GitHub repository') ? 'not a repo' : (Object.entries(DANE_ANSWERS).find(([k]) => q.startsWith(k))?.[1] ?? ''); };
  const writeText = (p, text) => { if (p === answersFile) writes += 1; if (writes > 1 && p === answersFile) { const e = new Error('read-only'); e.code = 'EROFS'; throw e; } writeFileSync(p, text); };
  assert.equal(await go({ ask: bad, writeText }), 1, out(w));
  assert.match(out(w), /^FAILED: answers: .*Taking "githubRepo" out of .* failed too \(EROFS\): fix it there by hand/m);
  assert.ok(!/asks "githubRepo" again/.test(out(w)));
});

test('main\'s stricter protection is named before the PUT switches it off', async (t) => {
  const { w, go } = makeWorld(t);
  w.protection = { required_linear_history: { enabled: true } };
  assert.equal(await go(), 0, out(w));
  const said = w.printed.findIndex((l) => /switches it off: linear history required/.test(l));
  assert.ok(said >= 0, out(w));
});

// --- The clone step (SP-119) ---------------------------------------------

test('a project with no checkout: cloned from main over the home\'s kind of address, read back, and the run carries on', async (t) => {
  const { w, go, checkout, logFile } = makeWorld(t);
  assert.equal(await go(), 0, out(w));
  assert.equal(w.clonedFrom, 'https://github.com/mentor24-maker/pressplay.git');
  const clone = w.calls.findIndex((c) => c.startsWith('git clone'));
  assert.equal(w.calls[clone], `git clone --quiet --branch main https://github.com/mentor24-maker/pressplay.git ${checkout}`);
  assert.ok(clone > w.calls.findIndex((c) => c.includes('onboard:look')), 'after the look');
  assert.ok(clone < w.calls.findIndex((c) => c.includes('onboard:settings -- write')), 'before the settings file');
  const after = w.calls.slice(clone + 1);
  for (const readBack of ['git remote get-url origin', 'git rev-parse --abbrev-ref HEAD', 'git status --porcelain']) assert.ok(after.includes(readBack), readBack);
  assert.match(out(w), /^clone\s+.*cloned into .*read back: origin mentor24-maker\/pressplay, a clean main/m);
  assert.match(readFileSync(logFile, 'utf8'), /\| clone \| done \|/);
  assert.ok(!out(w).includes('SECRET-TOKEN') && !readFileSync(logFile, 'utf8').includes('SECRET-TOKEN'), 'the home origin\'s token is never printed or logged');
});

test('the home\'s origin over ssh: the clone is over ssh too', async (t) => {
  const { w, go } = makeWorld(t);
  w.homeOrigin = 'git@github.com:mentor24-maker/spirality.git';
  assert.equal(await go(), 0, out(w));
  assert.equal(w.clonedFrom, 'git@github.com:mentor24-maker/pressplay.git');
});

test('a checkout that is there: the clone step is skipped and nothing is cloned', async (t) => {
  const { w, go, makeCheckout } = makeWorld(t);
  makeCheckout();
  assert.equal(await go(), 0, out(w));
  assert.match(out(w), /^clone\s+already done \(.* is there\)/m);
  assert.ok(!w.calls.some((c) => c.startsWith('git clone')));
});

for (const [what, set, seen] of [
  ['an origin that is not the repository', (w) => { w.cloneOrigin = 'https://github.com/someone/else.git'; }, /does not read back with origin mentor24-maker\/pressplay/],
  ['a branch that is not main', (w) => { w.cloneBranch = 'trunk'; }, /reads back on trunk, not main/],
  ['changes in it', (w) => { w.cloneDirty = ' M x.js'; }, /does not read back as a clean main/],
]) {
  test(`a clone that reads back with ${what}: FAILED at clone, nothing after it runs`, async (t) => {
    const { w, go } = makeWorld(t);
    set(w);
    assert.equal(await go(), 1, out(w));
    assert.match(out(w), new RegExp(`^FAILED: clone: .*${seen.source}`, 'm'));
    assert.ok(!w.calls.some((c) => c.includes('onboard:settings')), 'settings did not run');
    assert.ok(!out(w).includes('Done:'));
  });
}

test('a clone that fails: FAILED at clone saying what git said', async (t) => {
  const { w, go } = makeWorld(t);
  w.fail = 'clone';
  assert.equal(await go(), 1, out(w));
  assert.match(out(w), /^FAILED: clone: git clone of mentor24-maker\/pressplay into .* failed: .*repository not found/m);
});

// --- --no-prompt and the state file (SP-125) -----------------------------

const readState = (path) => JSON.parse(readFileSync(path, 'utf8'));
const outcomes = (state) => Object.fromEntries(state.steps.map((s) => [s.step, s.outcome]));
// Under --no-prompt the Terminal is never read: either read fails the test.
const NO_TERMINAL = {
  ask: async (q) => { throw new Error(`asked in the Terminal: ${q}`); },
  pause: async () => { throw new Error('waited on the Terminal'); },
};
const noPromptRun = (homeOpts, over = {}) => homeOpts({ noPrompt: true }, { ...NO_TERMINAL, ...over });

test('the state file has the shape the setup page reads, every step in STEPS order', async (t) => {
  const { w, go, statePath } = makeWorld(t);
  assert.equal(await go(), 0, out(w));
  const state = readState(statePath);
  assert.deepEqual(Object.keys(state), ['product', 'updatedAt', 'steps', 'stop', 'finished']);
  assert.equal(state.product, 'pressplay');
  assert.match(state.updatedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.deepEqual(state.steps.map((s) => s.step), STEPS);
  for (const s of state.steps) {
    assert.deepEqual(Object.keys(s), ['step', 'outcome', 'at', 'why']);
    assert.ok(['done', 'skip'].includes(s.outcome), `${s.step} is ${s.outcome}`);
    assert.match(s.at, /Z$/);
    assert.equal(typeof s.why, 'string');
  }
  assert.equal(state.stop, null);
  assert.equal(state.finished, true);
  assert.deepEqual(readdirSync(dirname(statePath)).filter((f) => f.endsWith('.tmp')), [], 'no half-written file left beside it');
});

test('the state file follows every step: running when it starts, its outcome when it ends, each write read back', async (t) => {
  const { w, go, statePath } = makeWorld(t);
  const seen = [];
  const readText = (p) => {
    let text = null;
    try { text = readFileSync(p, 'utf8'); } catch { return null; }
    if (p === statePath) seen.push(outcomes(JSON.parse(text)));
    return text;
  };
  assert.equal(await go({ readText }), 0, out(w));
  for (const step of STEPS) {
    assert.ok(seen.some((o) => o[step] === 'running'), `${step} was shown running`);
    const at = seen.findIndex((o) => o[step] === 'running');
    assert.ok(seen.slice(at).some((o) => ['done', 'skip'].includes(o[step])), `${step} then shown done`);
    assert.ok(seen.slice(0, at).every((o) => o[step] === 'pending'), `${step} pending before it ran`);
  }
});

test('--no-prompt with answers missing: STOPPED at answers, exit 3, the stop says fill the form, nothing asked', async (t) => {
  const { w, homeOpts, statePath } = makeWorld(t);
  assert.equal(await noPromptRun(homeOpts), 3, out(w));
  assert.match(out(w), /^STOPPED: answers: still to answer: productName, githubRepo/m);
  assert.match(out(w), /^  npm run onboard -- --product pressplay --no-prompt$/m);
  assert.ok(!w.calls.some((c) => c.startsWith('npm')), 'nothing after the answers ran');
  const state = readState(statePath);
  assert.deepEqual(state.stop, { step: 'answers', kind: 'answers', why: state.steps[0].why, commands: [], link: null });
  assert.match(state.stop.why, /still to answer: productName/);
  assert.equal(outcomes(state).answers, 'stopped');
  assert.equal(outcomes(state).look, 'pending');
  assert.equal(state.finished, false);
});

test('--no-prompt: answers filled in, the rerun stops for the paste block, then for the merge, then finishes', async (t) => {
  const { w, homeOpts, reset, seedAnswers, statePath, logFile } = makeWorld(t);
  assert.equal(await noPromptRun(homeOpts), 3, out(w));
  seedAnswers();

  // Stop 1: the sign-ins block, its lines in the stop.
  reset();
  assert.equal(await noPromptRun(homeOpts), 3, out(w));
  assert.match(out(w), /^STOPPED: signins: waiting on you to run the block above/m);
  assert.ok(!w.calls.some((c) => c.includes('onboard:copy')), 'copy did not run');
  let state = readState(statePath);
  assert.equal(state.stop.step, 'signins');
  assert.equal(state.stop.kind, 'paste');
  assert.equal(state.stop.link, null);
  assert.equal(state.stop.commands.length, 3);
  assert.match(state.stop.commands[0], /^cd /);
  assert.equal(state.stop.commands[1], 'doppler projects create pressplay');
  assert.match(state.stop.commands[2], /^TRACKER_DB=.* npm run tracker:signins -- create --name PressPlay --prefix PP --config /);
  for (const line of state.stop.commands) assert.ok(out(w).includes(`  ${line}`), 'the same block is printed');
  assert.deepEqual(outcomes(state), { answers: 'skip', look: 'done', clone: 'done', settings: 'done', signins: 'stopped', copy: 'pending', lanes: 'pending', merge: 'pending', protect: 'pending' });

  // Dane pastes the block. Stop 2: the merge, the setup ticket's link in the stop.
  w.signinsMade = true;
  w.dopplerProject = true;
  w.mergeAfterPolls = Infinity;
  reset();
  assert.equal(await noPromptRun(homeOpts), 3, out(w));
  assert.match(out(w), /^signins\s+already done/m);
  assert.match(out(w), /^STOPPED: merge: .*not merged yet; it waits on your merge phrase on PP-1/m);
  assert.equal(w.polls, 1, 'one look at the pull request, no waiting');
  assert.ok(!w.calls.some((c) => c.includes('-X PUT')), 'main not protected before the merge');
  state = readState(statePath);
  assert.deepEqual(state.stop, { step: 'merge', kind: 'merge', why: state.steps[7].why, commands: [], link: 'http://mac-mini.local:4180/t/PP-1' });
  assert.equal(outcomes(state).lanes, 'done');
  assert.equal(outcomes(state).protect, 'pending');

  // Dane merges. The rerun goes on to protect, and finishes.
  w.merged = true;
  reset();
  assert.equal(await noPromptRun(homeOpts), 0, out(w));
  assert.match(out(w), /Done: pressplay is set up/);
  state = readState(statePath);
  assert.equal(state.stop, null);
  assert.equal(state.finished, true);
  assert.equal(outcomes(state).protect, 'done');
  for (const s of state.steps) assert.ok(['done', 'skip'].includes(s.outcome), `${s.step} is ${s.outcome}`);

  // Nothing secret anywhere in it, nor in the step log.
  const text = readFileSync(statePath, 'utf8');
  assert.ok(!text.includes('SECRET-TOKEN') && !readFileSync(logFile, 'utf8').includes('SECRET-TOKEN'));
  assert.ok(!/dp\.(st|sa|ct|pt)\./.test(text), 'no Doppler token');
});

test('--no-prompt: a merge made before the run goes straight on, with no stop', async (t) => {
  const { w, homeOpts, seedAnswers, statePath } = makeWorld(t);
  seedAnswers();
  w.signinsMade = true;
  w.dopplerProject = true;
  assert.equal(await noPromptRun(homeOpts), 0, out(w));
  assert.equal(readState(statePath).finished, true);
});

test('--no-prompt: a failed step is a stop of kind failed, its FAILED text the why, exit 1; the rerun resumes', async (t) => {
  const { w, homeOpts, reset, seedAnswers, statePath } = makeWorld(t);
  seedAnswers();
  w.signinsMade = true;
  w.fail = 'copy';
  assert.equal(await noPromptRun(homeOpts), 1, out(w));
  const failed = /^FAILED: copy: (.*)$/m.exec(out(w));
  assert.ok(failed, out(w));
  let state = readState(statePath);
  assert.deepEqual(state.stop, { step: 'copy', kind: 'failed', why: failed[1], commands: [], link: null });
  assert.equal(outcomes(state).copy, 'failed');
  assert.equal(outcomes(state).lanes, 'pending');
  w.fail = null;
  reset();
  assert.equal(await noPromptRun(homeOpts), 0, out(w));
  state = readState(statePath);
  assert.equal(state.stop, null);
  assert.equal(state.finished, true);
});

test('--no-prompt: a state file that cannot be written fails the run, and no step after it runs', async (t) => {
  const { w, homeOpts, seedAnswers, statePath } = makeWorld(t);
  seedAnswers();
  const writeText = (p, text) => {
    if (p.startsWith(`${statePath}.`)) { const e = new Error('no space'); e.code = 'ENOSPC'; throw e; }
    writeFileSync(p, text);
  };
  assert.equal(await noPromptRun(homeOpts, { writeText }), 1, out(w));
  assert.match(out(w), /^FAILED: state: could not write the state file .*pressplay\.state\.json: ENOSPC/m);
  assert.ok(!w.calls.some((c) => c.startsWith('npm')), 'no step ran');
  assert.ok(!out(w).includes('Done:'));
});

test('--no-prompt: a state file that does not read back as written fails the run', async (t) => {
  const { w, homeOpts, seedAnswers, statePath } = makeWorld(t);
  seedAnswers();
  const readText = (p) => (p === statePath ? '{}' : (() => { try { return readFileSync(p, 'utf8'); } catch { return null; } })());
  assert.equal(await noPromptRun(homeOpts, { readText }), 1, out(w));
  assert.match(out(w), /^FAILED: state: .*did not read back as written/m);
});

test('in a Terminal, a state file that cannot be written is a warning and the run goes on as before', async (t) => {
  const { w, go, statePath } = makeWorld(t);
  const writeText = (p, text) => {
    if (p.startsWith(`${statePath}.`)) { const e = new Error('no space'); e.code = 'ENOSPC'; throw e; }
    writeFileSync(p, text);
  };
  assert.equal(await go({ writeText }), 0, out(w));
  assert.match(out(w), /\(could not write the state file .*ENOSPC; the setup page will not see this run\)/);
  assert.equal(w.printed.filter((l) => l.includes('could not write the state file')).length, 1, 'warned once, not on every step');
  assert.match(out(w), /Done: pressplay is set up/);
});

test('in a Terminal with no one to answer, the stops still say what is next in the state file', async (t) => {
  const { w, go, statePath } = makeWorld(t);
  assert.equal(await go({ pause: async () => null }), 3, out(w));
  const state = readState(statePath);
  assert.equal(state.stop.kind, 'paste');
  assert.equal(state.stop.commands.length, 3);
});

test('--no-prompt: an error that is not a step\'s own stop marks the running step failed in the state file, exit 1', async (t) => {
  const { w, homeOpts, seedAnswers, statePath, run: fakeRun } = makeWorld(t);
  seedAnswers();
  w.signinsMade = true;
  w.dopplerProject = true;
  const run = (cmd, args, o) => {
    if (args.some((a) => String(a).includes('onboard:copy'))) throw new Error('spawn npm EACCES');
    return fakeRun(cmd, args, o);
  };
  assert.equal(await noPromptRun(homeOpts, { run }), 1, out(w));
  assert.match(out(w), /^FAILED: copy: unexpected error — spawn npm EACCES$/m);
  const state = readState(statePath);
  assert.equal(outcomes(state).copy, 'failed');
  assert.equal(outcomes(state).lanes, 'pending');
  assert.deepEqual(state.stop, { step: 'copy', kind: 'failed', why: 'unexpected error — spawn npm EACCES', commands: [], link: null });
  assert.equal(state.finished, false);
  assert.ok(!state.steps.some((s) => s.outcome === 'running'), 'no step left running over a run that died');
});

test('an answers file the wizard cannot read: FAILED at answers in the state file, not "running"', async (t) => {
  const { w, homeOpts, answersFile, statePath } = makeWorld(t);
  const readText = (p) => {
    if (p === answersFile) { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; }
    try { return readFileSync(p, 'utf8'); } catch { return null; }
  };
  assert.equal(await noPromptRun(homeOpts, { readText }), 1, out(w));
  assert.match(out(w), /^FAILED: answers: unexpected error — EACCES: permission denied$/m);
  const state = readState(statePath);
  assert.equal(outcomes(state).answers, 'failed');
  assert.equal(state.stop.kind, 'failed');
});

test('a state file whose rename fails leaves no half-written file beside it', async (t) => {
  const { w, homeOpts, seedAnswers, statePath } = makeWorld(t);
  seedAnswers();
  const rename = (from, to) => {
    if (to === statePath) { const e = new Error('cross-device'); e.code = 'EXDEV'; throw e; }
    renameSync(from, to);
  };
  assert.equal(await noPromptRun(homeOpts, { rename }), 1, out(w));
  assert.match(out(w), /^FAILED: state: .*EXDEV/m);
  assert.deepEqual(readdirSync(dirname(statePath)).filter((f) => f.endsWith('.tmp')), []);
});
