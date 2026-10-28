/**
 * The importer: copies one product's Loop Queue, every ticket open and
 * closed, with its comments and threaded replies, from ClickUp into the
 * tracker's store (tracker/store.mjs). Design: docs/TRACKER_MVP.md, "How the
 * loops switch over", step 3.
 *
 *   node tracker/import.mjs --db <path> [--dry-run]
 *   npm run tracker:import -- --db <path> [--dry-run]     (Doppler supplies the token)
 *
 * It READS ClickUp, only through the ClickUp tracker
 * (scripts/tracker/clickupTracker.mjs), and never writes to it. The list,
 * the operator, the product and the ticket prefix all come from the project
 * config (lib/projectConfig.mjs).
 *
 * What it keeps:
 *
 *  - Each ticket's original filing time, and each comment's and reply's,
 *    with replies linked to their parent comment, oldest first.
 *  - A map from every old ClickUp id to its new one (`imported_ids` in the
 *    store), so an old pull-request link still resolves. The map row is
 *    written in the same transaction as the thing it maps.
 *  - Comment bodies exactly as ClickUp returned them, `[machine]` stamp
 *    included, so the package's readers decide on them as before.
 *
 * Who wrote what: a stamped comment (scripts/lib/machineComment.mjs) goes to
 * one machine actor named for the import; an unstamped one from the
 * operator's ClickUp seat goes to the operator. The workspace's service
 * account is the machine too. Anyone else gets a human actor of their own,
 * created once and found again on every later run.
 *
 * Safe to run again: anything already in the map is skipped, so a second run
 * adds only what is new (a ticket's fields are not refreshed; only new
 * tickets, comments and replies are added).
 *
 * Refusals, never guesses: a status that is not one of the seven
 * (lib/loopStatuses.js) stops that ticket, and the end-of-run report names
 * it. A read that fails stops the whole run, says so and exits non-zero;
 * everything a ticket needs is read before anything of it is written, so a
 * failed run leaves no half-copied ticket, and a re-run picks up where it
 * stopped.
 *
 * Exit codes: 0 everything copied or already there; 3 finished, but
 * something was refused (each one named); 1 a read or a write failed, or the
 * config is not usable: the import is INCOMPLETE.
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openStore, StoreError, STATUSES } from './store.mjs';
import { isMachineComment } from '../scripts/lib/machineComment.mjs';
import { createClickupTracker } from '../scripts/tracker/clickupTracker.mjs';
import { loadProjectConfig, ProjectConfigError } from '../lib/projectConfig.mjs';
import loopStatuses from '../lib/loopStatuses.js';

const { statusOf } = loopStatuses;

/** The name `imported_ids` files every row from ClickUp under. */
export const SOURCE = 'clickup';

/**
 * The map key the operator's ClickUp seat is filed under. tracker/signins.mjs
 * records the operator's sign-in under the same key, so both find one actor.
 */
export const operatorImportKey = (config) => ({ source: SOURCE, sourceId: `user:${config.operatorUserId}` });

/** The ClickUp custom field that holds the Loop note (lib/loopNote.js). */
const LOOP_NOTE_FIELD = 'Loop note';

/** How many pages of tasks to read before calling the list INCOMPLETE. */
const MAX_TASK_PAGES = 50;

const KINDS = Object.freeze(['tickets', 'comments', 'replies']);

/** A read from ClickUp that did not come back usable. The run stops on it. */
export class ImportReadError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImportReadError';
  }
}

function emptyCounts() {
  return Object.fromEntries(KINDS.map((k) => [k, { read: 0, written: 0, skipped: 0, refused: 0 }]));
}

function httpWhy(out) {
  const status = out?.res?.status ?? '?';
  const said = out?.json?.err || out?.json?.error || String(out?.text || '').slice(0, 200);
  return `HTTP ${status}${said ? ` (${said})` : ''}`;
}

/** ClickUp's times are milliseconds since 1970, sent as strings. */
function clickupTime(ms) {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null;
}

function byDateThenId(dateKey) {
  return (a, b) => (Number(a[dateKey]) - Number(b[dateKey])) || String(a.id).localeCompare(String(b.id));
}

/** Does this comment have a reply thread worth a request? Unknown means ask. */
function mayHaveReplies(comment) {
  if (comment.reply_count == null) return true;
  return Number(comment.reply_count) > 0;
}

/**
 * Copy the Loop Queue named in `config` from `tracker` (a ClickUp tracker, or
 * a fake answering the same shapes) into `store`. Answers
 * `{ counts, refusals }`; throws ImportReadError on a failed read, with
 * `counts` and `refusals` so far attached to it.
 */
export async function importLoopQueue({ tracker, store, config, log = () => {} }) {
  const counts = emptyCounts();
  const refusals = [];
  const refuse = (kind, what, why) => {
    counts[kind].refused += 1;
    refusals.push(`${what}: ${why}`);
  };

  try {
    const { operator, machine, project } = prepare(store, config);

    const authorOf = (user, body) => {
      if (isMachineComment(body)) return machine.id;
      const uid = user?.id == null ? '' : String(user.id);
      if (!uid) return null;
      if (uid === config.operatorUserId) return operator.id;
      if (uid === config.machineUserId) return machine.id;
      return store.importActor({
        source: SOURCE, sourceId: `user:${uid}`, kind: 'human',
        name: (typeof user.username === 'string' && user.username.trim()) || `ClickUp user ${uid}`,
      }).id;
    };

    const tasks = await readAllTasks(tracker, config.loopQueueListId);
    tasks.sort(byDateThenId('date_created'));
    log(`read ${tasks.length} ticket(s) from list ${config.loopQueueListId}`);

    for (const task of tasks) {
      counts.tickets.read += 1;
      const label = `ticket ${task.id} "${task.name}"`;
      let ticketId = store.importedId({ source: SOURCE, kind: 'ticket', sourceId: task.id });

      // The status is checked from the list itself, before any more reads:
      // a refused ticket costs nothing further.
      if (ticketId == null && !STATUSES.includes(statusOf(task))) {
        refuse('tickets', label, `status "${task.status?.status ?? ''}" is not one of the seven, so it was not copied (nor its comments)`);
        continue;
      }

      // Everything this ticket needs is read before anything of it is written.
      const full = ticketId == null ? await readTask(tracker, task.id) : null;
      const comments = await readComments(tracker, task.id);
      const replies = new Map();
      for (const c of comments) {
        replies.set(c.id, mayHaveReplies(c) ? await readReplies(tracker, c.id) : []);
      }
      counts.comments.read += comments.length;
      for (const list of replies.values()) counts.replies.read += list.length;

      if (ticketId == null) {
        try {
          ticketId = writeTicket(store, { task, full, project, authorOf, machine }).id;
          counts.tickets.written += 1;
        } catch (err) {
          if (!(err instanceof StoreError)) throw err;
          refuse('tickets', label, `${err.message} It was not copied (nor its comments).`);
          counts.comments.refused += comments.length;
          for (const list of replies.values()) counts.replies.refused += list.length;
          continue;
        }
      } else {
        counts.tickets.skipped += 1;
      }

      for (const c of comments) {
        const parentId = copyComment(store, {
          kind: 'comments', item: c, ticketId, parent: null, label: `${label} comment ${c.id}`, counts, refuse, authorOf,
        });
        for (const r of replies.get(c.id)) {
          if (parentId == null) {
            refuse('replies', `${label} reply ${r.id}`, `its comment ${c.id} was not copied, so it has nothing to hang from`);
            continue;
          }
          copyComment(store, {
            kind: 'replies', item: r, ticketId, parent: parentId, label: `${label} reply ${r.id}`, counts, refuse, authorOf,
          });
        }
      }
    }
  } catch (err) {
    err.counts = counts;
    err.refusals = refusals;
    throw err;
  }
  return { counts, refusals };
}

/**
 * The operator, the machine and the project, created on the first run and
 * found on every later one. A project already in the store is checked before
 * anything is written: its prefix must be the config's, and its operator the
 * actor the operator's ClickUp seat maps to (tracker/signins.mjs records that
 * mapping), so his history is never filed under a second operator.
 */
function prepare(store, config) {
  if (!config.trackerPrefix) {
    throw new ProjectConfigError('"trackerPrefix" is not set in the project config; the importer needs it to number tickets (a prefix "AB" gives AB-1, AB-2, ...)');
  }
  const operatorKey = operatorImportKey(config);
  let project = store.getProject(config.productSlug);
  if (project) {
    if (project.prefix !== config.trackerPrefix) {
      throw new ProjectConfigError(`the store already holds project "${project.slug}" with prefix "${project.prefix}", but the config says "${config.trackerPrefix}"; refusing to mix the two`);
    }
    const mapped = store.importedId({ ...operatorKey, kind: 'actor' });
    if (project.operator != null && mapped !== project.operator) {
      throw new ProjectConfigError(`project "${project.slug}" names actor ${project.operator} as its operator, but the operator's ClickUp seat maps to ${mapped == null ? 'no actor yet' : `actor ${mapped}`}; refusing to file his history under a second operator (run \`npm run tracker:signins -- create\` first, which records the mapping)`);
    }
  }
  const operator = store.importActor({ ...operatorKey, kind: 'human', name: config.operatorName });
  const machine = store.importActor({
    source: SOURCE, sourceId: 'machine', kind: 'machine', name: `${config.productSlug} loop (imported from ClickUp)`,
  });
  if (!project) {
    project = store.createProject({
      slug: config.productSlug, name: config.productSlug, prefix: config.trackerPrefix, operator: operator.id,
    });
  }
  return { operator, machine, project };
}

/** Every ticket in the list, open and closed; throws ImportReadError on a failed or partial read. */
export async function readAllTasks(tracker, list) {
  const tasks = [];
  for (let page = 0; page < MAX_TASK_PAGES; page += 1) {
    const out = await tracker.listTasksPage(list, page, { includeClosed: true });
    if (!out?.res?.ok) throw new ImportReadError(`reading page ${page} of list ${list} failed: ${httpWhy(out)}`);
    if (!out.json || !Array.isArray(out.json.tasks)) {
      throw new ImportReadError(`page ${page} of list ${list} did not come back as a task list`);
    }
    tasks.push(...out.json.tasks);
    if (out.json.last_page !== false || out.json.tasks.length === 0) return tasks;
  }
  throw new ImportReadError(`list ${list} ran past ${MAX_TASK_PAGES} pages; refusing to call a partial list complete`);
}

async function readTask(tracker, id) {
  const out = await tracker.getTask(id, { markdown: true });
  if (!out?.res?.ok || !out.json || typeof out.json !== 'object') {
    throw new ImportReadError(`reading ticket ${id} failed: ${httpWhy(out)}`);
  }
  return out.json;
}

/** Every comment on the ticket, OLDEST first. */
async function readComments(tracker, id) {
  const { paged, bad } = await tracker.listComments(id);
  if (!paged?.complete) {
    const why = bad ? httpWhy(bad) : (paged?.capped ? 'it ran past the page limit' : 'the read did not finish');
    throw new ImportReadError(`reading the comments on ticket ${id} failed: ${why}`);
  }
  return paged.comments.slice().sort(byDateThenId('date'));
}

/** Every reply to one comment, oldest first. */
async function readReplies(tracker, commentId) {
  const out = await tracker.listReplies(commentId);
  const list = out?.json?.comments ?? out?.json?.replies;
  if (!out?.res?.ok || !Array.isArray(list)) {
    throw new ImportReadError(`reading the replies to comment ${commentId} failed: ${httpWhy(out)}`);
  }
  return list.slice().sort(byDateThenId('date'));
}

function writeTicket(store, { task, full, project, authorOf, machine }) {
  const loopNote = (full.custom_fields || task.custom_fields || []).find((f) => f?.name === LOOP_NOTE_FIELD)?.value;
  const filer = authorOf(full.creator || task.creator, '') ?? machine.id;
  const firstAssignee = (full.assignees || task.assignees || [])[0];
  let assignee = firstAssignee ? authorOf(firstAssignee, '') : null;
  if (assignee === machine.id) assignee = null; // the machine is never assigned a ticket
  return store.importTicket({
    source: SOURCE,
    sourceId: task.id,
    createdAt: clickupTime(task.date_created),
    updatedAt: clickupTime(task.date_updated) ?? undefined,
    project: project.slug,
    actor: filer,
    name: task.name,
    description: full.markdown_description || full.description || '',
    status: statusOf(task),
    priority: task.priority?.priority ?? null,
    tags: (task.tags || []).map((t) => t?.name).filter((n) => typeof n === 'string'),
    assignee,
    loopNote: typeof loopNote === 'string' ? loopNote : '',
  });
}

/** Copy one comment or reply; answers its new id (also when it was already there), or null. */
function copyComment(store, { kind, item, ticketId, parent, label, counts, refuse, authorOf }) {
  const known = store.importedId({ source: SOURCE, kind: 'comment', sourceId: item.id });
  if (known != null) {
    counts[kind].skipped += 1;
    return known;
  }
  const body = item.comment_text;
  if (typeof body !== 'string' || !body.trim()) {
    refuse(kind, label, 'it has no text (an attachment or an emoji alone), so there is nothing to store');
    return null;
  }
  const author = authorOf(item.user, body);
  if (author == null) {
    refuse(kind, label, 'ClickUp gave it no author');
    return null;
  }
  try {
    const c = store.importComment({
      source: SOURCE, sourceId: item.id, createdAt: clickupTime(item.date), ticket: ticketId, author, body, parent,
    });
    counts[kind].written += 1;
    return c.id;
  } catch (err) {
    if (!(err instanceof StoreError)) throw err;
    refuse(kind, label, err.message);
    return null;
  }
}

/** The end-of-run table, one line per kind, then each refusal. */
export function formatReport({ counts, refusals }, { dryRun = false } = {}) {
  const written = dryRun ? 'would write' : 'written';
  const pad = (s, n) => String(s).padStart(n);
  const lines = [`${''.padEnd(9)}${pad('read', 6)}${pad(written, 13)}${pad('skipped', 9)}${pad('refused', 9)}`];
  for (const k of KINDS) {
    const c = counts[k];
    lines.push(`${k.padEnd(9)}${pad(c.read, 6)}${pad(c.written, 13)}${pad(c.skipped, 9)}${pad(c.refused, 9)}`);
  }
  if (refusals.length) {
    lines.push('', `Refused (${refusals.length}):`);
    for (const r of refusals) lines.push(`  - ${r}`);
  }
  return lines.join('\n');
}

function arg(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
}

/**
 * A dry run imports into a throwaway copy of the store (or an empty one, if
 * there is no store yet), so its counts are exactly what a real run would
 * write, and the real file is never opened.
 */
export function dryRunCopy(db) {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-import-dry-'));
  const copy = join(dir, 'tracker.db');
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  try {
    if (existsSync(db)) {
      for (const ext of ['', '-wal', '-shm']) {
        if (existsSync(db + ext)) copyFileSync(db + ext, copy + ext);
      }
    }
  } catch (err) {
    cleanup();
    throw err;
  }
  return { path: copy, cleanup };
}

async function main(argv) {
  const db = arg(argv, 'db');
  const dryRun = argv.includes('--dry-run');
  if (!db) {
    console.error('usage: node tracker/import.mjs --db <path> [--dry-run]');
    return 1;
  }
  let config;
  try {
    config = loadProjectConfig();
  } catch (err) {
    if (!(err instanceof ProjectConfigError)) throw err;
    console.error(`tracker:import: the project config is not usable — ${err.message}`);
    return 1;
  }
  if (!process.env.CLICKUP_API_TOKEN) {
    console.error(`tracker:import: CLICKUP_API_TOKEN is not set. Run it as \`npm run tracker:import -- ...\` so Doppler (${config.dopplerProject}/${config.dopplerConfig}) supplies it.`);
    return 1;
  }
  const tracker = createClickupTracker({
    token: process.env.CLICKUP_API_TOKEN,
    apiBase: process.env.CLICKUP_API_BASE,
    timeoutMs: process.env.CLICKUP_HTTP_TIMEOUT_MS,
  });
  const scratch = dryRun ? dryRunCopy(db) : null;
  const store = openStore(scratch ? scratch.path : db);
  console.log(`${dryRun ? 'DRY RUN — nothing is written to ' : 'Importing into '}${db}, from Loop Queue list ${config.loopQueueListId} (${config.productSlug}, prefix ${config.trackerPrefix ?? '(unset)'})`);
  try {
    const result = await importLoopQueue({ tracker, store, config, log: (line) => console.log(`  ${line}`) });
    console.log('');
    console.log(formatReport(result, { dryRun }));
    console.log('');
    if (result.refusals.length) {
      console.log(`Finished, but ${result.refusals.length} item(s) were refused (listed above).${dryRun ? ' Nothing was written.' : ''}`);
      return 3;
    }
    console.log(dryRun ? 'Dry run finished. Nothing was written.' : 'Import finished.');
    return 0;
  } catch (err) {
    console.error(`\ntracker:import FAILED — ${err.message}`);
    if (err.counts) {
      console.error('');
      console.error(formatReport({ counts: err.counts, refusals: err.refusals || [] }, { dryRun }));
    }
    console.error(`\nThe import is INCOMPLETE.${dryRun ? '' : ' What was written stays, and is whole ticket by ticket; run the same command again to carry on.'}`);
    return 1;
  } finally {
    store.close();
    tracker.reportLimits();
    scratch?.cleanup();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.exitCode = await main(process.argv.slice(2));
}
