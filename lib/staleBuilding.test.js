'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const sb = require('./staleBuilding.js');

const NOW = Date.parse('2026-11-03T12:00:00-07:00');
const MIN = 60 * 1000;
const OLD = NOW - 3 * 60 * MIN;
const free = sb.lockState({ exists: false });
const ours = sb.lockState({ exists: true, pid: '500', alive: true, ancestors: [900, 500, 1] });
const held = sb.lockState({ exists: true, pid: '500', alive: true, ancestors: [900, 1] });

test('the lock: absent or dead is free, an ancestor is ours, any other live pid is held', () => {
  assert.equal(free.state, 'free');
  assert.equal(sb.lockState({ exists: true, pid: '500', alive: false, ancestors: [1] }).state, 'free');
  assert.equal(ours.state, 'ours');
  assert.equal(held.state, 'held');
  assert.equal(sb.lockState({ exists: true, pid: '', alive: false }).state, 'unreadable');
  assert.equal(sb.lockState({ exists: true, pid: 'garbage', alive: false }).state, 'unreadable');
});

test('the lock path is built the way loop_runner.sh builds it, from the config', () => {
  assert.equal(sb.buildLockPath({ logDir: '~/loop-logs', productSlug: 'normie', home: '/Users/x' }), '/Users/x/loop-logs/normie-loop-build.lock');
  assert.equal(sb.buildLockPath({ logDir: '/var/logs', productSlug: 'spirality' }), '/var/logs/spirality-loop-build.lock');
});

test('a Building ticket with no PR, no running build pass and no change past the limit is requeued', () => {
  for (const lock of [free, ours]) {
    const d = sb.staleDecision({ status: 'building', lock, hasPr: false, updatedMs: OLD, nowMs: NOW });
    assert.equal(d.action, 'requeue', lock.state);
    assert.match(d.reason, /no PR is recorded/);
  }
});

test('a Building ticket whose pass is still running (lock held by a live process) is left alone', () => {
  const d = sb.staleDecision({ status: 'Building', lock: held, hasPr: false, updatedMs: OLD, nowMs: NOW });
  assert.equal(d.action, 'leave');
  assert.match(d.reason, /is running/);
});

test('a Building ticket with a "PR opened:" line is left alone', () => {
  const d = sb.staleDecision({ status: 'building', lock: free, hasPr: true, updatedMs: OLD, nowMs: NOW });
  assert.equal(d.action, 'leave');
  assert.match(d.reason, /PR opened/);
});

test('a Building ticket that changed inside the limit is left alone; the limit is the stranded limit', () => {
  assert.equal(sb.ABANDONED_AFTER_MS, 90 * MIN);
  const young = sb.staleDecision({ status: 'building', lock: free, hasPr: false, updatedMs: NOW - 30 * MIN, nowMs: NOW });
  assert.equal(young.action, 'leave');
  const atLimit = sb.staleDecision({ status: 'building', lock: free, hasPr: false, updatedMs: NOW - 90 * MIN, nowMs: NOW });
  assert.equal(atLimit.action, 'leave');
  const future = sb.staleDecision({ status: 'building', lock: free, hasPr: false, updatedMs: NOW + 10 * MIN, nowMs: NOW });
  assert.equal(future.action, 'leave');
  const custom = sb.staleDecision({ status: 'building', lock: free, hasPr: false, updatedMs: NOW - 30 * MIN, nowMs: NOW, limitMs: 20 * MIN });
  assert.equal(custom.action, 'requeue');
});

test('anything that could not be read leaves the ticket alone and says so', () => {
  const unreadableLock = sb.lockState({ exists: true, pid: null, alive: false });
  assert.equal(sb.staleDecision({ status: 'building', lock: unreadableLock, hasPr: false, updatedMs: OLD, nowMs: NOW }).action, 'cannot-tell');
  assert.equal(sb.staleDecision({ status: 'building', lock: free, hasPr: null, updatedMs: OLD, nowMs: NOW }).action, 'cannot-tell');
  assert.equal(sb.staleDecision({ status: 'building', lock: free, hasPr: false, updatedMs: NaN, nowMs: NOW }).action, 'cannot-tell');
  assert.equal(sb.staleDecision({ status: 'building', hasPr: false, updatedMs: OLD, nowMs: NOW }).action, 'cannot-tell');
});

test('a ticket not in Building is never requeued', () => {
  for (const status of ['queued', 'in review', 'rework', 'needs your input']) {
    assert.equal(sb.staleDecision({ status, lock: free, hasPr: false, updatedMs: OLD, nowMs: NOW }).action, 'leave', status);
  }
});

test('leftover worktrees: made around the claim and never pushed', () => {
  const claim = OLD;
  const wts = [
    { path: '/r/.claude/worktrees/a', branch: 'a', createdMs: claim + 2 * MIN, pushed: false, dirty: true },
    { path: '/r/.claude/worktrees/b', branch: 'b', createdMs: claim + 2 * MIN, pushed: true, dirty: false },
    { path: '/r/.claude/worktrees/c', branch: 'c', createdMs: claim - 60 * MIN, pushed: false, dirty: false },
    { path: '/r/.claude/worktrees/d', branch: 'd', createdMs: claim + 50 * MIN, pushed: false, dirty: false },
  ];
  assert.deepEqual(sb.leftoverWorktrees(wts, { updatedMs: claim }).map((w) => w.branch), ['a']);
});

test('the note names the time, the leftovers, and that nothing was deleted', () => {
  const note = sb.requeueNote({
    when: '11/2, 11:43 AM',
    reason: 'no build pass is on it',
    leftovers: [{ path: '/r/.claude/worktrees/reply-confirm-modal', branch: 'reply-confirm-modal', dirty: true }],
  });
  assert.match(note, /Put back in Queued/);
  assert.match(note, /11\/2, 11:43 AM MT/);
  assert.match(note, /reply-confirm-modal, branch reply-confirm-modal, with uncommitted edits/);
  assert.match(note, /Nothing was deleted/);
  assert.match(sb.requeueNote({ when: 'x', reason: 'y' }), /No unpushed worktree/);
  assert.doesNotMatch(note, /^> /m);
});
