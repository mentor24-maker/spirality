#!/usr/bin/env node
/**
 * `npm run doctor`: is every key this product expects actually in Doppler?
 * Looks in the Doppler project and config the project config names
 * (`dopplerProject`, `dopplerConfig`), and says which one it checked.
 * Prints expected names × configs as present / MISSING. Exit 0 when all are
 * there, 1 otherwise. It asks Doppler for NAMES ONLY (`--only-names`), so a
 * value never reaches this process, let alone the screen.
 */
import { spawnSync } from 'node:child_process';
import { loadProjectConfig, ProjectConfigError } from '../lib/projectConfig.mjs';
import { doctorTarget, doctorReport, formatReport } from './lib/expectedSecrets.mjs';

let target;
try {
  target = doctorTarget(loadProjectConfig());
} catch (err) {
  if (!(err instanceof ProjectConfigError)) throw err;
  console.error(`doctor: the project config is not usable — ${err.message}`);
  process.exit(1);
}
const { project, configs, expected } = target;

function namesIn(config) {
  const r = spawnSync('doppler', [
    'secrets', '--project', project, '--config', config, '--only-names', '--json', '--no-check-version',
  ], { encoding: 'utf8' });
  if (r.error) return { error: `could not run the doppler command (${r.error.code}); is the Doppler CLI installed?` };
  let parsed;
  try { parsed = JSON.parse(r.stdout); } catch { parsed = null; }
  if (r.status !== 0 || !parsed || parsed.error) {
    return { error: (parsed && parsed.error) || r.stderr.trim() || `doppler exited ${r.status}` };
  }
  return { names: new Set(Object.keys(parsed)) };
}

const present = {};
const problems = [];
for (const config of configs) {
  const { names, error } = namesIn(config);
  present[config] = names || null;
  if (error) problems.push(`${config}: ${error}`);
}

const report = doctorReport(present, expected, configs);
console.log(`Doppler project ${project}, config ${configs.join(', ')} (names only, never values)\n`);
console.log(formatReport(report, configs));
for (const p of problems) console.error(`\nCould not read config ${p}`);
console.log(report.ok
  ? '\ndoctor: every expected key is in Doppler.'
  : '\ndoctor: something is MISSING or unreadable. Add keys only through the Doppler dashboard.');
process.exit(report.ok ? 0 : 1);
