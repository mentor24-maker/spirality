/**
 * watchdogDoor.mjs — how the ticket watchdogs (stale-ready, stale-answer,
 * SP-267) read the tickets, ask the pause switch and post to the bus: through
 * Spirality's own door (`npm run clickup -- ...`), never ClickUp and never
 * the tracker's API directly.
 *
 * It is StarCaster's `scripts/lib/trackerDoor.cjs` (SC-794), the half those
 * two watchdogs used, moved here: one `tickets --json [--comments]` read
 * (and, for an answer already past its threshold, one `replies` read),
 * handed back in the SAME shapes the watchdogs' pure modules already consume
 * (a ClickUp-style task: `status.status`, `date_updated`; a ClickUp-style
 * comment: `comment_text`, `user.id`, `user.kind`, `date`), so
 * `lib/staleReady.js` and `lib/staleAnswer.js` came across unchanged in how
 * they count.
 *
 * Every door command reads its own write back and exits non-zero when it did
 * not stick, so a non-zero exit here is a failed read or post, never a quiet
 * success. Doppler supplies the token through `npm run clickup`; on the
 * relay's wake the relay's own seat (TRACKER_TOKEN_NAME, exported by
 * scripts/run_relay.sh) is the one used, by hand the hand-run seat.
 *
 * The door is reached with the environment as it stands, so
 * SPIRALITY_PROJECT (lib/projectConfig.mjs, namedProjectFolder) names the
 * same project for the door as for the watchdog that called it.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOOR_TIMEOUT_MS = Number(process.env.TRACKER_DOOR_TIMEOUT_MS) || 3 * 60 * 1000;

/** An ISO time as ClickUp's millisecond string, or null. */
function ms(iso) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? String(t) : null;
}

/** The page a person opens for a ticket (not the API address the door calls). */
export function ticketUrl(trackerUrl, id) {
  const base = String(trackerUrl || '').replace(/\/$/, '');
  return base ? `${base}/t/${id}` : '';
}

/** One `tickets --json` object in the shape the watchdogs read off a ClickUp task. */
export function asClickUpTask(t, { trackerUrl } = {}) {
  return {
    id: String(t.id),
    name: t.name,
    status: { status: String(t.status || '').toLowerCase() },
    priority: t.priority ? { priority: t.priority } : null,
    tags: (t.tags || []).map((name) => ({ name })),
    date_created: ms(t.created),
    date_updated: ms(t.updated),
    status_since: ms(t.statusSince),
    url: ticketUrl(trackerUrl, t.id),
  };
}

/** One `tickets --json --comments` comment as a ClickUp comment record. */
export function asCommentRecord(c) {
  return {
    id: String(c.id),
    comment_text: String(c.text ?? ''),
    user: { id: c.author?.id ?? null, username: c.author?.name ?? null, kind: c.author?.kind ?? null },
    date: ms(c.at),
  };
}

/**
 * The door's `tickets --json --comments` output as { tasks, commentsById }:
 * the tickets as ClickUp-style tasks, and each ticket's comments as ClickUp
 * comment records, newest first (ClickUp's order, which the modules were
 * written against; the door prints oldest first). Throws on anything that is
 * not a JSON list, naming `what`.
 */
export function parseTickets(stdout, { trackerUrl, what = 'reading the tickets' } = {}) {
  let out;
  try { out = JSON.parse(String(stdout || '').trim() || 'null'); } catch { out = null; }
  if (!Array.isArray(out)) throw new Error(`${what}: the door printed something that is not a JSON list of tickets`);
  const tasks = out.map((t) => asClickUpTask(t, { trackerUrl }));
  const commentsById = new Map();
  for (const t of out) {
    if (Array.isArray(t.comments)) commentsById.set(String(t.id), t.comments.map(asCommentRecord).reverse());
  }
  return { tasks, commentsById };
}

/** The first useful line a failed door command said, for a one-line reason. */
function firstLine(r) {
  const said = String(r.stderr || r.stdout || '').trim().split('\n').find((l) => l.trim()) || '';
  if (r.error) return r.error.code === 'ETIMEDOUT' ? 'it timed out' : String(r.error.message);
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
 * Every open ticket, with its comments. Throws naming the door's reason on
 * any failed read: the door prints nothing at all rather than half a list, so
 * there is never a partial answer to mistake for a whole one.
 */
export function readTickets({ trackerUrl, run } = {}) {
  const what = 'reading the tickets and their comments';
  const r = runDoor(['tickets', '--json', '--comments'], { run });
  if (r.error || r.status !== 0) throw new Error(`${what} through the door failed: ${firstLine(r)}`);
  return parseTickets(r.stdout, { trackerUrl, what });
}

/**
 * One comment's replies, through `replies --task --comment --json`, in the
 * envelope `staleAnswer.markersFromReplyEnvelope` reads: `{ ok: true, json:
 * { comments } }` with each reply a ClickUp-style comment record, or
 * `{ ok: false, why }` on any failed read. A failed read is never an empty
 * thread: "I could not check" and "there is no reply" are different answers.
 */
export function readReplies({ taskId, commentId, run } = {}) {
  const r = runDoor(['replies', '--task', String(taskId), '--comment', String(commentId), '--json'], { run, timeoutMs: 60_000 });
  if (r.error || r.status !== 0) return { ok: false, why: firstLine(r) };
  let out;
  try { out = JSON.parse(String(r.stdout || '').trim() || 'null'); } catch { out = null; }
  if (!Array.isArray(out)) return { ok: false, why: 'the door printed something that is not a JSON list of replies' };
  return { ok: true, json: { comments: out.map(asCommentRecord) } };
}

/**
 * Has the Settings page paused the relay (or the whole pipeline)? Asked by
 * running the one implementation, `pause-check --lane relay`, rather than
 * reading the switches a second way here: two readers of a safety switch
 * are two switches. Anything but exit 0 counts as paused (it fails safe),
 * as it does for the lanes.
 */
export function pausedNow({ run } = {}) {
  const r = runDoor(['pause-check', '--lane', 'relay'], { run, timeoutMs: 60_000 });
  if (!r.error && r.status === 0) return { paused: false, why: '' };
  return { paused: true, why: firstLine(r) };
}

/** Post one message to the project's bus, read back by the door. { ok, why }. */
export function postToBus(text, { run } = {}) {
  const r = runDoor(['bus-post', '--body-file', '-'], { input: text, run, timeoutMs: 60_000 });
  if (!r.error && r.status === 0) return { ok: true, why: '' };
  return { ok: false, why: `bus-post exited ${r.status ?? (r.error && r.error.code) ?? 'without a code'}: ${firstLine(r)}` };
}
