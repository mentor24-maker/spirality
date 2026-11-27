import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from './store.mjs';
import { boardOf, consoleOf, waitingFor, CONSOLE_LIVE_MS } from './pageData.mjs';
import { consoleWaiting } from './web/render-console.mjs';
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
const RELAY_DUE = '2026-11-12T10:03:00.000Z';
const ALL_KNOWN = {
  'loop-build': { logged: true, nextDue: BUILD_DUE },
  'loop-review': { logged: true, nextDue: REVIEW_DUE },
  'loop-intake': { logged: true, running: true },
  relay: { logged: true, nextDue: RELAY_DUE },
};

test('consoleOf lists every ticket but one Live for more than a day, in STAGE_ORDER, each with the fields a Console tile shows, and every project with its logo', () => {
  const { store, human, machine } = fixture();
  store.createProject({ slug: 'beta', name: 'Beta', prefix: 'BE', operator: human.id });
  const filed = IN_FLIGHT.slice().reverse().map((status) => store.fileTicket({ project: 'alpha', actor: machine.id, name: `In ${status}`, status, tags: ['epic-x'] }));
  store.fileTicket({ project: 'alpha', actor: machine.id, name: 'Done', status: 'Live' });
  const beta = store.fileTicket({ project: 'beta', actor: machine.id, name: 'Beta work', status: 'Queued', priority: 'high', assignee: human.id });
  const review = filed.find((t) => t.status === 'in review');
  store.postComment({ ticket: review.id, author: machine.id, body: 'PR opened: https://github.com/example/repo/pull/7' });

  const answer = consoleOf(store, { pipeline: pipelineFor('alpha', ALL_KNOWN), now: Date.parse('2026-11-14T10:00:00Z') });
  assert.deepEqual(answer.projects, [
    { slug: 'alpha', name: 'Alpha', prefix: 'AL', logo: 'https://alpha.example/logo.png' },
    { slug: 'beta', name: 'Beta', prefix: 'BE', logo: null },
  ]);
  assert.ok(!answer.tickets.some((t) => t.name === 'Done'), 'a ticket Live for two days is off the map');
  assert.deepEqual(answer.tickets.map((t) => t.status), ['Requested', 'Rework', 'Queued', 'Queued', 'Building', 'In review', 'Needs your input', 'Ready to launch']);
  for (const t of answer.tickets) {
    assert.deepEqual(Object.keys(t).sort(), ['answerIn', 'assignee', 'id', 'name', 'nextChange', 'priority', 'project', 'pullRequest', 'stageSince', 'status', 'tags', 'updatedAt', 'waitingOnOperator', 'hold'].sort());
  }
  const b = answer.tickets.find((t) => t.id === beta.id);
  assert.deepEqual([b.project, b.priority, b.assignee, b.pullRequest], ['beta', 'high', 'Operator', null]);
  assert.equal(b.nextChange, null, 'beta is not the project whose loop logs this tracker reads');
  assert.equal(answer.tickets.find((t) => t.id === review.id).pullRequest, 'https://github.com/example/repo/pull/7');
  assert.deepEqual(answer.tickets.find((t) => t.status === 'Requested').tags, ['epic-x']);
});

test('consoleOf: next change follows each stage to the lane that acts on it, from the Pipeline Status answer', () => {
  const { store, human, machine } = fixture();
  // His two statuses with him assigned and no word of his: the verdict says they wait on him.
  const his = new Set(['Needs your input', 'Ready to launch']);
  for (const status of IN_FLIGHT) store.fileTicket({ project: 'alpha', actor: machine.id, name: status, status, ...(his.has(status) ? { assignee: human.id } : {}) });
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

/**
 * The incident's three tiles (11/26): an answer of his is the newest word, a
 * merge word stands on a pull request behind main, and the pull request has
 * already merged; beside two that truly wait on him and one the verdict
 * cannot tell (his lane, nobody assigned).
 */
function incidentStore() {
  const { store, human, machine, tick } = fixture();
  const file = (name, status) => store.fileTicket({ project: 'alpha', actor: machine.id, name, status, assignee: human.id });
  const say = (t, author, body) => { tick(); store.postComment({ ticket: t.id, author: author.id, body }); };
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
  const unsure = store.fileTicket({ project: 'alpha', actor: machine.id, name: 'Nobody assigned', status: 'needs your input' });
  const prStates = new Map([
    [ready.id, { number: 20, state: 'OPEN' }],
    [standing.id, { number: 21, state: 'OPEN' }],
    [merged.id, { number: 22, state: 'MERGED' }],
  ]);
  return { store, human, prStates, ids: { asked: asked.id, answered: answered.id, ready: ready.id, standing: standing.id, merged: merged.id, unsure: unsure.id } };
}

test('consoleOf: the Console rings exactly the tickets Waiting on You lists, from one store; the rest name the Relay\'s next pass (SP-414)', () => {
  const { store, human, prStates, ids } = incidentStore();
  const pipeline = pipelineFor('alpha', ALL_KNOWN);
  const tiles = consoleOf(store, { pipeline, prStates }).tickets;
  const ringed = tiles.filter(consoleWaiting).map((t) => t.id).sort();
  const listed = waitingFor(store, human.id, { pipeline, prStates }).waiting.map((r) => r.id).sort();
  assert.deepEqual(ringed, listed, 'a ringed tile is on Waiting on You, and nothing else is ringed');
  assert.deepEqual(ringed, [ids.asked, ids.ready].sort());
  const tile = (id) => tiles.find((t) => t.id === id);
  for (const id of [ids.asked, ids.ready]) assert.deepEqual(tile(id).nextChange, { kind: 'operator' });
  const relay = { kind: 'lane', lane: 'Relay', job: 'relay', running: false, due: RELAY_DUE };
  for (const id of [ids.answered, ids.standing, ids.merged]) {
    assert.equal(tile(id).waitingOnOperator, false, id);
    assert.deepEqual(tile(id).nextChange, relay, `${id}: the relay moves it next`);
  }
  // The old rule would ring these: his answer is in, and the status is his.
  assert.equal(tile(ids.answered).answerIn, true);
  for (const id of [ids.standing, ids.merged]) assert.equal(tile(id).status, 'Ready to launch');
  // CANNOT_TELL: never ringed, and the dash rather than a guessed time.
  assert.equal(consoleWaiting(tile(ids.unsure)), false);
  assert.equal(tile(ids.unsure).nextChange, null);
});

test('consoleOf: a ticket off his list shows the Relay running now, or null when the relay\'s time is not known (SP-414)', () => {
  const { store, prStates, ids } = incidentStore();
  const next = (pipeline) => consoleOf(store, { pipeline, prStates }).tickets.find((t) => t.id === ids.answered).nextChange;
  assert.deepEqual(next(pipelineFor('alpha', { relay: { logged: true, running: true } })), { kind: 'lane', lane: 'Relay', job: 'relay', running: true, due: null });
  assert.equal(next(pipelineFor('alpha', {})), null, 'the relay logged nothing');
  assert.equal(next(pipelineFor('alpha', { relay: { logged: true } })), null, 'idle with no next time');
  assert.equal(next(null), null, 'no logs at all');
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

test('consoleOf carries the tickets that went Live in the last day, for the map\'s Live area, and none older (SP-333)', () => {
  const { store, machine, tick } = fixture();
  const old = store.fileTicket({ project: 'alpha', actor: machine.id, name: 'Old launch', status: 'In review' });
  const fresh = store.fileTicket({ project: 'alpha', actor: machine.id, name: 'New launch', status: 'In review' });
  store.changeTicket(old.id, { actor: machine.id, status: 'live' });
  const oldAt = Date.parse(store.listEvents(old.id).filter((e) => e.field === 'status').at(-1).at);
  tick(20 * 3_600_000);
  store.changeTicket(fresh.id, { actor: machine.id, status: 'live' });
  const freshAt = Date.parse(store.listEvents(fresh.id).filter((e) => e.field === 'status').at(-1).at);
  const live = (now) => consoleOf(store, { now }).tickets.filter((t) => t.status === 'Live').map((t) => t.name);
  assert.deepEqual(live(freshAt), ['Old launch', 'New launch']);
  assert.deepEqual(live(oldAt + CONSOLE_LIVE_MS + 1), ['New launch'], 'a day on, the older one is gone');
  assert.deepEqual(live(freshAt + CONSOLE_LIVE_MS + 1), []);
  const t = consoleOf(store, { now: freshAt }).tickets.find((x) => x.name === 'New launch');
  assert.equal(t.stageSince, new Date(freshAt).toISOString(), 'when it went Live, for its fade');
  assert.equal(t.nextChange, null);
  assert.equal(t.waitingOnOperator, false);
});

test('consoleOf reads no events for a ticket last edited before the Live window: an old launch costs nothing on the minute\'s redraw (SP-333)', () => {
  const { store, machine, tick } = fixture();
  const old = store.fileTicket({ project: 'alpha', actor: machine.id, name: 'Old launch', status: 'Live' });
  tick(2 * CONSOLE_LIVE_MS);
  store.fileTicket({ project: 'alpha', actor: machine.id, name: 'In flight', status: 'Queued' });
  const read = [];
  const listEvents = store.listEvents.bind(store);
  const watched = Object.create(store, { listEvents: { value: (id, ...rest) => { read.push(id); return listEvents(id, ...rest); } } });
  const names = consoleOf(watched, { now: Date.parse(old.updatedAt) + 2 * CONSOLE_LIVE_MS }).tickets.map((t) => t.name);
  assert.deepEqual(names, ['In flight']);
  assert.ok(!read.includes(old.id), 'the old launch\'s events were never read');
});

test('consoleOf: a Queued ticket carries what holds it from the build loop, the reasons holdReasons gives, and every other ticket hold: null (SP-377)', () => {
  const { store, machine } = fixture();
  const open = store.fileTicket({ project: 'alpha', actor: machine.id, name: 'Still open', status: 'Building' });
  const live = store.fileTicket({ project: 'alpha', actor: machine.id, name: 'Shipped', status: 'Live' });
  const file = (name, description, status = 'Queued') => store.fileTicket({ project: 'alpha', actor: machine.id, name, status, description });
  const held = file('Held', `Waits on: ${open.id}`);
  const typo = file('Odd line', 'Waits on: the API ticket');
  const missing = file('Missing', 'Waits on: AL-999');
  const free = file('Free', `Waits on: ${live.id}`);
  const plain = file('No line', 'Nothing to wait on.');
  const rework = file('Rework', `Waits on: ${open.id}`, 'Rework');
  const byId = new Map(consoleOf(store).tickets.map((t) => [t.id, t]));
  assert.deepEqual(byId.get(held.id).hold, { reasons: [`waits on ${open.id.toLowerCase()} (still open)`] });
  assert.deepEqual(byId.get(typo.id).hold, { reasons: ['its Waits on: line names "the API ticket", which is not a ticket id or link'] });
  assert.deepEqual(byId.get(missing.id).hold, { reasons: ['waits on al-999 (could not be read)'] });
  assert.equal(byId.get(free.id).hold, null, 'its prerequisite is Live');
  assert.equal(byId.get(plain.id).hold, null, 'no Waits on: line');
  assert.equal(byId.get(rework.id).hold, null, 'only Queued tickets are held');
  assert.equal(byId.get(open.id).hold, null);
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

test('the Tasks page lists each status as the door does: priority, then place, then oldest (SP-249)', () => {
  const { store, human, machine, tick } = fixture();
  const file = (name, priority = null) => { tick(); return store.fileTicket({ project: 'alpha', actor: machine.id, name, status: 'queued', priority }).id; };
  const unplaced = file('unplaced, oldest', 'normal');
  const two = file('placed 2', 'normal');
  const one = file('placed 1', 'normal');
  const high = file('high, unplaced', 'high');
  store.orderTickets('alpha', { ids: [one, two], actor: human.id });
  const expected = [high, one, two, unplaced];
  const queued = boardOf(store, 'alpha').columns.find((c) => c.status === 'Queued');
  assert.deepEqual(queued.tickets.map((t) => t.id), expected);
  assert.deepEqual(consoleOf(store).tickets.filter((t) => String(t.status).toLowerCase() === 'queued').map((t) => t.id), expected);
});
