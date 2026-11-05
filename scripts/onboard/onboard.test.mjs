import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { validateProjectConfig } from '../../lib/projectConfig.mjs';
import { settingsDraft, resolveAnswers } from '../../lib/onboardAnswers.mjs';
import {
  DANE_FIELDS, STEPS, answerValue, fieldNamed, loggedDone, mainVerifyVerdict, mountainStamp, onboard,
  parseOnboardArgs, pasteBlock, protectionGaps, protectionRequest, shellQuote, unanswered,
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
  assert.deepEqual(parseOnboardArgs(['--product', 'pressplay']).opts, { product: 'pressplay', allowReplace: false, mergeWaitMinutes: 60 });
  assert.equal(parseOnboardArgs(['--product', 'pressplay', '--allow-replace', '--merge-wait-minutes', '5']).opts.mergeWaitMinutes, 5);
  assert.match(parseOnboardArgs([]).error, /--product/);
  assert.match(parseOnboardArgs(['--product', 'Press Play']).error, /not a slug/);
  assert.match(parseOnboardArgs(['--product', 'x', '--merge-wait-minutes', '0']).error, /greater than 0/);
  assert.match(parseOnboardArgs(['--product', 'x', '--nope']).error, /unknown/);
});

// --- The wizard, against a fake world ------------------------------------

const PR = 'https://github.com/mentor24-maker/pressplay/pull/1';
const DANE_ANSWERS = {
  'Product name': 'PressPlay',
  'GitHub repository': 'mentor24-maker/pressplay',
  'Ticket prefix': 'PP',
  'Merge phrases': '',
  'Lanes that may merge': 'none',
  'Extra protected files': '',
  'What the product is': 'PressPlay plays things.',
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
  const checkout = join(dir, 'WebApps', 'pressplay');
  mkdirSync(join(checkout, '.git'), { recursive: true });
  writeFileSync(join(checkout, '.git', 'HEAD'), 'ref: refs/heads/main\n');

  // What the world is like; a test sets `fail` to the step that breaks.
  const w = {
    dir, homeConfig, homeRoot, checkout, fail: null,
    signinsMade: false, prOpen: false, ticket: null, lanesLoaded: false, merged: false,
    protection: null, mergeAfterPolls: 1, polls: 0, dopplerProject: false,
    calls: [], asked: [], paused: 0, printed: [],
  };
  const settingsFile = join(homeConfig.logDir, 'onboard', 'pressplay-settings', 'spirality.project.json');
  const answersPath = join(homeConfig.logDir, 'onboard', 'pressplay.answers.json');
  const settings = (machineUserId) => {
    const answers = resolveAnswers(JSON.parse(readFileSync(answersPath, 'utf8')), { homeConfig, homeRoot });
    return { ...settingsDraft(answers, homeConfig), operatorUserId: '1', machineUserId };
  };
  const ok = (out = '') => ({ code: 0, out, err: '' });
  const no = (err = 'no', code = 1) => ({ code, out: '', err });
  const breaks = (step) => w.fail === step;

  const run = (cmd, args) => {
    const line = [cmd, ...args].join(' ');
    w.calls.push(line);
    if (cmd === 'git') {
      if (args[0] === 'fetch') return ok();
      if (args[0] === 'show') return w.merged ? ok(JSON.stringify(settings('9'))) : no('fatal: path does not exist', 128);
      if (args[0] === 'merge-base') return w.merged ? ok() : no();
      if (args[0] === 'rev-parse') return ok('abc1234def');
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
        return ok();
      }
      if (script === 'onboard:lanes') {
        if (breaks('lanes')) return no();
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
    readText: (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } },
    writeText: (p, text) => writeFileSync(p, text),
    appendText: (p, text) => { mkdirSync(dirname(p), { recursive: true }); appendFileSync(p, text); },
    mkdir: (d) => mkdirSync(d, { recursive: true }),
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    ...over,
  });
  const opts = { product: 'pressplay', allowReplace: false, mergeWaitMinutes: 60 };
  const go = (over) => onboard(opts, deps(over));
  const reset = () => { w.calls = []; w.asked = []; w.paused = 0; w.printed = []; w.polls = 0; };
  const answersFile = answersPath;
  // The answers in place, written as the wizard would, with a checkout path in this scratch folder.
  const seedAnswers = () => {
    mkdirSync(dirname(answersPath), { recursive: true });
    writeFileSync(answersPath, JSON.stringify({ productSlug: 'pressplay', productName: 'PressPlay', githubRepo: 'mentor24-maker/pressplay', trackerPrefix: 'PP', mergePhrases: null, autoMergeLanes: [], extraGovernancePaths: null, description: 'PressPlay plays things.', checkoutDir: checkout }));
  };
  return { w, go, run, reset, answersFile, settingsFile, seedAnswers, logFile: join(homeConfig.logDir, 'pressplay-onboard.log') };
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

test('a product already set up (its settings on main, main protected) with an answers file: every step already done, nothing asked', async (t) => {
  const { w, go, seedAnswers } = makeWorld(t);
  seedAnswers();
  w.merged = true;
  w.protection = GOOD_PROTECTION;
  assert.equal(await go(), 0, out(w));
  assert.equal(w.asked.length, 0);
  for (const step of STEPS) assert.match(out(w), new RegExp(`^${step}\\s+already done`, 'm'), step);
});

// A failure at each step, then a rerun that resumes there.
const LATER = { look: 'onboard:look', settings: 'onboard:settings write', copy: 'onboard:copy', lanes: 'onboard:lanes', protect: '-X PUT' };
for (const failing of ['look', 'settings', 'copy', 'lanes', 'protect']) {
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
