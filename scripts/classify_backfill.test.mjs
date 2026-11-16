import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTable, planChanges } from './classify_backfill.mjs';

test('parseTable reads rows, skips comments and blank lines, and keeps an empty field as none', () => {
  const { rows, problems } = parseTable('# id\tkind\tstarted_by\toutcome\tnote\n\nSP-1\tfeature\toperator\tdone\tthe seed\nSP-2\tfix\t\t\t\n');
  assert.deepEqual(problems, []);
  assert.deepEqual(rows, [
    { id: 'SP-1', kind: 'feature', startedBy: 'operator', outcome: 'done', note: 'the seed' },
    { id: 'SP-2', kind: 'fix', startedBy: null, outcome: null, note: '' },
  ]);
});

test('parseTable names every line it cannot read: a bad id, a bad value, a repeated ticket', () => {
  const { problems } = parseTable('sp 1\tfeature\nSP-2\tchore\toperator\nSP-3\tfeature\tbot\nSP-3\tfix\n');
  assert.equal(problems.length, 4);
  assert.match(problems[0], /line 1: "sp 1" is not a ticket id/);
  assert.match(problems[1], /line 2 \(SP-2, kind\)/);
  assert.match(problems[2], /line 3 \(SP-3, started_by\)/);
  assert.match(problems[3], /line 4: SP-3 is in the table twice/);
});

test('planChanges writes only what differs, never an ending on an open ticket, and says what it skipped', () => {
  const rows = [
    { id: 'SP-1', kind: 'feature', startedBy: 'operator', outcome: 'done' },
    { id: 'SP-2', kind: 'fix', startedBy: 'agent', outcome: 'done' },
    { id: 'SP-3', kind: 'operational', startedBy: null, outcome: null },
    { id: 'SP-9', kind: 'feature', startedBy: null, outcome: null },
  ];
  const tickets = [
    { id: 'SP-1', status: 'live', kind: 'feature', startedBy: 'operator', outcome: 'done' },
    { id: 'SP-2', status: 'queued', kind: null, startedBy: null, outcome: null },
    { id: 'SP-3', status: 'live', kind: null, startedBy: 'agent', outcome: null },
  ];
  const { changes, skipped } = planChanges(rows, tickets);
  assert.deepEqual(changes.map((c) => [c.id, c.flags]), [
    ['SP-2', ['--kind', 'fix', '--started-by', 'agent']],
    ['SP-3', ['--kind', 'operational']],
  ]);
  assert.equal(skipped.length, 2);
  assert.match(skipped[0], /SP-2: open today \(queued\)/);
  assert.match(skipped[1], /SP-9: not in the tracker/);
});

test("Spirality's table reads cleanly: every line a ticket, every value one of the contract's", () => {
  const { rows, problems } = parseTable(readFileSync(new URL('../docs/ticket-class/spirality.tsv', import.meta.url), 'utf8'));
  assert.deepEqual(problems, []);
  assert.ok(rows.length >= 344, `expected every ticket filed before SP-345, got ${rows.length}`);
  for (const r of rows) assert.ok(r.kind && r.startedBy, `${r.id} has a kind and who started it`);
  // The contract's own examples (docs/LOOP_CONTRACT.md) are classed as it says.
  const kind = Object.fromEntries(rows.map((r) => [r.id, r.kind]));
  assert.equal(kind['SP-295'], 'feature');
  assert.equal(kind['SP-175'], 'feature');
  assert.equal(kind['SP-100'], 'fix');
  assert.equal(kind['SP-318'], 'documentation');
  assert.equal(kind['SP-315'], 'documentation');
});
