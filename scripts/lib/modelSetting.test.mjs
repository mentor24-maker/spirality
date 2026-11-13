/**
 * The model chosen on the Settings page, read by a lane's runner before
 * every pass (SP-239): modelSetting.mjs answers `default` or an id from the
 * page's own list, and never anything else a runner could hand to claude.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALLOWED, modelFrom, readModel } from './modelSetting.mjs';
import { DEFAULT_MODEL, MODELS, MODEL_LANES } from './laneModels.mjs';
import * as controls from '../../tracker/pipelineControls.mjs';

const require = createRequire(import.meta.url);
const { PASS_BANNER_RE } = require('../../lib/pulse.js');
const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const SETTINGS = ['wake.loop-build=600', 'paused=off', 'wip-cap=5', 'model.loop-intake=default', 'model.loop-build=default', `model.loop-review=${MODELS[1].id}`].join('\n');

test('the Settings page and the runner check against the one list', () => {
  assert.equal(controls.MODELS, MODELS);
  assert.equal(controls.MODEL_LANES, MODEL_LANES);
  assert.equal(controls.DEFAULT_MODEL, DEFAULT_MODEL);
  assert.deepEqual(ALLOWED, ['default', ...MODELS.map((m) => m.id)]);
  for (const id of ALLOWED) assert.match(id, /^(default|claude-[a-z0-9.-]+)$/, 'the runner only passes plain model ids');
});

test('modelFrom reads the lane\'s own line, and only a value on the list', () => {
  assert.deepEqual(modelFrom(SETTINGS, 'loop-review'), { model: MODELS[1].id });
  assert.deepEqual(modelFrom(SETTINGS, 'loop-build'), { model: 'default' });
  for (const bad of ['', 'opus', 'gpt-9', 'claude-opus-5-5 --x', 'Claude-opus-5-5']) {
    const { model, problem } = modelFrom(`model.loop-build=${bad}`, 'loop-build');
    assert.equal(model, undefined, bad);
    assert.match(problem, /is not "default" or a model on the Settings page's list/, bad);
  }
  assert.match(modelFrom('paused=off', 'loop-build').problem, /have no model\.loop-build line/);
  assert.match(modelFrom('model.loop-build-extra=default', 'loop-build').problem, /have no model\.loop-build line/);
});

test('readModel answers the model, or one line saying why the door could not give one', () => {
  const ok = (stdout) => () => ({ status: 0, stdout, stderr: '', error: null });
  assert.deepEqual(readModel('loop-review', { read: ok(SETTINGS) }), { code: 0, line: MODELS[1].id });
  assert.deepEqual(readModel('loop-intake', { read: ok(SETTINGS) }), { code: 0, line: 'default' });
  assert.equal(readModel('loop-build', { read: ok('model.loop-build=gpt-9\n') }).code, 1);
  assert.deepEqual(
    readModel('loop-build', { read: () => ({ status: 1, stdout: '', stderr: 'read the pipeline controls FAILED — fetch failed\n', error: null }) }),
    { code: 1, line: 'the settings read failed (exit 1: read the pipeline controls FAILED — fetch failed)' },
  );
  assert.match(readModel('loop-build', { read: () => ({ status: null, stdout: '', stderr: '', error: { code: 'ETIMEDOUT' } }) }).line, /took longer than 60s/);
  assert.match(readModel('loop-build', { read: () => ({ status: null, stdout: '', stderr: '', error: { code: 'ENOENT' } }) }).line, /could not run \(ENOENT\)/);
  // The relay runs no model: never asked, never answered.
  let asked = false;
  assert.equal(readModel('relay', { read: () => { asked = true; return ok(SETTINGS)(); } }).code, 2);
  assert.equal(asked, false);
});

test('the pulse still reads the runner\'s START line now it names the model, and its END line', () => {
  const runner = readFileSync(join(REPO, 'scripts/loop_runner.sh'), 'utf8');
  const start = /echo "(===== \$\(date [^)]*\) START [^"]*)"/.exec(runner)[1]
    .replace(/\$\(date [^)]*\)/, '2026-11-13 14:02:10').replace('$SKILL', 'loop-build');
  for (const model of ['default', 'claude-sonnet-5-5']) {
    const m = PASS_BANNER_RE.exec(start.replace('$PASS_MODEL', model));
    assert.ok(m, start);
    assert.deepEqual([m[1], m[2], m[3]], ['2026-11-13 14:02:10', 'START', 'loop-build']);
  }
  assert.ok(PASS_BANNER_RE.exec('===== 2026-08-22 01:43:14 START /loop-build ====='), 'an older START with no note still reads');
  assert.equal(PASS_BANNER_RE.exec('===== 2026-10-02 20:18:13 END /loop-build (exit 1 — not a verdict; the pass\'s report above is) =====')[4], '1');
});
