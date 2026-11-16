/**
 * Tests for Waiting on You, the home page. One file per page (SP-352),
 * so two tickets changing two pages no longer edit one test file; what they
 * share is tracker/webTestKit.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './webTestKit.mjs';

const idsWhere = (expect, outcome) => Object.keys(expect).filter((id) => expect[id] === outcome).sort();

// ── What waits on him ────────────────────────────────────────────────────────

test('"Waiting on you" lists exactly what the `waiting` command says is waiting on Dane, across both projects', async () => {
  const f = await fixture();
  try {
    const page = await f.call('GET', '/waiting');
    assert.equal(page.status, 200);

    // The real command, run against the same tickets, one project at a time.
    const said = { assigned: [], unassigned: [] };
    for (const slug of ['alpha', 'beta']) {
      const r = await f.waitingCommand(slug);
      // 1 when any ticket is undecided (it outranks 3), else 3: both projects have waits.
      assert.ok([1, 3].includes(r.code), r.err);
      for (const line of r.out.trim().split('\n')) {
        // The command and the page share one verdict (SP-217): WAITING is his,
        // CANNOT TELL is his status with nobody assigned.
        const [id, , , , , verdict] = line.split('\t');
        if (verdict.startsWith('WAITING ON DANE')) said.assigned.push(id);
        else if (verdict.startsWith('CANNOT TELL')) said.unassigned.push(id);
      }
    }

    assert.deepEqual(page.body.waiting.map((t) => t.id).sort(), said.assigned.sort());
    // The command calls his status with nobody assigned CANNOT TELL; the page shows those apart, never drops them.
    assert.deepEqual(page.body.unsure.map((t) => t.id).sort(), said.unassigned.sort());
    // And both agree with what the test data was built to be.
    assert.deepEqual(said.assigned.sort(), idsWhere(f.expect, 'waiting'));
    assert.deepEqual(said.unassigned.sort(), idsWhere(f.expect, 'unassigned'));
  } finally { await f.cleanup(); }
});

test('"Waiting on you" is newest first and names each ticket\'s project, status and name', async () => {
  const f = await fixture();
  try {
    const { waiting } = (await f.call('GET', '/waiting')).body;
    const times = waiting.map((t) => t.updatedAt);
    assert.deepEqual(times, [...times].sort().reverse());
    assert.ok(new Set(waiting.map((t) => t.project)).size === 2, 'tickets from both projects');
    const first = waiting.find((t) => t.id === 'AL-1');
    assert.equal(first.projectName, 'Alpha');
    assert.equal(first.status, 'needs your input');
    assert.equal(first.name, 'The tracker has nowhere to run: choose where it lives');
  } finally { await f.cleanup(); }
});

test('"Waiting on you" is the caller\'s own: a loop asking sees nothing of Dane\'s', async () => {
  const f = await fixture();
  try {
    const loopToken = f.store.issueToken(f.loop.id);
    const r = await f.call('GET', '/waiting', { token: loopToken });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.waiting, []);
    assert.equal((await f.call('GET', '/waiting', { token: null })).status, 401);
  } finally { await f.cleanup(); }
});

test('once Dane answers on the page, the ticket leaves "Waiting on you"', async () => {
  const f = await fixture();
  try {
    assert.ok((await f.call('GET', '/waiting')).body.waiting.some((t) => t.id === 'BE-1'));
    assert.equal((await f.call('POST', '/tickets/BE-1/comments', { body: { body: 'merge' } })).status, 201);
    assert.ok(!(await f.call('GET', '/waiting')).body.waiting.some((t) => t.id === 'BE-1'));
  } finally { await f.cleanup(); }
});
