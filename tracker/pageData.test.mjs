// heldUpBy (SP-228): is a ticket held up by a lane that keeps failing, rather
// than waiting on Dane? Plain rows in, no store, no clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heldUpBy } from './pageData.mjs';

const DANE = 7;
const LOOP = 9;
const SINCE = '2026-11-11T04:00:00.000Z';

/** GET /pipeline's stages as heldUpBy reads them, with the named jobs failing. */
function lanes(...failing) {
  const stages = [['Relay', 'relay'], ['Build', 'loop-build'], ['Review', 'loop-review'], ['Intake', 'loop-intake']].map(([name, job]) => ({
    name, job,
    failing: failing.includes(job),
    failingSince: failing.includes(job) ? SINCE : null,
    failingReason: failing.includes(job) ? 'keeps failing' : null,
  }));
  return new Map(stages.map((s) => [s.job, s]));
}

const ticket = (status, assignee = DANE) => ({ status, assignee });
let minute = 0;
const said = (author, body) => ({ author, body, createdAt: new Date(Date.UTC(2026, 10, 11, 3, minute++)).toISOString() });
const CARD = said(LOOP, '@@ASKED\nmerge it\n\nYour move: Merge');
const MERGE = said(DANE, 'merge');
const QUESTION = said(LOOP, '@@ASKED\nmerge\n\n@@NEEDED\nWhich one?\nYour move: Reply');

test('a Ready to launch ticket whose newest word is his "merge" is held up by a failing relay, with its name, reason and start (SP-228)', () => {
  assert.deepEqual(heldUpBy(ticket('ready to launch'), [CARD, MERGE], DANE, lanes('relay')),
    { stage: 'Relay', job: 'relay', reason: 'keeps failing', since: SINCE });
  assert.deepEqual(heldUpBy(ticket('needs your input'), [CARD, MERGE], DANE, lanes('relay')).stage, 'Relay');
});

test('a ticket that truly waits on him is never held up, whatever is failing (SP-228)', () => {
  const all = lanes('relay', 'loop-build', 'loop-review', 'loop-intake');
  assert.equal(heldUpBy(ticket('needs your input'), [CARD, MERGE, QUESTION], DANE, all), null, 'a loop\'s question is the newest word, after his');
  assert.equal(heldUpBy(ticket('ready to launch'), [CARD], DANE, all), null);
  // His lane, not assigned: the verdict cannot tell, and his word is not the newest: shown, never hidden.
  assert.equal(heldUpBy(ticket('ready to launch', null), [CARD], DANE, all), null);
});

test('a lane that is passing, or no lanes read, holds nothing up (SP-228)', () => {
  assert.equal(heldUpBy(ticket('ready to launch'), [CARD, MERGE], DANE, lanes('loop-build')), null, 'only the relay acts on his answer');
  assert.equal(heldUpBy(ticket('ready to launch'), [CARD, MERGE], DANE, lanes()), null);
  assert.equal(heldUpBy(ticket('ready to launch'), [CARD, MERGE], DANE, null), null);
  assert.equal(heldUpBy(ticket('ready to launch'), [CARD, MERGE], null, lanes('relay')), null, 'a project with no operator');
});

test('each machine status is held up by the lane that acts on it next; Building and Live by none (SP-228)', () => {
  const by = (status, failing) => heldUpBy(ticket(status, null), [], DANE, lanes(failing))?.stage ?? null;
  assert.equal(by('queued', 'loop-build'), 'Build');
  assert.equal(by('rework', 'loop-build'), 'Build');
  assert.equal(by('in review', 'loop-review'), 'Review');
  assert.equal(by('requested', 'loop-intake'), 'Intake');
  assert.equal(by('queued', 'loop-review'), null, 'another lane failing');
  assert.equal(by('in review', 'relay'), null);
  assert.equal(by('building', 'loop-build'), null, 'a pass is on it');
  assert.equal(by('live', 'relay'), null);
});

test('a failing stage with no reason or start still says it is held up (SP-228)', () => {
  const bare = new Map([['loop-build', { name: 'Build', job: 'loop-build', failing: true }]]);
  assert.deepEqual(heldUpBy(ticket('queued'), [], DANE, bare), { stage: 'Build', job: 'loop-build', reason: 'keeps failing', since: null });
});
