#!/usr/bin/env node
/**
 * A throwaway tracker with test data, for trying Dane's page by hand:
 *
 *   node tracker/demo.mjs
 *
 * It makes a fresh store in a temporary folder (never the real one), fills
 * it from tracker/demoData.mjs, starts the server on a free port and prints
 * the address and a sign-in token for the test operator. The token is for
 * this throwaway store only and dies with it. Ctrl-C stops it and deletes
 * the folder.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from './store.mjs';
import { startServer } from './server.mjs';
import { seedDemo, tickingClock } from './demoData.mjs';

const dir = mkdtempSync(join(tmpdir(), 'tracker-demo-'));
const store = openStore(join(dir, 'tracker.db'), { now: tickingClock(Date.now() - 60 * 60_000) });
const { operator, token } = seedDemo(store);
const server = await startServer({ store, port: Number(process.env.TRACKER_PORT ?? 0), log: (line) => console.log(line) });

console.log(`\nDemo tracker (test data only) at http://127.0.0.1:${server.address().port}/`);
console.log(`Sign in as ${operator.name} with this throwaway token:\n\n  ${token}\n`);
console.log('Ctrl-C stops it and deletes the test data.');

function stop() {
  server.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
