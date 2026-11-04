/**
 * The hand-over email (docs/TRACKER_MVP.md, "How he hears about a
 * hand-over"; Dane's decision, 2026-10-26): when a ticket enters one of the
 * operator's two statuses, one email goes out naming the ticket, its
 * project, the card's ask and a link to the ticket's page.
 *
 * The rules this module keeps:
 *
 *  - **One email per hand-over, never two.** A hand-over is one status
 *    change into the operator's lane, and a change has its own ticket
 *    version, so `<ticket>@<version>` names it. A key that was sent is never
 *    sent again, and a ticket holds at most one unsent hand-over: a newer one
 *    replaces the older.
 *  - **A move between machine statuses sends nothing.** Neither does a
 *    change that leaves the status alone.
 *  - **A failed send never fails the move.** The server answers the caller
 *    first and only then tells this module; a send that throws is logged and
 *    kept, and tried again on the next change the tracker writes. A kept one
 *    whose ticket has left the operator's lane by then is dropped: he has
 *    already answered it.
 *  - **Sends happen one at a time**, so two writes arriving together cannot
 *    both retry the same kept email.
 *
 * **Where it goes.** To the ticket's project's alert email when the project
 * has one (its Edit project page), else to TRACKER_NOTIFY_TO, the tracker's
 * default address. The log line says which of the two, never the address.
 *
 * The mail service itself is a `send({ to, subject, text })` function handed
 * in, which resolves when the service accepted the message and throws when
 * it did not. Tests hand in a fake. The real one is Resend (Dane's choice,
 * 2026-10-28): `resendSender` makes it, and `mailSettingsFromEnv` builds it
 * from RESEND_API_KEY and TRACKER_NOTIFY_TO, which live in Doppler. With
 * either one missing the email is off, said once in the server's log. The
 * key stays inside the sender; a log line here carries only a ticket id, a
 * status and the service's error message, with the key cut out of it.
 *
 * **The text** (SP-114) is a second channel beside the email, with the same
 * rules and its own record of what it sent and kept, so one failing never
 * stops or repeats the other. It goes to the project's alert phone through
 * Messages on this Mac (`imessageSender` below); a project with no alert
 * phone gets none.
 *
 * What is kept between tries lives in memory: a restart of the server drops
 * an unsent email or text. The page's waiting count is the backstop for that.
 */
import { existsSync } from 'node:fs';
import waitingOnOperator from '../lib/waitingOnOperator.js';
import { cardAsk } from './web/render.mjs';

const { OPERATOR_LANE } = waitingOnOperator;

/** A status as the contract writes it: "needs your input" -> "Needs your input". */
const statusName = (s) => String(s ?? '').replace(/^./, (c) => c.toUpperCase());

/** One line, for a subject: a newline in a ticket name must not reach a mail header. */
const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

/** True when `status` is one of the operator's two. */
export function isHandOverStatus(status) {
  return OPERATOR_LANE.includes(status);
}

/** The ask on the newest comment that carries an operator card, or null. */
export function newestAsk(comments) {
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const ask = cardAsk(comments[i].body);
    if (ask) return ask;
  }
  return null;
}

/** The email for one hand-over: `{ subject, text }`. `pageUrl` is the tracker's address as Dane opens it. */
export function handOverEmail({ ticket, projectName, ask, pageUrl }) {
  const link = `${String(pageUrl).replace(/\/+$/, '')}/t/${encodeURIComponent(ticket.id)}`;
  return {
    subject: oneLine(`Waiting on you: ${ticket.name}`),
    text: [
      ticket.name,
      '',
      `Project: ${projectName}`,
      `Status:  ${statusName(ticket.status)}`,
      `Needed:  ${ask ?? '(no question card on the ticket; open it to see why it is yours)'}`,
      '',
      `Open it: ${link}`,
      '',
    ].join('\n'),
  };
}

/** The ask, cut for a text: one line, about 300 characters at most. */
export const TEXT_ASK_LIMIT = 300;

/**
 * The text for one hand-over: the ticket id and name, its status, the
 * card's ask cut to about TEXT_ASK_LIMIT characters, and the ticket's link.
 */
export function handOverText({ ticket, ask, pageUrl }) {
  const link = `${String(pageUrl).replace(/\/+$/, '')}/t/${encodeURIComponent(ticket.id)}`;
  let needed = oneLine(ask ?? '(no question card on the ticket; open it to see why it is yours)');
  if (needed.length > TEXT_ASK_LIMIT) needed = `${needed.slice(0, TEXT_ASK_LIMIT - 1).trimEnd()}…`;
  return [
    `Waiting on you: ${ticket.id} ${oneLine(ticket.name)}`,
    `Status: ${statusName(ticket.status)}`,
    `Needed: ${needed}`,
    link,
  ].join('\n');
}

/**
 * One channel of the notifier (the email, or the text): its own record of
 * what it sent and what it keeps, so one channel failing never stops or
 * repeats the other. `deliver(ticket, project)` sends one hand-over and
 * resolves to the words the log line ends with ("to TRACKER_NOTIFY_TO"),
 * throws when the service refused, or resolves to null when this project
 * cannot get one (a text to a project with no alert phone), and then the
 * hand-over is dropped rather than kept.
 */
function createChannel({ kind, store, deliver, log }) {
  const sent = new Set();
  /** ticket id -> the one unsent hand-over it holds: `{ key, attempts }`. */
  const pending = new Map();

  async function trySend(ticketId) {
    const wanted = pending.get(ticketId);
    const ticket = store.getTicket(ticketId);
    if (!ticket || !isHandOverStatus(ticket.status)) {
      pending.delete(ticketId);
      log(`hand-over ${kind} dropped: ${ticketId} is no longer waiting on the operator (it is "${ticket?.status ?? 'gone'}").`);
      return;
    }
    const project = store.getProject(ticket.project);
    wanted.attempts += 1;
    let where;
    try {
      where = await deliver(ticket, project, wanted);
    } catch (err) {
      log(`hand-over ${kind} NOT sent: ${ticketId} (${ticket.status}) ${err?.where ?? ''}${err?.where ? ', ' : ''}try ${wanted.attempts}: ${err?.message ?? err}. It is tried again on the next change.`);
      return;
    }
    if (pending.get(ticketId) === wanted) pending.delete(ticketId);
    if (where == null) return;
    sent.add(wanted.key);
    log(`hand-over ${kind} sent: ${ticketId} (${ticket.status}) ${where}.`);
  }

  return {
    note(ticket, changed) {
      if (ticket && changed.includes('status') && isHandOverStatus(ticket.status)) {
        const key = `${ticket.id}@${ticket.version}`;
        if (!sent.has(key)) pending.set(ticket.id, { key, attempts: 0 });
      }
    },
    async flush() {
      for (const id of [...pending.keys()]) await trySend(id);
    },
    pending() {
      return [...pending.values()].map((p) => p.key);
    },
  };
}

/** An error that carries the words naming where a send was going, for the log line. */
function failedTo(where, err) {
  const out = err instanceof Error ? err : new Error(String(err));
  out.where = where;
  return out;
}

/**
 * The notifier the server calls after every write it has already answered.
 * `send` is the mail service (null: email off), `to` is the default address
 * (a project's alert email goes first), `pageUrl` the tracker's address for
 * the link. `sendText({ to, text })` is the text service (null: texts off);
 * a text goes to the ticket's project's alert phone, and a project with no
 * alert phone gets none, said once in the log until it has one.
 */
export function createNotifier({ store, send = null, to = null, pageUrl, sendText = null, log = () => {} }) {
  let queue = Promise.resolve();
  const toldNoPhone = new Set();
  const channels = [];

  const email = send && createChannel({
    kind: 'email', store, log,
    async deliver(ticket, project) {
      const message = handOverEmail({
        ticket,
        projectName: project?.name ?? ticket.project,
        ask: newestAsk(store.listComments(ticket.id)),
        pageUrl,
      });
      const where = project?.alertEmail ? "to the project's alert email" : `to ${MAIL_TO}`;
      try {
        await send({ to: project?.alertEmail || to, ...message });
      } catch (err) {
        throw failedTo(where, err);
      }
      return where;
    },
  });
  if (email) channels.push(email);

  const text = sendText && createChannel({
    kind: 'text', store, log,
    async deliver(ticket, project) {
      const slug = project?.slug ?? ticket.project;
      if (!project?.alertPhone) {
        if (!toldNoPhone.has(slug)) {
          toldNoPhone.add(slug);
          log(`hand-over text: off for project "${slug}", which has no alert phone (its Edit project page sets one).`);
        }
        return null;
      }
      toldNoPhone.delete(slug);
      const where = "to the project's alert phone";
      const body = handOverText({ ticket, ask: newestAsk(store.listComments(ticket.id)), pageUrl });
      try {
        await sendText({ to: project.alertPhone, text: body });
      } catch (err) {
        throw failedTo(where, err);
      }
      return where;
    },
  });
  if (text) channels.push(text);

  async function run(ticket, changed) {
    for (const channel of channels) channel.note(ticket, changed);
    // Each channel on its own: one that throws unexpectedly never stops the other.
    for (const channel of channels) {
      try {
        await channel.flush();
      } catch (err) {
        log(`hand-over ${channel === email ? 'email' : 'text'} failed unexpectedly: ${err?.message ?? err}`);
      }
    }
  }

  return {
    enabled: channels.length > 0,

    /**
     * After a write: `ticket` as it now stands (null for a write that changed
     * no ticket's fields, such as a comment) and the fields it changed. Never
     * throws; resolves once this write's emails and texts, and any kept
     * ones, are tried.
     */
    afterWrite(ticket, changed = []) {
      if (!channels.length) return Promise.resolve();
      queue = queue.then(() => run(ticket, changed)).catch((err) => {
        log(`hand-over notice failed unexpectedly: ${err?.message ?? err}`);
      });
      return queue;
    },

    /** Resolves once every write heard so far has been dealt with. */
    settled() {
      return queue;
    },

    /** The hand-over emails not yet sent, by ticket id. For the tests and the log. */
    pending() {
      return email ? email.pending() : [];
    },

    /** The hand-over texts not yet sent. */
    pendingTexts() {
      return text ? text.pending() : [];
    },
  };
}

/** The Doppler names the email reads: the service's key and Dane's address. */
export const MAIL_KEY = 'RESEND_API_KEY';
export const MAIL_TO = 'TRACKER_NOTIFY_TO';
/** Optional: a sender of our own once a domain is set up in Resend. */
export const MAIL_FROM = 'TRACKER_NOTIFY_FROM';
/**
 * Resend's shared sender. It needs no domain of our own, and Resend lets it
 * deliver only to the account's own address, which is exactly who this
 * email is for.
 */
export const DEFAULT_FROM = 'Tracker <onboarding@resend.dev>';
const RESEND_URL = 'https://api.resend.com/emails';

/**
 * A `send` that hands one email to Resend's API. Resolves once Resend has
 * accepted it; throws with Resend's own answer when it has not, or when it
 * could not be reached within `timeoutMs`. The key is cut out of every
 * error message, so a log line can never carry it.
 */
export function resendSender({ apiKey, from = DEFAULT_FROM, fetch: doFetch = globalThis.fetch, timeoutMs = 15_000 }) {
  const scrub = (text) => String(text ?? '').split(apiKey).join('[key]');
  return async function send({ to, subject, text }) {
    let res;
    try {
      res = await doFetch(RESEND_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, text }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new Error(`Resend could not be reached: ${scrub(err?.message ?? err)}`);
    }
    if (res.ok) return;
    let detail = '';
    try { detail = (await res.json())?.message ?? ''; } catch { /* no JSON body: the status says enough */ }
    throw new Error(`Resend answered ${res.status}${detail ? `: ${scrub(detail)}` : ''}`);
  };
}

/**
 * The mail settings from the environment: `{ send, to, pageUrl }`, or
 * `{ send: null, why }` naming what is missing. `pageUrl` is the tracker's
 * address as Dane opens it, for the link in the email.
 */
export function mailSettingsFromEnv(env = process.env, { pageUrl = null, fetch } = {}) {
  const missing = [MAIL_KEY, MAIL_TO].filter((name) => !env[name]);
  if (missing.length) {
    return { send: null, why: `${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not in Doppler, so the hand-over email is off.` };
  }
  if (!pageUrl) return { send: null, why: 'the tracker\'s own address is unknown, so the hand-over email is off.' };
  const send = resendSender({ apiKey: env[MAIL_KEY], from: env[MAIL_FROM] || DEFAULT_FROM, ...(fetch ? { fetch } : {}) });
  return { send, to: env[MAIL_TO], pageUrl };
}

/**
 * The mail names from Doppler, for the server on the Mini, which launchd
 * starts without them. Answers `{ env }` holding only the mail names found
 * (never any other key), or `{ error }` when Doppler could not be read; the
 * server then runs with the email off. `run` is execFile, promised.
 */
export async function mailEnvFromDoppler({ project, config, run }) {
  let out;
  try {
    ({ stdout: out } = await run('doppler', [
      'secrets', 'download', '--no-file', '--format', 'json',
      '--project', project, '--config', config, '--no-check-version',
    ], { timeout: 20_000, maxBuffer: 1024 * 1024 }));
  } catch (err) {
    return { error: `could not read Doppler ${project}/${config} (${err?.code ?? 'failed'})` };
  }
  let all;
  try { all = JSON.parse(out); } catch { return { error: `Doppler ${project}/${config} did not answer JSON` }; }
  const env = {};
  for (const name of [MAIL_KEY, MAIL_TO, MAIL_FROM]) if (all[name]) env[name] = all[name];
  return { env };
}

/**
 * The hand-over text (SP-114; Dane chose iMessage sent from the Mini, over
 * an SMS service or a push app): Messages on this Mac sends it, driven by
 * `osascript`.
 *
 * The AppleScript is fixed. The number and the text reach it only as
 * arguments (`on run argv`), never pasted into its source, so nothing in a
 * ticket name can become AppleScript. A send that errors or runs past
 * `timeoutMs` is a failed send, thrown like the email's, and the number is
 * cut out of the reason so a log line can never carry it.
 */
export const SEND_SCRIPT = Object.freeze([
  'on run argv',
  'set theNumber to item 1 of argv',
  'set theText to item 2 of argv',
  'tell application "Messages"',
  'set theService to 1st account whose service type = iMessage',
  'send theText to participant theNumber of theService',
  'end tell',
  'end run',
]);

/** The osascript arguments that send `text` to `to`: the fixed script, then the two values. */
export function osascriptArgs({ to, text }, script = SEND_SCRIPT) {
  return [...script.flatMap((line) => ['-e', line]), String(to), String(text)];
}

/**
 * A `sendText({ to, text })` that has Messages send one iMessage. Resolves
 * once Messages accepted it; throws with the reason when it did not, or when
 * it took longer than `timeoutMs` (the first send can sit on macOS's "allow
 * … to control Messages?" box). `run` is execFile, promised.
 */
export function imessageSender({ run, osascript = 'osascript', timeoutMs = 30_000 }) {
  return async function sendText({ to, text }) {
    const scrub = (line) => String(line ?? '').split(String(to)).join('[phone]').replace(/\s+/g, ' ').trim();
    try {
      await run(osascript, osascriptArgs({ to, text }), { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 });
    } catch (err) {
      if (err?.killed || err?.signal) throw new Error(`Messages did not answer within ${Math.round(timeoutMs / 1000)} seconds (is macOS asking to allow control of Messages on the Mini's screen?)`);
      if (err?.code === 'ENOENT') throw new Error(`${osascript} is not on this machine`);
      throw new Error(`Messages refused it: ${scrub(err?.stderr || err?.message || err) || `osascript exited ${err?.code}`}`);
    }
  };
}

/**
 * The text settings: `{ sendText }`, or `{ sendText: null, why }` when this
 * machine cannot send one (not a Mac, or no osascript). Whether a project
 * gets texts is its own alert phone's business, decided per hand-over.
 */
export function textSettings({ platform = process.platform, exists = existsSync, run, osascript = '/usr/bin/osascript' } = {}) {
  if (platform !== 'darwin') return { sendText: null, why: `this machine is not a Mac (${platform}), so there is no Messages to send from.` };
  if (!exists(osascript)) return { sendText: null, why: `${osascript} is not on this machine.` };
  return { sendText: imessageSender({ run, osascript }) };
}
