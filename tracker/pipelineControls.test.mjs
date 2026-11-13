import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CONTROLS, GROUPS, RELEASE_GROUP, LANES, MODEL_LANES, MODELS, checkControl, settingLines, withValues } from './pipelineControls.mjs';
import { intervalOf } from '../scripts/lib/loopSchedule.mjs';
import wipCap from '../lib/wipCap.js';

test('the defaults are today\'s behaviour, read from where it lives now (SP-224)', () => {
  for (const lane of LANES) assert.equal(CONTROLS.find((c) => c.key === `wake.${lane}`).default, String(intervalOf(lane)));
  assert.equal(CONTROLS.find((c) => c.key === 'wip-cap').default, String(wipCap.DEFAULT_WIP_CAP));
  assert.ok(CONTROLS.filter((c) => c.kind === 'switch').every((c) => c.default === 'off'));
  assert.ok(CONTROLS.filter((c) => c.kind === 'model').every((c) => c.default === 'default'));
  assert.deepEqual(CONTROLS.filter((c) => c.kind === 'model').map((c) => c.key), MODEL_LANES.map((l) => `model.${l}`));
});

test('every group the lanes do not use yet names the ticket that wires it in (the wake times, SP-236, and the pause switches, SP-237, are wired), and every control is in a group', () => {
  assert.deepEqual(GROUPS.map((g) => [g.key, g.wiredBy]), [['wake', null], ['pause', null], ['cap', null], ['model', 'SP-239']]);
  assert.ok(CONTROLS.every((c) => GROUPS.some((g) => g.key === c.group)));
  assert.deepEqual(RELEASE_GROUP, { key: 'release', title: 'Spirality Release', wiredBy: 'SP-276' }, 'the release group is not a control, and SP-276 wires it in (SP-275)');
  assert.ok(!CONTROLS.some((c) => c.group === RELEASE_GROUP.key));
});

test('checkControl stores text: numbers whole and in range, switches on or off, models on the list', () => {
  assert.equal(checkControl('wake.loop-build', 900), '900');
  assert.equal(checkControl('wake.loop-build', ' 60 '), '60');
  assert.equal(checkControl('wip-cap', '50'), '50');
  assert.equal(checkControl('paused', true), 'on');
  assert.equal(checkControl('paused.relay', 'off'), 'off');
  assert.equal(checkControl('model.loop-review', MODELS[0].id), MODELS[0].id);
  for (const [key, value] of [['wake.loop-build', 59], ['wake.loop-build', ''], ['wip-cap', -1], ['paused', 1], ['model.loop-build', 'opus']]) {
    assert.throws(() => checkControl(key, value), { code: 'bad-setting' }, `${key}=${value}`);
  }
});

test('the settings lines are every control, name=value, defaults included', () => {
  const lines = settingLines(withValues({ 'wake.loop-build': '900' }));
  assert.equal(lines.length, CONTROLS.length);
  assert.ok(lines.includes('wake.loop-build=900'));
  assert.ok(lines.includes('wip-cap=5'));
});

test('no project id, slug or name is written into the controls (engineering rule 2)', () => {
  const text = readFileSync(new URL('./pipelineControls.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(text, /spirality|starcaster|wavecenter|9014\d{8}/i);
});
