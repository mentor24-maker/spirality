#!/usr/bin/env node
/**
 * A throwaway tracker with test data, for trying Dane's page by hand:
 *
 *   node tracker/demo.mjs
 *
 * It makes a fresh store in a temporary folder (never the real one), fills
 * it from tracker/demoData.mjs, starts the server on a free port and prints
 * the address, a sign-in token for the test operator, and a set-password
 * link for the operator at a test email address, as the setup email would
 * carry. Both are for this throwaway store only and die with it. Ctrl-C
 * stops it and deletes the folder.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from './store.mjs';
import { CLOSE_PHRASE, startServer } from './server.mjs';
import { seedDemo, tickingClock } from './demoData.mjs';
import { setPasswordUrl } from './account.mjs';
import { loadProjectConfig } from '../lib/projectConfig.mjs';

/** The test operator's email, on a domain kept for examples, so nothing is ever sent to it. */
const DEMO_EMAIL = 'operator@example.com';

const dir = mkdtempSync(join(tmpdir(), 'tracker-demo-'));
const store = openStore(join(dir, 'tracker.db'), { now: tickingClock(Date.now() - 60 * 60_000) });
const { operator, token } = seedDemo(store);
// The Merge button posts the project config's first merge phrase, as on the real server.
let mergePhrase = null;
try { mergePhrase = loadProjectConfig().mergePhrases[0] ?? null; } catch (err) { console.log(`no Merge button: the project config is not usable (${err.message}).`); }
const server = await startServer({ store, port: Number(process.env.TRACKER_PORT ?? 0), log: (line) => console.log(line), mergePhrase, closePhrase: CLOSE_PHRASE });

console.log(`\nDemo tracker (test data only) at http://127.0.0.1:${server.address().port}/`);
console.log(`Sign in as ${operator.name} with this throwaway token:\n\n  ${token}\n`);
const link = store.makeLink({ purpose: 'setup', email: DEMO_EMAIL, actor: operator.id, madeBy: operator.id });
console.log(`Set-password link for ${operator.name} (test data only): ${setPasswordUrl(`http://127.0.0.1:${server.address().port}`, link.token)}\n`);
console.log('Ctrl-C stops it and deletes the test data.');

function stop() {
  server.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
