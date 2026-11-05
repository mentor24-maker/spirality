import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateProjectConfig } from './projectConfig.mjs';
import {
  ANSWER_FIELDS, AnswersError, answersFile, loadAnswers, nodeMeets, parseNodeNeed,
  resolveAnswers, settingsDraft, slugFromName,
} from './onboardAnswers.mjs';

// The tracker home's settings file, as Spirality's reads today.
const homeConfig = validateProjectConfig({
  workspaceId: '90141423066', spaceId: '90146476540', loopQueueListId: '901418065068',
  operatorUserId: '1', machineUserId: '2', githubRepo: 'mentor24-maker/spirality',
  dopplerProject: 'spirality', dopplerConfig: 'dev', launchdPrefix: 'com.spirality', logDir: '~/loop-logs',
  mergePhrases: ['merge', 'merge it', 'ship it', 'approve'],
  governancePaths: ['CLAUDE.md', 'docs/LOOP_ENGINEERING.md', '.claude/skills/', '.claude/settings.json', '.github/workflows/'],
  autoMergeLanes: [], operatorName: 'Dane', productSlug: 'spirality', legacyMachinePrefixes: [], productScripts: {},
  trackerPrefix: 'SP', trackerPort: 4180, trackerHost: '0.0.0.0', trackerDataDir: '~/spirality-tracker',
  tracker: 'api', trackerUrl: 'http://mac-mini.local:4180', trackerApiUrl: 'http://127.0.0.1:4180',
});
const homeRoot = '/Users/dane/WebApps/spirality';
const opts = { homeConfig, homeRoot, file: 'normie.answers.json' };

// Normie's real values (SETUP_REVIEW.md part 3, "What a person enters").
const normie = {
  productName: 'Normie',
  githubRepo: 'mentor24-maker/normie',
  productSlug: 'normie',
  trackerPrefix: 'NO',
  dopplerProject: 'normie',
  dopplerConfig: 'dev',
  launchdPrefix: 'com.normie',
  checkoutDir: '~/WebApps/normie',
  checkCommand: 'npm run verify:full',
  nodeVersion: '22',
  mergePhrases: ['merge', 'merge it', 'ship it', 'approve'],
  autoMergeLanes: [],
  extraGovernancePaths: ['.cursorrules'],
  hosting: 'Vercel (preview check on every pull request)',
  description: 'Normie is a Next.js app on Vercel: public personality polls, a page builder, a player portal and an admin control room.',
};

test("Normie's real answers pass, every field kept as written", () => {
  const a = resolveAnswers(normie, opts);
  for (const key of ANSWER_FIELDS) assert.deepEqual(a[key], normie[key], key);
  assert.ok(Object.isFrozen(a));
});

test("the settings file Normie's answers make matches Normie's real one, but for the ids found later", () => {
  const draft = settingsDraft(resolveAnswers(normie, opts), homeConfig);
  assert.deepEqual(draft.governancePaths, [...homeConfig.governancePaths, '.cursorrules']);
  assert.equal(draft.githubRepo, 'mentor24-maker/normie');
  assert.equal(draft.trackerPrefix, 'NO');
  assert.equal(draft.tracker, 'api');
  assert.equal(draft.trackerUrl, 'http://mac-mini.local:4180');
  assert.equal(draft.trackerApiUrl, 'http://127.0.0.1:4180');
  assert.equal(draft.trackerPort, undefined, 'only the tracker home runs the tracker');
  assert.doesNotThrow(() => validateProjectConfig(draft));
});

test('only the decisions need writing: every other field defaults from the slug or the tracker home', () => {
  const a = resolveAnswers({ productName: 'PressPlay', githubRepo: 'mentor24-maker/pressplay', description: 'An app.' }, opts);
  assert.equal(a.productSlug, 'pressplay');
  assert.equal(a.trackerPrefix, 'PR');
  assert.equal(a.dopplerProject, 'pressplay');
  assert.equal(a.dopplerConfig, 'dev');
  assert.equal(a.launchdPrefix, 'com.pressplay');
  assert.equal(a.checkoutDir, '/Users/dane/WebApps/pressplay');
  assert.equal(a.checkCommand, 'npm run verify');
  assert.equal(a.nodeVersion, null);
  assert.deepEqual(a.mergePhrases, homeConfig.mergePhrases);
  assert.deepEqual(a.autoMergeLanes, []);
  assert.deepEqual(a.extraGovernancePaths, []);
  assert.equal(a.hosting, null);
});

test('a name with spaces and marks makes a dashed slug', () => {
  assert.equal(slugFromName('Press Play!'), 'press-play');
  assert.equal(slugFromName('  WaveCenter '), 'wavecenter');
});

test('a missing decision is refused, naming the field', () => {
  for (const key of ['productName', 'githubRepo', 'description']) {
    const raw = { ...normie };
    delete raw[key];
    assert.throws(() => resolveAnswers(raw, opts), (err) => err instanceof AnswersError && err.message.includes(`"${key}" is missing`), key);
  }
});

test('a malformed field is refused, naming it', () => {
  const bad = {
    productName: 7,
    githubRepo: 'normie',
    productSlug: 'Normie',
    trackerPrefix: 'no',
    dopplerConfig: '',
    launchdPrefix: ['com.normie'],
    checkoutDir: '   ',
    checkCommand: false,
    nodeVersion: 'lts/*',
    mergePhrases: ['.'],
    autoMergeLanes: 'loop-build',
    extraGovernancePaths: [''],
    hosting: 3,
    description: '',
  };
  // A range written with a space after its operator, as npm accepts, is not refused.
  assert.equal(resolveAnswers({ ...normie, nodeVersion: '>= 22.12' }, opts).nodeVersion, '>= 22.12');
  for (const [key, value] of Object.entries(bad)) {
    assert.throws(
      () => resolveAnswers({ ...normie, [key]: value }, opts),
      (err) => err instanceof AnswersError && err.message.includes(`"${key}"`) && err.message.includes('normie.answers.json'),
      key,
    );
  }
});

test('an empty merge-phrase list is refused: the operator could never say merge', () => {
  assert.throws(() => resolveAnswers({ ...normie, mergePhrases: [] }, opts), /"mergePhrases" must list at least one entry/);
});

test('an unknown field is refused, naming it, so a typo is never a silent default', () => {
  assert.throws(() => resolveAnswers({ ...normie, githubrepo: 'x/y' }, opts), /unknown field "githubrepo"/);
});

test("the tracker home's own slug is refused", () => {
  assert.throws(() => resolveAnswers({ ...normie, productSlug: 'spirality' }, opts), /"productSlug" is "spirality", the tracker home's own slug/);
});

test('a product needs the settings file of the product that runs the tracker', () => {
  const guest = { ...homeConfig, trackerPort: null };
  assert.throws(() => resolveAnswers(normie, { ...opts, homeConfig: guest }), /tracker home's settings file is needed/);
});

test('the answers file is kept in the tracker home\'s log folder, outside the repository', () => {
  assert.equal(answersFile(homeConfig, 'normie', '/Users/dane'), '/Users/dane/loop-logs/onboard/normie.answers.json');
});

test('loadAnswers names the file when it is missing or not JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'answers-'));
  try {
    assert.throws(() => loadAnswers(join(dir, 'none.json'), opts), /none\.json: could not be read \(ENOENT\)/);
    writeFileSync(join(dir, 'bad.json'), '{ nope');
    assert.throws(() => loadAnswers(join(dir, 'bad.json'), opts), /bad\.json: is not valid JSON/);
    writeFileSync(join(dir, 'normie.json'), JSON.stringify(normie));
    assert.equal(loadAnswers(join(dir, 'normie.json'), opts).productSlug, 'normie');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a Node need is read as .nvmrc or engines.node writes it', () => {
  const ok = (need, version) => nodeMeets(version, parseNodeNeed(need));
  assert.equal(ok('22', 'v22.23.3'), true);
  assert.equal(ok('22', 'v24.1.0'), false);
  assert.equal(ok('v22.12.0', 'v22.11.9'), false);
  assert.equal(ok('>=22.12', 'v22.23.3'), true);
  assert.equal(ok('>=22.12', 'v24.0.0'), true);
  assert.equal(ok('>=22.12', 'v20.18.0'), false);
  assert.equal(ok('>=22 <23', 'v22.0.0'), true);
  assert.equal(ok('>=22 <23', 'v23.0.0'), false);
  assert.equal(ok('^20.9', 'v20.10.0'), true);
  assert.equal(ok('22.x', 'v22.1.0'), true);
  // Partial versions after an operator, read the way npm reads them (SP-108 review).
  assert.equal(ok('>=20 <=22', 'v22.5.0'), true, '<=22 is anything below 23.0.0');
  assert.equal(ok('>=20 <=22', 'v23.0.0'), false);
  assert.equal(ok('<=22.12', 'v22.12.9'), true);
  assert.equal(ok('<=22.12', 'v22.13.0'), false);
  assert.equal(ok('<=22.12.3', 'v22.12.3'), true);
  assert.equal(ok('<=22.12.3', 'v22.12.4'), false);
  assert.equal(ok('>22', 'v22.12.0'), false, '>22 is 23.0.0 or later');
  assert.equal(ok('>22', 'v23.0.0'), true);
  assert.equal(ok('>22.12', 'v22.12.9'), false);
  assert.equal(ok('>22.12', 'v22.13.0'), true);
  assert.equal(ok('>22.12.0', 'v22.12.1'), true);
  assert.equal(ok('~22.12', 'v22.20.0'), false, 'tilde allows patch updates only');
  assert.equal(ok('~22.12', 'v22.12.7'), true);
  assert.equal(ok('~22.12.3', 'v22.12.2'), false);
  assert.equal(ok('~22.12.3', 'v22.13.0'), false);
  assert.equal(ok('~22', 'v22.20.0'), true);
  assert.equal(ok('~22', 'v23.0.0'), false);
  assert.equal(ok('^22.12', 'v22.20.0'), true);
  assert.equal(ok('^22.12', 'v23.0.0'), false);
  // A Node version this cannot read (a prerelease) is "could not tell", never a verdict.
  assert.equal(nodeMeets('v23.0.0-rc.1', parseNodeNeed('>=22')), null);
  assert.equal(parseNodeNeed('>=23.0.0-rc.1'), null);
  assert.equal(parseNodeNeed('20 - 22'), null);
  // npm accepts a space between an operator and its version.
  assert.equal(ok('>= 22.12', 'v22.12.0'), true);
  assert.equal(ok('>= 22.12', 'v22.11.9'), false);
  assert.equal(ok('>= 20  < 23', 'v22.5.0'), true);
  assert.equal(ok('>= 20 < 23', 'v23.0.0'), false);
  assert.equal(ok('~ 22.12', 'v22.20.0'), false);
  assert.equal(parseNodeNeed('lts/*'), null);
  assert.equal(parseNodeNeed('18 || 20'), null);
  assert.equal(parseNodeNeed(''), null);
});
