/**
 * The ClickUp snapshot: a complete, read-only copy of one project's ClickUp
 * list(s), saved on the Mini before the project leaves ClickUp, so what the
 * importer (tracker/import.mjs) does not carry across is not lost when
 * ClickUp is let go: attachments, time in each status, custom fields and the
 * raw records. Design: docs/TRACKER_MVP.md, "Switching a project over",
 * step 4.
 *
 *   npm run tracker:snapshot -- [--list <id> ...] [--dry-run]     (Doppler supplies the token)
 *
 * It saves the project config's Loop Queue list, plus every `--list` given,
 * into `<trackerDataDir>/clickup-archive/<projectSlug>-<YYYY-MM-DD>/`:
 *
 *   manifest.json                          what was saved, the counts, when (local time)
 *   lists/<list id>/list.json              the list's own record
 *   lists/<list id>/tasks/<task id>.json   the ticket in full (markdown description, custom fields)
 *                                          with `comments` (oldest first, each with its `replies`)
 *                                          and `time_in_status` (null when ClickUp has none)
 *   attachments/<task id>/<id>-<name>      every file on the ticket or its comments
 *
 * and then packs that folder into one `.tar.gz` in `<trackerDataDir>/backups/`.
 * The nightly backup never prunes it: tracker/backup.mjs only removes its own
 * dated `.db` files.
 *
 * It READS ClickUp, only through scripts/tracker/clickupTracker.mjs, and
 * never writes to it. Nothing is imported into the tracker's database.
 *
 * Rule 6, a step that fails says so: a read or a download that fails stops
 * the run and exits non-zero. The copy is built in `<folder>.partial` and
 * only named as the snapshot once every read and download is done, so a
 * failed run never looks like a finished one; the next run throws the
 * partial folder away and starts a fresh, complete copy. The copy is built in
 * `clickup-archive/.partial/<name>/` and packed from there; it takes its real
 * name only after the archive has been written and read back.
 *
 * Rule 4, secret keys never reach a file: every file is checked for the
 * token before it is written, and the run stops if one would carry it.
 *
 * Exit codes: 0 saved and the counts agree with ClickUp's; 3 saved, but a
 * count differs from what ClickUp reports (each one named); 1 a read, a
 * download or a write failed, or the config is not usable: there is NO
 * snapshot.
 */
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClickupTracker } from '../scripts/tracker/clickupTracker.mjs';
import { noClickUpList } from './import.mjs';
import { loadProjectConfig, ProjectConfigError } from '../lib/projectConfig.mjs';
import { expandHome } from '../lib/onboardAnswers.mjs';

/** How many pages of tasks to read before calling a list INCOMPLETE. */
const MAX_TASK_PAGES = 50;

/** A read, a download or a write that did not work. The run stops on it. */
export class SnapshotError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SnapshotError';
  }
}

function httpWhy(out) {
  const status = out?.res?.status ?? '?';
  const said = out?.json?.err || out?.json?.error || String(out?.text || '').slice(0, 200);
  return `HTTP ${status}${said ? ` (${said})` : ''}`;
}

const pad2 = (n) => String(n).padStart(2, '0');

/** A date as YYYY-MM-DD in the machine's own time zone (the Mini's is Mountain), as backup.mjs names its files. */
export function localDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** The time in the machine's own zone with its offset, never UTC: 2026-11-08T22:30:05-07:00. */
export function localStamp(d) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${localDate(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/** A file name that is safe on disk: no folders, no hidden-file dot, not too long. */
export function safeName(name) {
  const cleaned = String(name ?? '')
    .replace(/[\u0000-\u001f/\\:]/g, '_')
    .replace(/^\.+/, '_')
    .trim();
  return (cleaned || 'file').slice(0, 120);
}

/** The folder the snapshot goes in, and the archive it is packed into. */
export function snapshotPaths({ dataDir, slug, now = new Date() }) {
  const name = `${slug}-${localDate(now)}`;
  return {
    name,
    root: join(dataDir, 'clickup-archive'),
    folder: join(dataDir, 'clickup-archive', name),
    // Built here, under its final name, so it can be packed before it is moved into place.
    work: join(dataDir, 'clickup-archive', '.partial', name),
    archive: join(dataDir, 'backups', `clickup-archive-${name}.tar.gz`),
  };
}

/** Every ticket in one list and one archived-or-not half, open and closed, subtasks included. */
async function readTaskPages(tracker, list, archived) {
  const tasks = [];
  for (let page = 0; page < MAX_TASK_PAGES; page += 1) {
    const out = await tracker.listTasksPage(list, page, { includeClosed: true, archived, subtasks: true });
    const what = `page ${page} of ${archived ? 'the archived tickets in ' : ''}list ${list}`;
    if (!out?.res?.ok) throw new SnapshotError(`reading ${what} failed: ${httpWhy(out)}`);
    if (!out.json || !Array.isArray(out.json.tasks)) throw new SnapshotError(`${what} did not come back as a task list`);
    tasks.push(...out.json.tasks);
    if (out.json.last_page !== false || out.json.tasks.length === 0) return tasks;
  }
  throw new SnapshotError(`list ${list} ran past ${MAX_TASK_PAGES} pages; refusing to call a partial list complete`);
}

/** Every ticket in the list: the live ones, then the archived ones, each once. */
async function readAllTasks(tracker, list) {
  const seen = new Set();
  const out = [];
  for (const archived of [false, true]) {
    for (const t of await readTaskPages(tracker, list, archived)) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      out.push({ task: t, archived });
    }
  }
  return out;
}

function byDateThenId(a, b) {
  return (Number(a.date) - Number(b.date)) || String(a.id).localeCompare(String(b.id));
}

/** Every comment on the ticket, oldest first, each with its replies. */
async function readThread(tracker, taskId) {
  const { paged, bad } = await tracker.listComments(taskId);
  if (!paged?.complete) {
    const why = bad ? httpWhy(bad) : (paged?.capped ? 'it ran past the page limit' : 'the read did not finish');
    throw new SnapshotError(`reading the comments on ticket ${taskId} failed: ${why}`);
  }
  const comments = paged.comments.slice().sort(byDateThenId);
  const thread = [];
  for (const c of comments) {
    let replies = [];
    // Unknown means ask: a missing reply_count is not proof of none.
    if (c.reply_count == null || Number(c.reply_count) > 0) {
      const out = await tracker.listReplies(c.id);
      const list = out?.json?.comments ?? out?.json?.replies;
      if (!out?.res?.ok || !Array.isArray(list)) {
        throw new SnapshotError(`reading the replies to comment ${c.id} on ticket ${taskId} failed: ${httpWhy(out)}`);
      }
      replies = list.slice().sort(byDateThenId);
    }
    thread.push({ ...c, replies });
  }
  return thread;
}

/** The files a ticket carries: its own attachments and any posted in a comment or reply, each once. */
export function attachmentsOf(full, thread) {
  const found = [];
  const seen = new Set();
  const add = (a, from) => {
    if (!a || typeof a.url !== 'string' || !a.url) return;
    const key = a.id != null ? `id:${a.id}` : `url:${a.url}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({
      id: a.id != null ? String(a.id) : String(found.length + 1),
      title: a.title || a.name || basename(new URL(a.url, 'https://x.invalid').pathname) || 'file',
      url: a.url,
      size: Number.isFinite(Number(a.size)) && a.size !== '' && a.size != null ? Number(a.size) : null,
      from,
    });
  };
  for (const a of full?.attachments || []) add(a, 'ticket');
  const fromParts = (c, from) => {
    for (const part of Array.isArray(c?.comment) ? c.comment : []) {
      if (part?.type === 'attachment' && part.attachment) add(part.attachment, from);
      // A picture pasted into a comment can come as its own part.
      if (part?.type === 'image' && part.image) add(part.image, from);
    }
  };
  for (const c of thread) {
    fromParts(c, `comment ${c.id}`);
    for (const r of c.replies || []) fromParts(r, `reply ${r.id}`);
  }
  return found;
}

/**
 * Save `lists` from `tracker` (a ClickUp tracker, or a fake answering the
 * same shapes) into `paths.folder` and pack it into `paths.archive`. With
 * `dryRun` everything is read and counted, and nothing is written or
 * downloaded. Answers the manifest; throws SnapshotError on any failure,
 * with the counts so far attached (`err.counts`).
 */
export async function snapshotClickup({ tracker, lists, paths, token = '', dryRun = false, slug, now = new Date(), log = () => {}, tar = 'tar' }) {
  if (!Array.isArray(lists) || lists.length === 0) throw new SnapshotError('no list to save');
  const counts = { lists: 0, tickets: 0, open: 0, closed: 0, archived: 0, comments: 0, replies: 0, attachments: 0, bytes: 0 };
  const checks = [];
  const timeInStatus = { available: null, why: null };
  const work = paths.work;
  const secret = typeof token === 'string' && token.length >= 8 ? token : null;

  const write = (rel, content) => {
    const file = join(work, rel);
    const data = typeof content === 'string' || Buffer.isBuffer(content) ? content : `${JSON.stringify(content, null, 2)}\n`;
    if (secret && (Buffer.isBuffer(data) ? data.includes(secret) : data.includes(secret))) {
      throw new SnapshotError(`${rel} would carry the ClickUp token, so it was not written; the run stops (rule 4)`);
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, data);
  };

  try {
    if (!dryRun) {
      // A rerun starts fresh: whatever a failed run left is thrown away.
      rmSync(work, { recursive: true, force: true });
      mkdirSync(work, { recursive: true });
    }

    const listRecords = [];
    for (const list of lists) {
      const rec = await tracker.getList(list);
      if (!rec?.res?.ok || !rec.json || typeof rec.json !== 'object') {
        throw new SnapshotError(`reading list ${list} failed: ${httpWhy(rec)}`);
      }
      counts.lists += 1;
      if (!dryRun) write(join('lists', list, 'list.json'), rec.json);

      const tasks = await readAllTasks(tracker, list);
      log(`list ${list} "${rec.json.name ?? ''}": ${tasks.length} ticket(s)`);
      const listCounts = { tickets: 0, open: 0, closed: 0, archived: 0, replies: 0, repliesCounted: 0, repliesClickup: 0, uncounted: 0 };

      for (const { task, archived } of tasks) {
        const full = await tracker.getTask(task.id, { markdown: true });
        if (!full?.res?.ok || !full.json || typeof full.json !== 'object') {
          throw new SnapshotError(`reading ticket ${task.id} "${task.name}" failed: ${httpWhy(full)}`);
        }
        const thread = await readThread(tracker, task.id);

        let tis = null;
        if (!dryRun && timeInStatus.available !== false) {
          const out = await tracker.getTimeInStatus(task.id);
          const status = out?.res?.status ?? 0;
          if (out?.res?.ok && out.json && typeof out.json === 'object') {
            tis = out.json;
            timeInStatus.available = true;
          } else if (timeInStatus.available == null && status >= 400 && status < 500 && status !== 429) {
            // ClickUp refuses it for the workspace (the ClickApp is off): said once, in the manifest.
            timeInStatus.available = false;
            timeInStatus.why = `ClickUp did not answer time in status (${httpWhy(out)}); it is not in this snapshot`;
            log(timeInStatus.why);
          } else {
            throw new SnapshotError(`reading the time in status of ticket ${task.id} failed: ${httpWhy(out)}`);
          }
        }

        const files = attachmentsOf(full.json, thread);
        const saved = [];
        for (const f of files) {
          if (dryRun) { saved.push({ ...f, file: null }); continue; }
          const got = await tracker.fetchFile(f.url);
          if (!got?.res?.ok || !Buffer.isBuffer(got.bytes)) {
            throw new SnapshotError(`downloading "${f.title}" (attachment ${f.id}, ${f.from}) on ticket ${task.id} failed: ${httpWhy(got)}`);
          }
          if (f.size != null && f.size !== got.bytes.length) {
            checks.push({ list, what: 'attachment size', ok: false, line: `ticket ${task.id}: "${f.title}" (attachment ${f.id}) came back ${got.bytes.length} bytes, but ClickUp says ${f.size}: THEY DIFFER` });
          }
          const rel = join('attachments', safeName(task.id), `${safeName(f.id)}-${safeName(f.title)}`);
          write(rel, got.bytes);
          counts.bytes += got.bytes.length;
          saved.push({ ...f, file: rel });
        }

        const replies = thread.reduce((n, c) => n + c.replies.length, 0);
        // Only comments ClickUp gave a reply_count for can be compared; the rest are named, not counted as 0.
        const counted = thread.filter((c) => c.reply_count != null && Number.isFinite(Number(c.reply_count)));
        const repliesCounted = counted.reduce((n, c) => n + c.replies.length, 0);
        const repliesClickup = counted.reduce((n, c) => n + Number(c.reply_count), 0);
        const closed = full.json.status?.type === 'closed' || task.status?.type === 'closed';
        counts.tickets += 1;
        counts.comments += thread.length;
        counts.replies += replies;
        counts.attachments += saved.length;
        counts[archived ? 'archived' : (closed ? 'closed' : 'open')] += 1;
        listCounts.tickets += 1;
        listCounts[archived ? 'archived' : (closed ? 'closed' : 'open')] += 1;
        listCounts.replies += replies;
        listCounts.repliesCounted += repliesCounted;
        listCounts.repliesClickup += repliesClickup;
        listCounts.uncounted += thread.length - counted.length;

        if (!dryRun) {
          write(join('lists', list, 'tasks', `${safeName(task.id)}.json`), {
            ...full.json, archived, comments: thread, time_in_status: tis, saved_attachments: saved,
          });
        }
      }

      checks.push(...compareCounts(list, rec.json, listCounts));
      const { repliesCounted: _rc, ...kept } = listCounts;
      listRecords.push({ id: list, name: rec.json.name ?? null, task_count_clickup: rec.json.task_count ?? null, ...kept });
    }

    const manifest = {
      project: slug,
      ranAt: localStamp(now),
      lists: listRecords,
      counts,
      timeInStatus: dryRun ? 'not read (dry run)' : (timeInStatus.available === false ? timeInStatus.why : 'saved for every ticket'),
      checks,
      dryRun,
    };
    if (dryRun) return manifest;

    write('manifest.json', manifest);
    // Packed from the working folder first: if tar or its read-back fails, nothing carries the snapshot's name.
    const packed = pack(paths, { tar });
    if (existsSync(paths.folder)) rmSync(paths.folder, { recursive: true, force: true });
    renameSync(work, paths.folder);
    renameSync(packed, paths.archive);
    return manifest;
  } catch (err) {
    err.counts = counts;
    if (!(err instanceof SnapshotError)) {
      const wrapped = new SnapshotError(`writing the snapshot failed: ${err.message}`);
      wrapped.counts = counts;
      throw wrapped;
    }
    throw err;
  }
}

/**
 * The counts against what ClickUp itself reports. ClickUp gives a list's
 * `task_count` (its figure may leave closed or archived tickets out, which is
 * named rather than called a match) and each comment's `reply_count`; it
 * gives no count of a ticket's comments, which are read page by page to the end.
 */
export function compareCounts(list, record, c) {
  const out = [];
  const reported = record?.task_count == null ? null : Number(record.task_count);
  if (reported == null || !Number.isFinite(reported)) {
    out.push({ list, what: 'tickets', ok: true, line: `list ${list}: found ${c.tickets} ticket(s); ClickUp's list record gives no count to compare` });
  } else if (reported === c.tickets) {
    out.push({ list, what: 'tickets', ok: true, line: `list ${list}: found ${c.tickets} ticket(s), ClickUp reports ${reported}: they match` });
  } else {
    const without = [[c.open, 'open'], [c.open + c.closed, 'open and closed (not archived)']].find(([n]) => n === reported);
    out.push(without
      ? { list, what: 'tickets', ok: true, line: `list ${list}: found ${c.tickets} ticket(s); ClickUp's count of ${reported} matches the ${without[1]} ones it counts (it leaves the rest out)` }
      : { list, what: 'tickets', ok: false, line: `list ${list}: found ${c.tickets} ticket(s), but ClickUp reports ${reported}: THEY DIFFER` });
  }
  const found = c.repliesCounted ?? c.replies;
  const uncounted = c.uncounted || 0;
  const aside = uncounted ? ` (${uncounted} comment(s) without a reply count from ClickUp are not comparable, so their ${c.replies - found} repl(ies) are left out of this check)` : '';
  out.push(found === c.repliesClickup
    ? { list, what: 'replies', ok: true, line: `list ${list}: found ${found} repl(ies), ClickUp's comments count ${c.repliesClickup}: they match${aside}` }
    : { list, what: 'replies', ok: false, line: `list ${list}: found ${found} repl(ies), but ClickUp's comments count ${c.repliesClickup}: THEY DIFFER${aside}` });
  return out;
}

/**
 * Pack the working folder into `<archive>.partial` and read it back, asking
 * tar for the manifest by name (a full listing of a big archive could overrun
 * the output buffer). Answers the packed file; the caller names it.
 */
export function pack(paths, { tar = 'tar' } = {}) {
  mkdirSync(dirname(paths.archive), { recursive: true });
  const partial = `${paths.archive}.partial`;
  rmSync(partial, { force: true });
  const manifest = `${paths.name}/manifest.json`;
  try {
    execFileSync(tar, ['-czf', partial, '-C', dirname(paths.work), paths.name], { stdio: ['ignore', 'ignore', 'pipe'] });
    execFileSync(tar, ['-tzf', partial, manifest], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    rmSync(partial, { force: true });
    const said = String(err.stderr || err.message || '').trim().slice(0, 200);
    throw new SnapshotError(`packing the archive ${paths.archive} failed, or it did not read back with ${manifest} in it${said ? ` (${said})` : ''}`);
  }
  return partial;
}

/** The end-of-run lines. */
export function formatSummary(m) {
  const c = m.counts;
  const lines = [
    `${c.tickets} ticket(s) (${c.open} open, ${c.closed} closed, ${c.archived} archived) in ${c.lists} list(s)`,
    `${c.comments} comment(s), ${c.replies} repl(ies), ${c.attachments} attachment(s)${m.dryRun ? ' listed' : ` (${c.bytes} bytes)`}`,
    `time in status: ${m.timeInStatus}`,
    '',
    'Compared with ClickUp:',
    ...m.checks.map((k) => `  ${k.ok ? 'OK ' : 'DIFFERS'} ${k.line}`),
  ];
  return lines.join('\n');
}

/** Every `--list <id>` given, in order. Anything else that is not a known flag is refused, never ignored. */
export function listArgs(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dry-run') continue;
    if (argv[i] !== '--list') {
      throw new SnapshotError(`"${argv[i]}" is not understood; a list id goes after --list (--list ${argv[i]})`);
    }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new SnapshotError('--list needs a list id after it');
    out.push(v);
    i += 1;
  }
  return out;
}

/**
 * The lists to save: the config's Loop Queue list, unless it is all zeros
 * (the project names no ClickUp list, tracker/import.mjs `noClickUpList`),
 * then every `--list` given. None at all is refused with a plain reason.
 */
export function listsToSave(config, extra) {
  const fromConfig = noClickUpList(config) ? [] : [String(config.loopQueueListId)];
  const lists = [...new Set([...fromConfig, ...extra])];
  if (lists.length === 0) {
    throw new SnapshotError(`${config.projectSlug}'s config names no ClickUp list (loopQueueListId is "${config.loopQueueListId}"), and no --list was given, so there is nothing to save. Name the list: npm run tracker:snapshot -- --list <id>`);
  }
  return lists;
}

async function main(argv) {
  const dryRun = argv.includes('--dry-run');
  let config;
  let lists;
  try {
    const extra = listArgs(argv);
    config = loadProjectConfig();
    lists = listsToSave(config, extra);
  } catch (err) {
    if (!(err instanceof ProjectConfigError) && !(err instanceof SnapshotError)) throw err;
    console.error(`tracker:snapshot: ${err instanceof ProjectConfigError ? 'the project config is not usable — ' : ''}${err.message}`);
    console.error('usage: npm run tracker:snapshot -- [--list <id> ...] [--dry-run]');
    return 1;
  }
  if (!config.trackerDataDir) {
    console.error('tracker:snapshot: "trackerDataDir" is not set in the project config, so there is nowhere on this machine to keep the snapshot.');
    return 1;
  }
  const token = process.env.CLICKUP_API_TOKEN;
  if (!token) {
    console.error(`tracker:snapshot: CLICKUP_API_TOKEN is not set. Run it as \`npm run tracker:snapshot -- ...\` so Doppler (${config.dopplerProject}/${config.dopplerConfig}) supplies it.`);
    return 1;
  }
  const paths = snapshotPaths({ dataDir: expandHome(config.trackerDataDir), slug: config.projectSlug });
  const tracker = createClickupTracker({ token, apiBase: process.env.CLICKUP_API_BASE, timeoutMs: process.env.CLICKUP_HTTP_TIMEOUT_MS });
  console.log(`${dryRun ? 'DRY RUN — reading and counting ' : 'Saving '}ClickUp list(s) ${lists.join(', ')} (${config.projectSlug})${dryRun ? '' : ` into ${paths.folder}`}`);
  try {
    const m = await snapshotClickup({ tracker, lists, paths, token, dryRun, slug: config.projectSlug, log: (l) => console.log(`  ${l}`) });
    console.log('');
    console.log(formatSummary(m));
    console.log('');
    if (dryRun) {
      console.log('nothing written (dry run)');
    } else {
      console.log(`Snapshot saved: ${paths.folder}`);
      console.log(`Packed into:    ${paths.archive}`);
    }
    const differs = m.checks.filter((k) => !k.ok);
    if (differs.length) {
      console.log(`\nFinished, but ${differs.length} count(s) differ from ClickUp's (marked DIFFERS above).`);
      return 3;
    }
    return 0;
  } catch (err) {
    console.error(`\ntracker:snapshot FAILED — ${err.message}`);
    if (!dryRun) console.error(`There is NO snapshot from this run. The unfinished copy in ${paths.work} is thrown away by the next run, which starts a fresh, complete one.`);
    return 1;
  } finally {
    tracker.reportLimits();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.exitCode = await main(process.argv.slice(2));
}
