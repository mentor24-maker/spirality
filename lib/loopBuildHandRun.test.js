'use strict';

// SP-296: loop-build skipped SP-25, a hand-run-only ticket, for 31 hours on
// reasons copied from its newest comment after both blockers had cleared.
// The fix is a rule in the loop-build skill; these tests fail if any part of
// that rule leaves the skill text.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SKILL = path.join(__dirname, '..', '.claude', 'skills', 'loop-build', 'SKILL.md');
const skill = fs.readFileSync(SKILL, 'utf8');

// Just the hand-run rule: from its heading to the next bold paragraph that
// opens step 1's Rework instructions.
function handRunRule() {
  const start = skill.indexOf('**A `Queued` ticket for a hand-run session only.**');
  assert.ok(start >= 0, 'the loop-build skill has a rule for hand-run-only tickets');
  const end = skill.indexOf('**On a `Rework` ticket', start);
  assert.ok(end > start, 'the hand-run rule sits in step 1, before the Rework instructions');
  return skill.slice(start, end).replace(/\s+/g, ' ');
}

test('the hand-run rule says to re-check every named blocker each pass', () => {
  const rule = handRunRule();
  assert.match(rule, /re-check, every pass/);
  assert.match(rule, /every id on its `Waits on:` line/);
  assert.match(rule, /newest hold-back comment names/);
  assert.match(rule, /Re-check each blocker now, never by copying the last comment/);
});

test('the hand-run rule hands the ticket to Dane with ask once every blocker has cleared', () => {
  const rule = handRunRule();
  assert.match(rule, /All cleared:\*\* hand the ticket to Dane with `ask --status "Needs your input"`/);
  assert.match(rule, /ready for a hand-run session/);
  assert.match(rule, /the pass does not build it/);
});

test('a skip note names only the blockers still open, and how each was checked', () => {
  const rule = handRunRule();
  assert.match(rule, /names only the blockers still open, each with what was checked/);
  assert.match(rule, /Never "nothing has changed since …" on its own/);
});

test('an unreadable blocker is named as unreadable and never counted as cleared', () => {
  const rule = handRunRule();
  assert.match(rule, /A blocker that cannot be checked\*\*/);
  assert.match(rule, /name it in the skip note as unreadable/);
  assert.match(rule, /never counted as cleared/);
});

test('the same skip comment is not repeated every pass', () => {
  const rule = handRunRule();
  assert.match(rule, /Do not repeat the same skip comment every pass/);
  assert.match(rule, /only when the still-open blockers differ from what the newest note already says/);
});
