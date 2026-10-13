'use strict';

/**
 * EVERY `skipWithoutDoor` GUARD IS AUDITED, not checked by eye.
 *
 * WHY THIS EXISTS (2026-10-12, task 86bcgmnpy, slice 1, review rounds 1 and 2).
 * The move wrapped a batch of tests in `skipWithoutProductScript` because they
 * read a PRODUCT script this repository does not have yet. The guard went on
 * too many: five tests that call nothing but pure functions were silenced with
 * it, and each round of review found some of them by reading the diff. Round 1
 * caught four, round 2's overlapping pass caught a fifth, and the round-1
 * report's claim that the remaining skips were "all genuine door reads" was
 * wrong by one.
 *
 * Reading them by eye is what kept missing one, so this does it mechanically:
 * for every test guarded by a product-script skip, the test's own body must
 * actually reach a product script — directly, or through a module-level name
 * that was itself built from one (`const SCRIPT = doorSource() || ''`, or a
 * helper function that reads the installer). A guard on a test that touches
 * neither is a silenced test, and this fails with its file and line.
 *
 * It is deliberately a source scan rather than a run: a test that is skipped
 * reports nothing about WHY, which is the whole problem. Slices 2 and 3 add
 * more guarded tests and then take the guards off again, so the audit stays.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/** A direct read of a product script's source. */
const READS_A_SCRIPT = /doorSource\(|productScript(Path)?\(/;
/**
 * The guard whose use is being audited, in the one shape it is ever written:
 * `if (skipWithoutDoor(t)) return;` on its own line. Deliberately narrow — a
 * test that merely MENTIONS the helper is testing the helper (this file, and
 * `substrateConfig.test.js`), not being switched off by it.
 */
const GUARD = /^\s*if \(skipWithout(Door|ProductScript)\([^)]*\)\) return;/m;

/** `test('...', (t) => {` … `});` blocks, flat at column 0 as these files are. */
function topLevelBlocks(lines, open) {
  const blocks = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = open.exec(lines[i]);
    if (!m) continue;
    let j = i;
    while (j < lines.length && !/^\}\)?;/.test(lines[j + 1] === undefined ? '};' : lines[j])) j += 1;
    blocks.push({ name: m[1], line: i + 1, text: lines.slice(i, j + 1).join('\n') });
  }
  return blocks;
}

/**
 * The module-level names in `lines` that hold, directly or at one remove, the
 * text of a product script. Resolved to a fixed point, because an alias can be
 * built from an alias (`const source = doorSource(); const code = source…`).
 */
function scriptDerivedNames(lines) {
  const bindings = [];
  for (let i = 0; i < lines.length; i += 1) {
    let m = /^const\s+([A-Za-z_$][\w$]*)\s*=/.exec(lines[i]);
    if (m) {
      let j = i;
      while (j < lines.length && !/;\s*$/.test(lines[j])) j += 1;
      bindings.push({ name: m[1], text: lines.slice(i, j + 1).join('\n') });
      continue;
    }
    m = /^function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(lines[i]);
    if (m) {
      let j = i;
      while (j < lines.length && !/^\}/.test(lines[j])) j += 1;
      bindings.push({ name: m[1], text: lines.slice(i, j + 1).join('\n') });
    }
  }
  const derived = new Set();
  let grew = true;
  while (grew) {
    grew = false;
    for (const b of bindings) {
      if (derived.has(b.name)) continue;
      const fromAlias = [...derived].some((d) => new RegExp(`\\b${d}\\b`).test(b.text));
      if (READS_A_SCRIPT.test(b.text) || fromAlias) { derived.add(b.name); grew = true; }
    }
  }
  return derived;
}

test('NO PURE TEST IS SILENCED BY A PRODUCT-SCRIPT GUARD', () => {
  const dir = __dirname;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js'));
  const silenced = [];
  let audited = 0;
  for (const file of files) {
    const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n');
    if (!lines.some((l) => GUARD.test(l))) continue;
    const derived = scriptDerivedNames(lines);
    for (const block of topLevelBlocks(lines, /^test\((.*)$/)) {
      if (!GUARD.test(block.text)) continue;
      audited += 1;
      // The guard line itself names the script; it is not a read of one.
      const body = block.text.replace(GUARD, '');
      const reaches = READS_A_SCRIPT.test(body)
        || [...derived].some((d) => new RegExp(`\\b${d}\\b`).test(body));
      if (!reaches) silenced.push(`${file}:${block.line}  ${block.name.slice(0, 80)}`);
    }
  }
  assert.ok(audited > 0, 'the audit found no guarded tests at all — it has stopped looking');
  assert.deepEqual(silenced, [],
    `${silenced.length} guarded test(s) never reach a product script, so the guard only `
    + 'switches them off. Delete the guard line (and the unused `t` parameter) from:\n'
    + `${silenced.join('\n')}`);
});

test('the audit can actually see a silenced test — it is not vacuously green', () => {
  // A source scan that matches nothing passes for the wrong reason, so this
  // feeds it the shape it is hunting for and checks it objects.
  const lines = [
    "const { doorSource, skipWithoutDoor } = require('./productScripts.js');",
    "const SCRIPT = doorSource() || '';",
    '',
    "test('genuinely reads the door', (t) => {",
    '  if (skipWithoutDoor(t)) return;',
    '  assert.match(SCRIPT, /something/);',
    '});',
    '',
    "test('pure, and silenced', (t) => {",
    '  if (skipWithoutDoor(t)) return;',
    '  assert.equal(pureThing(1), 2);',
    '});',
    '',
    "test('a test OF the guard, which is not a guarded test', () => {",
    '  assert.equal(skipWithoutDoor({ skip() {} }), true);',
    '});',
  ];
  const derived = scriptDerivedNames(lines);
  assert.ok(derived.has('SCRIPT'), 'an alias built from doorSource() must be followed');
  // Only a GUARDED test is audited, so the third block — which calls the
  // helper as its subject — is not in the list at all.
  const guarded = topLevelBlocks(lines, /^test\((.*)$/).filter((b) => GUARD.test(b.text));
  assert.deepEqual(guarded.map((b) => b.line), [4, 9],
    'a test that merely calls the helper is not a guarded test');

  const verdicts = guarded.map((block) => {
    const body = block.text.replace(GUARD, '');
    return READS_A_SCRIPT.test(body) || [...derived].some((d) => new RegExp(`\\b${d}\\b`).test(body));
  });
  assert.deepEqual(verdicts, [true, false],
    'the one that reads the door is fine; the pure one is caught');
});
