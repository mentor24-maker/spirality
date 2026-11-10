'use strict';

/**
 * autoMergeLedgerFile — the ONE piece of file IO Lane A owns, kept out of the
 * pure module (autoMergeLane.js) so that module stays break-testable without a
 * disk, and out of clickup_direct.mjs so this part can be tested at all.
 *
 * WHY IT IS ITS OWN FILE (2026-08-30, review round 2 on task 86bbkw2au). The
 * relay read the ledger, got `{ ok: false, ledger: <empty> }` on a corrupt
 * file, correctly halted the lane for that pass — and then wrote the EMPTY
 * ledger back over the corrupt one at the end of the block. That erased a
 * persisted "stop auto-merging", the self-disable flag and the rate-cap
 * history, so the NEXT pass read a clean ledger, saw no stop, and the lane was
 * back on. The one direction a fail-safe must never fail in, and nothing
 * tested it because the read and the write lived in a 3,000-line script.
 *
 * Two rules, both tested here:
 *   1. A ledger that could not be read is NEVER written over.
 *   2. A write is atomic — temp file then rename — because a torn write is how
 *      a ledger gets corrupt in the first place.
 */

const fs = require('fs');
const path = require('path');
const { asLedger } = require('./autoMergeLane');

/**
 * Read the ledger. A MISSING file is an empty ledger — that is a first run,
 * not a fault. An UNREADABLE or unparseable one is a different thing and must
 * not be waved through: the rate cap and the self-disable flag both live in
 * here, so "I could not read it" has to mean what an unreadable kill switch
 * means, which is OFF.
 */
function readLedgerFile(file) {
  if (!file) return { ok: false, ledger: asLedger(null), file: null, why: 'could not locate the git directory, so the auto-merge ledger could not be read' };
  if (!fs.existsSync(file)) return { ok: true, ledger: asLedger(null), file, fresh: true };
  try {
    return { ok: true, ledger: asLedger(JSON.parse(fs.readFileSync(file, 'utf8'))), file };
  } catch (e) {
    return { ok: false, ledger: asLedger(null), file, why: `the auto-merge ledger could not be read (${e.message})` };
  }
}

/** Write the whole ledger atomically: a temp file beside it, then a rename. */
function writeLedgerFile(ledger, file) {
  if (!file) return { ok: false, why: 'no ledger path' };
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`);
    fs.renameSync(tmp, file);
    return { ok: true };
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
    return { ok: false, why: e.message };
  }
}

/**
 * The guard the relay calls at the end of a pass. `read` is what
 * readLedgerFile returned at the START of the pass; if that read failed, the
 * ledger on disk holds state this pass never saw, and writing over it would
 * destroy a stop nobody has lifted. Refuses out loud rather than skipping.
 */
function saveLedgerIfReadable(read, ledger) {
  if (!read || !read.file) return { ok: false, skipped: true, why: 'no ledger path' };
  if (!read.ok) {
    return {
      ok: false,
      skipped: true,
      why: `the auto-merge ledger was not read cleanly this pass, so it was NOT written — a corrupt ledger must be looked at by hand (${read.file}), not overwritten with an empty one`,
    };
  }
  return writeLedgerFile(ledger, read.file);
}

module.exports = { readLedgerFile, writeLedgerFile, saveLedgerIfReadable };
