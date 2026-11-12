import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  snapshotClickup, snapshotPaths, attachmentsOf, compareCounts, formatSummary, listArgs, safeName,
  localStamp, SnapshotError, listsToSave,
} from './clickupSnapshot.mjs';
import { backupDatabase, listBackups } from './backup.mjs';
import { ARCHIVE_MAX_PAGES } from '../lib/commentPages.js';

/** Made-up values, so nothing can pass by matching a real project. */
const LIST = '4242';
const EXTRA = '5353';
const SLUG = 'widget';
const TOKEN = 'pk_test_ZZZ_not_a_real_token_123';
const NOW = new Date(2026, 10, 8, 21, 30, 5);

const ok = (json) => ({ res: { ok: true, status: 200 }, json, text: '' });
const failed = (status) => ({ res: { ok: false, status }, json: { err: 'boom' }, text: '' });

function task(id, { closed = false, list = LIST, ...rest } = {}) {
  return {
    id, name: `Ticket ${id}`, list: { id: list },
    status: { status: closed ? 'live' : 'queued', type: closed ? 'closed' : 'custom' },
    date_created: '1767225600000', custom_fields: [{ name: 'Loop note', value: `note ${id}` }],
    ...rest,
  };
}

/**
 * A fake ClickUp tracker over plain data. `fail` names a method (and an id)
 * to break. Every write-looking call is recorded in `writes`, which must stay
 * empty.
 */
function fakeTracker({ fail = {}, timeInStatus = 'yes', files = {}, lists, ...over } = {}) {
  const data = {
    lists: lists ?? {
      [LIST]: { record: { id: LIST, name: 'Loop Queue', task_count: 2 }, live: [task('t1'), task('t2', { closed: true })], archived: [task('t3')] },
    },
    tasks: {
      t1: { attachments: [{ id: 'a1', title: 'screen shot.png', url: 'https://t1.p.clickup-attachments.com/a1.png', size: 4 }] },
      t2: { attachments: [] },
      t3: {},
    },
    comments: {
      t1: [
        { id: 'c2', date: '1767312000000', comment_text: 'second', reply_count: 0,
          comment: [{ type: 'attachment', attachment: { id: 'a2', title: 'log.txt', url: 'https://t1.p.clickup-attachments.com/a2.txt' } }] },
        { id: 'c1', date: '1767225700000', comment_text: 'first', reply_count: 2 },
      ],
    },
    replies: { c1: [{ id: 'r2', date: '1767225900000', comment_text: 'b' }, { id: 'r1', date: '1767225800000', comment_text: 'a' }] },
    ...over,
  };
  const bytes = {
    'https://t1.p.clickup-attachments.com/a1.png': Buffer.from([137, 80, 78, 71]),
    'https://t1.p.clickup-attachments.com/a2.txt': Buffer.from('a log line\n'),
    ...files,
  };
  const calls = [];
  const writes = [];
  const listOf = (id) => data.lists[id];
  const t = {
    calls, writes,
    async getList(id) {
      calls.push(['getList', id]);
      if (fail.getList === id) return failed(500);
      return listOf(id) ? ok(listOf(id).record) : failed(404);
    },
    async listTasksPage(id, page, opts) {
      calls.push(['listTasksPage', id, page, opts]);
      if (fail.listTasksPage) return failed(500);
      const l = listOf(id);
      return ok({ tasks: page === 0 ? (opts.archived ? l.archived : l.live) : [], last_page: true });
    },
    async getTask(id, opts) {
      calls.push(['getTask', id, opts]);
      if (fail.getTask === id) return failed(404);
      const base = Object.values(data.lists).flatMap((l) => [...l.live, ...l.archived]).find((x) => x.id === id);
      return ok({ ...base, markdown_description: `## Goal\nbody of ${id}`, ...(data.tasks[id] || {}) });
    },
    async listComments(id, opts) {
      calls.push(['listComments', id, opts]);
      if (fail.listComments === id) return { paged: { complete: false, comments: [] }, bad: failed(503) };
      return { paged: { complete: true, comments: data.comments[id] || [] }, bad: null };
    },
    async listAllReplies(id, opts) {
      calls.push(['listAllReplies', id, opts]);
      if (fail.listReplies === id) return { paged: { complete: false, comments: [] }, bad: failed(500) };
      return { paged: { complete: true, comments: data.replies[id] || [] }, bad: null };
    },
    async getTimeInStatus(id) {
      calls.push(['getTimeInStatus', id]);
      if (timeInStatus === 'off') return failed(401);
      if (fail.getTimeInStatus === id) return failed(500);
      return ok({ current_status: { status: 'queued', total_time: { by_minute: 5 } }, status_history: [] });
    },
    async fetchFile(url) {
      calls.push(['fetchFile', url]);
      if (fail.fetchFile === url || !bytes[url]) return { ...failed(403), bytes: null };
      return { res: { ok: true, status: 200 }, bytes: bytes[url] };
    },
  };
  for (const w of ['createTask', 'updateTask', 'setTag', 'postComment', 'replyToComment']) {
    t[w] = async (...a) => { writes.push([w, ...a]); return ok({}); };
  }
  return t;
}

function scratch() {
  const dataDir = mkdtempSync(join(tmpdir(), 'clickup-snapshot-'));
  const paths = snapshotPaths({ dataDir, slug: SLUG, now: NOW });
  return { dataDir, paths, cleanup: () => rmSync(dataDir, { recursive: true, force: true }) };
}

function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

const run = (tracker, paths, extra = {}) => snapshotClickup({
  tracker, lists: [LIST], paths, token: TOKEN, slug: SLUG, now: NOW, ...extra,
});

test('the folder and the archive are named from the data folder, the slug and the local date', () => {
  const p = snapshotPaths({ dataDir: '/data', slug: 'widget', now: NOW });
  assert.equal(p.folder, '/data/clickup-archive/widget-2026-11-08');
  assert.equal(p.archive, '/data/backups/clickup-archive-widget-2026-11-08.tar.gz');
});

test('a run saves every ticket (open, closed, archived), comment, reply, time in status and attachment; ClickUp is never written', async () => {
  const { paths, cleanup } = scratch();
  try {
    const tracker = fakeTracker();
    const m = await run(tracker, paths);
    assert.deepEqual(tracker.writes, []);
    assert.deepEqual(m.counts, { lists: 1, tickets: 3, open: 1, closed: 1, archived: 1, comments: 2, replies: 2, attachments: 2, bytes: 15 });

    const files = filesUnder(paths.folder).map((f) => relative(paths.folder, f)).sort();
    assert.deepEqual(files, [
      'attachments/t1/a1-screen shot.png',
      'attachments/t1/a2-log.txt',
      'lists/4242/list.json',
      'lists/4242/tasks/t1.json',
      'lists/4242/tasks/t2.json',
      'lists/4242/tasks/t3.json',
      'manifest.json',
    ]);
    assert.ok(!existsSync(`${paths.folder}.partial`), 'the working folder is renamed, not left behind');

    const t1 = JSON.parse(readFileSync(join(paths.folder, 'lists/4242/tasks/t1.json'), 'utf8'));
    assert.equal(t1.markdown_description, '## Goal\nbody of t1');
    assert.deepEqual(t1.custom_fields, [{ name: 'Loop note', value: 'note t1' }]);
    assert.deepEqual(t1.comments.map((c) => c.id), ['c1', 'c2'], 'oldest first');
    assert.deepEqual(t1.comments[0].replies.map((r) => r.id), ['r1', 'r2']);
    assert.equal(t1.time_in_status.current_status.status, 'queued');
    assert.deepEqual(t1.saved_attachments.map((a) => [a.id, a.from, a.file]), [
      ['a1', 'ticket', 'attachments/t1/a1-screen shot.png'],
      ['a2', 'comment c2', 'attachments/t1/a2-log.txt'],
    ]);
    assert.deepEqual([...readFileSync(join(paths.folder, 'attachments/t1/a1-screen shot.png'))], [137, 80, 78, 71]);
    assert.equal(JSON.parse(readFileSync(join(paths.folder, 'lists/4242/tasks/t3.json'), 'utf8')).archived, true);

    const manifest = JSON.parse(readFileSync(join(paths.folder, 'manifest.json'), 'utf8'));
    assert.equal(manifest.project, SLUG);
    assert.equal(manifest.ranAt, localStamp(NOW));
    assert.match(manifest.ranAt, /^2026-11-08T21:30:05[+-]\d\d:\d\d$/, 'local time with its offset, not UTC');
    assert.equal(manifest.timeInStatus, 'saved for every ticket');

    // Closed, archived and subtask tickets were all asked for.
    const pages = tracker.calls.filter((c) => c[0] === 'listTasksPage').map((c) => c[3]);
    assert.deepEqual(pages, [
      { includeClosed: true, archived: false, subtasks: true },
      { includeClosed: true, archived: true, subtasks: true },
    ]);

    // The archive sits beside the backups and holds the whole folder.
    const listed = execFileSync('tar', ['-tzf', paths.archive], { encoding: 'utf8' });
    assert.match(listed, /widget-2026-11-08\/manifest\.json/);
    assert.match(listed, /widget-2026-11-08\/attachments\/t1\/a1-screen shot\.png/);
  } finally { cleanup(); }
});

test('the end-of-run lines compare the counts with ClickUp and say plainly when they differ', async () => {
  const { paths, cleanup } = scratch();
  try {
    // ClickUp's list count of 2 is the open and closed ones; archived are left out of it.
    const m = await run(fakeTracker(), paths);
    assert.ok(m.checks.every((k) => k.ok), JSON.stringify(m.checks));
    assert.match(formatSummary(m), /matches the open and closed \(not archived\) ones/);

    const lists = { [LIST]: { record: { id: LIST, name: 'Loop Queue', task_count: 9 }, live: [task('t1')], archived: [] } };
    const replies = { c1: [{ id: 'r1', date: '1', comment_text: 'a' }] };
    const m2 = await run(fakeTracker({ lists, replies }), paths);
    const text = formatSummary(m2);
    assert.match(text, /DIFFERS list 4242: found 1 ticket\(s\), but ClickUp reports 9: THEY DIFFER/);
    assert.match(text, /DIFFERS list 4242: found 1 repl\(ies\), but ClickUp's comments count 2: THEY DIFFER/);
  } finally { cleanup(); }
});

test('an attachment that comes back a different size from what ClickUp says is named as a difference', async () => {
  const { paths, cleanup } = scratch();
  try {
    const m = await run(fakeTracker({ files: { 'https://t1.p.clickup-attachments.com/a1.png': Buffer.from([1, 2]) } }), paths);
    const bad = m.checks.filter((k) => !k.ok);
    assert.equal(bad.length, 1);
    assert.match(bad[0].line, /"screen shot.png" \(attachment a1\) came back 2 bytes, but ClickUp says 4/);
  } finally { cleanup(); }
});

for (const [what, fail, said] of [
  ['the list record', { getList: LIST }, /reading list 4242 failed: HTTP 500/],
  ['a task page', { listTasksPage: true }, /reading page 0 of list 4242 failed: HTTP 500/],
  ['a ticket', { getTask: 't2' }, /reading ticket t2 "Ticket t2" failed: HTTP 404/],
  ['the comments', { listComments: 't1' }, /reading the comments on ticket t1 failed: HTTP 503/],
  ['the replies', { listReplies: 'c1' }, /reading the replies to comment c1 on ticket t1 failed: HTTP 500/],
  ['the time in status, after it worked once', { getTimeInStatus: 't2' }, /reading the time in status of ticket t2 failed: HTTP 500/],
  ['a download', { fetchFile: 'https://t1.p.clickup-attachments.com/a2.txt' }, /downloading "log.txt" \(attachment a2, comment c2\) on ticket t1 failed: HTTP 403/],
]) {
  test(`a failed read of ${what} stops the run, says what failed, and leaves no snapshot; a rerun makes a fresh, complete one`, async () => {
    const { paths, cleanup } = scratch();
    try {
      await assert.rejects(run(fakeTracker({ fail }), paths), (err) => {
        assert.ok(err instanceof SnapshotError);
        assert.match(err.message, said);
        return true;
      });
      assert.ok(!existsSync(paths.folder), 'no folder carries the snapshot name');
      assert.ok(!existsSync(paths.archive), 'no archive was packed');
      // Something the failed run left in the working folder must not survive the rerun.
      mkdirSync(paths.work, { recursive: true });
      writeFileSync(join(paths.work, 'stale.json'), '{}');
      const m = await run(fakeTracker(), paths);
      assert.equal(m.counts.tickets, 3);
      assert.ok(!existsSync(join(paths.folder, 'stale.json')));
      assert.equal(filesUnder(paths.folder).length, 7);
      assert.ok(existsSync(paths.archive));
    } finally { cleanup(); }
  });
}

test('a workspace without time in status is said once, in the manifest, and the rest is saved', async () => {
  const { paths, cleanup } = scratch();
  try {
    const lines = [];
    const tracker = fakeTracker({ timeInStatus: 'off' });
    const m = await run(tracker, paths, { log: (l) => lines.push(l) });
    assert.equal(tracker.calls.filter((c) => c[0] === 'getTimeInStatus').length, 1, 'asked once, not per ticket');
    assert.match(m.timeInStatus, /ClickUp did not answer time in status \(HTTP 401/);
    assert.equal(lines.filter((l) => /time in status/.test(l)).length, 1);
    assert.equal(m.counts.tickets, 3);
    const t1 = JSON.parse(readFileSync(join(paths.folder, 'lists/4242/tasks/t1.json'), 'utf8'));
    assert.equal(t1.time_in_status, null);
  } finally { cleanup(); }
});

test('the token is in no file the snapshot writes, and a record that would carry it stops the run', async () => {
  const { dataDir, paths, cleanup } = scratch();
  try {
    await run(fakeTracker(), paths);
    const written = [...filesUnder(dataDir)];
    assert.ok(written.length >= 8);
    for (const f of written) {
      assert.ok(!readFileSync(f).includes(TOKEN), `${f} carries the token`);
    }
    // The archive is compressed, so look inside it too.
    const inside = execFileSync('tar', ['-xzOf', paths.archive]);
    assert.ok(!inside.includes(TOKEN));

    const leaky = fakeTracker({ tasks: { t1: { description: `oops ${TOKEN}` }, t2: {}, t3: {} } });
    const again = scratch();
    try {
      await assert.rejects(run(leaky, again.paths), /would carry the ClickUp token, so it was not written/);
      for (const f of filesUnder(again.dataDir)) assert.ok(!readFileSync(f).includes(TOKEN));
    } finally { again.cleanup(); }
  } finally { cleanup(); }
});

test('comments and replies are read with the archive page limit, so a long trail is taken whole (SP-235, SP-242)', async () => {
  const { paths, cleanup } = scratch();
  try {
    const tracker = fakeTracker();
    await run(tracker, paths, { dryRun: true });
    const reads = tracker.calls.filter((c) => c[0] === 'listComments' || c[0] === 'listAllReplies');
    assert.ok(reads.some((c) => c[0] === 'listComments'));
    assert.ok(reads.some((c) => c[0] === 'listAllReplies'), 'replies are paged too (SP-242)');
    for (const c of reads) assert.deepEqual(c[2], { maxPages: ARCHIVE_MAX_PAGES });
  } finally { cleanup(); }
});

test('a dry run reads and counts, and writes and downloads nothing', async () => {
  const { dataDir, paths, cleanup } = scratch();
  try {
    const tracker = fakeTracker();
    const m = await run(tracker, paths, { dryRun: true });
    assert.equal(m.counts.tickets, 3);
    assert.equal(m.counts.attachments, 2);
    assert.equal(m.timeInStatus, 'not read (dry run)');
    assert.deepEqual(filesUnder(dataDir), []);
    assert.deepEqual(readdirSync(dataDir), []);
    assert.equal(tracker.calls.filter((c) => c[0] === 'fetchFile' || c[0] === 'getTimeInStatus').length, 0);
    assert.match(formatSummary(m), /2 attachment\(s\) listed/);
  } finally { cleanup(); }
});

test('every list given is saved under its own id', async () => {
  const { paths, cleanup } = scratch();
  try {
    const lists = {
      [LIST]: { record: { id: LIST, name: 'Loop Queue', task_count: 1 }, live: [task('t1')], archived: [] },
      [EXTRA]: { record: { id: EXTRA, name: 'Alarms', task_count: 1 }, live: [task('t9', { list: EXTRA })], archived: [] },
    };
    const m = await run(fakeTracker({ lists, comments: {} }), paths, { lists: [LIST, EXTRA] });
    assert.deepEqual(m.lists.map((l) => [l.id, l.name, l.tickets]), [[LIST, 'Loop Queue', 1], [EXTRA, 'Alarms', 1]]);
    assert.ok(existsSync(join(paths.folder, `lists/${EXTRA}/tasks/t9.json`)));
  } finally { cleanup(); }
});

test('the nightly backup never prunes the snapshot archive', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clickup-snapshot-backup-'));
  try {
    const db = join(dir, 'tracker.db');
    const live = new DatabaseSync(db);
    live.exec('CREATE TABLE tickets (id TEXT)');
    live.close();
    const backups = join(dir, 'backups');
    mkdirSync(backups);
    const archive = join(backups, 'clickup-archive-widget-2026-11-08.tar.gz');
    writeFileSync(archive, 'archive');
    for (const day of ['2026-11-01', '2026-11-02', '2026-11-03']) writeFileSync(join(backups, `tracker-${day}.db`), '');
    const { removed } = backupDatabase({ db, dir: backups, keep: 1, now: new Date(2026, 10, 9) });
    assert.equal(removed.length, 3);
    assert.ok(existsSync(archive), 'the archive is still there');
    assert.ok(!listBackups(db, backups).includes(archive));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('attachments are found on the ticket and in comments and replies, each once', () => {
  const thread = [
    { id: 'c1', comment: [{ type: 'attachment', attachment: { id: 'a1', title: 'dup', url: 'https://x.test/1' } }],
      replies: [{ id: 'r1', comment: [{ type: 'attachment', attachment: { id: 'a3', url: 'https://x.test/files/three.pdf' } }, { type: 'text', text: 'hi' }] }] },
  ];
  const found = attachmentsOf({ attachments: [{ id: 'a1', title: 'one', url: 'https://x.test/1', size: '10' }, { id: 'nourl' }] }, thread);
  assert.deepEqual(found.map((f) => [f.id, f.title, f.from, f.size]), [['a1', 'one', 'ticket', 10], ['a3', 'three.pdf', 'reply r1', null]]);
});

test('a file name cannot climb out of its folder or hide', () => {
  assert.equal(safeName('../../etc/passwd'), '__.._etc_passwd');
  assert.equal(safeName('.secret'), '_secret');
  assert.equal(safeName(''), 'file');
  assert.equal(safeName('a'.repeat(300)).length, 120);
});

test('--list may be given more than once, and needs an id', () => {
  assert.deepEqual(listArgs(['--list', '1', '--dry-run', '--list', '2']), ['1', '2']);
  assert.throws(() => listArgs(['--list', '--dry-run']), /--list needs a list id/);
});

test('a list record without a count says so rather than calling it a match or a miss', () => {
  const [k] = compareCounts('7', {}, { tickets: 3, open: 3, closed: 0, archived: 0, replies: 0, repliesClickup: 0 });
  assert.equal(k.ok, true);
  assert.match(k.line, /gives no count to compare/);
});

test('a config that names no ClickUp list (all zeros) saves only the --list ids, and refuses plainly when there are none', () => {
  const archived = { projectSlug: SLUG, loopQueueListId: '0' };
  assert.deepEqual(listsToSave(archived, [EXTRA]), [EXTRA]);
  assert.deepEqual(listsToSave({ ...archived, loopQueueListId: '000' }, [EXTRA, LIST, EXTRA]), [EXTRA, LIST]);
  assert.throws(() => listsToSave(archived, []), (err) => {
    assert.ok(err instanceof SnapshotError);
    assert.match(err.message, /names no ClickUp list .*"0".*no --list was given.*--list <id>/);
    return true;
  });
  assert.deepEqual(listsToSave({ projectSlug: SLUG, loopQueueListId: LIST }, [EXTRA]), [LIST, EXTRA]);
});

test('a list id typed without --list is refused, never silently ignored', () => {
  assert.throws(() => listArgs([EXTRA]), /"5353" is not understood.*--list 5353/);
  assert.throws(() => listArgs(['--dry-run', '--force']), /"--force" is not understood/);
  assert.deepEqual(listArgs(['--dry-run', '--list', EXTRA]), [EXTRA]);
});

test('a pack that fails leaves nothing named as the snapshot, and an earlier snapshot from the same day stays', async () => {
  const { paths, cleanup } = scratch();
  try {
    await run(fakeTracker(), paths);
    const before = filesUnder(paths.folder).length;
    const archiveBefore = readFileSync(paths.archive);
    await assert.rejects(run(fakeTracker(), paths, { tar: '/usr/bin/false' }), (err) => {
      assert.ok(err instanceof SnapshotError);
      assert.match(err.message, /packing the archive .* failed/);
      return true;
    });
    assert.equal(filesUnder(paths.folder).length, before, 'the earlier snapshot is untouched');
    assert.deepEqual(readFileSync(paths.archive), archiveBefore, 'the earlier archive is untouched');
    assert.ok(!existsSync(`${paths.archive}.partial`));
  } finally { cleanup(); }
});

test('a pack that fails on the first run leaves no folder and no archive under the snapshot name', async () => {
  const { paths, cleanup } = scratch();
  try {
    await assert.rejects(run(fakeTracker(), paths, { tar: '/usr/bin/false' }), SnapshotError);
    assert.ok(!existsSync(paths.folder));
    assert.ok(!existsSync(paths.archive));
  } finally { cleanup(); }
});

test('the archive holds the snapshot under its own name and reads back with its manifest', async () => {
  const { paths, cleanup } = scratch();
  try {
    await run(fakeTracker(), paths);
    const listed = execFileSync('tar', ['-tzf', paths.archive], { encoding: 'utf8' }).split('\n').map((l) => l.replace(/^\.\//, ''));
    assert.ok(listed.includes(`${paths.name}/manifest.json`));
    assert.ok(listed.every((l) => !l || l.startsWith(`${paths.name}/`)), 'nothing outside the snapshot folder, no .partial');
    assert.ok(!existsSync(paths.work));
  } finally { cleanup(); }
});

test('a comment with replies but no reply_count is not counted as a difference; it is named as not comparable', async () => {
  const { paths, cleanup } = scratch();
  try {
    const comments = { t1: [{ id: 'c1', date: '1767225700000', comment_text: 'first' }] };
    const m = await run(fakeTracker({ comments }), paths);
    assert.equal(m.counts.replies, 2, 'the replies were still read and saved');
    const replies = m.checks.find((k) => k.what === 'replies');
    assert.equal(replies.ok, true);
    assert.match(replies.line, /1 comment\(s\) without a reply count .* not comparable.* 2 repl\(ies\) are left out/);
    assert.ok(!formatSummary(m).includes('DIFFERS'));
  } finally { cleanup(); }
});

test('a picture pasted into a comment as an image part is found and saved', () => {
  const thread = [{ id: 'c9', comment: [
    { text: 'see this' },
    { type: 'image', text: 'shot.png', image: { id: 'i1', name: 'shot.png', url: 'https://t1.p.clickup-attachments.com/i1/shot.png' } },
  ], replies: [] }];
  assert.deepEqual(attachmentsOf({ attachments: [] }, thread).map((a) => [a.id, a.title, a.from]), [['i1', 'shot.png', 'comment c9']]);
});
