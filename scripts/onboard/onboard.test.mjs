import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { validateProjectConfig } from '../../lib/projectConfig.mjs';
import { settingsDraft, resolveAnswers } from '../../lib/onboardAnswers.mjs';
import {
  DANE_FIELDS, STEPS, answerValue, fieldNamed, loggedDone, mainVerifyVerdict, mountainStamp, onboard,
  cloneAddress, commandLine, parseOnboardArgs, pasteBlock, saidYes, signinCommands, protectionDropped, protectionGaps, protectionRequest, rerunCommand, shellQuote,
  unanswered, worktreesOnBranch, CLICKUP_RUN_STEPS,
} from './onboard.mjs';
import { passInFlight, readInstallerStatus, runsOldLoop, safeToSwitch, snapshotArgs, withClickupSteps } from './fromClickup.mjs';

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
  const name = DANE_FIELDS.find((f) => f.key === 'projectName');
  assert.equal(answerValue(name, '  PressPlay '), 'PressPlay');
  assert.equal(answerValue(name, ''), null);
  assert.deepEqual(answerValue(list, 'merge, ship it ,'), ['merge', 'ship it']);
  assert.deepEqual(answerValue(list, 'None'), []);
  assert.equal(answerValue(list, ' '), null);
});

test('only the fields that are Dane\'s decisions are asked, and one set to null counts as answered', () => {
  assert.deepEqual(DANE_FIELDS.map((f) => f.key), ['projectName', 'githubRepo', 'trackerPrefix', 'mergePhrases', 'autoMergeLanes', 'extraGovernancePaths', 'description']);
  assert.deepEqual(unanswered({ projectName: 'X', trackerPrefix: null }).map((f) => f.key), ['githubRepo', 'mergePhrases', 'autoMergeLanes', 'extraGovernancePaths', 'description']);
  assert.equal(fieldNamed('/x.json: "githubRepo" must be owner/name'), 'githubRepo');
});

test('the paste block makes the Doppler project only when it is missing, and quotes what it must', () => {
  const answers = { dopplerProject: 'pressplay', dopplerConfig: 'dev', projectName: "Press Play's", trackerPrefix: 'PP' };
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
  // What is printed is what runs: the same commands, word for word.
  const cmds = signinCommands({ ...base, projectExists: false, configExists: false });
  assert.deepEqual(cmds.map(commandLine), fresh.slice(1));
  assert.deepEqual(cmds.at(-1).env, { TRACKER_DB: '/Users/d/spirality-tracker/tracker.db' });
  assert.equal(cmds.at(-1).args[cmds.at(-1).args.indexOf('--name') + 1], "Press Play's", 'run as one word, unquoted');
});

test('only y or yes runs the sign-ins', () => {
  for (const yes of ['y', 'Y', ' yes ', 'YES']) assert.equal(saidYes(yes), true, yes);
  for (const no of ['', 'n', 'no', 'done', 'yep', null, undefined]) assert.equal(saidYes(no), false, String(no));
});

test('the step log: Mountain time, and a done step is found by name', () => {
  assert.match(mountainStamp(new Date('2026-11-05T05:00:00Z')), /^2026-11-04 22:00:00 MT$/);
  const log = '2026-11-04 22:00:00 MT | look | done | nothing is BLOCKED\n2026-11-04 22:01:00 MT | settings | FAILED | x\n';
  assert.equal(loggedDone(log, 'look'), true);
  assert.equal(loggedDone(log, 'settings'), false);
  assert.equal(loggedDone(null, 'look'), false);
});

test('the arguments: --project is a slug, the merge wait a positive number', () => {
  assert.deepEqual(parseOnboardArgs(['--project', 'pressplay']).opts, { project: 'pressplay', allowReplace: false, mergeWaitMinutes: 60, noPrompt: false });
  assert.equal(parseOnboardArgs(['--project', 'pressplay', '--no-prompt']).opts.noPrompt, true);
  assert.equal(parseOnboardArgs(['--project', 'pressplay', '--allow-replace', '--merge-wait-minutes', '5']).opts.mergeWaitMinutes, 5);
  assert.match(parseOnboardArgs([]).error, /--project/);
  // --product is the option's old name (SP-156): a command saved before the rename still runs.
  assert.deepEqual(parseOnboardArgs(['--product', 'pressplay']).opts, parseOnboardArgs(['--project', 'pressplay']).opts);
  assert.match(parseOnboardArgs(['--project', 'Press Play']).error, /not a slug/);
  assert.match(parseOnboardArgs(['--project', 'x', '--merge-wait-minutes', '0']).error, /greater than 0/);
  assert.match(parseOnboardArgs(['--project', 'x', '--nope']).error, /unknown/);
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
  assert.equal(rerunCommand({ project: 'pressplay', allowReplace: false, mergeWaitMinutes: 60 }), 'npm run onboard -- --project pressplay');
  assert.equal(rerunCommand({ project: 'pressplay', allowReplace: true, mergeWaitMinutes: 240 }), 'npm run onboard -- --project pressplay --allow-replace --merge-wait-minutes 240');
  assert.equal(rerunCommand({ project: 'pressplay', allowReplace: false, mergeWaitMinutes: 60, noPrompt: true }), 'npm run onboard -- --project pressplay --no-prompt');
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
    operatorName: 'Dane', projectSlug: 'spirality', legacyMachinePrefixes: [], projectScripts: {}, trackerPrefix: 'SP',
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
    calls: [], asked: [], printed: [], signinsEnv: [],
    // "Run these now?" at the sign-ins: what Dane answers, how often it was asked,
    // and the environment each command it ran was given.
    runAnswer: 'y', runAsked: 0, envs: {}, signinsHollow: false, createFails: null,
    // onboard:copy's worktree, on the setup branch; true once copy has run (as the real one keeps it).
    setupWorktree: false, worktreeRemoveRefused: false,
    // The tracker home's origin, with a sign-in token in it as a real one can carry.
    homeOrigin: 'https://x-access-token:SECRET-TOKEN@github.com/mentor24-maker/spirality.git',
    clonedFrom: null, cloneOrigin: 'https://github.com/mentor24-maker/pressplay.git', cloneBranch: 'main', cloneDirty: '',
    // SP-154: GitHub's repository, a real bare one here. Not empty unless a
    // test says so; `pushFails` refuses the start step's push, `readBack`
    // makes GitHub answer something else after it.
    repoEmpty: false, bare: join(dir, 'github', 'pressplay.git'), pushedTo: null, pushFails: false, readBack: null, viewFails: false,
  };
  const startDir = join(homeConfig.logDir, 'onboard', 'pressplay-start');
  const realGit = (args, cwd) => {
    const r = spawnSync('git', args, {
      cwd, encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    });
    return { code: r.status ?? 1, out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim() };
  };
  w.makeEmptyRepo = () => {
    w.repoEmpty = true;
    mkdirSync(w.bare, { recursive: true });
    realGit(['init', '--quiet', '--bare', '--initial-branch=main', w.bare], dir);
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
    if (o.env) w.envs[line] = o.env;
    if (cmd === 'git' && o.cwd === startDir) {
      if (args[0] === 'push') {
        w.pushedTo = args.at(-2);
        if (w.pushFails) return no('! [rejected]        main -> main (fetch first)\nerror: failed to push some refs', 1);
        const r = realGit([...args.slice(0, -2), w.bare, args.at(-1)], o.cwd);
        if (r.code === 0) w.repoEmpty = false;
        return r;
      }
      return realGit(args, o.cwd);
    }
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
      const [, script, , ...rest] = args.filter((a) => a !== '--silent');
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
      if (script === 'tracker:signins') {
        // As the real one does: a guest project's settings name no
        // trackerDataDir, so without TRACKER_DB there is no database to use.
        w.signinsEnv.push(o.env?.TRACKER_DB ?? null);
        if (o.env?.TRACKER_DB !== join(homeConfig.trackerDataDir, 'tracker.db')) return no('The project config names no trackerDataDir, and TRACKER_DB is not set: there is no tracker database to use.');
        if (rest[0] === 'create') {
          if (w.createFails === 'tracker') return no('could not make the project', 4);
          if (!w.signinsHollow) w.signinsMade = true;
          return ok();
        }
        return w.signinsMade ? ok('all answer as themselves') : no('Could not find requested project');
      }
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
    if (cmd === 'doppler' && args[1] === 'create') {
      if (w.createFails === 'doppler') return no('Doppler Error: unauthorized', 2);
      if (args[0] === 'projects') w.dopplerProject = true;
      return ok();
    }
    if (cmd === 'doppler') return w.dopplerProject ? ok('{}') : no();
    if (cmd === 'bash') {
      return ok(w.lanesLoaded ? ['relay', 'loop-build', 'loop-review', 'loop-intake'].map((l) => `── ${l}\nschedule: INSTALLED\nloaded:   yes`).join('\n') : '');
    }
    if (cmd === 'gh') {
      if (args[0] === 'repo' && args[1] === 'view' && args[2] === 'mentor24-maker/pressplay') {
        if (w.viewFails) return no('HTTP 502: Bad Gateway', 1);
        // `readBack` is what GitHub answers once the push has landed.
        const seen = w.readBack && !w.repoEmpty ? w.readBack : { isEmpty: w.repoEmpty, defaultBranchRef: w.repoEmpty ? null : { name: 'main' } };
        return ok(JSON.stringify(seen));
      }
      if (args[0] === 'api' && args[1] === 'repos/mentor24-maker/pressplay/commits/main') {
        const sha = realGit(['rev-parse', 'main'], w.bare);
        if (sha.code !== 0) return no('gh: Git Repository is empty. (HTTP 409)');
        const parents = realGit(['rev-list', '--parents', '-n', '1', 'main'], w.bare).out.split(' ').slice(1);
        return ok(JSON.stringify({ sha: sha.out, parents: parents.map((p) => ({ sha: p })) }));
      }
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
      if (q.startsWith('Run these now')) { w.runAsked += 1; return w.runAnswer; }
      w.asked.push(q);
      const key = Object.keys(DANE_ANSWERS).find((k) => q.startsWith(k));
      return key ? DANE_ANSWERS[key] : '';
    },
    print: (line) => w.printed.push(line),
    exists: (p) => existsSync(p),
    readText: (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } },
    writeText: (p, text) => writeFileSync(p, text),
    appendText: (p, text) => { mkdirSync(dirname(p), { recursive: true }); appendFileSync(p, text); },
    mkdir: (d) => mkdirSync(d, { recursive: true }),
    rename: (from, to) => renameSync(from, to),
    remove: (p) => rmSync(p, { force: true }),
    removeTree: (p) => rmSync(p, { recursive: true, force: true }),
    nodeVersion: 'v22.23.3',
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    ...over,
  });
  const opts = { project: 'pressplay', allowReplace: false, mergeWaitMinutes: 60 };
  const go = (over) => onboard(opts, deps(over));
  const homeOpts = (more, over) => onboard({ ...opts, ...more }, deps(over));
  const reset = () => { w.calls = []; w.asked = []; w.runAsked = 0; w.envs = {}; w.printed = []; w.polls = 0; };
  const answersFile = answersPath;
  // The answers in place, written as the wizard would, with a checkout path in this scratch folder.
  const seedAnswers = () => {
    mkdirSync(dirname(answersPath), { recursive: true });
    writeFileSync(answersPath, JSON.stringify({ projectSlug: 'pressplay', projectName: 'PressPlay', githubRepo: 'mentor24-maker/pressplay', trackerPrefix: 'PP', mergePhrases: null, autoMergeLanes: [], extraGovernancePaths: null, description: 'PressPlay plays things.', checkoutDir: checkout }));
  };
  const statePath = join(homeConfig.logDir, 'onboard', 'pressplay.state.json');
  return { startDir, realGit, w, go, homeOpts, run, reset, checkout, makeCheckout, setupWorktreePath, answersFile, settingsFile, seedAnswers, statePath, logFile: join(homeConfig.logDir, 'pressplay-onboard.log') };
}

const out = (w) => w.printed.join('\n');

test('a first run asks Dane only his answers, stops for the paste block and the merge phrase, and ends set up', async (t) => {
  const { w, go, answersFile, logFile } = makeWorld(t);
  // The checkout folder is not asked: it defaults beside the home's, in this scratch folder.
  const code = await go();
  assert.equal(code, 0, out(w));
  assert.equal(w.asked.length, DANE_FIELDS.length, 'one question per Dane field');
  assert.equal(w.runAsked, 1, 'one question, Run these now?, for the sign-ins');
  assert.match(out(w), /Your move, Dane \(real secret values\)/);
  assert.match(out(w), /doppler projects create pressplay/);
  // On his y the commands ran, in order, then the sign-ins were read back.
  const made = w.calls.indexOf('doppler projects create pressplay');
  const create = w.calls.findIndex((c) => c.startsWith('npm run tracker:signins -- create --name PressPlay --prefix PP'));
  assert.ok(made >= 0 && create > made, 'the Doppler project, then the sign-ins');
  assert.ok(w.calls.slice(create + 1).some((c) => c.includes('tracker:signins -- check')), 'read back after');
  assert.equal(w.envs[w.calls[create]].TRACKER_DB, join(w.homeConfig.trackerDataDir, 'tracker.db'));
  assert.ok(!/type done/i.test(out(w)), 'never asks him to type done');
  assert.match(out(w), /Your move, Dane \(a decision\).*"merge", "ship it".*PP-1: http:\/\/mac-mini\.local:4180\/t\/PP-1/);
  assert.equal((out(w).match(/Your move, Dane/g) || []).length, 2, 'exactly two stops beyond the questions');
  assert.match(out(w), /Done: pressplay is set up\. Its tickets: http:\/\/mac-mini\.local:4180\/list\/pressplay/);
  const answers = JSON.parse(readFileSync(answersFile, 'utf8'));
  assert.equal(answers.projectSlug, 'pressplay');
  assert.equal(answers.trackerPrefix, 'PP');
  assert.equal(answers.mergePhrases, null, 'a blank answer takes the default');
  assert.deepEqual(answers.autoMergeLanes, []);
  const log = readFileSync(logFile, 'utf8');
  // The repository already has history, so the start step (SP-154) is skipped; every other step is done.
  for (const step of STEPS.filter((x) => x !== 'start')) assert.match(log, new RegExp(`\\| ${step} \\| done \\|`), step);
  assert.match(log, /\| start \| skip \| mentor24-maker\/pressplay already has a main branch \(main\)/);
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
  assert.equal(w.runAsked, 0);
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
    assert.match(out(w), /npm run onboard -- --project pressplay/);
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
  assert.match(out(w), /^STOPPED: answers: no Terminal to ask in; still to answer: projectName, githubRepo/m);
});

test('a failure at signins: the block ran but the sign-ins still do not answer — FAILED, and the rerun asks and runs it again', async (t) => {
  const { w, go, reset } = makeWorld(t);
  w.signinsHollow = true;
  assert.equal(await go(), 1, out(w));
  assert.match(out(w), /^FAILED: signins: tracker:signins check does not pass yet/m);
  assert.ok(!w.calls.some((c) => c.includes('onboard:copy')), 'copy did not run');
  w.signinsHollow = false;
  reset();
  assert.equal(await go(), 0, out(w));
  assert.equal(w.runAsked, 1, 'Run these now? is asked again');
  assert.ok(!w.calls.includes('doppler projects create pressplay'), 'the Doppler project made last time is not made again');
  assert.equal(w.asked.length, 0);
  assert.match(out(w), /^settings\s+already done/m);
});

test('the sign-ins check is given the tracker home\'s database, so a run whose sign-ins exist passes without TRACKER_DB in the shell', async (t) => {
  const { w, go } = makeWorld(t);
  w.signinsMade = true;
  assert.equal(await go(), 0, out(w));
  assert.match(out(w), /^signins\s+already done/m);
  assert.equal(w.runAsked, 0, 'no Run these now?: the sign-ins were already there');
  assert.ok(w.signinsEnv.length > 0, 'the check ran');
  for (const db of w.signinsEnv) assert.equal(db, join(w.homeConfig.trackerDataDir, 'tracker.db'));
});

const signinsRan = (w) => w.calls.some((c) => / create/.test(c) && (c.startsWith('doppler') || c.includes('tracker:signins')));

for (const [why, answer] of [['no Terminal to ask in', null], ['n', 'n'], ['a bare Enter', ''], ['anything but y', 'done']]) {
  test(`at the sign-ins, ${why}: nothing is run, the block is printed, STOPPED, and a rerun after he ran it resumes`, async (t) => {
    const { w, go, reset } = makeWorld(t);
    w.runAnswer = answer;
    assert.equal(await go(), 3, out(w));
    assert.equal(w.runAsked, 1);
    assert.ok(!signinsRan(w), 'nothing was run without his y');
    assert.match(out(w), /^ {2}doppler projects create pressplay$/m);
    assert.match(out(w), /tracker:signins -- create --name PressPlay --prefix PP --config /);
    assert.match(out(w), /^STOPPED: signins: the block above is not run/m);
    assert.ok(!w.calls.some((c) => c.includes('onboard:copy')), 'copy did not run');
    // He ran it himself; the rerun reads it back and goes on without asking.
    w.signinsMade = true;
    w.dopplerProject = true;
    reset();
    assert.equal(await go(), 0, out(w));
    assert.equal(w.runAsked, 0);
    assert.match(out(w), /^signins\s+already done/m);
  });
}

for (const failing of ['doppler', 'tracker']) {
  test(`at the sign-ins, a ${failing} command that fails: FAILED with its exit code, nothing after it runs`, async (t) => {
    const { w, go } = makeWorld(t);
    w.createFails = failing;
    assert.equal(await go(), 1, out(w));
    const code = failing === 'doppler' ? 2 : 4;
    assert.match(out(w), new RegExp(`^FAILED: signins: ${failing === 'doppler' ? 'doppler projects create pressplay' : 'TRACKER_DB=\\S+ npm run tracker:signins -- create'}.* ended with exit ${code}`, 'm'));
    if (failing === 'doppler') assert.ok(!w.calls.some((c) => c.includes('tracker:signins -- create')), 'the sign-ins were not made after it');
    const failed = w.calls.findIndex((c) => (failing === 'doppler' ? c.startsWith('doppler projects create') : c.includes('tracker:signins -- create')));
    assert.ok(failed >= 0 && !w.calls.slice(failed + 1).some((c) => c.includes('tracker:signins -- check')), 'no read back over a failed command');
    assert.ok(!w.calls.some((c) => c.includes('onboard:copy')), 'copy did not run');
  });
}

test('at the sign-ins, a Doppler project that is already there is not made again', async (t) => {
  const { w, go } = makeWorld(t);
  w.dopplerProject = true;
  assert.equal(await go(), 0, out(w));
  assert.ok(!w.calls.some((c) => c.startsWith('doppler projects create')));
  assert.ok(w.calls.some((c) => c.includes('tracker:signins -- create')));
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
  assert.match(out(w), /^  npm run onboard -- --project pressplay --merge-wait-minutes 240$/m);
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
};
const noPromptRun = (homeOpts, over = {}) => homeOpts({ noPrompt: true }, { ...NO_TERMINAL, ...over });

test('the state file has the shape the setup page reads, every step in STEPS order', async (t) => {
  const { w, go, statePath } = makeWorld(t);
  assert.equal(await go(), 0, out(w));
  const state = readState(statePath);
  assert.deepEqual(Object.keys(state), ['project', 'updatedAt', 'steps', 'stop', 'finished']);
  assert.equal(state.project, 'pressplay');
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
  assert.match(out(w), /^STOPPED: answers: still to answer: projectName, githubRepo/m);
  assert.match(out(w), /^  npm run onboard -- --project pressplay --no-prompt$/m);
  assert.ok(!w.calls.some((c) => c.startsWith('npm')), 'nothing after the answers ran');
  const state = readState(statePath);
  assert.deepEqual(state.stop, { step: 'answers', kind: 'answers', why: state.steps[0].why, commands: [], link: null });
  assert.match(state.stop.why, /still to answer: projectName/);
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
  assert.deepEqual(outcomes(state), { answers: 'skip', look: 'done', start: 'skip', clone: 'done', settings: 'done', signins: 'stopped', copy: 'pending', lanes: 'pending', merge: 'pending', protect: 'pending' });

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
  assert.deepEqual(state.stop, { step: 'merge', kind: 'merge', why: state.steps.find((s) => s.step === 'merge').why, commands: [], link: 'http://mac-mini.local:4180/t/PP-1' });
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
  w.runAnswer = null; // no one at the Terminal to answer Run these now?
  assert.equal(await go(), 3, out(w));
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

// --- start: the first commit of an empty repository (SP-154) ---------------

test('an empty repository: start pushes one first commit to main, read back, between the look and the clone; a fresh clone of it installs and passes verify', async (t) => {
  const { w, go, realGit, logFile } = makeWorld(t);
  w.makeEmptyRepo();
  assert.equal(await go(), 0, out(w));
  assert.match(out(w), /^start\s+mentor24-maker\/pressplay is empty; making its first commit on main/m);
  assert.match(out(w), /^start\s+mentor24-maker\/pressplay's first commit [0-9a-f]{7} pushed to main, read back: not empty, default branch main/m);
  assert.match(readFileSync(logFile, 'utf8'), /\| start \| done \|/);
  const push = w.calls.findIndex((c) => c.startsWith('git push'));
  assert.ok(push > w.calls.findIndex((c) => c.includes('onboard:look')), 'after the look');
  assert.ok(push < w.calls.findIndex((c) => c.startsWith('git clone')), 'before the clone');
  assert.ok(!w.calls[push].includes('--force') && !w.calls[push].includes(' -f '), 'never a forced push');
  assert.equal(w.pushedTo, 'https://github.com/mentor24-maker/pressplay.git', 'over the home origin\'s kind of address, its token left out');
  assert.ok(!out(w).includes('SECRET-TOKEN') && !readFileSync(logFile, 'utf8').includes('SECRET-TOKEN'));
  // Read back after the push: GitHub's view of the repository and of main.
  const after = w.calls.slice(push + 1);
  assert.ok(after.includes('gh repo view mentor24-maker/pressplay --json isEmpty,defaultBranchRef'));
  assert.ok(after.includes('gh api repos/mentor24-maker/pressplay/commits/main'));
  // Exactly one commit on main, holding the starter and nothing else.
  assert.equal(realGit(['rev-list', '--count', 'main'], w.bare).out, '1');
  assert.deepEqual(realGit(['ls-tree', '-r', '--name-only', 'main'], w.bare).out.split('\n').sort(),
    ['.gitignore', '.nvmrc', 'README.md', 'package-lock.json', 'package.json', 'test/smoke.test.mjs']);
  const pkg = JSON.parse(realGit(['show', 'main:package.json'], w.bare).out);
  assert.equal(pkg.name, 'pressplay');
  assert.equal(pkg.engines.node, '>=22', 'this Mac\'s major Node, as the answers name none');
  assert.equal(realGit(['show', 'main:.nvmrc'], w.bare).out, '22');
  assert.match(realGit(['show', 'main:README.md'], w.bare).out, /^# PressPlay\n[\s\S]*mentor24-maker\/pressplay/);
  assert.match(realGit(['show', 'main:.gitignore'], w.bare).out, /^node_modules\/$[\s\S]*^\.env$[\s\S]*^\.env\.\*$/m);
  // The scratch folder is gone once it is pushed.
  assert.ok(!existsSync(join(w.homeConfig.logDir, 'onboard', 'pressplay-start')));

  // What CI and the look will do with it: a fresh clone, npm ci, npm run verify.
  const fresh = join(w.dir, 'fresh');
  assert.equal(realGit(['clone', '--quiet', '--branch', 'main', w.bare, fresh], w.dir).code, 0);
  const npm = (...args) => spawnSync('npm', args, { cwd: fresh, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, CI: 'true' } });
  for (const args of [['ci', '--no-audit', '--no-fund', '--offline'], ['run', 'verify']]) {
    const r = npm(...args);
    assert.equal(r.status, 0, `npm ${args.join(' ')}:\n${r.stdout}\n${r.stderr}`);
  }
  assert.match(npm('run', 'verify').stdout, /# pass 1/);
  rmSync(join(fresh, 'node_modules'), { recursive: true, force: true });
  const install = npm('install', '--no-audit', '--no-fund', '--offline');
  assert.equal(install.status, 0, install.stderr);
});

test('start takes the Node version from the answers when they name one', async (t) => {
  const { w, go, realGit, seedAnswers, answersFile } = makeWorld(t);
  w.makeEmptyRepo();
  seedAnswers();
  writeFileSync(answersFile, JSON.stringify({ ...JSON.parse(readFileSync(answersFile, 'utf8')), nodeVersion: '>=22.12' }));
  assert.equal(await go(), 0, out(w));
  assert.equal(JSON.parse(realGit(['show', 'main:package.json'], w.bare).out).engines.node, '>=22.12');
  assert.equal(realGit(['show', 'main:.nvmrc'], w.bare).out, '22');
});

test('a repository with any commit: start is skipped and nothing is written to it', async (t) => {
  const { w, go, startDir } = makeWorld(t);
  assert.equal(await go(), 0, out(w));
  assert.match(out(w), /^start\s+already done \(mentor24-maker\/pressplay already has a main branch \(main\)/m);
  assert.ok(!w.calls.some((c) => c.startsWith('git push') || c.startsWith('git init') || c.startsWith('git commit')), 'no commit made, nothing pushed');
  assert.ok(!existsSync(startDir));
});

test('a push GitHub refuses: FAILED at start saying so, nothing after it runs; the rerun makes the commit again and goes on', async (t) => {
  const { w, go, reset, realGit } = makeWorld(t);
  w.makeEmptyRepo();
  w.pushFails = true;
  assert.equal(await go(), 1, out(w));
  assert.match(out(w), /^FAILED: start: git push to mentor24-maker\/pressplay in .* failed: .*\[rejected\]/m);
  assert.ok(!w.calls.some((c) => c.startsWith('git clone')), 'clone did not run');
  assert.ok(!out(w).includes('Done:'));
  w.pushFails = false;
  reset();
  assert.equal(await go(), 0, out(w));
  assert.match(out(w), /^start\s+mentor24-maker\/pressplay's first commit/m);
  assert.equal(realGit(['rev-list', '--count', 'main'], w.bare).out, '1');
});

for (const [what, readBack, seen] of [
  ['still empty', { isEmpty: true, defaultBranchRef: null }, /GitHub reads mentor24-maker\/pressplay back as still empty, not main/],
  ['on another default branch', { isEmpty: false, defaultBranchRef: { name: 'master' } }, /GitHub reads mentor24-maker\/pressplay back as on default branch master, not main/],
]) {
  test(`a push GitHub reads back ${what}: FAILED at start, nothing after it runs; the rerun finds history and skips start`, async (t) => {
    const { w, go, reset } = makeWorld(t);
    w.makeEmptyRepo();
    w.readBack = readBack;
    assert.equal(await go(), 1, out(w));
    assert.match(out(w), new RegExp(`^FAILED: start: pushed, but ${seen.source}`, 'm'));
    assert.ok(!w.calls.some((c) => c.startsWith('git clone')), 'clone did not run');
    // GitHub catches up; the rerun does not push again.
    w.readBack = null;
    reset();
    assert.equal(await go(), 0, out(w));
    assert.match(out(w), /^start\s+already done \(mentor24-maker\/pressplay already has a main branch \(main\)/m);
    assert.ok(!w.calls.some((c) => c.startsWith('git push')));
  });
}

test('GitHub cannot be asked whether the repository is empty: FAILED at start, nothing written, clone not run', async (t) => {
  const { w, go, startDir } = makeWorld(t);
  w.makeEmptyRepo();
  w.viewFails = true;
  assert.equal(await go(), 1, out(w));
  assert.match(out(w), /^FAILED: start: gh repo view mentor24-maker\/pressplay failed: HTTP 502/m);
  assert.ok(!w.calls.some((c) => c.startsWith('git push') || c.startsWith('git clone')));
  assert.ok(!existsSync(startDir));
});

// --- SP-159: a project already running a loop on ClickUp ------------------

const WC_STATUS = (loaded, logDir) => ['loop-build', 'loop-review', 'merge-on-comment'].map((l) => [
  `── ${l}`,
  'schedule: INSTALLED at /Users/d/Library/LaunchAgents/com.pressplay.' + l + '.plist — every 15 minutes',
  loaded ? `loaded:   yes — 2168${l.length} 0 com.pressplay.${l}` : 'loaded:   no',
  '          (columns: PID, last exit code, label. A PID here means the runner is alive right now.)',
  'lock:     none',
  `log:      ${join(logDir, `pressplay-${l}.log`)} (last modified 2026-11-08 23:26)`,
].join('\n')).join('\n');

const CLICKUP_ANSWERS = {
  'Does this project already run a loop on ClickUp': '901422159126',
  'Your own ClickUp user id': '48012725',
  'The old loop\'s ClickUp machine user id': '48099999',
  'Other ClickUp lists to keep': '901400000001',
};

/**
 * The fake world with the project's old loop in its checkout: its own
 * installer, its lanes loaded, and the tracker scripts as doubles. `c.code`
 * sets what a tracker script ends with ({ 'import.mjs --dry-run': 3 }).
 */
function clickupWorld(t) {
  const world = makeWorld(t);
  const { w, checkout, makeCheckout, run } = world;
  makeCheckout();
  mkdirSync(join(checkout, 'scripts'), { recursive: true });
  const installer = join(checkout, 'scripts', 'install_loop_runner.sh');
  writeFileSync(installer, '#!/bin/bash\n# the old loop\'s installer\n');
  const logDir = join(w.dir, 'logs');
  mkdirSync(logDir, { recursive: true });
  const c = { oldLoaded: true, code: {}, uninstallLeaves: false, switchOut: 'switch-check: every check passed. Safe to switch.', calls: [] };
  const fakeRun = (cmd, args, o = {}) => {
    if (cmd === 'bash' && args[0] === installer && !w.lanesLoaded) {
      const line = [cmd, ...args].join(' ');
      w.calls.push(line);
      if (args[1] === '--uninstall') { if (!c.uninstallLeaves) c.oldLoaded = false; return { code: c.code.uninstall ?? 0, out: '', err: '' }; }
      const status = WC_STATUS(c.oldLoaded, logDir);
      // c.noLogFor: a lane whose --status names no log.
      return { code: 0, out: c.noLogFor ? status.replace(new RegExp(`^log: .*pressplay-${c.noLogFor}\\.log.*$\\n?`, 'm'), '') : status, err: '' };
    }
    if (cmd === 'node' && args[0].endsWith('/scripts/with_doppler.mjs')) {
      const script = args[3].split('/').pop();
      const key = [script, ...args.slice(4)].join(' ');
      w.calls.push(`tracker ${key}`);
      c.calls.push({ key, cwd: o.cwd, env: o.env, show: o.show });
      const code = c.code[key] ?? c.code[script] ?? 0;
      return { code, out: script === 'switchCheck.mjs' ? c.switchOut : '', err: '' };
    }
    return run(cmd, args, o);
  };
  const ask = async (q) => {
    if (q.startsWith('Run these now')) { w.runAsked += 1; return w.runAnswer; }
    w.asked.push(q);
    const key = [...Object.keys(DANE_ANSWERS), ...Object.keys(CLICKUP_ANSWERS)].find((k) => q.startsWith(k));
    return key ? (DANE_ANSWERS[key] ?? CLICKUP_ANSWERS[key]) : '';
  };
  const go = (over) => world.go({ run: fakeRun, ask, ...over });
  const homeOpts = (more, over) => world.homeOpts(more, { run: fakeRun, ask, ...over });
  return { ...world, c, go, homeOpts, installer, logDir };
}

const callIndex = (w, text) => w.calls.findIndex((x) => x.includes(text));

test('fromClickup: the installer\'s own --status gives each lane, its label and its log', () => {
  const jobs = readInstallerStatus(WC_STATUS(true, '/l'));
  assert.deepEqual(jobs.map((j) => [j.name, j.loaded, j.label, j.log]), [
    ['loop-build', true, 'com.pressplay.loop-build', '/l/pressplay-loop-build.log'],
    ['loop-review', true, 'com.pressplay.loop-review', '/l/pressplay-loop-review.log'],
    ['merge-on-comment', true, 'com.pressplay.merge-on-comment', '/l/pressplay-merge-on-comment.log'],
  ]);
  assert.ok(readInstallerStatus(WC_STATUS(false, '/l')).every((j) => !j.loaded && j.label === null));
  // Spirality's own wording, where a lane between passes shows no PID.
  const relay = readInstallerStatus('── relay\nloaded:   yes — -\t0\tcom.spirality.relay\nlog:      /x/relay.log (last modified 2026-11-08 23:27)');
  assert.deepEqual([relay[0].label, relay[0].log], ['com.spirality.relay', '/x/relay.log']);
  assert.deepEqual(readInstallerStatus(''), []);
  // A log path with a space in it, and a log not written yet.
  const spaced = readInstallerStatus('── loop-build\nloaded:   yes — 1 0 com.x.loop-build\nlog:      /Users/d/loop logs/x-loop-build.log (last modified 2026-11-08 23:27)\n── loop-review\nloaded:   yes — 2 0 com.x.loop-review\nlog:      /Users/d/loop logs/x-loop-review.log (nothing written yet)');
  assert.deepEqual(spaced.map((j) => j.log), ['/Users/d/loop logs/x-loop-build.log', '/Users/d/loop logs/x-loop-review.log']);
});

test('fromClickup: a START with no END after it is a pass in flight', () => {
  const ended = '===== 2026-11-08 23:26:17 START /loop-build (time limit 7200s) =====\nwork\n===== 2026-11-08 23:26:32 END /loop-build (exit 0) =====\n';
  assert.deepEqual(passInFlight(ended), { running: false, started: '2026-11-08 23:26:17' });
  assert.deepEqual(passInFlight(`${ended}===== 2026-11-08 23:40:00 START /loop-build =====\nworking\n`), { running: true, started: '2026-11-08 23:40:00' });
  assert.equal(passInFlight('no passes here'), null);
  assert.equal(passInFlight(null), null);
});

test('fromClickup: the ClickUp steps go before copy; only a checkout with its own installer and no settings file is an old loop', (t) => {
  assert.deepEqual(withClickupSteps(STEPS), ['answers', 'look', 'start', 'clone', 'settings', 'signins', 'stop', 'snapshot', 'import', 'switch-check', 'copy', 'lanes', 'merge', 'protect']);
  assert.deepEqual(CLICKUP_RUN_STEPS, withClickupSteps(STEPS));
  const have = new Set(['/p/scripts/install_loop_runner.sh']);
  assert.equal(runsOldLoop('/p', (p) => have.has(p)), true);
  have.add('/p/spirality.project.json');
  assert.equal(runsOldLoop('/p', (p) => have.has(p)), false, 'already on Spirality');
  assert.equal(runsOldLoop('/q', (p) => have.has(p)), false, 'no checkout, or no installer');
  assert.deepEqual(snapshotArgs({ clickupExtraLists: ['7', '8'] }, { dryRun: true }), ['--dry-run', '--list', '7', '--list', '8']);
  assert.deepEqual(snapshotArgs({ clickupExtraLists: [] }, { dryRun: false }), []);
  assert.equal(safeToSwitch({ code: 0, out: 'x\nswitch-check: every check passed. Safe to switch.' }), true);
  assert.equal(safeToSwitch({ code: 0, out: 'switch-check: NOT SAFE TO SWITCH yet' }), false);
  assert.equal(safeToSwitch({ code: 1, out: 'Safe to switch.' }), false);
});

test('a project already on ClickUp: one more question, then stop, snapshot, import and switch-check before the copy, and the copy replaces the old one', async (t) => {
  const { w, c, go, answersFile, logFile, statePath, installer } = clickupWorld(t);
  const code = await go();
  // The run as Dane sees it, for the pull request.
  if (process.env.SHOW_WIZARD_RUN) console.log(out(w));
  assert.equal(code, 0, out(w));
  assert.equal(w.asked.length, DANE_FIELDS.length + 4, 'his answers, then the four ClickUp ones');
  const answers = JSON.parse(readFileSync(answersFile, 'utf8'));
  assert.equal(answers.clickupListId, '901422159126');
  assert.equal(answers.clickupOperatorId, '48012725');
  assert.equal(answers.clickupMachineUserId, '48099999');
  assert.deepEqual(answers.clickupExtraLists, ['901400000001']);
  // The order the runbook needs, all before the copy's pull request exists.
  const order = [
    `${installer} --status`, 'tracker clickupSnapshot.mjs --dry-run --list 901400000001', `${installer} --uninstall`,
    'tracker clickupSnapshot.mjs --list 901400000001',
    'tracker import.mjs --db', 'tracker switchCheck.mjs', 'onboard:copy', 'onboard:lanes',
  ].map((x) => callIndex(w, x));
  assert.ok(order.every((i) => i >= 0), `every step ran: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'in order');
  const db = join(w.homeConfig.trackerDataDir, 'tracker.db');
  assert.equal(w.calls.filter((x) => x.startsWith('tracker clickupSnapshot.mjs --dry-run')).length, 1, 'the snapshot\'s dry run once, before the stop');
  const imports = w.calls.filter((x) => x.startsWith('tracker import.mjs'));
  assert.deepEqual(imports, [`tracker import.mjs --db ${db} --dry-run`, `tracker import.mjs --db ${db}`], 'a dry run, then the real one');
  assert.match(w.calls[callIndex(w, 'onboard:copy')], /--allow-replace/);
  // The tracker scripts read the switch settings file, in its own folder.
  const switchFolder = join(w.homeConfig.logDir, 'onboard', 'pressplay-switch');
  assert.ok(c.calls.every((x) => x.cwd === switchFolder));
  const sw = JSON.parse(readFileSync(join(switchFolder, 'spirality.project.json'), 'utf8'));
  assert.equal(sw.loopQueueListId, '901422159126');
  assert.equal(sw.operatorUserId, '48012725');
  assert.equal(sw.machineUserId, '48099999', 'the old loop\'s ClickUp seat, which the importer files its comments under');
  assert.equal(sw.trackerDataDir, w.homeConfig.trackerDataDir);
  assert.equal(sw.projectSlug, 'pressplay');
  assert.equal(c.calls.find((x) => x.key.startsWith('switchCheck')).env.TRACKER_DB, db);
  assert.match(out(w), /^stop\s+stopped com\.pressplay\.loop-build, com\.pressplay\.loop-review, com\.pressplay\.merge-on-comment/m);
  assert.match(out(w), /^switch-check tracker:switch-check: Safe to switch\./m);
  const log = readFileSync(logFile, 'utf8');
  for (const step of ['stop', 'snapshot', 'import', 'switch-check']) assert.match(log, new RegExp(`\\| ${step} \\| done \\|`), step);
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.deepEqual(state.steps.map((s) => s.step), CLICKUP_RUN_STEPS);
  assert.equal(state.finished, true);
});

test('a project on ClickUp, rerun once done: every step already done, nothing stopped, saved or imported again', async (t) => {
  const { w, go, reset } = clickupWorld(t);
  assert.equal(await go(), 0, out(w));
  reset();
  assert.equal(await go(), 0, out(w));
  assert.equal(w.asked.length, 0);
  for (const step of CLICKUP_RUN_STEPS) assert.match(out(w), new RegExp(`^${step}\\s+already done`, 'm'), step);
  assert.ok(!w.calls.some((x) => x.startsWith('tracker ') || x.includes('--uninstall')));
});

// A failure at each ClickUp step, then a rerun that resumes there.
const CLICKUP_FAILS = {
  stop: (c) => { c.code.uninstall = 1; },
  snapshot: (c) => { c.code['clickupSnapshot.mjs --list 901400000001'] = 3; },
  import: (c) => { c.code['import.mjs'] = 1; },
  'switch-check': (c) => { c.switchOut = 'queues match: NOT OK\nswitch-check: NOT SAFE TO SWITCH yet (see NOT OK above).'; c.code['switchCheck.mjs'] = 1; },
};
const CLICKUP_LATER = { snapshot: 'tracker clickupSnapshot.mjs --list', // the real one; its dry run goes before the stop
  import: 'tracker import.mjs', 'switch-check': 'tracker switchCheck.mjs', copy: 'onboard:copy', lanes: 'onboard:lanes' };
for (const failing of Object.keys(CLICKUP_FAILS)) {
  test(`a project on ClickUp, failure at ${failing}: FAILED, nothing after it runs, and the rerun resumes there`, async (t) => {
    const { w, c, go, reset } = clickupWorld(t);
    CLICKUP_FAILS[failing](c);
    assert.equal(await go(), 1, out(w));
    assert.match(out(w), new RegExp(`^FAILED: ${failing}: `, 'm'));
    assert.match(out(w), /^ {2}npm run onboard -- --project pressplay$/m);
    for (const step of CLICKUP_RUN_STEPS.slice(CLICKUP_RUN_STEPS.indexOf(failing) + 1)) {
      if (CLICKUP_LATER[step]) assert.ok(!w.calls.some((x) => x.includes(CLICKUP_LATER[step])), `${step} did not run`);
    }
    assert.ok(!out(w).includes('Done:'));
    c.code = {};
    c.switchOut = 'switch-check: every check passed. Safe to switch.';
    reset();
    assert.equal(await go(), 0, out(w));
    assert.equal(w.asked.length, 0, 'nothing asked twice');
    // The import, once done, still runs again until switch-check has said
    // Safe to switch (its NOT OK lines mean "import again").
    const again = failing === 'switch-check' ? ['import', failing] : [failing];
    for (const step of CLICKUP_RUN_STEPS.slice(0, CLICKUP_RUN_STEPS.indexOf(failing))) {
      if (!again.includes(step)) assert.match(out(w), new RegExp(`^${step}\\s+already done`, 'm'), step);
    }
    for (const step of again) assert.ok(!new RegExp(`^${step}\\s+already done`, 'm').test(out(w)), `${step} runs again`);
  });
}

test('a project on ClickUp, switch-check says NOT YET IMPORTED once: the rerun imports again, then it is Safe to switch', async (t) => {
  const { w, c, go, reset, logFile } = clickupWorld(t);
  c.switchOut = 'NOT YET IMPORTED: 901422159126 abc123 changed after the import. Run the real import again.\nswitch-check: NOT SAFE TO SWITCH yet (see NOT OK above).';
  c.code['switchCheck.mjs'] = 1;
  assert.equal(await go(), 1, out(w));
  assert.match(out(w), /^FAILED: switch-check: /m);
  assert.match(readFileSync(logFile, 'utf8'), /\| import \| done \|/, 'the import was logged done');
  c.code = {};
  c.switchOut = 'switch-check: every check passed. Safe to switch.';
  reset();
  assert.equal(await go(), 0, out(w));
  assert.match(out(w), /^import\s+imported before, but switch-check has not said Safe to switch yet, so the import runs again/m);
  const db = join(w.homeConfig.trackerDataDir, 'tracker.db');
  const order = [`tracker import.mjs --db ${db} --dry-run`, `tracker import.mjs --db ${db}`, 'tracker switchCheck.mjs', 'onboard:copy'].map((x) => w.calls.indexOf(w.calls.find((y) => y === x || (x.endsWith('.mjs') || x.startsWith('onboard')) && y.includes(x))));
  assert.ok(order.every((i) => i >= 0), `each ran on the rerun: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'import, then switch-check, then the copy');
  assert.match(out(w), /^snapshot\s+already done/m, 'the snapshot is not taken again');
  // Once Safe to switch, a third run skips the import too.
  reset();
  assert.equal(await go(), 0, out(w));
  assert.match(out(w), /^import\s+already done/m);
  assert.ok(!w.calls.some((x) => x.startsWith('tracker ')));
});

test('a project on ClickUp whose snapshot dry run fails: FAILED at stop before anything is stopped, the old lanes keep running', async (t) => {
  const { w, c, go } = clickupWorld(t);
  c.code['clickupSnapshot.mjs --dry-run --list 901400000001'] = 1;
  assert.equal(await go(), 1, out(w));
  assert.match(out(w), /^FAILED: stop: the snapshot's dry run ended with exit 1 .*so the old lanes were left running/m);
  assert.ok(!w.calls.some((x) => x.includes('--uninstall')), 'nothing was stopped');
  assert.equal(c.oldLoaded, true);
});

test('a project on ClickUp with a pass in flight: FAILED at stop, nothing is stopped', async (t) => {
  const { w, go, logDir } = clickupWorld(t);
  writeFileSync(join(logDir, 'pressplay-loop-review.log'), '===== 2026-11-08 23:40:00 START /loop-review =====\nworking\n');
  assert.equal(await go(), 1, out(w));
  assert.match(out(w), /^FAILED: stop: a loop-review pass is in flight \(started 2026-11-08 23:40:00/m);
  assert.ok(!w.calls.some((x) => x.includes('--uninstall') || x.startsWith('tracker ')));
});

test('a loaded lane whose --status names no log: FAILED at stop, it cannot be checked, nothing is stopped', async (t) => {
  const { w, c, go } = clickupWorld(t);
  c.noLogFor = 'loop-review';
  assert.equal(await go(), 1, out(w));
  assert.match(out(w), /^FAILED: stop: loop-review is loaded, but .* --status names no log for it, so whether a pass is in flight cannot be checked\. Nothing was stopped/m);
  assert.ok(!/no pass is in flight/.test(out(w)));
  assert.ok(!w.calls.some((x) => x.includes('--uninstall') || x.startsWith('tracker ')));
});

test('uninstall that leaves a lane loaded: FAILED at stop, naming it', async (t) => {
  const { w, c, go } = clickupWorld(t);
  c.uninstallLeaves = true;
  assert.equal(await go(), 1, out(w));
  assert.match(out(w), /^FAILED: stop: after .* --uninstall these are still loaded: com\.pressplay\.loop-build/m);
});

test('an old loop that is not on ClickUp: "no" is kept, asked once, and the run is a new project\'s', async (t) => {
  const { w, go, reset, answersFile, statePath } = clickupWorld(t);
  const no = async (q) => { w.asked.push(q); if (q.startsWith('Run these now')) return 'y'; if (q.startsWith('Does this project')) return ''; const k = Object.keys(DANE_ANSWERS).find((x) => q.startsWith(x)); return k ? DANE_ANSWERS[k] : ''; };
  assert.equal(await go({ ask: no }), 0, out(w));
  assert.equal(JSON.parse(readFileSync(answersFile, 'utf8')).clickupListId, null);
  assert.equal(w.asked.filter((q) => q.startsWith('Your own ClickUp')).length, 0, 'no seat asked without a list');
  assert.deepEqual(JSON.parse(readFileSync(statePath, 'utf8')).steps.map((s) => s.step), STEPS);
  assert.ok(!w.calls.some((x) => x.includes('--uninstall') || x.startsWith('tracker ')));
  assert.ok(!/--allow-replace/.test(w.calls[callIndex(w, 'onboard:copy')]));
  reset();
  assert.equal(await go({ ask: no }), 0, out(w));
  assert.equal(w.asked.length, 0, 'not asked again');
});

test('an old loop under --no-prompt with no ClickUp answer: STOPPED at answers, naming the field', async (t) => {
  const { w, homeOpts, seedAnswers } = clickupWorld(t);
  seedAnswers();
  assert.equal(await homeOpts({ noPrompt: true }), 3, out(w));
  assert.match(out(w), /^STOPPED: answers: .*already runs a loop of its own.*Fill them in on its setup page's answers form/m);
  assert.doesNotMatch(out(w), /Write "clickupListId"/, 'nobody is told to edit a JSON file');
});

test('the ClickUp answers: digits, the seat required with a list, and none without one', () => {
  const homeConfig = validateProjectConfig({
    workspaceId: '0', spaceId: '0', loopQueueListId: '0', operatorUserId: '1', machineUserId: '2',
    githubRepo: 'mentor24-maker/spirality', dopplerProject: 'spirality', dopplerConfig: 'dev', launchdPrefix: 'com.spirality',
    logDir: '/tmp/logs', mergePhrases: ['merge'], governancePaths: ['CLAUDE.md'], autoMergeLanes: [],
    operatorName: 'Dane', projectSlug: 'spirality', legacyMachinePrefixes: [], projectScripts: {}, trackerPrefix: 'SP',
    trackerPort: 4180, trackerHost: '0.0.0.0', trackerDataDir: '/tmp/tracker', tracker: 'api', trackerUrl: 'http://mac-mini.local:4180',
  });
  const base = { projectName: 'WaveCenter', githubRepo: 'mentor24-maker/wavecenter', description: 'x.' };
  const r = (more) => resolveAnswers({ ...base, ...more }, { homeConfig, homeRoot: '/w/spirality' });
  assert.deepEqual([r({}).clickupListId, r({}).clickupOperatorId, r({}).clickupExtraLists], [null, null, []]);
  const on = r({ clickupListId: '901422159126', clickupOperatorId: '48012725', clickupMachineUserId: '48099999', clickupExtraLists: ['901400000001'] });
  assert.deepEqual([on.clickupListId, on.clickupOperatorId, on.clickupMachineUserId, [...on.clickupExtraLists]], ['901422159126', '48012725', '48099999', ['901400000001']]);
  assert.equal(r({}).clickupMachineUserId, null);
  assert.throws(() => r({ clickupListId: '901422159126', clickupMachineUserId: '9' }), /"clickupOperatorId" is missing/);
  assert.throws(() => r({ clickupListId: '901422159126', clickupOperatorId: '1' }), /"clickupMachineUserId" is missing/);
  assert.throws(() => r({ clickupListId: '7', clickupOperatorId: '1', clickupMachineUserId: '1' }), /"clickupMachineUserId" is the same as "clickupOperatorId"/);
  assert.throws(() => r({ clickupListId: '7', clickupOperatorId: '1', clickupMachineUserId: 'x' }), /"clickupMachineUserId" must be a ClickUp id/);
  assert.throws(() => r({ clickupListId: 'abc', clickupOperatorId: '1', clickupMachineUserId: '9' }), /"clickupListId" must be a ClickUp id/);
  assert.throws(() => r({ clickupListId: '0', clickupOperatorId: '1', clickupMachineUserId: '9' }), /not all zeros/);
  assert.throws(() => r({ clickupOperatorId: '1' }), /"clickupListId" is missing/);
  assert.throws(() => r({ clickupMachineUserId: '9' }), /"clickupListId" is missing/);
  assert.throws(() => r({ clickupListId: '5', clickupOperatorId: '1', clickupMachineUserId: '9', clickupExtraLists: ['5'] }), /names the Loop Queue list 5 itself/);
});

test('the setup page reads a ClickUp project\'s state file, its four extra steps included', async (t) => {
  const { readState } = await import('../../tracker/setup.mjs');
  const { w, go } = clickupWorld(t);
  assert.equal(await go(), 0, out(w));
  const { state, error } = readState(w.homeConfig, 'pressplay');
  assert.equal(error, null);
  assert.deepEqual(state.steps.map((s) => s.step), CLICKUP_RUN_STEPS);
});
