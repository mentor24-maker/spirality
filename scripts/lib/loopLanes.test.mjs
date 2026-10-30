/**
 * The kept-alive lanes the installer puts on the Mini (SKILLS in
 * scripts/install_loop_runner.sh), checked against what each lane needs to
 * run: a skill for `claude -p /<lane>` to find, and a tracker sign-in seat
 * under the name loop_runner.sh derives from the lane (loop-intake ->
 * TRACKER_TOKEN_LOOP_INTAKE), or the door refuses every pass.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TRACKER_SEATS } from './expectedSecrets.mjs';

const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const installer = readFileSync(join(REPO, 'scripts/install_loop_runner.sh'), 'utf8');

function lanes() {
  const m = installer.match(/^SKILLS=\(([^)]*)\)$/m);
  assert.ok(m, 'install_loop_runner.sh has no SKILLS=(...) line');
  return m[1].trim().split(/\s+/);
}

/** The secret name loop_runner.sh exports as TRACKER_TOKEN_NAME for a lane. */
const seatSecretFor = (lane) => `TRACKER_TOKEN_${lane.toUpperCase().replace(/-/g, '_')}`;

test('the installer keeps three lanes alive (build, review, intake) beside the relay: four loop jobs', () => {
  assert.deepEqual(lanes(), ['loop-build', 'loop-review', 'loop-intake']);
  assert.match(installer, /^RELAY=relay$/m);
});

test('every lane has a skill and its own machine sign-in seat', () => {
  for (const lane of lanes()) {
    assert.ok(existsSync(join(REPO, '.claude/skills', lane, 'SKILL.md')), `${lane}: no .claude/skills/${lane}/SKILL.md`);
    const seat = TRACKER_SEATS.find((s) => s.secret === seatSecretFor(lane));
    assert.ok(seat, `${lane}: no seat ${seatSecretFor(lane)} in TRACKER_SEATS`);
    assert.equal(seat.kind, 'machine');
    assert.equal(seat.name, lane);
  }
});

test('every lane has its own interval, and labels come from the project config, never typed in', () => {
  for (const lane of lanes()) assert.match(installer, new RegExp(`^\\s+${lane}\\)\\s+echo \\d+ ;;$`, 'm'), `${lane}: no interval_of entry`);
  assert.match(installer, /^PREFIX="\$\(config_value launchdPrefix\)"$/m);
  assert.doesNotMatch(installer, /com\.spirality/);
});
