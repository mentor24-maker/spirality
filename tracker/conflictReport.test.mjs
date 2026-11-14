import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  conflictReportOf, readSignal, mergedNumber, prOpenedNumber, familyKeys, settingsAt, settingsLabel, shortSeconds,
  CONFLICT_LIST_LIMIT,
} from './conflictReport.mjs';
import mainMoved from '../lib/mainMoved.js';
import conflictWork from '../lib/conflictWork.js';
import { openStore } from './store.mjs';
import { reportsOf } from './pageData.mjs';

const T = (iso) => Date.parse(iso);
const REPO = 'https://github.com/o/r';
const opened = (n) => `PR opened: ${REPO}/pull/${n}`;
const merged = (n) => `Merged: PR #${n} (${REPO}/pull/${n}) squash-merged into main at 2026-11-01T00:00:00Z, on your comment 1.`;
const moved = (mergedPr, pr, kind, files = []) => mainMoved.mainMovedComment({
  merged: { number: mergedPr, url: `${REPO}/pull/${mergedPr}` },
  pr: { number: pr },
  base: 'main',
  verdict: { kind, files, reason: 'x' },
});
const DEFAULTS = { 'wake.loop-build': '1800', 'wake.loop-review': '1800', 'wake.relay': '600', 'wip-cap': '5' };

/** A ticket row as conflictsOf passes it: steps [iso, status], comments [iso, body]. */
const ticket = (id, { project = 'sp', name = `ticket ${id}`, description = '', steps = [], comments = [] } = {}) => ({
  id, name, project, description,
  steps: steps.map(([at, s]) => [T(at), s]),
  comments: comments.map(([at, body]) => ({ at: T(at), body })),
});

test('readSignal reads the three conflict notes in the shapes their writers produce, and nothing else', () => {
  const note = moved(10, 12, 'conflict', ['docs/A.md', 'tracker/server.mjs']);
  assert.deepEqual(readSignal(note), { kind: 'main-moved', merged: 10, pr: 12, clean: false, conflict: true, files: ['docs/A.md', 'tracker/server.mjs'] });
  assert.equal(readSignal(moved(10, 12, 'same-files', ['x'])).clean, true);
  assert.deepEqual(readSignal(moved(10, 12, 'same-files', ['x'])).files, [], 'only a conflict names conflicting files');
  assert.equal(readSignal(moved(10, 12, 'cannot-tell')).clean, false);
  assert.equal(readSignal(moved(10, 12, 'cannot-tell')).conflict, false);
  const refused = 'MERGE NOT DONE (authorization 901, reason conflict)\n\nYour "merge" was read, but the merge lane did not merge: PR #153 conflicts with main — the same lines.';
  assert.deepEqual(readSignal(refused), { kind: 'merge-refused', pr: 153, files: [] });
  assert.equal(readSignal('MERGE NOT DONE (authorization 901, reason checks-red)\n\nPR #153 conflicts'), null, 'another refusal reason is not a conflict');
  const filed = conflictWork.conflictTicketFiledComment({ id: 'SP-9', url: 'http://t/SP-9', prNumber: 44, localVerdict: { kind: 'conflict' } });
  assert.deepEqual(readSignal(filed), { kind: 'catch-up', pr: 44, files: [] });
  assert.equal(readSignal('REVIEW: sent back — the MAIN MOVED: PR #1 -> PR #2 — conflict note was quoted'), null, 'a quote mid-line is not a note');
  assert.equal(readSignal(null), null);
});

test('mergedNumber reads both relays\' merge notes; prOpenedNumber reads the PR opened line', () => {
  assert.equal(mergedNumber(merged(7)), 7);
  assert.equal(mergedNumber('Merged by Lane Auto: PR #8 (u) squash-merged into main at t.'), 8);
  assert.equal(mergedNumber('MERGED: https://github.com/o/wavecenter/pull/153 (commit bb186eb)'), 153);
  assert.equal(mergedNumber('Not merged: PR #9'), null);
  assert.equal(prOpenedNumber(`${opened(31)}\n\nmore`), 31);
  assert.equal(prOpenedNumber('opened a PR'), null);
});

test('settingsAt: a change before the time gives its new value, the first change after gives the old one, none gives the value now', () => {
  const changes = [
    { setting: 'wake.loop-build', from: '1800', to: '300', at: '2026-11-13T22:00:00Z' },
    { setting: 'wake.loop-build', from: '300', to: '120', at: '2026-11-14T22:00:00Z' },
  ];
  const now = { ...DEFAULTS, 'wake.loop-build': '120', 'wip-cap': '8' };
  assert.equal(settingsAt(changes, now, T('2026-11-01T00:00:00Z'))['wake.loop-build'], '1800');
  assert.equal(settingsAt(changes, now, T('2026-11-14T00:00:00Z'))['wake.loop-build'], '300');
  assert.equal(settingsAt(changes, now, T('2026-11-15T00:00:00Z'))['wake.loop-build'], '120');
  assert.equal(settingsAt(changes, now, T('2026-11-01T00:00:00Z'))['wip-cap'], '8');
  assert.equal(settingsLabel(settingsAt([], DEFAULTS, 0)), 'build 30m · review 30m · relay 10m · cap 5');
  assert.equal(settingsLabel({}), 'build ? · review ? · relay ? · cap ?');
  assert.deepEqual([shortSeconds(3600), shortSeconds(300), shortSeconds(90), shortSeconds('x')], ['1h', '5m', '90s', 'x']);
});

test('familyKeys: Sliced from, being sliced from, and the same Asked words tie siblings; nothing else does', () => {
  const asked = '## Asked\n\n```\nDo the three things.\n```\n\nmore';
  const a = familyKeys({ id: 'SP-1', description: asked }, new Set(['SP-1']));
  const b = familyKeys({ id: 'SP-2', description: `${asked.replace('more', 'Sliced from SP-1 ("x"), slice 2 of 3.')}` });
  assert.ok([...a].some((k) => b.has(k)));
  assert.ok(b.has('id:SP-1'));
  assert.equal(familyKeys({ id: 'SP-3', description: 'no asked block' }).size, 0);
});

test('one conflict, several notes: later MAIN MOVED conflicts and a refused merge join it, a clean MAIN MOVED ends it, a new conflict after is a second one', () => {
  const t = ticket('SP-5', {
    steps: [['2026-11-01T00:00:00Z', 'queued'], ['2026-11-01T01:00:00Z', 'building'], ['2026-11-01T02:00:00Z', 'rework']],
    comments: [
      ['2026-11-01T01:30:00Z', opened(20)],
      ['2026-11-01T03:00:00Z', moved(18, 20, 'conflict', ['a.js'])],
      ['2026-11-01T04:00:00Z', moved(19, 20, 'conflict', ['a.js', 'b.js'])],
      ['2026-11-01T05:00:00Z', moved(21, 20, 'no-overlap')],
      ['2026-11-01T06:00:00Z', moved(22, 20, 'conflict', ['c.js'])],
      ['2026-11-01T06:30:00Z', moved(23, 20, 'cannot-tell')],
    ],
  });
  const r = conflictReportOf({ tickets: [t] });
  assert.equal(r.total, 2);
  const [newest, first] = r.conflicts;
  assert.deepEqual(first.files, ['a.js', 'b.js']);
  assert.equal(first.causedBy.pr, 18, 'the first note names the merge that caused it');
  assert.equal(first.causedBy.inferred, false);
  assert.equal(first.status, 'rework');
  assert.equal(first.prOpenMs, 90 * 60_000);
  assert.deepEqual(newest.files, ['c.js'], 'cannot-tell neither ends it nor adds files');
});

test('moving into In review or Live settles a conflict; a merge refused after that is a new one', () => {
  const t = ticket('SP-6', {
    steps: [['2026-11-01T00:00:00Z', 'building'], ['2026-11-01T04:00:00Z', 'in review'], ['2026-11-01T05:00:00Z', 'ready to launch']],
    comments: [
      ['2026-11-01T00:30:00Z', opened(30)],
      ['2026-11-01T03:00:00Z', moved(29, 30, 'conflict')],
      ['2026-11-01T06:00:00Z', 'MERGE NOT DONE (authorization 1, reason conflict)\n\nPR #30 conflicts with main.'],
      ['2026-11-01T06:10:00Z', 'MERGE NOT DONE (authorization 1, reason conflict)\n\nPR #30 conflicts with main.'],
      ['2026-11-01T06:20:00Z', 'CONFLICT TICKET FILED: PR #30 — http://t/SP-7\n\nwork'],
      ['2026-11-01T09:00:00Z', 'CONFLICT TICKET FILED: PR #30 — http://t/SP-8\n\nThe earlier catch-up, ticket SP-7, was finished'],
    ],
  });
  const r = conflictReportOf({ tickets: [t] });
  assert.equal(r.total, 3, 'one before In review, one at the merge word (with its catch-up), one refiled catch-up');
  assert.deepEqual(r.conflicts[1].kinds, ['merge-refused', 'catch-up']);
  assert.equal(r.conflicts[1].status, 'ready to launch');
});

test('a relay merge note or CONFLICT SETTLED ends a conflict too', () => {
  const t = ticket('WC-1', {
    project: 'wc',
    steps: [['2026-11-01T00:00:00Z', 'live']],
    comments: [
      ['2026-11-01T00:30:00Z', opened(40)],
      ['2026-11-01T01:00:00Z', 'MERGE NOT DONE (authorization 1, reason conflict)\n\nPR #40 conflicts with main.'],
      ['2026-11-01T01:05:00Z', 'CONFLICT SETTLED (authorization 1, reason conflict)'],
      ['2026-11-01T01:10:00Z', 'MERGE NOT DONE (authorization 1, reason conflict)\n\nPR #40 conflicts with main.'],
    ],
  });
  assert.equal(conflictReportOf({ tickets: [t] }).total, 2);
});

test('conflicts per merged pull request, by the settings in force at each merge and each conflict', () => {
  const change = '2026-11-10T00:00:00Z';
  const settings = {
    sp: {
      changes: [{ setting: 'wake.loop-build', from: '1800', to: '300', at: change }],
      current: { ...DEFAULTS, 'wake.loop-build': '300' },
    },
  };
  const done = (id, pr, at) => ticket(id, {
    steps: [['2026-10-01T00:00:00Z', 'building'], [at, 'live']],
    comments: [['2026-10-01T01:00:00Z', opened(pr)], [at, merged(pr)]],
  });
  const tickets = [
    done('SP-1', 1, '2026-11-01T00:00:00Z'),
    done('SP-2', 2, '2026-11-02T00:00:00Z'),
    done('SP-3', 3, '2026-11-11T00:00:00Z'),
    done('SP-4', 4, '2026-11-12T00:00:00Z'),
    // Imported already Live: no merge note and no move into Live after its PR, so no merge counted.
    ticket('SP-9', { steps: [['2026-09-01T00:00:00Z', 'live']], comments: [['2026-10-01T00:00:00Z', opened(9)]] }),
    ticket('SP-5', {
      steps: [['2026-10-01T00:00:00Z', 'in review']],
      comments: [
        ['2026-10-01T01:00:00Z', opened(5)],
        ['2026-11-01T00:00:00Z', moved(1, 5, 'conflict', ['x.js'])],
        ['2026-11-11T00:00:00Z', moved(3, 5, 'no-overlap')],
        ['2026-11-12T00:00:00Z', moved(4, 5, 'conflict', ['x.js', 'y.js'])],
      ],
    }),
  ];
  const r = conflictReportOf({ tickets, settings });
  assert.equal(r.merged, 4);
  assert.equal(r.total, 2);
  assert.equal(r.rate, 0.5);
  const by = Object.fromEntries(r.bySetting.map((g) => [g.setting, g]));
  const before = by['build 30m · review 30m · relay 10m · cap 5'];
  const after = by['build 5m · review 30m · relay 10m · cap 5'];
  assert.deepEqual([before.merged, before.conflicts, before.rate], [2, 1, 0.5]);
  assert.deepEqual([after.merged, after.conflicts, after.rate], [2, 1, 0.5]);
  assert.equal(r.bySetting[0], after, 'newest settings first');
  assert.deepEqual(r.topFiles, [{ file: 'x.js', count: 2 }, { file: 'y.js', count: 1 }]);
  const newest = r.conflicts[0];
  assert.equal(newest.setting, 'build 5m · review 30m · relay 10m · cap 5');
  assert.deepEqual(newest.causedBy, { pr: 4, ticket: 'SP-4', inferred: false });
  // At 11/12 00:00 SP-4's merge note closes its PR at that very moment; SP-5's PR is open.
  assert.equal(newest.openPrs, 1);
  assert.equal(r.conflicts[1].openPrs, 4, 'on 11/1 SP-1 (merging that moment) is not open; SP-2, 3, 4 and 5 are; the import is closed with no known end');
});

test('a conflict with no MAIN MOVED note is blamed on the newest merge before it, marked as inferred; siblings are read from the two tickets', () => {
  const asked = '## Asked\n\n```\nFile the three recommendations.\n```\n';
  const tickets = [
    ticket('SP-1', { description: asked, steps: [['2026-11-01T00:00:00Z', 'building'], ['2026-11-01T03:00:00Z', 'live']], comments: [['2026-11-01T01:00:00Z', opened(1)], ['2026-11-01T03:00:00Z', merged(1)]] }),
    ticket('SP-2', {
      description: asked,
      steps: [['2026-11-01T00:00:00Z', 'ready to launch']],
      comments: [['2026-11-01T01:00:00Z', opened(2)], ['2026-11-01T04:00:00Z', 'CONFLICT TICKET FILED: PR #2 — http://t/SP-3\n\nwork']],
    }),
    ticket('SP-4', {
      steps: [['2026-11-01T00:00:00Z', 'ready to launch']],
      comments: [['2026-11-01T01:00:00Z', opened(4)], ['2026-11-01T04:00:00Z', 'CONFLICT TICKET FILED: PR #4 — http://t/SP-5\n\nwork']],
    }),
  ];
  const r = conflictReportOf({ tickets });
  const of = (id) => r.conflicts.find((c) => c.ticket === id);
  assert.deepEqual(of('SP-2').causedBy, { pr: 1, ticket: 'SP-1', inferred: true });
  assert.equal(of('SP-2').sibling, true);
  assert.equal(of('SP-4').sibling, false);
  assert.deepEqual(r.siblings, { known: 2, count: 1 });
});

test('nothing recorded: zero counts, no rate, empty lists; the list stops at the limit but the counts do not', () => {
  const empty = conflictReportOf({ tickets: [] });
  assert.deepEqual([empty.total, empty.merged, empty.rate, empty.bySetting, empty.conflicts], [0, 0, null, [], []]);
  const comments = [['2026-11-01T00:00:00Z', opened(1)]];
  for (let i = 0; i < CONFLICT_LIST_LIMIT + 5; i += 1) {
    const at = new Date(T('2026-11-01T01:00:00Z') + i * 120_000).toISOString();
    comments.push([at, moved(100 + i, 1, 'conflict')]);
    comments.push([new Date(T(at) + 60_000).toISOString(), moved(1000 + i, 1, 'no-overlap')]);
  }
  const r = conflictReportOf({ tickets: [ticket('SP-1', { steps: [['2026-11-01T00:00:00Z', 'rework']], comments })] });
  assert.equal(r.total, CONFLICT_LIST_LIMIT + 5);
  assert.equal(r.conflicts.length, CONFLICT_LIST_LIMIT);
  assert.equal(r.listed, CONFLICT_LIST_LIMIT);
});

test('reportsOf carries the conflicts, read from the store: notes, status history and the settings changes the Settings page wrote', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-conflicts-'));
  let clock = T('2026-11-01T00:00:00Z');
  const at = (iso) => { clock = T(iso); };
  const store = openStore(join(dir, 'tracker.db'), { now: () => new Date(clock).toISOString() });
  try {
    const loop = store.createActor({ kind: 'machine', name: 'Loop' });
    const dane = store.createActor({ kind: 'human', name: 'Dane' });
    store.createProject({ slug: 'alpha', name: 'Alpha', prefix: 'AL', operator: dane.id });
    const one = store.fileTicket({ project: 'alpha', actor: loop.id, name: 'first', status: 'building' }).id;
    const two = store.fileTicket({ project: 'alpha', actor: loop.id, name: 'second', status: 'building' }).id;
    at('2026-11-01T01:00:00Z');
    store.postComment({ ticket: one, author: loop.id, body: opened(1) });
    store.postComment({ ticket: two, author: loop.id, body: opened(2) });
    at('2026-11-02T00:00:00Z');
    store.setPipelineSetting({ project: 'alpha', setting: 'wake.loop-build', value: '300', actor: dane.id });
    at('2026-11-03T00:00:00Z');
    store.changeTicket(one, { actor: loop.id, status: 'live' });
    store.postComment({ ticket: one, author: loop.id, body: merged(1) });
    at('2026-11-03T00:05:00Z');
    store.postComment({ ticket: two, author: loop.id, body: moved(1, 2, 'conflict', ['tracker/server.mjs']) });
    const c = reportsOf(store, { project: 'alpha', now: T('2026-11-04T00:00:00Z') }).conflicts;
    assert.equal(c.total, 1);
    assert.equal(c.merged, 1);
    assert.equal(c.rate, 1);
    assert.equal(c.conflicts[0].ticket, two);
    assert.equal(c.conflicts[0].setting, 'build 5m · review 30m · relay 10m · cap 5');
    assert.deepEqual(c.conflicts[0].causedBy, { pr: 1, ticket: one, inferred: false });
    assert.deepEqual(c.conflicts[0].files, ['tracker/server.mjs']);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the Reporting page draws Merge Conflicts from the server\'s answer, before Open Now, each conflict linking to its ticket', () => {
  const app = readFileSync(new URL('./web/app.mjs', import.meta.url), 'utf8');
  const fn = app.slice(app.indexOf('async function drawReporting('));
  const page = fn.slice(fn.indexOf('<h1>Reporting</h1>'), fn.indexOf('<h2>Open Now</h2>'));
  assert.match(page, /\$\{conflictsHtml\}/);
  assert.match(fn, /const conflictsHtml = conflictSection\(r\.conflicts\);/);
  const section = app.slice(app.indexOf('function conflictSection('));
  assert.match(section, /<h2>Merge Conflicts<\/h2>/);
  assert.match(section, /<th class="count">Per Merged Pull Request<\/th>/);
  assert.match(section, /<a href="\/t\/\$\{encodeURIComponent\(x\.ticket\)\}">/);
});
