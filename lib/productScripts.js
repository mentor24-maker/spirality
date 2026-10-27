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
 * Slice 2 (2026-10-13) brought tests that read four more product files, all
 * product governance rather than modules: the loop-build skill, the loop
 * engineering guide, the auto-merge reach check (with the package.json and CI
 * workflow beside it) and the folder of `check_*` gates. Same rule, same
 * mechanism:
 *
 *   buildSkill           the product's `.claude/skills/loop-build/SKILL.md`
 *   loopDoc              the product's `docs/LOOP_ENGINEERING.md`
 *   automergeReachCheck  the product's `scripts/check_automerge_reach.cjs`
 *   gates                the FOLDER holding the product's `check_*` gates
 *                        (read with `productDir`, not `productScript`)
 *
 * In StarCaster both sat beside the folder these modules lived in, so the
 * tests found them at `../`. Here there is no such sibling: Spirality's door
 * is `scripts/clickup.mjs`, a different and much smaller script, and there is
 * no bus relay at all. Pointing these tests at what this repository happens to
 * have would not be the same check, it would be a new and failing one — and
 * the ticket's non-goals forbid changing what a moved test asserts.
 *
 * Slice 3 (2026-10-26) brought three helper tests that read five more, all
 * runners and commands the helpers are the tables for:
 *
 *   reviewSkill          the product's `.claude/skills/loop-review/SKILL.md`
 *   preflightRunner      the product's `scripts/preflight.mjs`
 *   repairRunner         the product's `scripts/repair.mjs`
 *   busRelayRunner       the product's `scripts/run_bus_relay.sh`
 *   reconcileScript      the product's `scripts/reconcile_clickup_github.cjs`
 *
 * So a product script's path is a per-product fact, like every other one: it
 * comes from the project config, under `productScripts`. Until a product's own
 * scripts move into this package too — which is NOT part of task 86bcgmnpy:
 * on 2026-10-26 Dane chose (a), closing that ticket without the door, which
 * gets its own ticket and a spec pass first — these reads find nothing and the
 * tests that need them skip out loud rather than failing on an absence that is
 * expected. A product whose config names its scripts runs every one of them.
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
    + '— this wiring check runs where the product\'s own script is configured (task 86bcgmnpy)');
  return true;
}

/** The product's ClickUp door, by far the most-read of them. */
const doorSource = () => productScript('door');
const skipWithoutDoor = (t) => skipWithoutProductScript(t, 'door');

/**
 * The folder the product config was found in — the product's repo root — or
 * null when there is no config. Tests that read a file BESIDE a product script
 * (the package.json next to a gate) resolve it from here, never from this
 * package's own folder.
 */
const productRoot = () => repoRoot();

/**
 * The absolute path of the product FOLDER `key`, or null when none is
 * configured. As with `productScript`, a folder that is configured and is not
 * there THROWS: the config said the product has it.
 */
function productDir(key) {
  const dir = productScriptPath(key);
  if (!dir) return null;
  let stat;
  try {
    stat = fs.statSync(dir);
  } catch (err) {
    throw new Error(`product "${key}" folder is configured (project config "productScripts.${key}") `
      + `as ${dir}, but it cannot be read: ${err.code || err.message}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`product "${key}" is configured (project config "productScripts.${key}") `
      + `as ${dir}, which is not a folder`);
  }
  return dir;
}

/** `skipWithoutProductScript`, for a key that names a folder. */
function skipWithoutProductDir(t, key) {
  if (productDir(key) !== null) return false;
  t.skip(`no product "${key}" folder configured here (project config "productScripts.${key}") `
    + '— this wiring check runs where the product\'s own folder is configured (task 86bcgmnpy)');
  return true;
}

module.exports = {
  productScriptPath, productScript, skipWithoutProductScript, doorSource, skipWithoutDoor,
  productRoot, productDir, skipWithoutProductDir,
};
