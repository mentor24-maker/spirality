import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from './store.mjs';
import { clickupIdOf, formatOldIds, openOldIdMap, resolveOldIds } from './oldId.mjs';

test('a bare ClickUp id or a ClickUp task link both give the id; anything else gives null', () => {
  assert.equal(clickupIdOf('86bctjbc3'), '86bctjbc3');
  assert.equal(clickupIdOf(' 86BCTJBC3 '), '86bctjbc3');
  assert.equal(clickupIdOf('https://app.clickup.com/t/86bctjbc3'), '86bctjbc3');
  assert.equal(clickupIdOf('https://app.clickup.com/t/86bctjbc3/'), '86bctjbc3');
  assert.equal(clickupIdOf('https://app.clickup.com/t/90141423066/86bctjbc3?x=1'), '86bctjbc3');
  assert.equal(clickupIdOf('https://example.com/t/86bctjbc3'), null);
  assert.equal(clickupIdOf('SP-21 or so'), null);
  assert.equal(clickupIdOf(''), null);
});

test('each old id resolves to its tracker id and page, or says plainly that it was not imported', () => {
  const map = { '86bctjbc3': 'SP-21', '86bcudhyj': 'SP-31' };
  const results = resolveOldIds(
    ['86bctjbc3', 'https://app.clickup.com/t/86bcudhyj', 'zzz9', 'not an id!'],
    { lookup: (id) => map[id] ?? null, trackerUrl: 'http://mac-mini.local:4180/' },
  );
  assert.deepEqual(formatOldIds(results), [
    '86bctjbc3\tSP-21\thttp://mac-mini.local:4180/t/SP-21',
    '86bcudhyj\tSP-31\thttp://mac-mini.local:4180/t/SP-31',
    'zzz9\tnot imported',
    'not an id!\tnot a ClickUp id or link',
  ]);
});

test('the map is read from the database read-only: the file is byte-for-byte unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-oldid-'));
  const path = join(dir, 'tracker.db');
  try {
    const store = openStore(path);
    const human = store.createActor({ kind: 'human', name: 'Operator' });
    const machine = store.createActor({ kind: 'machine', name: 'Loop' });
    store.createProject({ slug: 'alpha', name: 'Alpha', prefix: 'AL', operator: human.id });
    store.importTicket({
      source: 'clickup', sourceId: 'abc1', createdAt: '2026-01-02T03:04:05.000Z',
      project: 'alpha', actor: machine.id, name: 'Old', status: 'Live',
    });
    store.close();
    const before = readFileSync(path);

    const map = openOldIdMap(path);
    try {
      assert.equal(map.lookup('abc1'), 'AL-1');
      assert.equal(map.lookup('nope'), null);
    } finally { map.close(); }
    assert.deepEqual(readFileSync(path), before, 'reading the map changed nothing on disk');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
