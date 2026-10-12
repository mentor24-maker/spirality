import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadProjectConfig, validateProjectConfig, findConfigFile, ProjectConfigError, SCHEMA, CONFIG_FILE,
} from './projectConfig.mjs';

const good = () => ({
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
