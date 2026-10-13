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
const { projectConfig } = require('./substrateConfig.js');

/**
 * The CONSUMER'S config, read through the one reader (`projectConfig.mjs`, by
 * way of `substrateConfig.js`) — never a second parser of the same file that
 * could drift from it. It walks up from the working directory, never from this
 * file's own folder: see the note in `substrateConfig.js`.
 */
function repoRoot() {
  try {
    // eslint-disable-next-line global-require
    const { findConfigFile } = require('./projectConfig.mjs');
    const file = findConfigFile(process.cwd());
    return file ? path.dirname(file) : null;
  } catch {
    return null;
  }
}

/** The `productScripts` map from the project config, or an empty object. */
function configuredScripts() {
  const config = projectConfig();
  const scripts = config && config.productScripts;
  return scripts && typeof scripts === 'object' && !Array.isArray(scripts) ? scripts : {};
}

/** The absolute path configured for `key`, or null when none is. */
function productScriptPath(key) {
  const rel = configuredScripts()[key];
  if (typeof rel !== 'string' || !rel.trim()) return null;
  const root = repoRoot();
  return root ? path.join(root, rel) : null;
}

/**
 * The source text of the product script `key`, or null when NONE IS
 * CONFIGURED. A script that IS configured but cannot be read THROWS: the
 * config says the product has it, so its absence is a fault, not an expected
 * gap — and a quiet null would let the wiring tests skip green over exactly
 * the mistake they exist to catch (review of task 86bcgmnpy).
 */
function productScript(key) {
  const file = productScriptPath(key);
  if (!file) return null;
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`product "${key}" script is configured (project config "productScripts.${key}") `
      + `as ${file}, but it cannot be read: ${err.code || err.message}`);
  }
}

/**
 * Skip the running test when this repository configures no such product
 * script. `t` is node:test's context. Returns true when the test should stop.
 * A configured script that is missing FAILS the test instead (see above).
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
