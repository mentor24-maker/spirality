#!/usr/bin/env node
/**
 * Give a project's existing tickets their kind, who started them and how they
 * ended, from a reviewed table (SP-348).
 *
 *   node scripts/classify_backfill.mjs docs/ticket-class/spirality.tsv           say what it WOULD set, write nothing
 *   node scripts/classify_backfill.mjs docs/ticket-class/spirality.tsv --apply   set it, one `classify` per ticket
 *
 * WHY THIS EXISTS (2026-11-16). SP-345 gave every ticket three fields
 * (lib/ticketClass.js, docs/LOOP_CONTRACT.md), but the 344 tickets filed
 * before them had none, so a report could not compare the past with what
 * comes next. The judgment (which ticket is a Feature, which a Fix) is made
 * by reading each ticket, not by a rule in code, so it lives in a table a
 * person can read and overturn line by line, and this script only applies
 * it. StarCaster and WaveCenter can each get a table of their own.
 *
 * The table is tab-separated: `id`, `kind`, `started_by`, `outcome`, `note`.
 * A line starting `#` is a comment. An empty field is left alone (never
 * cleared), so a table can fill in only what it knows.
 *
 * Every write goes through the door's `classify` command, which reads each
 * ticket back and exits non-zero when a value did not stick (engineering rule
 * 5). Only a field that differs from the ticket today is written, so running
 * it twice writes nothing the second time. An ending on a ticket that is open
 * today is skipped and said, because the tracker refuses one (a ticket the
 * table saw closed may have been reopened since).
 *
 * Exit codes: 0 every change was made (or, without --apply, the table is
 * sound); 1 a write or the read of the tickets failed; 2 the table has a
 * line it cannot read, so nothing was written.
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classValue } = require('../lib/ticketClass.js');

/** The table's columns, as the door's flags and as `tickets --json` names them. */
const COLUMNS = [
  { column: 'kind', field: 'kind', flag: '--kind' },
  { column: 'started_by', field: 'startedBy', flag: '--started-by' },
  { column: 'outcome', field: 'outcome', flag: '--outcome' },
];

/**
 * Read the table. Returns `{ rows, problems }`: each row `{ id, kind,
 * startedBy, outcome, note }` with a value or null per field, and each
 * problem a plain sentence naming its line.
 */
export function parseTable(text) {
  const rows = [];
  const problems = [];
  const seen = new Set();
  String(text).split('\n').forEach((raw, i) => {
    const line = raw.replace(/\r$/, '');
    if (!line.trim() || line.startsWith('#')) return;
    const cells = line.split('\t');
    const where = `line ${i + 1}`;
    const id = (cells[0] || '').trim();
    if (!/^[A-Z][A-Z0-9]*-\d+$/.test(id)) { problems.push(`${where}: "${id}" is not a ticket id.`); return; }
    if (seen.has(id)) { problems.push(`${where}: ${id} is in the table twice.`); return; }
    seen.add(id);
    const row = { id, note: (cells[4] || '').trim() };
    COLUMNS.forEach(({ column, field }, n) => {
      const got = classValue(field, cells[n + 1] ?? null);
      if (got.problem) { problems.push(`${where} (${id}, ${column}): ${got.problem}`); row[field] = null; } else row[field] = got.value;
    });
    rows.push(row);
  });
  return { rows, problems };
}

/**
 * What to write, given the table and the tickets as `tickets --json` prints
 * them. Returns `{ changes, skipped }`: each change `{ id, flags, said }`
 * names only the fields that differ today; each skip says why.
 */
export function planChanges(rows, tickets) {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const changes = [];
  const skipped = [];
  for (const row of rows) {
    const t = byId.get(row.id);
    if (!t) { skipped.push(`${row.id}: not in the tracker's list of tickets, so nothing was set.`); continue; }
    const flags = [];
    const said = [];
    for (const { field, flag } of COLUMNS) {
      const want = row[field];
      if (want == null || t[field] === want) continue;
      if (field === 'outcome' && t.status !== 'live') { skipped.push(`${row.id}: open today (${t.status}), so its ending "${want}" was not set.`); continue; }
      flags.push(flag, want);
      said.push(`${field} ${t[field] ?? 'none'} -> ${want}`);
    }
    if (flags.length) changes.push({ id: row.id, flags, said: said.join(', ') });
  }
  return { changes, skipped };
}

function door(args) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  return spawnSync('npm', ['run', '--silent', 'clickup', '--', ...args], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

async function main(argv) {
  const file = argv.find((a) => !a.startsWith('--'));
  const apply = argv.includes('--apply');
  if (!file) { console.error('Usage: node scripts/classify_backfill.mjs <table.tsv> [--apply]'); return 2; }
  const { rows, problems } = parseTable(readFileSync(file, 'utf8'));
  if (problems.length) {
    console.error(`The table has ${problems.length} line(s) it cannot read, so nothing was written:`);
    for (const p of problems) console.error(`  ${p}`);
    return 2;
  }
  const read = door(['tickets', '--json', '--include-closed']);
  let tickets;
  try { tickets = JSON.parse(read.stdout); } catch { tickets = null; }
  if (read.status !== 0 || !Array.isArray(tickets)) {
    console.error(`Could not read the tickets (exit ${read.status}): ${String(read.stderr).slice(0, 400)}\nNothing was written.`);
    return 1;
  }
  const { changes, skipped } = planChanges(rows, tickets);
  for (const s of skipped) console.log(`skipped ${s}`);
  if (!apply) {
    for (const c of changes) console.log(`would set ${c.id}: ${c.said}`);
    console.log(`${changes.length} ticket(s) would change, ${rows.length - changes.length} need nothing. Nothing was written (add --apply).`);
    return 0;
  }
  let set = 0;
  const failed = [];
  for (const c of changes) {
    const out = door(['classify', '--task', c.id, ...c.flags]);
    if (out.status === 0) { set += 1; console.log(`set ${c.id}: ${c.said} (read back)`); } else {
      failed.push(c.id);
      console.error(`FAILED ${c.id} (exit ${out.status}): ${String(out.stderr).trim().split('\n')[0]}`);
    }
  }
  console.log(`${set} ticket(s) set and read back, ${failed.length} failed${failed.length ? ` (${failed.join(', ')})` : ''}, ${skipped.length} field(s) skipped, ${rows.length - changes.length} ticket(s) needed nothing.`);
  return failed.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => { console.error(err?.stack || String(err)); process.exit(1); });
}
