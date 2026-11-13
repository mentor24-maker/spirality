import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProjectConfig, MANIFEST_VERSION } from './projectConfig.mjs';
import { resolveAnswers } from './onboardAnswers.mjs';
import {
  MACHINE_PLACEHOLDER, SettingsError, actorNamed, fieldsThatDiffer, machineUserPending,
  settingsFromAnswers, settingsText, withMachineUser,
} from './onboardSettings.mjs';

// The tracker home's settings file, as Spirality's reads today.
const homeConfig = validateProjectConfig({
  manifestVersion: 1, workspaceId: '90141423066', spaceId: '90146476540', loopQueueListId: '901418065068',
  operatorUserId: '1', machineUserId: '2', githubRepo: 'mentor24-maker/spirality',
  dopplerProject: 'spirality', dopplerConfig: 'dev', launchdPrefix: 'com.spirality', logDir: '~/loop-logs',
  mergePhrases: ['merge', 'merge it', 'ship it', 'approve'],
  governancePaths: ['CLAUDE.md', 'docs/LOOP_ENGINEERING.md', '.claude/skills/', '.claude/settings.json', '.github/workflows/'],
  autoMergeLanes: [], operatorName: 'Dane', projectSlug: 'spirality', legacyMachinePrefixes: [], projectScripts: {},
  trackerPrefix: 'SP', trackerPort: 4180, trackerHost: '0.0.0.0', trackerDataDir: '~/spirality-tracker',
  tracker: 'api', trackerUrl: 'http://mac-mini.local:4180', trackerApiUrl: 'http://127.0.0.1:4180',
});
const homeRoot = '/Users/dane/WebApps/spirality';

// Normie's answers file (~/loop-logs/onboard/normie.answers.json).
const normieAnswers = resolveAnswers({
  projectName: 'Normie',
  githubRepo: 'mentor24-maker/normie',
  projectSlug: 'normie',
  trackerPrefix: 'NO',
  dopplerProject: 'normie',
  dopplerConfig: 'dev',
  launchdPrefix: 'com.normie',
  checkoutDir: '~/WebApps/normie',
  checkCommand: 'npm run verify:full',
  mergePhrases: ['merge', 'merge it', 'ship it', 'approve'],
  autoMergeLanes: [],
  extraGovernancePaths: ['.cursorrules'],
  hosting: 'Vercel (preview check on every pull request)',
  description: 'Normie is a Next.js app on Vercel: public personality polls, a visual page builder, a player portal and a protected admin control room.',
}, { homeConfig, homeRoot });

// Normie's committed spirality.project.json, written by hand in NO-3, byte for
// byte, plus the "manifestVersion" line the wizard writes since SP-262.
const NORMIE_COMMITTED = `{
  "manifestVersion": 1,
  "workspaceId": "0",
  "spaceId": "0",
  "loopQueueListId": "0",
  "operatorUserId": "1",
  "machineUserId": "8",
  "githubRepo": "mentor24-maker/normie",
  "dopplerProject": "normie",
  "dopplerConfig": "dev",
  "launchdPrefix": "com.normie",
  "logDir": "~/loop-logs",
  "mergePhrases": [
    "merge",
    "merge it",
    "ship it",
    "approve"
  ],
  "governancePaths": [
    "CLAUDE.md",
    ".cursorrules",
    "docs/LOOP_ENGINEERING.md",
    ".claude/skills/",
    ".claude/settings.json",
    ".github/workflows/"
  ],
  "autoMergeLanes": [],
  "operatorName": "Dane",
  "projectSlug": "normie",
  "legacyMachinePrefixes": [],
  "projectScripts": {},
  "trackerPrefix": "NO",
  "tracker": "api",
  "trackerUrl": "http://mac-mini.local:4180",
  "trackerApiUrl": "http://127.0.0.1:4180"
}
`;

test("Normie's answers make Normie's committed settings file, but for the fields set by hand on purpose", () => {
  const made = settingsFromAnswers(normieAnswers, homeConfig, { operatorUserId: '1', machineUserId: '8' });
  const committed = JSON.parse(NORMIE_COMMITTED);
  // Set by hand on purpose, and only these:
  //   governancePaths  NO-3 put ".cursorrules" second, beside CLAUDE.md, its
  //                    sibling guide; the generator adds a project's extra
  //                    paths after the tracker home's. Same entries, and the
  //                    order means nothing to the loops (a set of paths).
  const BY_HAND = ['governancePaths'];
  assert.deepEqual(fieldsThatDiffer(committed, made), BY_HAND);
  assert.deepEqual([...made.governancePaths].sort(), [...committed.governancePaths].sort());
  // Same keys, in the same order, as the hand-written file.
  assert.deepEqual(Object.keys(made), Object.keys(committed));
  // With the one by-hand order put back, the text is Normie's byte for byte.
  assert.equal(settingsText({ ...made, governancePaths: committed.governancePaths }), NORMIE_COMMITTED);
});

test('the made settings pass the reader every loop uses, as a guest project (no tracker service)', () => {
  const made = settingsFromAnswers(normieAnswers, homeConfig, { operatorUserId: '1', machineUserId: '8' });
  const checked = validateProjectConfig(made);
  assert.equal(checked.trackerPort, null);
  assert.equal(checked.tracker, 'api');
  assert.equal(checked.trackerApiUrl, homeConfig.trackerApiUrl);
  assert.equal(checked.logDir, homeConfig.logDir);
  assert.equal(Object.hasOwn(made, 'trackerPort'), false);
  assert.equal(Object.hasOwn(made, 'trackerDataDir'), false);
  assert.equal(Object.hasOwn(made, 'trackerHost'), false);
});

test('every value comes from the answers or the tracker home, none from the code', () => {
  const otherHome = validateProjectConfig({
    ...homeConfig, logDir: '/srv/logs', operatorName: 'Robin', trackerUrl: 'https://tracker.example', trackerApiUrl: 'https://tracker.example',
    governancePaths: ['AGENTS.md'], mergePhrases: ['ship'],
  });
  const answers = resolveAnswers({ projectName: 'Press Play', githubRepo: 'someone/pressplay', description: 'A thing.' }, { homeConfig: otherHome, homeRoot });
  const made = settingsFromAnswers(answers, otherHome, { operatorUserId: '41' });
  assert.equal(made.projectSlug, 'press-play');
  assert.equal(made.trackerPrefix, 'PR');
  assert.equal(made.launchdPrefix, 'com.press-play');
  assert.equal(made.dopplerProject, 'press-play');
  assert.equal(made.logDir, '/srv/logs');
  assert.equal(made.operatorName, 'Robin');
  assert.equal(made.operatorUserId, '41');
  assert.deepEqual(made.governancePaths, ['AGENTS.md']);
  assert.deepEqual(made.mergePhrases, ['ship']);
  assert.equal(made.trackerUrl, 'https://tracker.example');
  // The same address twice is written once: the reader defaults one to the other.
  assert.equal(Object.hasOwn(made, 'trackerApiUrl'), false);
});

test('before the sign-ins exist, machineUserId is the placeholder, and filling it in keeps every other field', () => {
  const made = settingsFromAnswers(normieAnswers, homeConfig, { operatorUserId: '1' });
  assert.equal(made.machineUserId, MACHINE_PLACEHOLDER);
  assert.equal(machineUserPending(made), true);
  validateProjectConfig(made);
  const filled = withMachineUser(made, 8);
  assert.equal(filled.machineUserId, '8');
  assert.equal(machineUserPending(filled), false);
  assert.deepEqual(fieldsThatDiffer(made, filled), ['machineUserId']);
  assert.deepEqual(Object.keys(filled), Object.keys(made));
});

test('an operator or machine id that is not digits is refused, naming the field', () => {
  assert.throws(() => settingsFromAnswers(normieAnswers, homeConfig, {}), (e) => e instanceof SettingsError && /operatorUserId/.test(e.message));
  assert.throws(() => settingsFromAnswers(normieAnswers, homeConfig, { operatorUserId: 'dane' }), /operatorUserId/);
  assert.throws(() => settingsFromAnswers(normieAnswers, homeConfig, { operatorUserId: '1', machineUserId: 'x8' }), /machineUserId/);
  assert.throws(() => withMachineUser({ ...settingsFromAnswers(normieAnswers, homeConfig, { operatorUserId: '1' }) }, ''), /machineUserId/);
});

test('a settings file the reader would refuse is refused here, naming the field', () => {
  const broken = { ...normieAnswers, githubRepo: 'not a repo' };
  assert.throws(() => settingsFromAnswers(broken, homeConfig, { operatorUserId: '1' }), (e) => e instanceof SettingsError && /"githubRepo"/.test(e.message));
});

test('a guest settings file is never made from a home that runs no tracker', () => {
  const { trackerPort, trackerDataDir, trackerHost, ...rest } = homeConfig;
  const guestHome = validateProjectConfig(rest);
  assert.throws(() => settingsFromAnswers(normieAnswers, guestHome, { operatorUserId: '1' }), /trackerPort/);
});

test('actorNamed finds exactly one actor by name, or none, and refuses two', () => {
  const actors = [{ id: 1, name: 'Dane' }, { id: 8, name: 'normie loop-build' }, { id: 2, name: 'loop-build' }];
  assert.equal(actorNamed(actors, 'normie loop-build'), '8');
  assert.equal(actorNamed(actors, 'Dane'), '1');
  assert.equal(actorNamed(actors, 'pressplay loop-build'), null);
  assert.equal(actorNamed(null, 'Dane'), null);
  assert.throws(() => actorNamed([...actors, { id: 9, name: 'Dane' }], 'Dane'), /2 actors named "Dane"/);
});

test('fieldsThatDiffer names added, removed and changed fields', () => {
  assert.deepEqual(fieldsThatDiffer({ a: 1, b: [1] }, { a: 1, b: [1] }), []);
  assert.deepEqual(fieldsThatDiffer({ a: 1, b: [1] }, { a: 2, c: 3 }), ['a', 'b', 'c']);
});

test('a settings file the wizard makes says the manifest version first, and loads (SP-262)', () => {
  const made = settingsFromAnswers(normieAnswers, homeConfig, { operatorUserId: '1', machineUserId: '8' });
  assert.equal(made.manifestVersion, MANIFEST_VERSION);
  assert.equal(Object.keys(made)[0], 'manifestVersion');
  assert.match(settingsText(made), /^\{\n {2}"manifestVersion": 1,\n/);
  assert.equal(validateProjectConfig(JSON.parse(settingsText(made)), { env: {} }).manifestVersion, 1);
  const pending = settingsFromAnswers(normieAnswers, homeConfig, { operatorUserId: '1' });
  assert.equal(withMachineUser(pending, '8').manifestVersion, MANIFEST_VERSION);
});
