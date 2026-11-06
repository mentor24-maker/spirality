#!/usr/bin/env node
/**
 * A throwaway tracker with test data, for trying Dane's page by hand:
 *
 *   node tracker/demo.mjs
 *
 * It makes a fresh store in a temporary folder (never the real one), fills
 * it from tracker/demoData.mjs, starts the server on a free port and prints
 * the address, the test operator's email and a fresh password to sign in
 * with, and a set-password link for the operator, as the setup email would
 * carry. "Forgot password?" and the Users page's invites send nothing:
 * each email is printed here instead, an invite with its link on a line of
 * its own (`Invite link for <email>: <link>`). All of it is for this throwaway store only and dies with it.
 * Ctrl-C stops it and deletes the folder.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from './store.mjs';
import { CLOSE_PHRASE, GO_PHRASE, startServer } from './server.mjs';
import { seedDemo, tickingClock } from './demoData.mjs';
import { setPasswordUrl } from './account.mjs';
import { loadProjectConfig } from '../lib/projectConfig.mjs';

/** The test operator's email, on a domain kept for examples, so nothing is ever sent to it. */
const DEMO_EMAIL = 'operator@example.com';

const dir = mkdtempSync(join(tmpdir(), 'tracker-demo-'));
const clock = tickingClock(Date.now() - 60 * 60_000);
const store = openStore(join(dir, 'tracker.db'), { now: clock });
const { operator } = seedDemo(store, { clock });
const password = randomBytes(9).toString('base64url');
store.setEmail(operator.id, DEMO_EMAIL);
store.setPassword(operator.id, password);
/**
 * The reset and invite emails, printed rather than sent: the demo's email
 * addresses are example ones. An invite's link is also printed on a line
 * of its own, to open in a private window.
 */
const printEmail = async ({ to, subject, text, kind, link }) => {
  console.log(`\n--- email to ${to} (printed, not sent) ---\nSubject: ${subject}\n\n${text}--- end of email ---\n`);
  if (kind === 'invite') console.log(`Invite link for ${to}: ${link}\n`);
};
const port = Number(process.env.TRACKER_PORT ?? 0);
// The Merge button posts the project config's first merge phrase, as on the real server.
let mergePhrase = null;
try { mergePhrase = loadProjectConfig().mergePhrases[0] ?? null; } catch (err) { console.log(`no Merge button: the project config is not usable (${err.message}).`); }
const accountMail = { send: printEmail, pageUrl: null, projectName: 'Demo' };
const server = await startServer({ store, port, log: (line) => console.log(line), mergePhrase, closePhrase: CLOSE_PHRASE, goPhrase: GO_PHRASE, accountMail });
accountMail.pageUrl = `http://127.0.0.1:${server.address().port}`;

console.log(`\nDemo tracker (test data only) at http://127.0.0.1:${server.address().port}/`);
console.log(`Sign in as ${operator.name} with this throwaway email and password:\n\n  email:    ${DEMO_EMAIL}\n  password: ${password}\n`);
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
