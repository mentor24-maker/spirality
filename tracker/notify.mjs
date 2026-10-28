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
 * The mail service itself is a `send({ to, subject, text })` function handed
 * in, which resolves when the service accepted the message and throws when
 * it did not. Tests hand in a fake. Which service sends the real email, and
 * its key, are Dane's choice and live in Doppler; until one is wired in,
 * `mailSenderFromEnv` answers null and the email is off, said once in the
 * server's log. The key never reaches this module, and a log line here
 * carries only a ticket id, a status and the service's error message.
 *
 * What is kept between tries lives in memory: a restart of the server drops
 * an unsent email. The page's waiting count is the backstop for that.
 */
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

/**
 * The notifier the server calls after every write it has already answered.
 * `send` is the mail service (null: email off, every call is a no-op), `to`
 * is Dane's address, `pageUrl` the tracker's address for the link.
 */
export function createNotifier({ store, send, to, pageUrl, log = () => {} }) {
  const sent = new Set();
  /** ticket id -> the one unsent hand-over it holds: `{ key, attempts }`. */
  const pending = new Map();
  let queue = Promise.resolve();

  async function trySend(ticketId) {
    const wanted = pending.get(ticketId);
    const ticket = store.getTicket(ticketId);
    if (!ticket || !isHandOverStatus(ticket.status)) {
      pending.delete(ticketId);
      log(`hand-over email dropped: ${ticketId} is no longer waiting on the operator (it is "${ticket?.status ?? 'gone'}").`);
      return;
    }
    const project = store.getProject(ticket.project);
    const email = handOverEmail({
      ticket,
      projectName: project?.name ?? ticket.project,
      ask: newestAsk(store.listComments(ticket.id)),
      pageUrl,
    });
    wanted.attempts += 1;
    try {
      await send({ to, ...email });
    } catch (err) {
      log(`hand-over email NOT sent: ${ticketId} (${ticket.status}), try ${wanted.attempts}: ${err?.message ?? err}. It is tried again on the next change.`);
      return;
    }
    sent.add(wanted.key);
    if (pending.get(ticketId) === wanted) pending.delete(ticketId);
    log(`hand-over email sent: ${ticketId} (${ticket.status}).`);
  }

  async function run(ticket, changed) {
    if (ticket && changed.includes('status') && isHandOverStatus(ticket.status)) {
      const key = `${ticket.id}@${ticket.version}`;
      if (!sent.has(key)) pending.set(ticket.id, { key, attempts: 0 });
    }
    for (const id of [...pending.keys()]) await trySend(id);
  }

  return {
    enabled: Boolean(send),

    /**
     * After a write: `ticket` as it now stands (null for a write that changed
     * no ticket's fields, such as a comment) and the fields it changed. Never
     * throws; resolves once this write's emails, and any kept ones, are tried.
     */
    afterWrite(ticket, changed = []) {
      if (!send) return Promise.resolve();
      queue = queue.then(() => run(ticket, changed)).catch((err) => {
        log(`hand-over email failed unexpectedly: ${err?.message ?? err}`);
      });
      return queue;
    },

    /** Resolves once every write heard so far has been dealt with. */
    settled() {
      return queue;
    },

    /** The hand-overs not yet sent, by ticket id. For the tests and the log. */
    pending() {
      return [...pending.values()].map((p) => p.key);
    },
  };
}

/**
 * The mail service, from the environment. No service is chosen yet (Dane's
 * decision: the service, and its key in Doppler), so this answers why the
 * email is off. The ticket that wires one in returns
 * `{ send, to, pageUrl }` here, with the names it reads added to
 * scripts/lib/expectedSecrets.mjs.
 */
export function mailSettingsFromEnv(/* env = process.env */) {
  return { send: null, why: 'no mail service is chosen yet, so the hand-over email is off.' };
}
