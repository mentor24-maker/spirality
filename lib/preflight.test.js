'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { productScript, skipWithoutProductScript } = require('./productScripts.js');

const pf = require('./preflight.js');

// ---------------------------------------------------------------------------
// The sequence itself (task 86bbtujen). The table IS the order; these
// assertions are what makes a silent reorder impossible.
// ---------------------------------------------------------------------------

test('loop-build clears ownership -> reconcile -> pause -> cap, in that order', () => {
  assert.deepEqual(pf.GATES['loop-build'].map((g) => g.id), ['ownership', 'reconcile', 'pause', 'cap']);
  // Reconcile BEFORE pause, exactly as the skill always ordered it: repairing
  // a dropped ticket is not claiming and not merging, so a pause must not
  // defer the repair.
});

test('loop-review clears ownership -> pause, and deliberately nothing else', () => {
  assert.deepEqual(pf.GATES['loop-review'].map((g) => g.id), ['ownership', 'pause']);
  // No reconcile (the marker is loop-build's move) and no cap — review drains
  // the very PRs the cap waits on; capping it would deadlock the pipeline
  // against itself.
});

test('every gate is CALLED through its own npm script, never re-implemented', (t) => {
  for (const loop of pf.KNOWN_LOOPS) {
    for (const gate of pf.GATES[loop]) {
      assert.ok(gate.npmArgs.length >= 1, `${gate.id} names the script it calls`);
    }
  }
  if (skipWithoutProductScript(t, 'preflightRunner')) return;
  const io = productScript('preflightRunner') || '';
  assert.match(io, /spawnSync\('npm', \['run', '--silent', \.\.\.gate\.npmArgs\]/,
    'the runner executes the table — a second copy of any gate would be that gate, pre-drifted');
});

// ---------------------------------------------------------------------------
// The dialect translations — each tool keeps its own codes; the preflight
// owns the one mapping per dialect.
// ---------------------------------------------------------------------------

test('node:owns dialect: 1 means "cannot tell", and that is house 2, never a decline', () => {
  const owns = pf.GATES['loop-build'][0];
  assert.equal(pf.interpretGate(owns, 1).houseCode, 2,
    '"someone else is doing it" and "nobody is doing it" look identical from here — only one is safe');
  assert.equal(pf.interpretGate(owns, 3).houseCode, 3);
  assert.equal(pf.interpretGate(owns, 0).stop, false);
});

test('wip-check dialect: its documented 1 is "could not tell", house 2', () => {
  const cap = pf.GATES['loop-build'][3];
  assert.equal(pf.interpretGate(cap, 1).houseCode, 2);
  assert.equal(pf.interpretGate(cap, 3).houseCode, 3, 'capped is a normal decline');
});

test('reconcile never stops the pass, and never disappears into a green line', () => {
  const rec = pf.GATES['loop-build'][1];
  for (const code of [3, 2, 1]) {
    const r = pf.interpretGate(rec, code);
    assert.equal(r.stop, false, `reconcile exit ${code} carries on — its own contract says so`);
    assert.equal(r.warn, true, `but exit ${code} must be REPORTED — a hand-back's line is the only evidence it happened`);
  }
  assert.equal(pf.interpretGate(rec, 0).warn, false);
});

test('an exit code a dialect does not define is a real failure, never guessed around', () => {
  const pause = pf.GATES['loop-build'][2];
  const r = pf.interpretGate(pause, 7);
  assert.equal(r.houseCode, 1);
  assert.equal(r.stop, true);
  assert.match(r.note, /does not define/);
});

// ---------------------------------------------------------------------------
// The composed verdict.
// ---------------------------------------------------------------------------

test('the first stopper wins and its house code is the exit', () => {
  const v = pf.composeVerdict([
    { gateId: 'ownership', houseCode: 0, stop: false, warn: false },
    { gateId: 'pause', houseCode: 3, stop: true, warn: false },
  ]);
  assert.equal(v.code, 3);
  assert.match(v.line, /pause declined/);
  assert.match(v.line, /normal outcome/);
});

test('"could not tell" exits 2 and says never to treat it as clear', () => {
  const v = pf.composeVerdict([{ gateId: 'cap', houseCode: 2, stop: true, warn: false }]);
  assert.equal(v.code, 2);
  assert.match(v.line, /could not tell/i);
  assert.match(v.line, /never treat/);
});

test('a clean run with a reconcile note says GO and names what to report', () => {
  const v = pf.composeVerdict([
    { gateId: 'ownership', houseCode: 0, stop: false, warn: false },
    { gateId: 'reconcile', houseCode: 0, stop: false, warn: true },
    { gateId: 'pause', houseCode: 0, stop: false, warn: false },
    { gateId: 'cap', houseCode: 0, stop: false, warn: false },
  ]);
  assert.equal(v.code, 0);
  assert.match(v.line, /report what reconcile said/);
});

test('a wholly clean run is a plain GO', () => {
  const v = pf.composeVerdict([
    { gateId: 'ownership', houseCode: 0, stop: false, warn: false },
    { gateId: 'pause', houseCode: 0, stop: false, warn: false },
  ]);
  assert.equal(v.code, 0);
  assert.match(v.line, /go — claim from the queue/);
});

test('the gate line leads with a verdict word a column of which scans', () => {
  const owns = pf.GATES['loop-build'][0];
  assert.match(pf.renderGateLine(owns, 0, 'this machine owns it'), /^ok {2}/);
  assert.match(pf.renderGateLine(owns, 3, 'mac-mini owns it'), /^STOP/);
  assert.match(pf.renderGateLine(owns, 1, 'no identity file'), /^\?\?\?\?/);
  const rec = pf.GATES['loop-build'][1];
  assert.match(pf.renderGateLine(rec, 3, 'handed back'), /^NOTE/);
});

// ---------------------------------------------------------------------------
// The skills defer to the command — the whole point of the ticket.
// ---------------------------------------------------------------------------

test('the skills reference the preflight and no longer enumerate its gates', (t) => {
  if (skipWithoutProductScript(t, 'buildSkill')) return;
  if (skipWithoutProductScript(t, 'reviewSkill')) return;
  for (const [file, loop, key] of [
    ['.claude/skills/loop-build/SKILL.md', 'loop-build', 'buildSkill'],
    ['.claude/skills/loop-review/SKILL.md', 'loop-review', 'reviewSkill'],
  ]) {
    const skill = productScript(key) || '';
    assert.match(skill, new RegExp(`npm run preflight -- ${loop}`), `${file} runs the one command`);
    // The three gate commands must not be re-narrated as steps. (pass-reconcile
    // may stay in the by-hand reference list — the ban is on the SEQUENCE
    // living as prose, which is what a pass can skip by summarizing badly.)
    for (const cmd of ['npm run node:owns --', 'npm run pipeline -- check', 'npm run clickup -- wip-check']) {
      assert.ok(!skill.includes(cmd),
        `${file} still enumerates "${cmd}" — the sequence lives in lib/preflight.js now, once`);
    }
  }
});
