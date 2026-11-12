import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from './store.mjs';
import { consoleOf } from './pageData.mjs';
import { STAGES } from './pipeline.mjs';
import loopStatuses from '../lib/loopStatuses.js';

const { STAGE_ORDER } = loopStatuses;
const IN_FLIGHT = STAGE_ORDER.filter((s) => s !== 'Live');

/** A store on a clock the test moves, an operator, a loop, and project alpha. */
function fixture() {
  let clock = Date.parse('2026-11-12T10:00:00Z');
  const store = openStore(':memory:', { now: () => new Date(clock).toISOString() });
  const tick = (ms = 60_000) => { clock += ms; };
  const human = store.createActor({ kind: 'human', name: 'Operator' });
  const machine = store.createActor({ kind: 'machine', name: 'Loop' });
  store.createProject({ slug: 'alpha', name: 'Alpha', prefix: 'AL', operator: human.id, logo: 'https://alpha.example/logo.png' });
  return { store, human, machine, tick };
}

/** A Pipeline Status answer for `slug`, each lane as given, the rest with nothing logged. */
function pipelineFor(slug, lanes) {
  return {
    slug,
    stages: STAGES.map(({ name, job }) => ({ name, job, logged: false, running: false, lastStart: null, lastEnd: null, lastExit: null, interval: 1800, nextDue: null, ...(lanes[job] ?? {}) })),
  };
}

const BUILD_DUE = '2026-11-12T11:30:00.000Z';
const REVIEW_DUE = '2026-11-12T11:45:00.000Z';
const ALL_KNOWN = {
  'loop-build': { logged: true, nextDue: BUILD_DUE },
  'loop-review': { logged: true, nextDue: REVIEW_DUE },
  'loop-intake': { logged: true, running: true },
};

test('consoleOf lists every ticket but Live, in STAGE_ORDER, each with the fields a Console tile shows, and every project with its logo', () => {
  const { store, human, machine } = fixture();
  store.createProject({ slug: 'beta', name: 'Beta', prefix: 'BE', operator: human.id });
  const filed = IN_FLIGHT.slice().reverse().map((status) => store.fileTicket({ project: 'alpha', actor: machine.id, name: `In ${status}`, status, tags: ['epic-x'] }));
  store.fileTicket({ project: 'alpha', actor: machine.id, name: 'Done', status: 'Live' });
  const beta = store.fileTicket({ project: 'beta', actor: machine.id, name: 'Beta work', status: 'Queued', priority: 'high', assignee: human.id });
  const review = filed.find((t) => t.status === 'in review');
  store.postComment({ ticket: review.id, author: machine.id, body: 'PR opened: https://github.com/example/repo/pull/7' });

  const answer = consoleOf(store, { pipeline: pipelineFor('alpha', ALL_KNOWN) });
  assert.deepEqual(answer.projects, [
    { slug: 'alpha', name: 'Alpha', prefix: 'AL', logo: 'https://alpha.example/logo.png' },
    { slug: 'beta', name: 'Beta', prefix: 'BE', logo: null },
  ]);
  assert.ok(!answer.tickets.some((t) => t.name === 'Done'), 'a Live ticket is not in flight');
  assert.deepEqual(answer.tickets.map((t) => t.status), ['Requested', 'Rework', 'Queued', 'Queued', 'Building', 'In review', 'Needs your input', 'Ready to launch']);
  for (const t of answer.tickets) {
    assert.deepEqual(Object.keys(t).sort(), ['answerIn', 'assignee', 'id', 'name', 'nextChange', 'priority', 'project', 'pullRequest', 'stageSince', 'status', 'tags', 'updatedAt', 'waitingOnOperator'].sort());
  }
  const b = answer.tickets.find((t) => t.id === beta.id);
  assert.deepEqual([b.project, b.priority, b.assignee, b.pullRequest], ['beta', 'high', 'Operator', null]);
  assert.equal(b.nextChange, null, 'beta is not the project whose loop logs this tracker reads');
  assert.equal(answer.tickets.find((t) => t.id === review.id).pullRequest, 'https://github.com/example/repo/pull/7');
  assert.deepEqual(answer.tickets.find((t) => t.status === 'Requested').tags, ['epic-x']);
});

test('consoleOf: next change follows each stage to the lane that acts on it, from the Pipeline Status answer', () => {
  const { store, machine } = fixture();
  for (const status of IN_FLIGHT) store.fileTicket({ project: 'alpha', actor: machine.id, name: status, status });
  const next = Object.fromEntries(consoleOf(store, { pipeline: pipelineFor('alpha', ALL_KNOWN) }).tickets.map((t) => [t.status, t.nextChange]));
  assert.deepEqual(next, {
    Requested: { kind: 'lane', lane: 'Intake', job: 'loop-intake', running: true, due: null },
    Rework: { kind: 'lane', lane: 'Build', job: 'loop-build', running: false, due: BUILD_DUE },
    Queued: { kind: 'lane', lane: 'Build', job: 'loop-build', running: false, due: BUILD_DUE },
    Building: { kind: 'running', lane: 'Build', job: 'loop-build' },
    'In review': { kind: 'lane', lane: 'Review', job: 'loop-review', running: false, due: REVIEW_DUE },
    'Needs your input': { kind: 'operator' },
    'Ready to launch': { kind: 'operator' },
  });
});

test('consoleOf: next change is null, never a guess, when the lane\'s time cannot be read', () => {
  const { store, machine } = fixture();
  for (const status of ['Requested', 'Queued', 'In review']) store.fileTicket({ project: 'alpha', actor: machine.id, name: status, status });
  const nulls = (pipeline) => consoleOf(store, { pipeline }).tickets.map((t) => t.nextChange);
  // No logs at all (the tracker could not read them, or has no project config).
  assert.deepEqual(nulls(null), [null, null, null]);
  // Each lane logged nothing; or logged, idle, with no next time.
  assert.deepEqual(nulls(pipelineFor('alpha', {})), [null, null, null]);
  assert.deepEqual(nulls(pipelineFor('alpha', { 'loop-intake': { logged: true }, 'loop-build': { logged: true }, 'loop-review': { logged: true } })), [null, null, null]);
  // The logs read are another project's.
  assert.deepEqual(nulls(pipelineFor('beta', ALL_KNOWN)), [null, null, null]);
});

test('consoleOf: stageSince is when the ticket entered its status, not its last edit; waitingOnOperator and answerIn follow the loop\'s own verdict', () => {
  const { store, human, machine, tick } = fixture();
  const t = store.fileTicket({ project: 'alpha', actor: machine.id, name: 'Moves', status: 'Queued' });
  tick();
  store.changeTicket(t.id, { actor: machine.id, status: 'needs your input', assignee: human.id });
  tick();
  store.changeTicket(t.id, { actor: machine.id, name: 'Moves, renamed' });
  const one = () => consoleOf(store).tickets[0];
  const enteredAt = store.listEvents(t.id).filter((e) => e.field === 'status').at(-1).at;
  assert.equal(one().stageSince, enteredAt);
  assert.notEqual(one().updatedAt, enteredAt, 'the rename moved updatedAt, not stageSince');
  assert.equal(store.getTicket(t.id).status, 'needs your input');
  assert.equal(one().waitingOnOperator, true);
  assert.equal(one().answerIn, false);
  tick();
  store.postComment({ ticket: t.id, author: human.id, body: 'go' });
  assert.equal(one().answerIn, true);
  assert.equal(one().waitingOnOperator, false, 'his answer is in, so it no longer waits on him');
});

test('consoleOf narrows to the projects `only` lets through', () => {
  const { store, human, machine } = fixture();
  store.createProject({ slug: 'beta', name: 'Beta', prefix: 'BE', operator: human.id });
  store.fileTicket({ project: 'alpha', actor: machine.id, name: 'Seen', status: 'Queued' });
  store.fileTicket({ project: 'beta', actor: machine.id, name: 'Hidden', status: 'Queued' });
  const answer = consoleOf(store, { only: new Set(['alpha']) });
  assert.deepEqual(answer.projects.map((p) => p.slug), ['alpha']);
  assert.deepEqual(answer.tickets.map((t) => t.name), ['Seen']);
});
