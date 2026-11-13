import test from 'node:test';
import assert from 'node:assert/strict';
import { DAY_MS, followReleases, moveLine, quietMovePlan, rolledBackFrom } from './releaseFollow.mjs';

const NOW = Date.parse('2026-11-13T15:00:00Z');
const newest = { name: 'release-4', number: 4, commit: 'a'.repeat(40) };
const runs3 = [{ release: 'release-3' }, { release: 'release-2' }];
const base = { quietDays: 3, history: runs3, newest, releasedAt: NOW - 4 * DAY_MS, alarms: [], now: NOW };

test('rolledBackFrom: a release some later entry replaced with a lower number (SP-277)', () => {
  assert.deepEqual([...rolledBackFrom([])], []);
  assert.deepEqual([...rolledBackFrom([{ release: 'release-3' }, { release: 'release-2' }, { release: 'release-1' }])], []);
  // ran 4, rolled back to 3, then named 5: 4 was rolled back from, 5 was not.
  assert.deepEqual([...rolledBackFrom([{ release: 'release-5' }, { release: 'release-3' }, { release: 'release-4' }, { release: 'release-3' }])], ['release-4']);
  // two roll-backs in a row: 5 and 4 both.
  assert.deepEqual([...rolledBackFrom([{ release: 'release-3' }, { release: 'release-4' }, { release: 'release-5' }])].sort(), ['release-4', 'release-5']);
});

test('quietMovePlan: quiet days 0 never moves (SP-277)', () => {
  assert.equal(quietMovePlan({ ...base, quietDays: 0 }).act, 'off');
  assert.equal(quietMovePlan({ ...base, quietDays: '0' }).act, 'off');
});

test('quietMovePlan: after N quiet days it moves to the newest; before them it waits (SP-277)', () => {
  const plan = quietMovePlan(base);
  assert.equal(plan.act, 'move');
  assert.equal(plan.from, 'release-3');
  assert.equal(plan.to, 'release-4');
  assert.equal(quietMovePlan({ ...base, releasedAt: NOW - 3 * DAY_MS }).act, 'move', 'exactly N days is enough');
  const early = quietMovePlan({ ...base, releasedAt: NOW - 2 * DAY_MS });
  assert.equal(early.act, 'wait');
  assert.match(early.why, /release-4 has run on Spirality's own lanes for 2 days of the 3 days set/);
});

test('quietMovePlan: an ALARM since the release reached main holds it; one before does not (SP-277)', () => {
  const held = quietMovePlan({ ...base, alarms: [NOW - DAY_MS] });
  assert.equal(held.act, 'held');
  assert.match(held.why, /1 ALARM post\(s\) on Spirality's bus since release-4 reached main/);
  assert.equal(quietMovePlan({ ...base, alarms: [NOW - 10 * DAY_MS] }).act, 'move');
});

test('quietMovePlan: never chooses a release it was rolled back from (SP-277)', () => {
  const history = [{ release: 'release-3' }, { release: 'release-4' }, { release: 'release-3' }];
  const plan = quietMovePlan({ ...base, history });
  assert.equal(plan.act, 'stay');
  assert.match(plan.why, /rolled back from release-4, so that release waits for a person to name it/);
  // A newer one than the bad one is fair game.
  assert.equal(quietMovePlan({ ...base, history, newest: { name: 'release-5', number: 5 } }).act, 'move');
});

test('quietMovePlan: nothing to move to, and what it cannot tell, are said plainly (SP-277)', () => {
  assert.match(quietMovePlan({ ...base, newest: null }).why, /no release has been cut yet/);
  assert.match(quietMovePlan({ ...base, history: [] }).why, /no release is named for it yet; the first one is named by hand/);
  assert.match(quietMovePlan({ ...base, history: [{ release: 'release-4' }] }).why, /already runs release-4, the newest/);
  assert.equal(quietMovePlan({ ...base, releasedAt: null }).act, 'unknown');
  const deaf = quietMovePlan({ ...base, alarms: null, alarmsWhy: 'no bus' });
  assert.equal(deaf.act, 'unknown');
  assert.match(deaf.why, /could not tell whether Spirality's own lanes were quiet: no bus/);
});

test('moveLine names both releases and how to go back, and is not an alarm (SP-277)', () => {
  const line = moveLine({ slug: 'beta', projectName: 'Beta', from: 'release-3', to: 'release-4', quietDays: 3 });
  assert.match(line, /^Spirality release: Beta moved from release-3 to release-4 by itself/);
  assert.match(line, /release back --project beta$/);
  assert.doesNotMatch(line, /^ALARM:/i);
});

/** Fakes for followReleases, recording every write. */
function fakes({ alarms = { times: [] }, releasedAt = NOW - 5 * DAY_MS, nameFails = false, readBack = null, postFails = false, buses = ['beta-bus'] } = {}) {
  const calls = { named: [], posted: [], alarmReads: 0, timeReads: 0 };
  const io = {
    releasedAt: () => { calls.timeReads += 1; return releasedAt; },
    alarms: async () => { calls.alarmReads += 1; return alarms; },
    nameRelease: async (slug, to) => { calls.named.push([slug, to]); return nameFails ? { ok: false, problem: 'HTTP 500' } : { ok: true, release: readBack ?? to }; },
    busOf: (slug) => (buses.includes(`${slug}-bus`) ? `${slug}-bus` : null),
    postBus: async (bus, text) => { calls.posted.push([bus, text]); return postFails ? { ok: false, problem: 'HTTP 502' } : { ok: true }; },
  };
  return { io, calls };
}

const projects = [
  { slug: 'home', name: 'Home', own: true, history: [], quietDays: 5 },
  { slug: 'beta', name: 'Beta', own: false, history: runs3, quietDays: 3 },
  { slug: 'gamma', name: 'Gamma', own: false, history: runs3, quietDays: 0 },
];

test('followReleases moves each project past its quiet days, reads it back, tells its bus; never Spirality\'s own or one set to 0 (SP-277)', async () => {
  const { io, calls } = fakes();
  const out = await followReleases({ projects, newest, io, now: NOW });
  assert.deepEqual(out.problems, []);
  assert.deepEqual(out.moved, ['beta']);
  assert.deepEqual(calls.named, [['beta', 'release-4']]);
  assert.equal(calls.posted.length, 1);
  assert.equal(calls.posted[0][0], 'beta-bus');
  assert.match(calls.posted[0][1], /Beta moved from release-3 to release-4 by itself/);
  assert.deepEqual(out.lines, ['beta\trelease-follow\tmoved: release-3 -> release-4, read back (release-4 has run quietly on Spirality\'s own lanes for 5 days (3 days set)); told its bus beta-bus']);
});

test('followReleases with every project at 0 reads nothing and writes nothing (SP-277)', async () => {
  const { io, calls } = fakes();
  const out = await followReleases({ projects: projects.map((p) => ({ ...p, quietDays: 0 })), newest, io, now: NOW });
  assert.deepEqual(out, { lines: [], problems: [], moved: [] });
  assert.deepEqual(calls, { named: [], posted: [], alarmReads: 0, timeReads: 0 });
});

test('followReleases: an alarm holds it, a dry run writes nothing, and a project still waiting reads no bus (SP-277)', async () => {
  const loud = fakes({ alarms: { times: [NOW - DAY_MS] } });
  const held = await followReleases({ projects, newest, io: loud.io, now: NOW });
  assert.deepEqual(loud.calls.named, []);
  assert.match(held.lines[0], /^beta\trelease-follow\theld: 1 ALARM post/);
  assert.deepEqual(held.problems, []);

  const dry = fakes();
  const would = await followReleases({ projects, newest, io: dry.io, now: NOW, dryRun: true });
  assert.deepEqual(dry.calls.named, []);
  assert.deepEqual(dry.calls.posted, []);
  assert.match(would.lines[0], /would-move: release-3 -> release-4/);

  const early = fakes({ releasedAt: NOW - DAY_MS });
  const wait = await followReleases({ projects, newest, io: early.io, now: NOW });
  assert.match(wait.lines[0], /^beta\trelease-follow\twait: /);
  assert.equal(early.calls.alarmReads, 0);
});

test('followReleases: a step that fails says so, and nothing is claimed that did not happen (SP-277)', async () => {
  const deaf = fakes({ alarms: { problem: "home's project config names no bus" } });
  const noBus = await followReleases({ projects, newest, io: deaf.io, now: NOW });
  assert.deepEqual(deaf.calls.named, []);
  assert.match(noBus.problems[0], /release-follow beta: could not tell whether Spirality's own lanes were quiet: home's project config names no bus; nothing moved/);

  const untimed = fakes({ releasedAt: { problem: 'commit not here' } });
  const noTime = await followReleases({ projects, newest, io: untimed.io, now: NOW });
  assert.match(noTime.problems[0], /could not tell when release-4 reached Spirality's main.*\(commit not here\)/);

  const refused = fakes({ nameFails: true });
  const failed = await followReleases({ projects, newest, io: refused.io, now: NOW });
  assert.deepEqual(failed.moved, []);
  assert.match(failed.problems[0], /naming release-4 FAILED \(HTTP 500\); it still runs release-3/);
  assert.deepEqual(refused.calls.posted, [], 'no bus line for a move that did not happen');

  const wrong = fakes({ readBack: 'release-3' });
  const notStuck = await followReleases({ projects, newest, io: wrong.io, now: NOW });
  assert.match(notStuck.problems[0], /release-4 was named but read back as release-3; treat it as not moved/);
  assert.deepEqual(wrong.calls.posted, []);

  const mute = fakes({ postFails: true });
  const unheard = await followReleases({ projects, newest, io: mute.io, now: NOW });
  assert.deepEqual(unheard.moved, ['beta']);
  assert.match(unheard.problems[0], /moved to release-4 \(read back\), but the line on its bus beta-bus did not post \(HTTP 502\)/);

  const busless = fakes({ buses: [] });
  const quiet = await followReleases({ projects, newest, io: busless.io, now: NOW });
  assert.deepEqual(quiet.problems, []);
  assert.match(quiet.lines[0], /it has no bus, so nothing was posted/);
});
