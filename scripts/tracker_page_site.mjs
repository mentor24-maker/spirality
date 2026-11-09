#!/usr/bin/env node
/**
 * Make (or, with --check, check) the forwarding site for the tracker's page
 * name, sites/tracker-page/vercel.json, from the project config's
 * trackerPublicUrl (SP-164; why and how in scripts/lib/trackerPageSite.mjs
 * and docs/TRACKER_MVP.md, "The page's own name").
 *
 *   node scripts/tracker_page_site.mjs           write the file
 *   node scripts/tracker_page_site.mjs --check   exit 1 if it differs from the config
 *
 * Exit 0 done or matching, 1 differs (--check) or the write did not read
 * back, 2 the config could not be read or sets no trackerPublicUrl.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProjectConfig } from '../lib/projectConfig.mjs';
import { SITE_FILE, trackerPageSite, checkTrackerPageSite } from './lib/trackerPageSite.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = join(root, SITE_FILE);
const check = process.argv.includes('--check');

let config;
try {
  // The file's values only: an address override in the environment must not change what is committed.
  config = loadProjectConfig({ cwd: root, env: {} });
} catch (err) {
  console.error(`tracker page site: the project config could not be read: ${err.message}`);
  process.exit(2);
}

const onDisk = existsSync(file) ? readFileSync(file, 'utf8') : null;
if (check) {
  const { ok, why } = checkTrackerPageSite(config, onDisk);
  (ok ? console.log : console.error)(`check:tracker-page: ${ok ? '' : 'FAILED — '}${why}`);
  process.exit(ok ? 0 : 1);
}

let text;
try { text = trackerPageSite(config); } catch (err) {
  console.error(`tracker page site: ${err.message}`);
  process.exit(2);
}
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, text);
if (readFileSync(file, 'utf8') !== text) {
  console.error(`tracker page site: wrote ${SITE_FILE} but it did not read back the same.`);
  process.exit(1);
}
console.log(`tracker page site: wrote ${SITE_FILE}, forwarding every path to ${new URL(config.trackerPublicUrl).origin}.`);
