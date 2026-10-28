#!/usr/bin/env node
/**
 * Send one real hand-over email, to prove the mail service works:
 *
 *   npm run tracker:test-email
 *
 * It reads the mail settings exactly as the tracker server does (Doppler,
 * through the project config), makes a throwaway tracker in memory (never
 * the real one), files a test ticket, puts a question card on it and hands
 * it over to the operator. The notifier then sends the same email a real
 * hand-over sends, through the real service. Exit 0 once the service has
 * accepted it; 1, with the reason, when it did not or the email is off.
 *
 * The link in the email points at the real tracker, where this test ticket
 * does not exist; that is expected.
 */
import { loadProjectConfig } from '../lib/projectConfig.mjs';
import { createNotifier } from './notify.mjs';
import { loadMailSettings } from './server.mjs';
import { openStore } from './store.mjs';

const say = (line) => console.log(line);
const config = loadProjectConfig();
const mail = await loadMailSettings({ host: config.trackerHost, port: config.trackerPort, log: say });
if (!mail.send) {
  console.error(`test-email: not sent. ${mail.why}`);
  process.exit(1);
}

const store = openStore(':memory:');
const operator = store.createActor({ kind: 'human', name: config.operatorName });
const loop = store.createActor({ kind: 'machine', name: 'Test email' });
store.createProject({ slug: config.productSlug, name: config.productSlug, prefix: 'TEST', operator: operator.id });
const ticket = store.fileTicket({
  project: config.productSlug, actor: loop.id, status: 'building',
  name: 'Test hand-over: the tracker can email you',
});
store.postComment({
  ticket: ticket.id, author: loop.id,
  body: '@@NEEDED\nNothing. This is a test email; if you are reading it, the hand-over email works.\n',
});
const moved = store.changeTicket(ticket.id, { actor: loop.id, status: 'needs your input', assignee: operator.id });

const lines = [];
const notifier = createNotifier({ store, ...mail, log: (line) => { lines.push(line); say(line); } });
await notifier.afterWrite(moved.ticket, moved.changed);
store.close();

if (lines.some((line) => line.startsWith('hand-over email sent'))) {
  say(`test-email: sent. It should be in ${config.operatorName}'s inbox (TRACKER_NOTIFY_TO) within a minute.`);
  process.exit(0);
}
console.error('test-email: NOT sent; the line above says why.');
process.exit(1);
