import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CONTROLS, GROUPS, LANES, MODEL_LANES, MODELS, checkControl, settingLines, withValues } from './pipelineControls.mjs';
import { intervalOf } from '../scripts/lib/loopSchedule.mjs';
import wipCap from '../lib/wipCap.js';

test('the defaults are today\'s behaviour, read from where it lives now (SP-224)', () => {
  for (const lane of LANES) assert.equal(CONTROLS.find((c) => c.key === `wake.${lane}`).default, String(intervalOf(lane)));
  assert.equal(CONTROLS.find((c) => c.key === 'wip-cap').default, String(wipCap.DEFAULT_WIP_CAP));
  assert.ok(CONTROLS.filter((c) => c.kind === 'switch').every((c) => c.default === 'off'));
  assert.ok(CONTROLS.filter((c) => c.kind === 'model').every((c) => c.default === 'default'));
  assert.deepEqual(CONTROLS.filter((c) => c.kind === 'model').map((c) => c.key), MODEL_LANES.map((l) => `model.${l}`));
  assert.equal(CONTROLS.find((c) => c.key === 'release.quiet-days').default, '0', 'nothing moves by itself until Dane turns it on (SP-277)');
});

test('every group names the ticket that wires it in, and every control is in a group', () => {
  assert.deepEqual(GROUPS.map((g) => [g.key, g.wiredBy]), [['wake', 'SP-236'], ['pause', 'SP-237'], ['cap', 'SP-238'], ['model', 'SP-239'], ['release-move', null]]);
  assert.deepEqual(GROUPS.filter((g) => g.notOnOwnProject).map((g) => g.key), ['release-move'], 'only the release group is left out for the home project (SP-277)');
  assert.ok(CONTROLS.every((c) => GROUPS.some((g) => g.key === c.group)));
});

test('checkControl stores text: numbers whole and in range, switches on or off, models on the list', () => {
  assert.equal(checkControl('wake.loop-build', 900), '900');
  assert.equal(checkControl('wake.loop-build', ' 60 '), '60');
  assert.equal(checkControl('wip-cap', '50'), '50');
  assert.equal(checkControl('paused', true), 'on');
  assert.equal(checkControl('paused.relay', 'off'), 'off');
  assert.equal(checkControl('model.loop-review', MODELS[0].id), MODELS[0].id);
  assert.equal(checkControl('release.quiet-days', '0'), '0');
  assert.equal(checkControl('release.quiet-days', 30), '30');
  for (const [key, value] of [['wake.loop-build', 59], ['wake.loop-build', ''], ['wip-cap', -1], ['paused', 1], ['model.loop-build', 'opus'], ['release.quiet-days', 31], ['release.quiet-days', -1], ['release.quiet-days', '2.5']]) {
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
