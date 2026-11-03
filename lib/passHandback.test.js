'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ph = require('./passHandback.js');
const pc = require('./passClaim.js');

const MIN = 60 * 1000;
const marked = { found: true, record: pc.claimRecord({ task: 'SP-92', skill: 'loop-build', at: '2026-11-02T18:43:00Z', pid: 1 }), why: '' };
const none = { found: false, record: null, why: '' };

test('the lock: absent or dead is free; the runner this process is under is ours; any other live runner is held', () => {
  assert.equal(ph.lockState({ exists: false }).state, 'free');
  assert.equal(ph.lockState({ exists: true, pid: '500', alive: false, ancestors: [500] }).state, 'free', 'a dead pid is never ours');
  assert.equal(ph.lockState({ exists: true, pid: '500', alive: true, runnerPid: '500' }).state, 'ours', 'the runner\'s own export');
  assert.equal(ph.lockState({ exists: true, pid: '500', alive: true, ancestors: [900, 500, 1] }).state, 'ours', 'or an ancestor');
  assert.equal(ph.lockState({ exists: true, pid: '500', alive: true, ancestors: [900, 1], runnerPid: '600' }).state, 'held',
    'the review runner\'s LOOP_RUNNER_PID is not the build runner');
  assert.equal(ph.lockState({ exists: true, pid: '', alive: false }).state, 'unreadable');
  assert.equal(ph.lockState({ exists: true, pid: 'garbage', alive: false }).state, 'unreadable');
});

test('the lock path is built the way loop_runner.sh builds it, from the config', () => {
  assert.equal(ph.buildLockPath({ logDir: '~/loop-logs', productSlug: 'normie', home: '/Users/x' }), '/Users/x/loop-logs/normie-loop-build.lock');
  assert.equal(ph.buildLockPath({ logDir: '/var/logs', productSlug: 'spirality' }), '/var/logs/spirality-loop-build.lock');
});

test('only a claim made under the build runner writes the marker: a hand-run session never arms it', () => {
  assert.equal(ph.writesMarker({ state: 'ours' }), true);
  for (const state of ['free', 'held', 'unreadable']) assert.equal(ph.writesMarker({ state }), false, state);
  assert.equal(ph.writesMarker(null), false);
});

test('the seat: the runner\'s next pass, or no runner at all, may judge the marker on its status', () => {
  assert.equal(ph.seatGate({ state: 'ours', why: '' }, marked), null);
  assert.equal(ph.seatGate({ state: 'free', why: '' }, marked), null);
  // And through passClaim's own decision, a marked ticket still in Building is handed back, with no timer.
  const d = ph.seatGate({ state: 'ours' }, marked) || pc.reconcileDecision({ marker: marked, status: 'building', trigger: pc.TRIGGER_PASS });
  assert.equal(d.action, 'handback');
});

test('the seat: a hand-run session while a build runner is running leaves the marked ticket alone', () => {
  const d = ph.seatGate({ state: 'held', why: 'a build runner (pid 500) is running and this session is not under it' }, marked);
  assert.equal(d.action, 'in-flight');
  assert.match(d.reason, /SP-92 may be the ticket it is building/);
  assert.equal(pc.reconcileExitCode(d), 0, 'nothing wrong, nothing done');
});

test('the seat: an unreadable lock is "could not tell", never a hand-back', () => {
  const d = ph.seatGate({ state: 'unreadable', why: 'the build lock exists but names no readable pid' }, marked);
  assert.equal(d.action, 'unreadable');
  assert.equal(pc.reconcileExitCode(d), 2);
  assert.equal(ph.seatGate(null, marked).action, 'unreadable');
});

test('the seat: no marker means nothing to gate, whatever the lock says', () => {
  for (const state of ['held', 'unreadable']) assert.equal(ph.seatGate({ state, why: '' }, none), null, state);
  assert.equal(pc.reconcileDecision({ marker: none, status: '', trigger: pc.TRIGGER_PASS }).action, 'nothing');
});

test('where it goes: a recorded PR to Rework, none to Queued, unreadable comments to Rework', () => {
  assert.equal(ph.handbackDestination(true).status, 'Rework');
  assert.equal(ph.handbackDestination(false).status, 'Queued');
  assert.equal(ph.handbackDestination(null).status, 'Rework', 'the direction that cannot lose work');
});

test('leftover worktrees: made around the claim and never pushed', () => {
  const claim = Date.parse('2026-11-02T18:43:00Z');
  const wts = [
    { path: '/r/.claude/worktrees/a', branch: 'a', createdMs: claim + 2 * MIN, pushed: false, dirty: true },
    { path: '/r/.claude/worktrees/b', branch: 'b', createdMs: claim + 2 * MIN, pushed: true, dirty: false },
    { path: '/r/.claude/worktrees/c', branch: 'c', createdMs: claim - 60 * MIN, pushed: false, dirty: false },
    { path: '/r/.claude/worktrees/d', branch: 'd', createdMs: claim + 50 * MIN, pushed: false, dirty: false },
  ];
  assert.deepEqual(ph.leftoverWorktrees(wts, { claimedMs: claim }).map((w) => w.branch), ['a']);
});

test('the note names the claim time, where it went and why, the leftovers, and that nothing was deleted', () => {
  const note = ph.handbackNote({
    when: '11/2, 11:43 AM',
    destination: ph.handbackDestination(false),
    leftovers: [{ path: '/r/.claude/worktrees/reply-confirm-modal', branch: 'reply-confirm-modal', dirty: true }],
  });
  assert.match(note, /^Put back in Queued: the build pass that claimed this ticket at 11\/2, 11:43 AM MT ended/);
  assert.match(note, /Why Queued: no pull request was recorded on it\./);
  assert.match(note, /reply-confirm-modal, branch reply-confirm-modal, with uncommitted edits/);
  assert.match(note, /Nothing was deleted/);
  assert.match(ph.handbackNote({ when: '', destination: ph.handbackDestination(true) }), /^Put back in Rework: the build pass that claimed this ticket ended[\s\S]*No unpushed worktree/);
});
