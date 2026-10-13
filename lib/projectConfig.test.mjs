import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadProjectConfig, validateProjectConfig, findConfigFile, ProjectConfigError, SCHEMA, CONFIG_FILE,
} from './projectConfig.mjs';

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
  productSlug: 'example',
  legacyMachinePrefixes: [],
  productScripts: {},
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
  for (const key of Object.keys(SCHEMA)) {
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

test('operatorName, productSlug, legacy prefixes and product scripts load', () => {
  const cfg = validateProjectConfig(good({
    operatorName: 'Dana',
    productSlug: 'star-caster',
    legacyMachinePrefixes: ['[CC-starcaster]'],
    productScripts: { door: 'scripts/clickup_direct.mjs' },
  }));
  assert.equal(cfg.operatorName, 'Dana');
  assert.equal(cfg.productSlug, 'star-caster');
  assert.deepEqual(cfg.legacyMachinePrefixes, ['[CC-starcaster]']);
  assert.equal(cfg.productScripts.door, 'scripts/clickup_direct.mjs');
  assert.ok(Object.isFrozen(cfg.productScripts), 'a consumer must not edit it in place');
});

test('productSlug has to be usable inside a sender tag', () => {
  // It is interpolated into "[CC-<slug>]", which is matched by a regex that
  // only accepts lower-case letters, digits and dashes — a slug with a space
  // or a capital would build a tag the matcher does not recognise.
  for (const bad of ['Star Caster', 'StarCaster', '-leading', 'with_underscore', '', 42]) {
    failsNaming(() => validateProjectConfig(good({ productSlug: bad })), 'productSlug');
  }
  for (const ok of ['starcaster', 'star-caster', 'wc2']) {
    assert.equal(validateProjectConfig(good({ productSlug: ok })).productSlug, ok);
  }
});

test('productScripts must be an object of name to path, and says which entry is wrong', () => {
  failsNaming(() => validateProjectConfig(good({ productScripts: [] })), 'productScripts');
  failsNaming(() => validateProjectConfig(good({ productScripts: 'scripts/' })), 'productScripts');
  failsNaming(
    () => validateProjectConfig(good({ productScripts: { door: '' } })),
    'productScripts', 'door',
  );
  assert.deepEqual(validateProjectConfig(good({ productScripts: {} })).productScripts, {});
});

test('every key in the schema is one the config file actually carries', () => {
  // The guard against a key added to SCHEMA and forgotten in the repository's
  // own config: this repo is the package's first consumer, so a miss here is a
  // miss for every product.
  const here = JSON.parse(readFileSync(
    join(fileURLToPath(new URL('..', import.meta.url)), CONFIG_FILE), 'utf8'));
  assert.deepEqual(
    Object.keys(SCHEMA).filter((k) => !Object.hasOwn(here, k)), [],
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
