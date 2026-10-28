import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from './store.mjs';
import { backupDatabase, listBackups, DEFAULT_KEEP } from './backup.mjs';

const BACKUP_SCRIPT = new URL('./backup.mjs', import.meta.url).pathname;

/** A store on disk with one machine, one project and `n` tickets, plus an empty backup folder. */
function fixture(n = 3) {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-backup-'));
  const path = join(dir, 'tracker.db');
  const backups = join(dir, 'backups');
  mkdirSync(backups);
  const store = openStore(path);
  const machine = store.createActor({ kind: 'machine', name: 'Loop' });
  store.createProject({ slug: 'alpha', name: 'Alpha', prefix: 'AL' });
  for (let i = 0; i < n; i += 1) {
    store.fileTicket({ project: 'alpha', actor: machine.id, name: `ticket ${i}`, status: 'queued', description: `body ${i}` });
  }
  const cleanup = () => { store.close(); rmSync(dir, { recursive: true, force: true }); };
  return { dir, path, backups, store, machine, cleanup };
}

function ticketsIn(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare('SELECT * FROM tickets ORDER BY number').all();
  } finally { db.close(); }
}

test('a backup is a dated, standalone copy that opens cleanly and holds the same tickets', () => {
  const { path, backups, cleanup } = fixture(3);
  try {
    const r = backupDatabase({ db: path, dir: backups, now: new Date(2026, 9, 27, 3, 15) });
    assert.equal(r.file, join(backups, 'tracker-2026-10-27.db'));
    assert.equal(r.tickets, 3);
    assert.deepEqual(r.removed, []);
    // Nothing left beside it: no partial file, no write-ahead log.
    assert.deepEqual(readdirSync(backups), ['tracker-2026-10-27.db']);
    assert.deepEqual(ticketsIn(r.file), ticketsIn(path));
    const copy = new DatabaseSync(r.file, { readOnly: true });
    try {
      assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.equal(copy.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
    } finally { copy.close(); }
  } finally { cleanup(); }
});

test('a backup made while another connection keeps writing opens cleanly and holds the same tickets', async () => {
  const { path, backups, store, machine, cleanup } = fixture(50);
  const storeUrl = new URL('./store.mjs', import.meta.url).href;
  // The writer files tickets as fast as it can until told to stop: the server
  // under load, from the backup's point of view (another connection, its own
  // write transactions, the log growing all the while).
  const source = `
    import { workerData, parentPort } from 'node:worker_threads';
    const { openStore } = await import(workerData.storeUrl);
    const s = openStore(workerData.path);
    const stop = new Int32Array(workerData.stop);
    let n = 0;
    parentPort.postMessage('started');
    while (Atomics.load(stop, 0) === 0) {
      s.fileTicket({ project: 'alpha', actor: workerData.actor, name: 'during ' + n, status: 'queued', description: 'x'.repeat(2000) });
      n += 1;
    }
    s.close();
    parentPort.postMessage(n);
  `;
  const stop = new SharedArrayBuffer(4);
  const w = new Worker(source, { eval: true, type: 'module', workerData: { storeUrl, path, actor: machine.id, stop } });
  try {
    const started = new Promise((resolve, reject) => { w.once('message', resolve); w.once('error', reject); });
    await started;
    // Let it write for a moment so the backup lands in the middle of the stream.
    await new Promise((r) => setTimeout(r, 200));
    const before = store.listTickets('alpha').length;
    const r = backupDatabase({ db: path, dir: backups, now: new Date(2026, 9, 27) });
    const done = new Promise((resolve, reject) => { w.once('message', resolve); w.once('error', reject); });
    Atomics.store(new Int32Array(stop), 0, 1);
    assert.ok((await done) > 0, 'the writer was really writing');

    const copy = new DatabaseSync(r.file, { readOnly: true });
    try {
      assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    } finally { copy.close(); }
    // The copy is the database at one moment: at least every ticket that
    // existed before the backup started, each exactly as the source holds it,
    // and no gaps (tickets are numbered in the order they were written).
    const saved = ticketsIn(r.file);
    const live = ticketsIn(path);
    assert.ok(saved.length >= before, `the copy holds ${saved.length} tickets, fewer than the ${before} written before it began`);
    assert.equal(r.tickets, saved.length);
    assert.deepEqual(saved, live.slice(0, saved.length));
  } finally {
    Atomics.store(new Int32Array(stop), 0, 1);
    await w.terminate();
    cleanup();
  }
});

test('only the newest backups are kept, and a same-day run replaces that day', () => {
  const { path, backups, cleanup } = fixture(1);
  try {
    // Something else in the folder is never touched by pruning.
    writeFileSync(join(backups, 'notes.txt'), 'keep me');
    for (let day = 1; day <= 5; day += 1) {
      backupDatabase({ db: path, dir: backups, keep: 3, now: new Date(2026, 9, day, 3) });
    }
    const kept = listBackups(path, backups).map((f) => f.slice(backups.length + 1));
    assert.deepEqual(kept, ['tracker-2026-10-03.db', 'tracker-2026-10-04.db', 'tracker-2026-10-05.db']);
    const again = backupDatabase({ db: path, dir: backups, keep: 3, now: new Date(2026, 9, 5, 23) });
    assert.deepEqual(again.removed, []);
    assert.equal(listBackups(path, backups).length, 3);
    assert.ok(existsSync(join(backups, 'notes.txt')));
    assert.equal(DEFAULT_KEEP, 14);
  } finally { cleanup(); }
});

test('a missing database or folder fails saying so, and creates nothing', () => {
  const { dir, backups, cleanup } = fixture(0);
  try {
    const missing = join(dir, 'nope.db');
    assert.throws(() => backupDatabase({ db: missing, dir: backups }), /no database at/);
    assert.equal(existsSync(missing), false, 'a missing database is not created by trying to back it up');
    assert.throws(() => backupDatabase({ db: join(dir, 'tracker.db'), dir: join(dir, 'gone') }), /does not exist/);
    assert.throws(() => backupDatabase({ db: join(dir, 'tracker.db'), dir: backups, keep: 0 }), /at least 1/);
    assert.deepEqual(readdirSync(backups), []);
  } finally { cleanup(); }
});

test('run directly, it reads TRACKER_DB and TRACKER_BACKUP_DIR and exits non-zero on failure', () => {
  const { dir, path, backups, cleanup } = fixture(2);
  try {
    const ok = spawnSync(process.execPath, [BACKUP_SCRIPT], {
      encoding: 'utf8', env: { ...process.env, TRACKER_DB: path, TRACKER_BACKUP_DIR: backups },
    });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /backup OK: .*tracker-\d{4}-\d{2}-\d{2}\.db \(2 ticket\(s\)\); kept the newest 14, removed 0\./);

    const bad = spawnSync(process.execPath, [BACKUP_SCRIPT], {
      encoding: 'utf8', env: { ...process.env, TRACKER_DB: join(dir, 'nope.db'), TRACKER_BACKUP_DIR: backups },
    });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /backup FAILED: there is no database at/);
    assert.doesNotMatch(bad.stdout, /OK/);
  } finally { cleanup(); }
});
