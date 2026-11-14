/**
 * watchdogDoorCalls.mjs — how the throughput, checkout-currency and
 * failed-pass watchdogs (SP-268) reach the tracker and the bus: through
 * Spirality's own door (`npm run clickup -- ...`), never ClickUp and never
 * the tracker's API directly. In StarCaster they called
 * `scripts/lib/clickup.cjs` (`listTasks`, `postBusMessage`) with ClickUp ids
 * written into the scripts; here every id comes from the project config,
 * which the door reads.
 *
 * Every door command reads its own write back and exits non-zero when it did
 * not stick, so a non-zero exit is a failed read or post, never a quiet
 * success. Doppler supplies the token through `npm run clickup`; the seat is
 * whatever TRACKER_TOKEN_NAME the caller set (the relay's on its wake, the
 * lane's in a runner, hand-run by hand). The environment is passed through as
 * it stands, so SPIRALITY_PROJECT names the same project for the door as for
 * the watchdog.
 */
import { spawnSync } from 'node:child_process';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProjectConfig, namedProjectFolder } from '../../lib/projectConfig.mjs';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOOR_TIMEOUT_MS = Number(process.env.TRACKER_DOOR_TIMEOUT_MS) || 3 * 60 * 1000;

/** A leading `~/` as the home folder, as scripts/project_config.mjs expands it for the runners. */
export function expandHome(value, home = homedir()) {
  return typeof value === 'string' && /^~(\/|$)/.test(value) ? value.replace(/^~/, home) : value;
}

/**
 * This project's settings the watchdogs need: where stamps go (the log
 * folder, `~/` expanded the way the runners read it, so the stamps sit beside
 * the lane logs) and which repository. Throws naming the problem.
 */
export function watchdogSettings({ env = process.env } = {}) {
  const config = loadProjectConfig({ project: namedProjectFolder(env), env });
  return { logDir: expandHome(config.logDir), slug: config.projectSlug, githubRepo: config.githubRepo, busProject: config.busProject || '' };
}

/** This machine's short name, for "noticed by ...". */
export function nodeName() {
  return String(hostname() || '').split('.')[0] || 'an unnamed machine';
}

/** The first useful line a failed command said, for a one-line reason. */
export function firstLine(r) {
  if (r.error) return r.error.code === 'ETIMEDOUT' ? 'it timed out' : String(r.error.message);
  const said = String(r.stderr || r.stdout || '').split('\n')
    .map((l) => l.trim())
    .find((l) => l && !/^tracker: \d+ request/.test(l)) || '';
  return said.slice(0, 200) || `it exited ${r.status}`;
}

/** Run one door command. `run` is injectable so a test reaches every branch without a tracker. */
export function runDoor(args, { input, run = spawnSync, timeoutMs = DOOR_TIMEOUT_MS } = {}) {
  return run('npm', ['run', '--silent', 'clickup', '--', ...args], {
    cwd: REPO,
    input,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 256 * 1024 * 1024,
  });
}

/**
 * Every ticket in the project's queue, finished ones included, as the door's
 * `tickets --json --include-closed` prints them. `{ rows, why }`: rows null
 * and `why` saying what failed on any failed read (the door prints nothing at
 * all rather than half a list, so a partial answer is never taken for a whole one).
 */
export function readAllTickets({ run } = {}) {
  const r = runDoor(['tickets', '--json', '--include-closed'], { run });
  if (r.error || r.status !== 0) return { rows: null, why: `the door's tickets read failed: ${firstLine(r)}` };
  let rows;
  try { rows = JSON.parse(String(r.stdout || '').trim() || 'null'); } catch { rows = null; }
  if (!Array.isArray(rows)) return { rows: null, why: 'the door printed something that is not a JSON list of tickets' };
  return { rows, why: null };
}

/** Post one message to the project's bus, read back by the door. `{ ok, why }`. */
export function postToBus(text, { run } = {}) {
  const r = runDoor(['bus-post', '--body-file', '-'], { input: text, run, timeoutMs: 60_000 });
  if (!r.error && r.status === 0) return { ok: true, why: '' };
  return { ok: false, why: `bus-post exited ${r.status ?? (r.error && r.error.code) ?? 'without a code'}: ${firstLine(r)}` };
}
