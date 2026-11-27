import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from './store.mjs';
import { boardOf, consoleOf, threadOf, waitingFor, whoseMove, heldUpBy } from './pageData.mjs';
import { STAGES } from './pipeline.mjs';

/**
 * One store holding every case the Console's incident store covers (SP-414:
 * asked and waiting, ready to launch and waiting, his answer newest, a
 * standing merge word, a merged pull request, a ticket not assigned to him),
 * plus one held up by a failing relay. Every view that says "is it Dane's
 * move?" is built from it, and no two may disagree (SP-419).
 */
function parityStore() {
  let clock = Date.parse('2026-11-27T10:00:00Z');
  const store = openStore(':memory:', { now: () => new Date(clock).toISOString() });
  const human = store.createActor({ kind: 'human', name: 'Operator' });
  const machine = store.createActor({ kind: 'machine', name: 'Loop' });
  store.createProject({ slug: 'alpha', name: 'Alpha', prefix: 'AL', operator: human.id });
  const file = (name, status, assignee = human.id) => store.fileTicket({ project: 'alpha', actor: machine.id, name, status, ...(assignee == null ? {} : { assignee }) });
  const say = (t, author, body) => { clock += 60_000; store.postComment({ ticket: t.id, author: author.id, body }); };

  const asked = file('Asked, not answered', 'needs your input');
  say(asked, machine, 'Which of the two?');
  const answered = file('Answered', 'needs your input');
  say(answered, machine, 'Which of the two?');
  say(answered, human, 'copy');
  const ready = file('Ready, no word yet', 'ready to launch');
  say(ready, machine, 'PR opened: https://github.com/example/repo/pull/20');
  say(ready, machine, 'REVIEW: PASSED — all green.');
  const standing = file('Merge word stands', 'ready to launch');
  say(standing, machine, 'PR opened: https://github.com/example/repo/pull/21');
  say(standing, machine, 'REVIEW: PASSED — all green.');
  say(standing, human, 'merge');
  say(standing, machine, 'The pull request is behind main; your approval is still standing.');
  const merged = file('Already merged', 'ready to launch');
  say(merged, machine, 'PR opened: https://github.com/example/repo/pull/22');
  say(merged, machine, 'REVIEW: PASSED — all green.');
  const unassigned = file('Not assigned to him', 'needs your input', null);
  say(unassigned, machine, 'Which of the two?');
  const held = file('Answered while the relay fails', 'ready to launch');
  say(held, machine, 'PR opened: https://github.com/example/repo/pull/23');
  say(held, machine, 'REVIEW: PASSED — all green.');
  say(held, human, 'merge');
  const queued = file('A machine status', 'queued', null);

  const prStates = new Map([
    [ready.id, { number: 20, state: 'OPEN' }],
    [standing.id, { number: 21, state: 'OPEN' }],
    [merged.id, { number: 22, state: 'MERGED' }],
    [held.id, { number: 23, state: 'OPEN' }],
  ]);
  const pipeline = {
    slug: 'alpha',
    stages: STAGES.map(({ name, job }) => ({
      name, job, logged: true, running: false, nextDue: null,
      ...(job === 'relay' ? { failing: true, failingReason: 'keeps failing', failingSince: '2026-11-27T09:00:00.000Z' } : {}),
    })),
  };
  const ids = { asked: asked.id, answered: answered.id, ready: ready.id, standing: standing.id, merged: merged.id, unassigned: unassigned.id, held: held.id, queued: queued.id };
  return { store, human, prStates, pipeline, ids };
}

/** Each view's set of tickets that wait on Dane, sorted, built from one store. */
function viewsOf({ store, human, prStates, pipeline }) {
  const all = store.listTickets('alpha').map((t) => t.id);
  const board = boardOf(store, 'alpha', { viewerId: human.id, prStates });
  return {
    console: consoleOf(store, { pipeline, prStates }).tickets.filter((t) => t.waitingOnOperator).map((t) => t.id).sort(),
    // GET /waiting: the bell, the Waiting on You page and the mlist page's Waiting for me list all read this.
    waitingOnYou: waitingFor(store, human.id, { pipeline, prStates }).waiting.map((r) => r.id).sort(),
    ticketPage: all.filter((id) => threadOf(store, id, { pipeline, prStates }).waitingOnOperator).sort(),
    tasksPage: board.columns.flatMap((c) => c.tickets).filter((t) => t.waiting).map((t) => t.id).sort(),
  };
}

test('every view agrees on which tickets wait on Dane, from one store (SP-419)', () => {
  const fixture = parityStore();
  const views = viewsOf(fixture);
  const expected = [fixture.ids.asked, fixture.ids.ready].sort();
  for (const [name, waiting] of Object.entries(views)) {
    assert.deepEqual(waiting, expected, `${name} disagrees about which tickets wait on Dane`);
  }
});

test('the views agree on whose answer is in and whose merge word stands (SP-419)', () => {
  const fixture = parityStore();
  const { store, prStates, pipeline, ids } = fixture;
  const board = boardOf(store, 'alpha', { viewerId: fixture.human.id, prStates }).columns.flatMap((c) => c.tickets);
  const tiles = consoleOf(store, { pipeline, prStates }).tickets;
  for (const id of Object.values(ids)) {
    const thread = threadOf(store, id, { pipeline, prStates });
    const row = board.find((t) => t.id === id);
    const tile = tiles.find((t) => t.id === id);
    assert.equal(row.answerIn, thread.answerIn, `${id}: Tasks page and ticket page on answerIn`);
    assert.equal(tile.answerIn, thread.answerIn, `${id}: Console and ticket page on answerIn`);
    assert.equal(row.mergeStands, thread.mergeStands, `${id}: Tasks page and ticket page on mergeStands`);
  }
  assert.equal(threadOf(store, ids.answered, { prStates }).answerIn, true);
  assert.equal(threadOf(store, ids.standing, { prStates }).mergeStands, true);
});

test('the ticket held up by a failing relay is held on the ticket page and left off Waiting on You (SP-419)', () => {
  const { store, human, prStates, pipeline, ids } = parityStore();
  assert.deepEqual(threadOf(store, ids.held, { pipeline, prStates }).heldUp, { stage: 'Relay', job: 'relay', reason: 'keeps failing', since: '2026-11-27T09:00:00.000Z' });
  const { waiting, unsure } = waitingFor(store, human.id, { pipeline, prStates });
  assert.ok(![...waiting, ...unsure].some((r) => r.id === ids.held));
  // A ticket that truly waits on him is never held up, whatever is failing.
  assert.equal(threadOf(store, ids.asked, { pipeline, prStates }).heldUp, null);
  // The ticket not assigned to him: the verdict cannot tell, so Waiting on You shows it as unsure.
  assert.deepEqual(unsure.map((r) => r.id), [ids.unassigned]);
});

test('whoseMove: one answer per ticket, the same heldUpBy gives (SP-419)', () => {
  const { store, human, prStates, pipeline, ids } = parityStore();
  const lanes = new Map(pipeline.stages.map((s) => [s.job, s]));
  for (const id of Object.values(ids)) {
    const ticket = store.getTicket(id);
    const comments = store.listComments(id).map((c) => ({ ...c, authorKind: store.getActor(c.author)?.kind ?? null }));
    const move = whoseMove(ticket, comments, { operatorId: human.id, prStates, lanes });
    assert.deepEqual(Object.keys(move), ['verdict', 'why', 'waiting', 'answerIn', 'mergeStands', 'heldUp']);
    assert.deepEqual(move.heldUp, heldUpBy(ticket, comments, human.id, lanes, prStates), id);
    assert.equal(move.waiting, move.verdict === 'WAITING', id);
  }
  const queued = store.getTicket(ids.queued);
  assert.deepEqual(whoseMove(queued, [], { operatorId: human.id }), { verdict: null, why: null, waiting: false, answerIn: false, mergeStands: false, heldUp: null });
  assert.equal(whoseMove(store.getTicket(ids.asked), [], {}).verdict, null, 'no operator, no verdict');
});

test('the parity check catches a reader that drops the pull request\'s state (SP-419)', () => {
  const fixture = parityStore();
  const views = viewsOf(fixture);
  // The ticket page as it would read with no GitHub answer: the merged pull request then looks like his move.
  const blind = Object.values(fixture.ids).filter((id) => threadOf(fixture.store, id, { pipeline: fixture.pipeline }).waitingOnOperator).sort();
  assert.ok(blind.includes(fixture.ids.merged));
  assert.notDeepEqual(blind, views.console, 'a reader without prStates disagrees with the Console');
});
