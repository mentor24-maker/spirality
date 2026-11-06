import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadProjectConfig, validateProjectConfig, findConfigFile, ProjectConfigError, SCHEMA, CONFIG_FILE,
  OLD_NAMES, withProjectNames,
} from './projectConfig.mjs';
import { execFileSync } from 'node:child_process';

const good = (overrides = {}) => ({
  workspaceId: '111',
  spaceId: '222',
  loopQueueListId: '333',
  operatorUserId: 444,
  machineUserId: '555',
  githubRepo: 'owner/repo',
  dopplerProject: 'proj',
  dopplerConfig: 'dev',
  launchdPrefix: 'com.example',
  logDir: '~/loop-logs',
  mergePhrases: ['merge'],
  governancePaths: ['CLAUDE.md'],
  autoMergeLanes: [],
  operatorName: 'Dana',
  projectSlug: 'example',
  legacyMachinePrefixes: [],
  projectScripts: {},
  ...overrides,
});

function repoWith(config) {
  const dir = mkdtempSync(join(tmpdir(), 'projcfg-'));
  writeFileSync(join(dir, CONFIG_FILE), typeof config === 'string' ? config : JSON.stringify(config));
  return dir;
}

const failsNaming = (fn, ...parts) => assert.throws(fn, (err) => {
  assert.ok(err instanceof ProjectConfigError, `expected ProjectConfigError, got ${err}`);
  for (const p of parts) assert.ok(err.message.includes(p), `"${err.message}" should name ${p}`);
  return true;
});

test('a complete config loads, ids come back as digit strings, and the result is frozen', () => {
  const dir = repoWith(good());
  const cfg = loadProjectConfig({ cwd: dir, env: {} });
  assert.equal(cfg.operatorUserId, '444');
  assert.equal(cfg.loopQueueListId, '333');
  assert.deepEqual(cfg.mergePhrases, ['merge']);
  assert.ok(Object.isFrozen(cfg) && Object.isFrozen(cfg.mergePhrases));
  assert.deepEqual(Object.keys(cfg), Object.keys(SCHEMA));
});

test('a missing key fails naming the key and the file', () => {
  for (const key of Object.keys(SCHEMA).filter((k) => !SCHEMA[k].optional)) {
    const config = good();
    delete config[key];
    const dir = repoWith(config);
    failsNaming(() => loadProjectConfig({ cwd: dir, env: {} }), `"${key}"`, join(dir, CONFIG_FILE));
  }
});

test('a non-numeric id fails naming the key and the file', () => {
  for (const bad of ['90141x', '', -5, 1.5, null]) {
    const dir = repoWith({ ...good(), loopQueueListId: bad });
    failsNaming(() => loadProjectConfig({ cwd: dir, env: {} }), '"loopQueueListId"', join(dir, CONFIG_FILE), 'numeric');
  }
});

test('an unknown key fails naming the key and the file', () => {
  const dir = repoWith({ ...good(), loopQueueList: '333' });
  failsNaming(() => loadProjectConfig({ cwd: dir, env: {} }), '"loopQueueList"', join(dir, CONFIG_FILE), 'unknown');
});

test('wrong shapes for the non-id keys are refused', () => {
  failsNaming(() => validateProjectConfig({ ...good(), githubRepo: 'just-a-name' }, { file: 'x.json' }), '"githubRepo"', 'x.json');
  failsNaming(() => validateProjectConfig({ ...good(), dopplerProject: '  ' }, { file: 'x.json' }), '"dopplerProject"');
  failsNaming(() => validateProjectConfig({ ...good(), mergePhrases: [] }, { file: 'x.json' }), '"mergePhrases"');
  failsNaming(() => validateProjectConfig({ ...good(), governancePaths: 'CLAUDE.md' }, { file: 'x.json' }), '"governancePaths"');
  failsNaming(() => validateProjectConfig([], { file: 'x.json' }), 'x.json');
});

test('the environment overrides keep StarCaster\'s names, and a bad override names the variable', () => {
  const cfg = validateProjectConfig(good(), { env: { CLICKUP_LOOP_QUEUE_LIST: '999', CLICKUP_OPERATOR_ID: '777' } });
  assert.equal(cfg.loopQueueListId, '999');
  assert.equal(cfg.operatorUserId, '777');
  assert.equal(validateProjectConfig(good(), { env: { CLICKUP_SPACE_ID: '' } }).spaceId, '222');
  failsNaming(() => validateProjectConfig(good(), { env: { CLICKUP_MACHINE_ID: 'pulse' } }), 'CLICKUP_MACHINE_ID', '"machineUserId"');
});

test('the file is found from a subfolder, and its absence is a clear failure', () => {
  const dir = repoWith(good());
  const deep = join(dir, 'a', 'b');
  mkdirSync(deep, { recursive: true });
  assert.equal(findConfigFile(deep), join(dir, CONFIG_FILE));
  assert.equal(loadProjectConfig({ cwd: deep, env: {} }).spaceId, '222');
  const empty = mkdtempSync(join(tmpdir(), 'projcfg-none-'));
  if (findConfigFile(empty) === null) failsNaming(() => loadProjectConfig({ cwd: empty, env: {} }), CONFIG_FILE);
  failsNaming(() => loadProjectConfig({ cwd: repoWith('{ not json'), env: {} }), 'not valid JSON');
});

test('this repository\'s own spirality.project.json passes', () => {
  const file = fileURLToPath(new URL(`../${CONFIG_FILE}`, import.meta.url));
  const cfg = validateProjectConfig(JSON.parse(readFileSync(file, 'utf8')), { file });
  assert.equal(cfg.loopQueueListId, '901418065068');
});

// ---------------------------------------------------------------------------
// The keys the moved substrate modules read (2026-10-12, task 86bcgmnpy).
// ---------------------------------------------------------------------------

test('operatorName, projectSlug, legacy prefixes and project scripts load', () => {
  const cfg = validateProjectConfig(good({
    operatorName: 'Dana',
    projectSlug: 'star-caster',
    legacyMachinePrefixes: ['[CC-starcaster]'],
    projectScripts: { door: 'scripts/clickup_direct.mjs' },
  }));
  assert.equal(cfg.operatorName, 'Dana');
  assert.equal(cfg.projectSlug, 'star-caster');
  assert.deepEqual(cfg.legacyMachinePrefixes, ['[CC-starcaster]']);
  assert.equal(cfg.projectScripts.door, 'scripts/clickup_direct.mjs');
  assert.ok(Object.isFrozen(cfg.projectScripts), 'a consumer must not edit it in place');
});

test('projectSlug has to be usable inside a sender tag', () => {
  // It is interpolated into "[CC-<slug>]", which is matched by a regex that
  // only accepts lower-case letters, digits and dashes — a slug with a space
  // or a capital would build a tag the matcher does not recognise.
  for (const bad of ['Star Caster', 'StarCaster', '-leading', 'with_underscore', '', 42]) {
    failsNaming(() => validateProjectConfig(good({ projectSlug: bad })), 'projectSlug');
  }
  for (const ok of ['starcaster', 'star-caster', 'wc2']) {
    assert.equal(validateProjectConfig(good({ projectSlug: ok })).projectSlug, ok);
  }
});

test('projectScripts must be an object of name to path, and says which entry is wrong', () => {
  failsNaming(() => validateProjectConfig(good({ projectScripts: [] })), 'projectScripts');
  failsNaming(() => validateProjectConfig(good({ projectScripts: 'scripts/' })), 'projectScripts');
  failsNaming(
    () => validateProjectConfig(good({ projectScripts: { door: '' } })),
    'projectScripts', 'door',
  );
  assert.deepEqual(validateProjectConfig(good({ projectScripts: {} })).projectScripts, {});
});

test('tracker is optional: absent means "clickup", and an unknown value fails naming the key and the file', () => {
  assert.equal(SCHEMA.tracker.optional, true);
  const absent = good();
  delete absent.tracker;
  assert.equal(loadProjectConfig({ cwd: repoWith(absent), env: {} }).tracker, 'clickup');
  assert.equal(validateProjectConfig(good({ tracker: 'clickup' })).tracker, 'clickup');
  for (const bad of ['ClickUp', 'API', 'spirality', '', 7, null]) {
    const dir = repoWith(good({ tracker: bad }));
    failsNaming(() => loadProjectConfig({ cwd: dir, env: {} }), '"tracker"', join(dir, CONFIG_FILE), '"clickup"', '"api"');
  }
});

test('trackerPrefix is optional: absent means null, and a bad prefix fails naming the key and the file', () => {
  assert.equal(SCHEMA.trackerPrefix.optional, true);
  const absent = good();
  delete absent.trackerPrefix;
  assert.equal(loadProjectConfig({ cwd: repoWith(absent), env: {} }).trackerPrefix, null);
  assert.equal(validateProjectConfig(good({ trackerPrefix: 'SP' })).trackerPrefix, 'SP');
  assert.equal(validateProjectConfig(good({ trackerPrefix: 'WC2' })).trackerPrefix, 'WC2');
  for (const bad of ['sp', 'SP-', '2SP', '', 7, null]) {
    const dir = repoWith(good({ trackerPrefix: bad }));
    failsNaming(() => loadProjectConfig({ cwd: dir, env: {} }), '"trackerPrefix"', join(dir, CONFIG_FILE));
  }
});

test('tracker "api" needs a trackerUrl; the address is checked, trimmed of a trailing slash, and overridable', () => {
  const cfg = validateProjectConfig(good({ tracker: 'api', trackerUrl: 'http://mini.local:7420/' }));
  assert.equal(cfg.tracker, 'api');
  assert.equal(cfg.trackerUrl, 'http://mini.local:7420');
  // What is stored is the parsed origin, never the raw string as written.
  for (const loose of ['http://mini.local:7420/?', ' http://mini.local:7420 ', 'HTTP://Mini.Local:7420/#']) {
    assert.equal(validateProjectConfig(good({ tracker: 'api', trackerUrl: loose })).trackerUrl, 'http://mini.local:7420');
  }
  assert.equal(validateProjectConfig(good()).trackerUrl, null);
  const dir = repoWith(good({ tracker: 'api' }));
  failsNaming(() => loadProjectConfig({ cwd: dir, env: {} }), '"trackerUrl"', '"api"', join(dir, CONFIG_FILE));
  assert.equal(loadProjectConfig({ cwd: dir, env: { TRACKER_URL: 'https://t.example' } }).trackerUrl, 'https://t.example');
  for (const bad of ['mini.local:7420', 'ftp://mini.local', 'http://u:p@mini.local', 'http://mini.local/api', 'http://mini.local?x=1', '', 7]) {
    failsNaming(() => validateProjectConfig(good({ tracker: 'api', trackerUrl: bad })), '"trackerUrl"');
  }
});

test('trackerApiUrl, the address the loops call, defaults to trackerUrl and is checked the same way', () => {
  const plain = validateProjectConfig(good({ tracker: 'api', trackerUrl: 'http://mini.local:7420' }));
  assert.equal(plain.trackerApiUrl, 'http://mini.local:7420');
  const both = validateProjectConfig(good({ tracker: 'api', trackerUrl: 'http://mini.local:7420', trackerApiUrl: 'http://127.0.0.1:7420/' }));
  assert.equal(both.trackerApiUrl, 'http://127.0.0.1:7420');
  assert.equal(both.trackerUrl, 'http://mini.local:7420', 'the browser address is left alone');
  assert.equal(validateProjectConfig(good()).trackerApiUrl, null);
  const dir = repoWith(good({ tracker: 'api', trackerUrl: 'http://mini.local:7420' }));
  assert.equal(loadProjectConfig({ cwd: dir, env: { TRACKER_API_URL: 'http://127.0.0.1:7420' } }).trackerApiUrl, 'http://127.0.0.1:7420');
  for (const bad of ['127.0.0.1:7420', 'http://127.0.0.1:7420/api', '']) {
    failsNaming(() => validateProjectConfig(good({ tracker: 'api', trackerUrl: 'http://mini.local:7420', trackerApiUrl: bad })), '"trackerApiUrl"');
  }
});

test('the tracker service keys are optional: absent means no service; a bad port fails naming the key', () => {
  for (const key of ['trackerPort', 'trackerHost', 'trackerDataDir']) assert.equal(SCHEMA[key].optional, true);
  const absent = validateProjectConfig(good());
  assert.equal(absent.trackerPort, null);
  assert.equal(absent.trackerHost, '127.0.0.1');
  assert.equal(absent.trackerDataDir, null);
  const set = validateProjectConfig(good({ trackerPort: 4180, trackerHost: '0.0.0.0', trackerDataDir: '~/t' }));
  assert.deepEqual([set.trackerPort, set.trackerHost, set.trackerDataDir], [4180, '0.0.0.0', '~/t']);
  assert.equal(validateProjectConfig(good({ trackerPort: '4180' })).trackerPort, 4180);
  for (const bad of [0, 65536, -1, 41.5, 'eighty', '', null]) {
    failsNaming(() => validateProjectConfig(good({ trackerPort: bad })), '"trackerPort"', 'port number');
  }
  failsNaming(() => validateProjectConfig(good({ trackerDataDir: '' })), '"trackerDataDir"');
});

test('every key in the schema is one the config file actually carries', () => {
  // The guard against a key added to SCHEMA and forgotten in the repository's
  // own config: this repo is the package's first consumer, so a miss here is a
  // miss for every project.
  const here = JSON.parse(readFileSync(
    join(fileURLToPath(new URL('..', import.meta.url)), CONFIG_FILE), 'utf8'));
  assert.deepEqual(
    Object.keys(SCHEMA).filter((k) => !SCHEMA[k].optional && !Object.hasOwn(here, k)), [],
    'spirality.project.json is missing a key the schema requires',
  );
});

test('a merge phrase with no letter or digit is refused, naming the entry', () => {
  // `"."` normalizes away to the empty string, and an empty phrase equals an
  // empty comment: every silent comment would read as "merge" (review of
  // 86bcgmnpy, round 3).
  failsNaming(
    () => validateProjectConfig(good({ mergePhrases: ['merge', '.'] }), { file: 'x.json' }),
    '"mergePhrases"', '"."',
  );
  failsNaming(
    () => validateProjectConfig(good({ mergePhrases: ['***'] }), { file: 'x.json' }),
    '"mergePhrases"', '"***"',
  );
});

test('a merge phrase written with capitals or punctuation is ACCEPTED, because the matcher normalizes both sides', async () => {
  const cfg = validateProjectConfig(good({ mergePhrases: ['Ship it', 'Merge!', 'merge  it'] }), { file: 'x.json' });
  assert.deepEqual(cfg.mergePhrases, ['Ship it', 'Merge!', 'merge  it']);
  // And this is the half that makes accepting them honest: every phrase the
  // validator accepts must survive the matcher's normalization as something
  // non-empty, or it could never match. Checked here against the matcher's own
  // function so the two cannot drift apart.
  // A default import, because the module's exports object is partly getters
  // and Node's CommonJS named-export detection does not see through those.
  const { default: mergeOnComment } = await import('./mergeOnComment.js');
  const { normalizeCommand } = mergeOnComment;
  for (const phrase of cfg.mergePhrases) {
    assert.ok(normalizeCommand(phrase), `${JSON.stringify(phrase)} must normalize to something`);
  }
});

// ── The old field names (SP-130) ──────────────────────────────────────────
// Normie's settings file exactly as it stood on its main on 2026-11-05, before
// any project moved over to the new names. These tests are the ones allowed
// to say productSlug / productScripts: they prove the old names still load.
const NORMIE_2026_11_05 = `{
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
  "productSlug": "normie",
  "legacyMachinePrefixes": [],
  "productScripts": {},
  "trackerPrefix": "NO",
  "tracker": "api",
  "trackerUrl": "http://mac-mini.local:4180",
  "trackerApiUrl": "http://127.0.0.1:4180"
}
`;

test('old names: Normie\'s settings file as it is today loads exactly as before, read under the new names', () => {
  const oldFile = loadProjectConfig({ cwd: repoWith(NORMIE_2026_11_05), env: {} });
  const moved = JSON.parse(NORMIE_2026_11_05);
  moved.projectSlug = moved.productSlug; delete moved.productSlug;
  moved.projectScripts = moved.productScripts; delete moved.productScripts;
  const newFile = loadProjectConfig({ cwd: repoWith(moved), env: {} });
  assert.deepEqual(oldFile, newFile);
  assert.equal(oldFile.projectSlug, 'normie');
  assert.deepEqual(oldFile.projectScripts, {});
  assert.equal(Object.hasOwn(oldFile, 'productSlug'), false, 'callers see the new names only');
  assert.equal(Object.hasOwn(oldFile, 'productScripts'), false);
});

test('old names: a file with only the new names loads, and Spirality\'s own settings file uses them', () => {
  assert.equal(validateProjectConfig(good(), { env: {} }).projectSlug, 'example');
  const here = fileURLToPath(new URL('../spirality.project.json', import.meta.url));
  const own = JSON.parse(readFileSync(here, 'utf8'));
  assert.ok(Object.hasOwn(own, 'projectSlug') && Object.hasOwn(own, 'projectScripts'));
  for (const old of Object.keys(OLD_NAMES)) assert.equal(Object.hasOwn(own, old), false, `${old} is gone from spirality.project.json`);
});

test('old names: one field under both names with different values is refused, naming both', () => {
  const { projectSlug, projectScripts, ...rest } = good();
  failsNaming(() => validateProjectConfig({ ...rest, projectScripts, projectSlug: 'normie', productSlug: 'pressplay' }, { env: {} }),
    '"projectSlug"', '"productSlug"');
  failsNaming(() => validateProjectConfig({ ...rest, projectSlug, projectScripts: {}, productScripts: { door: 'x.mjs' } }, { env: {} }),
    '"projectScripts"', '"productScripts"');
});

test('old names: the same value under both names is accepted', () => {
  const c = validateProjectConfig(good({ productSlug: 'example', productScripts: {} }), { env: {} });
  assert.equal(c.projectSlug, 'example');
  assert.equal(Object.hasOwn(c, 'productSlug'), false);
});

test('old names: withProjectNames maps productName too, and leaves a file without old names as it is', () => {
  assert.deepEqual(withProjectNames({ productName: 'Normie', githubRepo: 'o/n' }), { projectName: 'Normie', githubRepo: 'o/n' });
  assert.deepEqual(withProjectNames({ projectSlug: 'x' }), { projectSlug: 'x' });
  assert.deepEqual(OLD_NAMES, { productSlug: 'projectSlug', productName: 'projectName', productScripts: 'projectScripts' });
});

test('old names: scripts/project_config.mjs answers projectSlug and productSlug alike, in an old file and a new one', () => {
  const cli = fileURLToPath(new URL('../scripts/project_config.mjs', import.meta.url));
  const moved = JSON.parse(NORMIE_2026_11_05);
  moved.projectSlug = moved.productSlug; delete moved.productSlug;
  moved.projectScripts = moved.productScripts; delete moved.productScripts;
  for (const dir of [repoWith(NORMIE_2026_11_05), repoWith(moved)]) {
    for (const key of ['projectSlug', 'productSlug']) {
      const out = execFileSync(process.execPath, [cli, key], { cwd: dir, encoding: 'utf8' });
      assert.equal(out, 'normie\n', `${key} in ${dir}`);
    }
  }
});
