#!/usr/bin/env node
/**
 * modelSetting.mjs — the Claude model a lane's passes run on, as Dane chose
 * it on the tracker's Settings page (SP-224, SP-239), for the lane's runner.
 *
 *   node scripts/lib/modelSetting.mjs loop-review  → claude-sonnet-5-5   (exit 0)
 *                                                  → default             (exit 0)
 *                                                  → one line saying why (exit 1)
 *
 * It asks the door (`npm run --silent clickup -- settings`, the same read
 * scripts/lib/wakeSetting.mjs makes) and prints the lane's `model.<lane>`
 * value: `default` (Claude's default: the runner passes no --model, exactly
 * as it always has) or one id from MODELS (scripts/lib/laneModels.mjs). The
 * Settings page refuses anything else; this checks again, because a value
 * the runner hands to `claude --model` must never be one nobody chose from
 * that list. Anything short of a value on the list is a failure, and the
 * ONE line it prints, on stdout so the runner can log it as it is, says why;
 * the runner then runs the pass on Claude's default.
 *
 * scripts/loop_runner.sh runs it before every pass. The relay runs no Claude
 * session, so has no model and is refused here.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MODEL, MODELS, MODEL_LANES } from './laneModels.mjs';
import { defaultRead, lastSaid, READ_TIMEOUT_MS } from './wakeSetting.mjs';

/** The values a lane's model may be: Claude's default, or one on the Settings page's list. */
export const ALLOWED = Object.freeze([DEFAULT_MODEL, ...MODELS.map((m) => m.id)]);

/**
 * `lane`'s model in the `settings` command's output (`name=value` lines):
 * `{ model }` (`default` or an id from MODELS), or `{ problem }` in words.
 */
export function modelFrom(text, lane) {
  const key = `model.${lane}=`;
  const line = String(text ?? '').split('\n').map((l) => l.trim()).find((l) => l.startsWith(key));
  if (line == null) return { problem: `the tracker's settings have no model.${lane} line` };
  const value = line.slice(key.length);
  if (!ALLOWED.includes(value)) {
    const shown = value.length > 60 ? `${value.slice(0, 60)}…` : value;
    return { problem: `the tracker answered model.${lane}=${shown}, which is not "${DEFAULT_MODEL}" or a model on the Settings page's list (${MODELS.map((m) => m.id).join(', ')})` };
  }
  return { model: value };
}

/**
 * Read `lane`'s model: `{ code: 0, line: '<id or default>' }`, or `{ code: 1,
 * line }` naming why it could not (2: not a lane with a model). `read()` is a
 * stand-in for tests.
 */
export function readModel(lane, { read = defaultRead } = {}) {
  if (!MODEL_LANES.includes(lane)) return { code: 2, line: `modelSetting: "${lane ?? ''}" is not a lane that runs a model — one of: ${MODEL_LANES.join(', ')}` };
  const r = read();
  if (r.error?.code === 'ETIMEDOUT') return { code: 1, line: `the settings read took longer than ${READ_TIMEOUT_MS / 1000}s and was stopped` };
  if (r.error) return { code: 1, line: `the settings read could not run (${r.error.code || r.error.message})` };
  if (r.status !== 0) return { code: 1, line: `the settings read failed (exit ${r.status ?? 'without a code'}${lastSaid(r.stderr) ? `: ${lastSaid(r.stderr)}` : ''})` };
  const { model, problem } = modelFrom(r.stdout, lane);
  if (problem) return { code: 1, line: problem };
  return { code: 0, line: model };
}

/** Run as a command, also through a link to this file (a real path both sides). */
function runAsCommand() {
  try {
    return Boolean(process.argv[1]) && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (runAsCommand()) {
  const lane = process.argv[2];
  if (!lane || lane === '--help') {
    console.error(`usage: node scripts/lib/modelSetting.mjs <lane>\n  lanes: ${MODEL_LANES.join(', ')}`);
    process.exit(2);
  }
  const { code, line } = readModel(lane);
  console.log(line);
  process.exit(code);
}
