'use strict';

/**
 * The project config, for the CommonJS substrate modules.
 *
 * WHY THIS EXISTS (2026-10-12, task 86bcgmnpy). CLAUDE.md engineering rule 2:
 * nothing project-specific is hard-coded in substrate code — every id, name,
 * path and phrase that differs between products comes from the project config,
 * and "a literal list id in a module is a bug". The modules moved from
 * StarCaster carry a handful of such literals in the strings they build: the
 * operator's name, and the `[CC-<product>]` tag a loop signs a bus post with.
 *
 * `projectConfig.mjs` is the one reader, and it is ESM. These modules are
 * CommonJS, as they are in StarCaster (rule 3: move, don't rewrite). Node
 * 22.12 and newer let CommonJS `require()` an ESM module that has no top-level
 * await, which `projectConfig.mjs` does not — so the two live together with no
 * second copy of the reader and no rewrite of 13 modules.
 *
 * EVERY READ HERE FALLS BACK rather than throws. These are pure decision
 * modules: they are imported to format a sentence or classify a comment, often
 * in a test or a consumer that has no config file yet, and a module that
 * cannot build a string because a config key is missing has turned a wording
 * detail into an outage. The fallbacks name no product: "the operator", and a
 * tag of `[CC-loop]`. A product that wants its own name says so in its config.
 */

/** Loaded once per working directory; `null` records a load that failed. */
let cached;
let cachedFor;

/**
 * The validated project config, or `null` when there is none to read or it
 * does not pass its own checks. Never throws.
 *
 * THE CONFIG IS THE CONSUMER'S, FOUND FROM THE WORKING DIRECTORY — never from
 * this file's own folder. `projectConfig.mjs` walks up from `cwd` by design,
 * and that is the behaviour wanted: once StarCaster depends on this package,
 * `lib/` sits in ITS `node_modules` (a symlink, for a local checkout), so
 * walking up from `__dirname` would find SPIRALITY's config and hand StarCaster
 * a `productSlug` of "spirality". Caught by installing the package into a
 * throwaway consumer and reading the tag back, 2026-10-12.
 */
function projectConfig() {
  const cwd = process.cwd();
  if (cached !== undefined && cachedFor === cwd) return cached;
  cachedFor = cwd;
  cached = null;
  // A Node too old to require() an ESM file is NOT a missing config: falling
  // back here would sign every post `[CC-loop]` with no error at all. So the
  // reader is loaded outside the fallback, and that failure is loud.
  // `package.json` says node >=22.12 for this reason (review of 86bcgmnpy).
  // eslint-disable-next-line global-require
  const { loadProjectConfig } = require('./projectConfig.mjs');
  try {
    cached = loadProjectConfig({ cwd });
  } catch {
    cached = null;
  }
  return cached;
}

/** Forget the cached config. For tests that write a config and re-read it. */
function resetProjectConfig() { cached = undefined; cachedFor = undefined; }

/** What the loops call the operator in anything he reads. */
function operatorName() {
  const config = projectConfig();
  return (config && config.operatorName) || 'the operator';
}

/**
 * The tag a loop signs a post with: `[CC-spirality bus-relay]`, or
 * `[CC-spirality]` with no role. `CC` is the agent that runs the loop.
 */
function machineSenderTag(role, { agent = 'CC' } = {}) {
  const config = projectConfig();
  const slug = (config && config.productSlug) || 'loop';
  return role ? `[${agent}-${slug} ${role}]` : `[${agent}-${slug}]`;
}

/**
 * Comment prefixes this product's loops used before the `[machine]` stamp
 * existed. Per-product history; empty where a product has none.
 */
function legacyMachinePrefixes() {
  const config = projectConfig();
  return (config && config.legacyMachinePrefixes) || [];
}

module.exports = {
  projectConfig, resetProjectConfig, operatorName, machineSenderTag, legacyMachinePrefixes,
};
