#!/usr/bin/env node
/**
 * `npm run doctor`: is every key Spirality expects actually in Doppler?
 * Prints expected names × configs as present / MISSING. Exit 0 when all are
 * there, 1 otherwise. It asks Doppler for NAMES ONLY (`--only-names`), so a
 * value never reaches this process, let alone the screen.
 */
import { spawnSync } from 'node:child_process';
import { DOPPLER_PROJECT, CONFIGS, doctorReport, formatReport } from './lib/expectedSecrets.mjs';

function namesIn(config) {
  const r = spawnSync('doppler', [
    'secrets', '--project', DOPPLER_PROJECT, '--config', config, '--only-names', '--json', '--no-check-version',
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
for (const config of CONFIGS) {
  const { names, error } = namesIn(config);
  present[config] = names || null;
  if (error) problems.push(`${config}: ${error}`);
}

const report = doctorReport(present);
console.log(`Doppler project "${DOPPLER_PROJECT}" (names only, never values)\n`);
console.log(formatReport(report));
for (const p of problems) console.error(`\nCould not read config ${p}`);
console.log(report.ok
  ? '\ndoctor: every expected key is in Doppler.'
  : '\ndoctor: something is MISSING or unreadable. Add keys only through the Doppler dashboard.');
process.exit(report.ok ? 0 : 1);
