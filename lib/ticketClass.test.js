'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { KINDS, STARTERS, OUTCOMES, CLASS_FIELDS, classValue } = require('./ticketClass.js');

test('the agreed values, in order (SP-345)', () => {
  assert.deepEqual(KINDS, ['feature', 'fix', 'operational', 'documentation']);
  assert.deepEqual(STARTERS, ['operator', 'client', 'agent']);
  assert.deepEqual(OUTCOMES, ['done', 'wont-do', 'duplicate', 'test']);
});

test('every value has a Title Case label', () => {
  for (const spec of Object.values(CLASS_FIELDS)) {
    for (const v of spec.values) assert.match(spec.labels[v], /^[A-Z]/, v);
    assert.equal(Object.keys(spec.labels).length, spec.values.length);
  }
});

test('classValue: case, spaces, underscores and apostrophes are forgiven', () => {
  assert.deepEqual(classValue('kind', 'Feature'), { value: 'feature' });
  assert.deepEqual(classValue('outcome', "Won't do"), { value: 'wont-do' });
  assert.deepEqual(classValue('outcome', 'WONT_DO'), { value: 'wont-do' });
  assert.deepEqual(classValue('startedBy', ' agent '), { value: 'agent' });
});

test('classValue: null, empty and "none" are no value', () => {
  assert.deepEqual(classValue('kind', null), { value: null });
  assert.deepEqual(classValue('kind', ''), { value: null });
  assert.deepEqual(classValue('kind', 'None'), { value: null });
});

test('classValue: anything else names the choices, and an unknown field is refused', () => {
  assert.match(classValue('kind', 'bug').problem, /"bug" is not a kind: feature, fix, operational, documentation, or none\./);
  assert.match(classValue('size', 'big').problem, /not a ticket class field/);
});
