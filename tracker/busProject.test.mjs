import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from './store.mjs';
import { startServer } from './server.mjs';
import { busShape, ensureBusProject } from './busProject.mjs';
import { seatsForConfig } from './signins.mjs';
import { validateProjectConfig } from '../lib/projectConfig.mjs';

const DOOR = fileURLToPath(new URL('../scripts/clickup.mjs', import.meta.url));

/**
 * A fresh tracker with the operator and a guest project's loop sign-ins, as
 * the sign-ins step leaves them, and that project's settings (with a bus).
 */
function fixture({ busProject = 'pressplay-bus' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bus-project-'));
  const store = openStore(join(dir, 'tracker.db'));
  const operator = store.createActor({ kind: 'human', name: 'Dana' });
  const raw = {
    manifestVersion: 2, workspaceId: '0', spaceId: '0', loopQueueListId: '0',
    operatorUserId: String(operator.id), machineUserId: '0',
    githubRepo: 'owner/pressplay', dopplerProject: 'pressplay', dopplerConfig: 'dev',
    launchdPrefix: 'com.pressplay', logDir: '~/loop-logs', mergePhrases: ['merge'],
    governancePaths: [], autoMergeLanes: [], operatorName: 'Dana', projectSlug: 'pressplay',
    legacyMachinePrefixes: [], projectScripts: {}, trackerPrefix: 'PP', tracker: 'api',
    trackerUrl: 'http://tracker.test',
    ...(busProject ? { busProject } : {}),
  };
  const seats = seatsForConfig(validateProjectConfig(raw, { env: {} })).seats;
  const loops = Object.fromEntries(seats.map((s) => [s.secret, store.createActor({ kind: 'machine', name: s.name })]));
  raw.machineUserId = String(loops.TRACKER_TOKEN_LOOP_BUILD.id);
  const config = validateProjectConfig(raw, { env: {} });
  return {
    dir, store, operator, raw, config, loops,
    cleanup() { store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test('a project with a bus gets its tracker project once: made, read back, every loop sees it; a second run changes nothing', (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  assert.deepEqual(busShape(f.config, 'PressPlay'), { slug: 'pressplay-bus', name: 'PressPlay bus', prefix: 'PPBUS' });

  const first = ensureBusProject({ store: f.store, config: f.config, projectName: 'PressPlay' });
  assert.equal(first.ok, true, first.lines.join('\n'));
  assert.equal(first.made, true);
  const made = f.store.getProject('pressplay-bus');
  assert.equal(made.name, 'PressPlay bus');
  assert.equal(made.prefix, 'PPBUS');
  assert.equal(made.operator, f.operator.id);
  assert.equal(made.repo, null, 'nothing on the bus is ever built');
  assert.ok(f.store.listMembers('pressplay-bus').some((m) => m.id === f.operator.id), 'the operator is its member');
  for (const actor of Object.values(f.loops)) {
    assert.ok(f.store.projectsVisibleTo(actor.id).includes('pressplay-bus'), actor.name);
    assert.ok(first.lines.some((l) => l.startsWith(`${actor.name}: sees "pressplay-bus"`)), actor.name);
  }

  const projects = f.store.listProjects().length;
  const second = ensureBusProject({ store: f.store, config: f.config, projectName: 'PressPlay' });
  assert.equal(second.ok, true, second.lines.join('\n'));
  assert.equal(second.made, false);
  assert.match(second.lines[0], /already there .*left alone/);
  assert.equal(f.store.listProjects().length, projects, 'nothing new');
});

test('no bus: nothing is made', (t) => {
  const f = fixture({ busProject: null });
  t.after(() => f.cleanup());
  const r = ensureBusProject({ store: f.store, config: f.config, projectName: 'PressPlay' });
  assert.equal(r.ok, true);
  assert.equal(r.made, false);
  assert.deepEqual(f.store.listProjects(), []);
});

test('a bus project that is there under another operator is refused, and nothing changes', (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  const other = f.store.createActor({ kind: 'human', name: 'Someone Else' });
  f.store.createProject({ slug: 'pressplay-bus', name: 'Not ours', prefix: 'NO', operator: other.id });
  const r = ensureBusProject({ store: f.store, config: f.config, projectName: 'PressPlay' });
  assert.equal(r.ok, false);
  assert.match(r.lines[0], /REFUSED\. It is there, but its operator is actor/);
  assert.equal(f.store.getProject('pressplay-bus').name, 'Not ours');
});

test('a loop sign-in not made yet fails the check, naming it; a taken prefix is not made', (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  const config = validateProjectConfig({ ...f.raw, projectSlug: 'other', trackerPrefix: 'OT', busProject: 'other-bus' }, { env: {} });
  const r = ensureBusProject({ store: f.store, config, projectName: 'Other' });
  assert.equal(r.ok, false);
  assert.match(r.lines.join('\n'), /other loop-build: no such sign-in yet \(the sign-ins step makes it\)/);

  f.store.createProject({ slug: 'taken', name: 'Taken', prefix: 'PPBUS', operator: f.operator.id });
  const refused = ensureBusProject({ store: f.store, config: f.config, projectName: 'PressPlay' });
  assert.equal(refused.ok, false);
  assert.match(refused.lines[0], /NOT made: .*already exists/);
  assert.equal(f.store.getProject('pressplay-bus'), null);
});

test('bus-post from the project\'s folder, signed in as its build loop, posts to the bus the step made and reads back', async (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  assert.equal(ensureBusProject({ store: f.store, config: f.config, projectName: 'PressPlay' }).ok, true);
  const server = await startServer({ store: f.store, port: 0 });
  t.after(() => new Promise((r) => server.close(r)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const folder = join(f.dir, 'pressplay');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'spirality.project.json'), JSON.stringify({ ...f.raw, trackerUrl: url }));
  const token = f.store.issueToken(f.loops.TRACKER_TOKEN_LOOP_BUILD.id);
  const door = (args, input) => new Promise((resolve) => {
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, TRACKER_TOKEN_NAME: 'TRACKER_TOKEN_LOOP_BUILD', TRACKER_TOKEN_LOOP_BUILD: token };
    const child = spawn(process.execPath, [DOOR, ...args], { cwd: folder, env });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('close', (code) => resolve({ code, out, err }));
    child.stdin.end(input ?? '');
  });
  const posted = await door(['bus-post', '--body-file', '-', '--from', 'mini'], 'the heartbeat stopped at 09:10');
  assert.equal(posted.code, 0, `${posted.out}\n${posted.err}`);
  assert.match(posted.out, /Posted to the bus: comment \d+ on PPBUS-1 "Team chat" in pressplay-bus \(verified by reading it back\)/);
  // The team chat it made is the loop's own operational ticket (SP-346).
  const chat = f.store.getTicket('PPBUS-1');
  assert.deepEqual([chat.kind, chat.startedBy], ['operational', 'agent']);
  const read = await door(['bus-read']);
  assert.equal(read.code, 0, `${read.out}\n${read.err}`);
  assert.match(read.out, /PPBUS-1\tmachine\tpressplay loop-build\t/);
});

/** The door run from the project's folder against a live server on the fixture's store. */
async function serveDoor(t, f, raw = f.raw) {
  const server = await startServer({ store: f.store, port: 0 });
  t.after(() => new Promise((r) => server.close(r)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const folder = join(f.dir, 'pressplay');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'spirality.project.json'), JSON.stringify({ ...raw, trackerUrl: url }));
  const token = f.store.issueToken(f.loops.TRACKER_TOKEN_LOOP_BUILD.id);
  return (args, input) => new Promise((resolve) => {
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, TRACKER_TOKEN_NAME: 'TRACKER_TOKEN_LOOP_BUILD', TRACKER_TOKEN_LOOP_BUILD: token };
    const child = spawn(process.execPath, [DOOR, ...args], { cwd: folder, env });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('close', (code) => resolve({ code, out, err }));
    child.stdin.end(input ?? '');
  });
}

test('a project that is its own bus (SP-356): no second project is made; the noticeboard tag is saved once, read back', (t) => {
  const f = fixture({ busProject: 'pressplay' });
  t.after(() => f.cleanup());
  f.store.createProject({ slug: 'pressplay', name: 'PressPlay', prefix: 'PP', operator: f.operator.id });
  const before = f.store.listProjects().length;
  const first = ensureBusProject({ store: f.store, config: f.config, projectName: 'PressPlay' });
  assert.equal(first.ok, true, first.lines.join('\n'));
  assert.deepEqual([first.made, first.tagged], [false, true]);
  assert.match(first.lines[0], /^bus "pressplay": the project's own queue, no second project; noticeboard tag saved on its tag list \(read back\)\.$/);
  assert.equal(f.store.listProjects().length, before, 'no "<slug>-bus" project');
  assert.equal(f.store.getProject('pressplay-bus'), null);
  assert.ok(f.store.listTags('pressplay').some((g) => g.name === 'noticeboard'));
  for (const actor of Object.values(f.loops)) assert.ok(first.lines.some((l) => l.startsWith(`${actor.name}: sees "pressplay"`)), actor.name);

  const second = ensureBusProject({ store: f.store, config: f.config, projectName: 'PressPlay' });
  assert.equal(second.ok, true, second.lines.join('\n'));
  assert.deepEqual([second.made, second.tagged], [false, false]);
  assert.match(second.lines[0], /already on its tag list, left alone/);
  assert.equal(f.store.listTags('pressplay').filter((g) => g.name === 'noticeboard').length, 1);
});

test('own-queue bus: a project not on the tracker yet, or under another operator, is refused and nothing is made', (t) => {
  const f = fixture({ busProject: 'pressplay' });
  t.after(() => f.cleanup());
  const missing = ensureBusProject({ store: f.store, config: f.config, projectName: 'PressPlay' });
  assert.equal(missing.ok, false);
  assert.match(missing.lines[0], /NOT ready\. The project is not on this tracker yet/);
  assert.deepEqual(f.store.listProjects(), []);
  const other = f.store.createActor({ kind: 'human', name: 'Someone Else' });
  f.store.createProject({ slug: 'pressplay', name: 'PressPlay', prefix: 'PP', operator: other.id });
  const refused = ensureBusProject({ store: f.store, config: f.config, projectName: 'PressPlay' });
  assert.equal(refused.ok, false);
  assert.match(refused.lines[0], /REFUSED\. Its operator is actor/);
  assert.deepEqual(f.store.listTags('pressplay'), []);
});

test('own-queue bus through the door: bus-post makes Team chat in Live tagged noticeboard; bus-read reads only noticeboards; a steward ticket is filed only in Live (SP-356)', async (t) => {
  const f = fixture({ busProject: 'pressplay' });
  t.after(() => f.cleanup());
  f.store.createProject({ slug: 'pressplay', name: 'PressPlay', prefix: 'PP', operator: f.operator.id });
  const door = await serveDoor(t, f);

  const posted = await door(['bus-post', '--body-file', '-', '--from', 'mini'], 'ALARM: the heartbeat stopped');
  assert.equal(posted.code, 0, `${posted.out}\n${posted.err}`);
  assert.match(posted.err, /created PP-1 in Live, tagged noticeboard \(both read back\)/);
  const chat = f.store.getTicket('PP-1');
  assert.equal(chat.name, 'Team chat');
  assert.equal(chat.status, 'live');
  assert.deepEqual(chat.tags, ['noticeboard']);
  assert.ok(f.store.listTags('pressplay').some((g) => g.name === 'noticeboard'), 'saved on the project too');
  assert.equal(f.store.getProject('pressplay-bus'), null, 'no second project');

  // A second post finds it; nothing new is made.
  const again = await door(['bus-post', '--body-file', '-'], 'weekly report');
  assert.equal(again.code, 0, again.err);
  assert.doesNotMatch(again.err, /created/);

  // His word on a work ticket in the same queue is not the bus; on a tagged board it is.
  const work = f.store.fileTicket({ project: 'pressplay', actor: f.loops.TRACKER_TOKEN_LOOP_BUILD.id, status: 'queued', name: 'Build the poll page' });
  f.store.postComment({ ticket: work.id, author: f.operator.id, body: 'pause the merges' });
  const board = f.store.fileTicket({ project: 'pressplay', actor: f.loops.TRACKER_TOKEN_LOOP_BUILD.id, status: 'live', name: 'Pipeline pulse', tags: ['noticeboard'] });
  f.store.postComment({ ticket: board.id, author: f.operator.id, body: 'resume auto-merging' });
  const read = await door(['bus-read', '--operator']);
  assert.equal(read.code, 0, `${read.out}\n${read.err}`);
  assert.match(read.out, new RegExp(`\\t${board.id}\\toperator\\tDana\\tresume auto-merging$`, 'm'));
  assert.doesNotMatch(read.out, /pause the merges/, 'a comment on a work ticket is never read as the bus');
  assert.doesNotMatch(read.out, new RegExp(`\\t${work.id}\\t`));
  assert.match(read.err, /\(pressplay, 2 noticeboard ticket\(s\) read in full\), the operator's only/);

  // A steward's question: refused in Queued (the default) or any claimable status, filed in Live.
  for (const extra of [[], ['--status', 'Queued'], ['--status', 'Rework']]) {
    const refused = await door(['task', '--list', 'pressplay', '--name', 'A question for Dana', '--tags', 'noticeboard', '--body-file', '-', ...extra], 'Which one?');
    assert.equal(refused.code, 2, `${extra.join(' ')}: ${refused.err}`);
    assert.match(refused.err, /is not work, so it is filed in Live .*Nothing was created/);
  }
  assert.equal(f.store.listTickets('pressplay').filter((x) => x.name === 'A question for Dana').length, 0);
  const filed = await door(['task', '--list', 'pressplay', '--name', 'A question for Dana', '--tags', 'noticeboard', '--status', 'Live', '--body-file', '-'], 'Which one?');
  assert.equal(filed.code, 0, filed.err);
  const question = f.store.listTickets('pressplay').find((x) => x.name === 'A question for Dana');
  assert.equal(question.status, 'live');
  const claimable = await door(['queue', '--claimable']);
  assert.doesNotMatch(claimable.out, new RegExp(`${question.id}|${chat.id}|${board.id}`), 'no noticeboard is ever claimable');
});
