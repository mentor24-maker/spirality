#!/usr/bin/env node
/**
 * Give a person already in the tracker their first password, by email
 * (docs/TRACKER_MVP.md, "Sign-ins"). Run it under `doppler run` (the npm
 * script does), on the machine the tracker runs on:
 *
 *   npm run tracker:account -- setup-link --actor <id> --email <address>
 *
 * It makes a single-use `setup` link for that actor (tracker/store.mjs
 * makeLink: 7 days) and emails it through Resend, the same sender as the
 * hand-over email (tracker/notify.mjs). Using the link sets the actor's
 * email and password, so the person keeps every ticket and comment that
 * actor already holds.
 *
 * Refused, with nothing made or sent: an unknown actor, a machine, an email
 * another person holds, no RESEND_API_KEY, no trackerUrl in the project
 * config file. A send the mail service refuses withdraws the link, so no
 * usable link is left behind. It prints one line: "sent to <address>, good
 * for 7 days", or why not. The link's token is never printed.
 *
 * The link's address is the project config FILE's trackerUrl, never
 * Doppler's same-machine TRACKER_URL override (127.0.0.1 on the Mini),
 * which would not open from anyone else's computer. The database is the
 * project config's trackerDataDir/tracker.db, or TRACKER_DB.
 */
import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openStore, StoreError } from './store.mjs';
import { DEFAULT_FROM, MAIL_FROM, MAIL_KEY, resendSender } from './notify.mjs';
import { loadProjectConfig } from '../lib/projectConfig.mjs';

const DAY = 24 * 60 * 60 * 1000;

/** The setup email: `{ subject, text }`. `link` is the whole set-password address. */
export function setupEmail({ name, productName, link, days }) {
  return {
    subject: `Set your ${productName} password`,
    text: [
      `Hello ${name},`,
      '',
      `Here is your link to set a password for the ${productName} tracker:`,
      '',
      link,
      '',
      `It works once, for the next ${days} days. If you did not expect this email, ignore it: nothing changes until the link is used.`,
      '',
    ].join('\n'),
  };
}

/** The set-password page's address for a link token, under the tracker's address. */
export function setPasswordUrl(trackerUrl, token) {
  return `${String(trackerUrl).replace(/\/+$/, '')}/set-password?link=${encodeURIComponent(token)}`;
}

/**
 * Make a setup link for `actor` at `email` and send it. `send` is the mail
 * service (null: no key, refused); `trackerUrl` the address the link opens.
 * Answers `{ ok, line }`; the line never carries the link's token.
 */
export async function sendSetupLink({ store, actor, email, send, trackerUrl, productName, now = Date.now }) {
  const refuse = (why) => ({ ok: false, line: `NOT sent: ${why} Nothing was made or sent.` });
  const person = Number.isInteger(actor) ? store.getActor(actor) : null;
  if (!person) return refuse(`there is no actor ${actor} in this tracker.`);
  if (person.kind !== 'human') return refuse(`actor ${actor} ("${person.name}") is a machine; a machine never holds an email or a password.`);
  const holder = store.actorForEmail(email);
  if (holder && holder.id !== person.id) return refuse(`${email} already belongs to another person (actor ${holder.id}).`);
  if (!send) return refuse(`${MAIL_KEY} is not in Doppler, so no email can go out.`);
  if (!trackerUrl) return refuse('the project config file names no trackerUrl, so the link would have no address.');

  let link;
  try {
    link = store.makeLink({ purpose: 'setup', email, actor: person.id, madeBy: person.id });
  } catch (err) {
    if (err instanceof StoreError) return refuse(err.message);
    throw err;
  }
  const scrub = (text) => String(text ?? '').split(link.token).join('[link]');
  const days = Math.round((Date.parse(link.expiresAt) - now()) / DAY);
  const to = email.trim().toLowerCase();
  try {
    await send({ to, ...setupEmail({ name: person.name, productName, link: setPasswordUrl(trackerUrl, link.token), days }) });
  } catch (err) {
    let withdrawn = 'The link was withdrawn, so nothing usable is left.';
    try { store.cancelLink(link.token); } catch (e) { withdrawn = `The link could NOT be withdrawn (${scrub(e.message)}); it was never sent, so nobody holds it.`; }
    return { ok: false, line: `NOT sent to ${to}: ${scrub(err?.message ?? err)}. ${withdrawn}` };
  }
  return { ok: true, line: `sent to ${to}, good for ${days} days` };
}

const USAGE = `usage (under doppler run, as the npm script does), on the machine the tracker runs on:
  npm run tracker:account -- setup-link --actor <id> --email <address>`;

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [command, ...rest] = process.argv.slice(2);
  let values;
  try {
    ({ values } = parseArgs({ args: rest, strict: true, options: { actor: { type: 'string' }, email: { type: 'string' } } }));
  } catch (err) {
    console.error(`${err.message}\n${USAGE}`);
    process.exit(1);
  }
  if (command !== 'setup-link' || !values.actor || !values.email) {
    console.error(USAGE);
    process.exit(1);
  }
  if (!/^[0-9]+$/.test(values.actor)) {
    console.error(`NOT sent: --actor is an actor's number, not "${values.actor}". Nothing was made or sent.`);
    process.exit(1);
  }
  const config = loadProjectConfig();
  const dataDir = config.trackerDataDir?.replace(/^~(?=\/|$)/, homedir());
  const db = process.env.TRACKER_DB || (dataDir && join(dataDir, 'tracker.db'));
  if (!db || !existsSync(db)) {
    console.error(`NOT sent: there is no tracker database${db ? ` at ${db}` : ''}, so this is not the machine the tracker runs on. Nothing was made or sent.`);
    process.exit(1);
  }
  // The address everyone opens, from the config FILE, never Doppler's
  // same-machine override (tracker/signins.mjs trackerAddress says why).
  const trackerUrl = loadProjectConfig({ env: { ...process.env, TRACKER_URL: '' } }).trackerUrl;
  const apiKey = process.env[MAIL_KEY];
  const send = apiKey ? resendSender({ apiKey, from: process.env[MAIL_FROM] || DEFAULT_FROM }) : null;
  const store = openStore(db);
  let result;
  try {
    result = await sendSetupLink({
      store, actor: Number(values.actor), email: values.email, send, trackerUrl,
      productName: store.getProject(config.productSlug)?.name ?? 'tracker',
    });
  } finally {
    store.close();
  }
  console.log(result.line);
  process.exit(result.ok ? 0 : 1);
}
