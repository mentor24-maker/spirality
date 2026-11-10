'use strict';

/**
 * mergeWindowLeaseFile — the only disk IO the merge window owns, kept out of
 * `mergeWindowLease.js` so that module stays break-testable without a disk,
 * and out of `scripts/clickup_direct.mjs` so this part can be tested at all.
 *
 * The shape and the two rules are `autoMergeLedgerFile.js`'s, and for the same
 * incident (2026-08-30): a fail-safe that gets overwritten by the pass that
 * tripped it is not a fail-safe. One difference, and it matters — the ledger is
 * written once at the END of a pass, and this is written the INSTANT the window
 * changes hands. A pass that crashes between taking the window and merging must
 * leave the window HELD, because the alternative is a crash quietly letting the
 * next branch in, which is the livelock arriving through the fix meant to
 * prevent it. The 45-minute bound in the pure module is what clears it after.
 *
 *   1. A lease that could not be read is NEVER written over.
 *   2. A write is atomic — temp file then rename — because a torn write is how
 *      a lease gets unreadable in the first place.
 */

const fs = require('fs');
const { spawnSync } = require('child_process');
const { asLease } = require('./mergeWindowLease');

/**
 * Beside the auto-merge ledger, in the git common directory. `--git-common-dir`
 * rather than `--git-dir` so the answer is the same from inside a linked
 * worktree — the relay may be started from anywhere, and a lease that lives in
 * two places is two windows (vault doctrine/NODES.md P1: derive the path, never
 * write it down).
 */
function leasePath({ cwd } = {}) {
  const out = spawnSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8', cwd });
  const dir = out.status === 0 ? String(out.stdout || '').trim() : '';
  if (!dir) return null;
  return `${dir}/merge-window-lease.json`;
}

/**
 * Read the lease. A MISSING file is a free window — that is a first run, not a
 * fault. An UNREADABLE one is a different thing: the file may name a holder
 * this pass cannot see, and `windowDecision` turns that into a refusal to move
 * main. So the distinction has to survive the read.
 */
function readLeaseFile(file) {
  if (!file) return { ok: false, lease: asLease(null), file: null, why: 'could not locate the git directory, so the merge window could not be read' };
  if (!fs.existsSync(file)) return { ok: true, lease: asLease(null), file, fresh: true };
  try {
    return { ok: true, lease: asLease(JSON.parse(fs.readFileSync(file, 'utf8'))), file };
  } catch (e) {
    return { ok: false, lease: asLease(null), file, why: `the merge window file could not be read (${e.message})` };
  }
}

/** Write the whole lease atomically: a temp file beside it, then a rename. */
function writeLeaseFile(lease, file) {
  if (!file) return { ok: false, why: 'no merge-window path' };
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(asLease(lease), null, 2)}\n`);
    fs.renameSync(tmp, file);
    return { ok: true };
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* a leftover temp file is not worth failing over */ }
    return { ok: false, why: e.message };
  }
}

/**
 * The guard every caller uses. `read` is what `readLeaseFile` returned; if that
 * read failed, the file on disk holds a window this pass never saw, and writing
 * over it would hand the window to a second branch — the exact thing the lease
 * exists to prevent. Refuses out loud rather than skipping.
 */
function saveLeaseIfReadable(read, lease) {
  if (!read || !read.file) return { ok: false, skipped: true, why: 'no merge-window path' };
  if (!read.ok) {
    return {
      ok: false,
      skipped: true,
      why: `the merge window was not read cleanly this pass, so it was NOT written — an unreadable window must be looked at by hand (${read.file}), not overwritten with a free one`,
    };
  }
  return writeLeaseFile(lease, read.file);
}

module.exports = { leasePath, readLeaseFile, writeLeaseFile, saveLeaseIfReadable };
