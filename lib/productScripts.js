'use strict';

/**
 * The consuming product's own scripts, read as source text — or `null` when
 * this repository does not have the one asked for.
 *
 * WHY THIS EXISTS (2026-10-12, task 86bcgmnpy, slice 1 of 3). Several of the
 * moved modules ship "wiring" tests that read a PRODUCT script's source and
 * assert the product actually calls the module — the check that catches a fix
 * which is correct in the module and inert in the thing that runs. Two such
 * scripts are read:
 *
 *   door                 StarCaster's `scripts/clickup_direct.mjs`, the one
 *                        command that touches ClickUp.
 *   busRelayInstaller    StarCaster's `install_bus_relay.sh`, which declares
 *                        INTERVAL_SECONDS — the bound a pass may not outlast.
 *
 * In StarCaster both sat beside the folder these modules lived in, so the
 * tests found them at `../`. Here there is no such sibling: Spirality's door
 * is `scripts/clickup.mjs`, a different and much smaller script, and there is
 * no bus relay at all. Pointing these tests at what this repository happens to
 * have would not be the same check, it would be a new and failing one — and
 * the ticket's non-goals forbid changing what a moved test asserts.
 *
 * So a product script's path is a per-product fact, like every other one: it
 * comes from the project config, under `productScripts`. Until a product's own
 * scripts move into this package too — Dane's decision of 2026-10-12, option
 * (a), slice 3 — these reads find nothing and the tests that need them skip
 * out loud rather than failing on an absence that is expected.
 *
 * Every assertion in those tests is left byte-for-byte as it came across.
 * The slice that brings a script over gives it a `productScripts` entry, and
 * its tests start running with no further edit.
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * Walk up from the WORKING DIRECTORY to the folder holding the project config
 * — the consumer's, never this package's own. See the note in
 * `substrateConfig.js`: resolving from `__dirname` finds Spirality's config
 * once this package sits in another repository's `node_modules`.
 */
function repoRoot() {
  let dir = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(dir, 'spirality.project.json'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** The `productScripts` map from the project config, or an empty object. */
function configuredScripts() {
  const root = repoRoot();
  if (!root) return {};
  try {
    const config = JSON.parse(fs.readFileSync(path.join(root, 'spirality.project.json'), 'utf8'));
    const scripts = config && config.productScripts;
    return scripts && typeof scripts === 'object' && !Array.isArray(scripts) ? scripts : {};
  } catch {
    return {};
  }
}

/** The absolute path configured for `key`, or null when none is. */
function productScriptPath(key) {
  const rel = configuredScripts()[key];
  if (typeof rel !== 'string' || !rel.trim()) return null;
  const root = repoRoot();
  return root ? path.join(root, rel) : null;
}

/** The source text of the product script `key`, or null when there is none. */
function productScript(key) {
  const file = productScriptPath(key);
  if (!file || !fs.existsSync(file)) return null;
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Skip the running test when this repository has no such product script.
 * `t` is node:test's context. Returns true when the test should stop.
 */
function skipWithoutProductScript(t, key) {
  if (productScript(key) !== null) return false;
  t.skip(`no product "${key}" script configured here (project config "productScripts.${key}") `
    + '— this wiring check moves with that script in slice 3 of task 86bcgmnpy');
  return true;
}

/** The product's ClickUp door, by far the most-read of them. */
const doorSource = () => productScript('door');
const skipWithoutDoor = (t) => skipWithoutProductScript(t, 'door');

module.exports = {
  productScriptPath, productScript, skipWithoutProductScript, doorSource, skipWithoutDoor,
};
