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
export function setupEmail({ name, projectName, link, days }) {
  return {
    subject: `Set your ${projectName} password`,
    text: [
      `Hello ${name},`,
      '',
      `Here is your link to set a password for the ${projectName} tracker:`,
      '',
      link,
      '',
      `It works once, for the next ${days} days. If you did not expect this email, ignore it: nothing changes until the link is used.`,
      '',
    ].join('\n'),
  };
}

/** The reset email: `{ subject, text }`. `link` is the whole set-password address. */
export function resetEmail({ name, projectName, link }) {
  return {
    subject: `Reset your ${projectName} password`,
    text: [
      `Hello ${name},`,
      '',
      `Someone asked to reset your password for the ${projectName} tracker. Here is your link to set a new one:`,
      '',
      link,
      '',
      'It works once, for the next hour. Using it signs you out everywhere you were signed in. If you did not ask for this, ignore it: your password stays as it is.',
      '',
    ].join('\n'),
  };
}

/**
 * The page's "Forgot password?": make a 1-hour `reset` link for the person
 * `email` belongs to and send it. An email nobody holds gets nothing, and
 * the caller answers the page the same either way. Answers `{ ok, line }`
 * for the server log; the line never carries the link's token or the email.
 * A send the mail service refuses withdraws the link.
 */
export async function sendResetLink({ store, email, send, trackerUrl, projectName }) {
  const person = store.actorForEmail(email);
  if (!person) return { ok: true, line: 'reset asked for an email with no account; nothing sent' };
  if (!send) return { ok: false, line: `reset NOT sent to actor ${person.id}: ${MAIL_KEY} is not in Doppler, so no email can go out` };
  if (!trackerUrl) return { ok: false, line: `reset NOT sent to actor ${person.id}: the tracker's own address is unknown` };
  let link;
  try {
    link = store.makeLink({ purpose: 'reset', email, madeBy: person.id });
  } catch (err) {
    if (err instanceof StoreError) return { ok: false, line: `reset NOT sent to actor ${person.id}: ${err.message}` };
    throw err;
  }
  const scrub = (text) => String(text ?? '').split(link.token).join('[link]');
  try {
    await send({ to: store.emailOf(person.id), ...resetEmail({ name: person.name, projectName, link: setPasswordUrl(trackerUrl, link.token) }) });
  } catch (err) {
    let withdrawn = 'the link was withdrawn';
    try { store.cancelLink(link.token); } catch (e) { withdrawn = `the link could NOT be withdrawn (${scrub(e.message)}), but it was never sent`; }
    return { ok: false, line: `reset NOT sent to actor ${person.id}: ${scrub(err?.message ?? err)}; ${withdrawn}` };
  }
  return { ok: true, line: `reset link sent to actor ${person.id}, good for 1 hour` };
}

/** The invite email: `{ subject, text }`. `link` is the whole set-password address. */
export function inviteEmail({ inviter, projectName, link, days }) {
  return {
    subject: `${inviter} invited you to the ${projectName} tracker`,
    text: [
      'Hello,',
      '',
      `${inviter} invited you to the ${projectName} tracker. Here is your link to choose your name and a password:`,
      '',
      link,
      '',
      `It works once, for the next ${days} days. If you did not expect this email, ignore it: no account is made until the link is used.`,
      '',
    ].join('\n'),
  };
}

/**
 * The People page's "Invite someone": make a 7-day `invite` link for
 * `email`, made by the person `madeBy`, and send it. Refused, with nothing
 * made or sent: an email a person holds (`duplicate-email`) or with an open
 * invite (`duplicate-invite`), no mail sender (`no-mail`), no tracker
 * address (`no-address`). A send the mail service refuses withdraws the
 * link (`not-sent`), so no open invite is left. Answers `{ ok, code, line }`;
 * the line never carries the link's token. The mail handed to `send` also
 * carries `kind: 'invite'` and the `link`, for the demo to print; Resend
 * reads only `to`, `subject` and `text`.
 */
export async function sendInvite({ store, email, madeBy, send, trackerUrl, projectName, now = Date.now }) {
  const refuse = (code, why) => ({ ok: false, code, line: `Not invited: ${why} Nothing was made or sent.` });
  const inviter = Number.isInteger(madeBy) ? store.getActor(madeBy) : null;
  if (!inviter || inviter.kind !== 'human') return refuse('people-only', 'only a person may invite someone.');
  if (!send) return refuse('no-mail', `${MAIL_KEY} is not in Doppler, so no email can go out.`);
  if (!trackerUrl) return refuse('no-address', "the tracker's own address is unknown, so the link would have no address.");
  let link;
  try {
    link = store.makeLink({ purpose: 'invite', email, madeBy: inviter.id });
  } catch (err) {
    if (err instanceof StoreError) return refuse(err.code, err.message);
    throw err;
  }
  const scrub = (text) => String(text ?? '').split(link.token).join('[link]');
  const days = Math.round((Date.parse(link.expiresAt) - now()) / DAY);
  const to = email.trim().toLowerCase();
  const address = setPasswordUrl(trackerUrl, link.token);
  try {
    await send({ to, ...inviteEmail({ inviter: inviter.name, projectName, link: address, days }), kind: 'invite', link: address });
  } catch (err) {
    let withdrawn = 'The invite was withdrawn, so nothing usable is left.';
    try { store.cancelLink(link.token); } catch (e) { withdrawn = `The invite could NOT be withdrawn (${scrub(e.message)}); it was never sent, so nobody holds it.`; }
    return { ok: false, code: 'not-sent', line: `Not invited: the email to ${to} did not go out (${scrub(err?.message ?? err)}). ${withdrawn}` };
  }
  return { ok: true, code: null, line: `Invite sent to ${to}, good for ${days} days.` };
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
export async function sendSetupLink({ store, actor, email, send, trackerUrl, projectName, now = Date.now }) {
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
    await send({ to, ...setupEmail({ name: person.name, projectName, link: setPasswordUrl(trackerUrl, link.token), days }) });
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
      projectName: store.getProject(config.projectSlug)?.name ?? 'tracker',
    });
  } finally {
    store.close();
  }
  console.log(result.line);
  process.exit(result.ok ? 0 : 1);
}
