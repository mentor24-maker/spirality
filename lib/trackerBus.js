'use strict';

/**
 * THE BUS, IN THE TRACKER (SP-24).
 *
 * StarCaster raises its alarms on "the bus": a ClickUp chat channel (the
 * party line), which ClickUp refuses on the free plan, so in practice every
 * post lands on a standing "Team chat" ticket instead (lib/busFallback.js),
 * plus a second ClickUp list, "Agent Response", where the steward asks the operator
 * things and the relay watches for the operator's replies. The tracker has no chat and
 * needs none: the smallest equivalent is a PROJECT OF ITS OWN, named in the
 * project config as `busProject`, holding
 *
 *   - the same standing "Team chat" ticket, found by name (oldest wins),
 *     whose comments are the posts, and
 *   - any ticket the steward files for the operator (the Agent Response list's job).
 *
 * No loop claims from it: the build and review lanes read `projectSlug`
 * only, so a bus ticket is never built. Every comment in the tracker carries
 * its author's own actor id, so "only the operator's words" is a fact read off the row,
 * not the machine-stamp guess the party line needed (task 86bbt038u).
 *
 * The door's `bus-post` and `bus-read` commands are the two halves; this file
 * holds their decisions so a test reaches them without a network.
 */

const { FALLBACK_TASK_NAME, FALLBACK_TASK_STATUS, isTeamChatTask } = require('./busFallback.js');
const { operatorName } = require('./substrateConfig.js');

/**
 * Every way StarCaster posts to or reads the bus today, beside its tracker
 * equivalent. `docs/TRACKER_MVP.md` prints the same table; a test holds the
 * two together, so a use added here and not there (or the other way) fails.
 */
const BUS_USES = Object.freeze([
  {
    use: 'Alarms and reports posted to the party line (`postBusMessage`, the `chat` command): heartbeat, throughput, report_job_failure, reconcile, stale_answer, stale_ready, checkout_currency, ai_keys_check, site_import_watch, unapplied_sql_watch, pulse_publish, weekly_report, repair',
    tracker: '`npm run clickup -- bus-post --body-file -`: one comment on the bus project\'s "Team chat" ticket, read back',
  },
  {
    use: 'Direct chat posts that skip `postBusMessage`: the pause switch\'s `announce` (pipeline.mjs), the review gate\'s `announceWaiver`, the reconciler\'s `postBus`',
    tracker: '`bus-post`, the same one command',
  },
  {
    use: 'The relay\'s own notices (`postToBus` / `postOrSaveToBus`): merged, merge refused or deferred, stalled hand-off, auto-merge latched off, lane armed, "<operator> replied on ..."',
    tracker: '`bus-post`; the "replied on" relay is no longer needed, because the steward reads the operator\'s replies with `bus-read --operator`',
  },
  {
    use: 'The fallback when the party line refuses (`saveUndeliveredAlarm`): a comment on the "Team chat" ticket in the Loop Queue, created if missing, oldest wins',
    tracker: '`bus-post` IS that ticket, in the bus project: there is no plan limit to fall back from, and a refused write exits 1 and says so',
  },
  {
    use: 'A relay receipt on the ticket a message was about (`deliverToBus` with a hand-back target)',
    tracker: '`npm run clickup -- comment --task <id>`, unchanged',
  },
  {
    use: 'The steward filing a question for the operator as a ticket in the Agent Response list',
    tracker: 'Two commands, both needed: `npm run clickup -- task --list <busProject>` files it (it lands in Queued, which is NOT on the operator\'s Waiting on You list), then `ask --task <id> --status "Needs your input"` with the operator card puts it there',
  },
  {
    use: 'Reading the party line for the operator\'s stop and resume words (`readBusSwitchSignals`)',
    tracker: '`bus-read --operator`: only comments whose author is the operator\'s own actor, no machine-stamp guess',
  },
  {
    use: 'The relay watching Agent Response tickets ("pending response", "responding") for the operator\'s comments',
    tracker: '`bus-read --operator --since <time>`, across every ticket in the bus project',
  },
  {
    use: '`waiting` sweeping the Agent Response list for "what actually needs me?"',
    tracker: 'The page\'s Waiting on You list, which reads every project the operator is on, the bus project included, but shows only tickets in the operator\'s statuses: a steward question shows there once it has been through `ask`, never straight after `task`',
  },
  {
    use: 'The operator seeing a new post: the "Team chat" ticket puts itself in their ClickUp "Assigned to me" list',
    tracker: 'The bus project\'s board on the tracker page, where "Team chat" sits in Live. No email or text per post (a follow-up ticket asks the operator how loud alarms should be)',
  },
]);

/** The standing ticket's status: a noticeboard, not work, so nothing claims it. */
const TEAM_CHAT_STATUS = FALLBACK_TASK_STATUS;

/**
 * The "Team chat" ticket among `tasks` (ClickUp-shaped, as the door reads
 * them), under its current name or an old one; the OLDEST wins, so two
 * machines that both created one still agree on which is the record.
 * Null when there is none.
 */
function pickTeamChat(tasks) {
  const matches = (Array.isArray(tasks) ? tasks : []).filter((t) => isTeamChatTask(t));
  if (!matches.length) return null;
  return matches.reduce((a, b) => (Number(a.date_created || 0) <= Number(b.date_created || 0) ? a : b));
}

/** The description the ticket is created with. */
function renderTeamChatSeed() {
  return [
    `The **${FALLBACK_TASK_NAME}**. Do not build this, do not close it, do not delete it.`,
    '',
    'This is where the machines and agent sessions post what they would otherwise',
    'say in a chat channel: pass reports, decisions, and alarms when a scheduled',
    'job stops or fails. It is the tracker\'s copy of the "Team chat" ticket',
    'StarCaster kept in ClickUp.',
    '',
    'Each comment starts with which machine posted it and when. Most are routine.',
    'An alarm says what broke in its own words.',
    '',
    `To stop or resume something, ${operatorName()} replies here: the loops read`,
    `${operatorName()}'s own comments (\`npm run clickup -- bus-read --operator\`).`,
  ].join('\n');
}

/**
 * A time as the operator reads it: Mountain time, never UTC (CLAUDE.md),
 * e.g. "11/9/2026, 10:15 AM MT".
 */
function mountainTime(ms) {
  const d = new Date(Number(ms));
  if (!Number.isFinite(d.getTime())) return '';
  return `${d.toLocaleString('en-US', {
    timeZone: 'America/Denver', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit',
  })} MT`;
}

/** One post, as it lands: who sent it, when, then the message verbatim. */
function renderBusPost({ text, node, at }) {
  const body = String(text ?? '').trim();
  if (!body) return null;
  const who = String(node || '').trim() || 'an unnamed machine';
  const when = String(at || '').trim();
  return [`**From ${who}**${when ? ` · ${when}` : ''}`, '', body].join('\n');
}

/**
 * The read: every comment from `tickets` (each `{ id, name, comments }`,
 * comments ClickUp-shaped as the door reads them), oldest first, as
 * `{ at, ticket, ticketName, author, authorId, byOperator, text }`.
 *
 * `operatorId` marks the operator's comments; with `operatorOnly` nothing else comes
 * back. `since` (milliseconds) drops anything at or before it, so a reader
 * that remembers its last time never sees a post twice.
 */
function busMessages(tickets, { operatorId, operatorOnly = false, since = null } = {}) {
  const out = [];
  for (const t of Array.isArray(tickets) ? tickets : []) {
    for (const c of Array.isArray(t.comments) ? t.comments : []) {
      const at = Number(c.date) || 0;
      const authorId = c.user?.id == null ? null : Number(c.user.id);
      const byOperator = operatorId != null && authorId === Number(operatorId);
      if (operatorOnly && !byOperator) continue;
      if (since != null && at <= since) continue;
      out.push({
        at,
        ticket: String(t.id),
        ticketName: String(t.name ?? ''),
        author: String(c.user?.username ?? (authorId == null ? 'unknown' : `actor ${authorId}`)),
        authorId,
        byOperator,
        text: String(c.comment_text ?? ''),
      });
    }
  }
  return out.sort((a, b) => a.at - b.at || a.ticket.localeCompare(b.ticket));
}

/** The "**From <machine>** · <time>" line renderBusPost puts first. */
const POST_HEADER = /^\*\*From .+\*\*( · .*)?$/;

/**
 * One tab-separated line per message, for a script to read: time (ISO, UTC,
 * so a reader can hand it straight back as --since), ticket, operator|machine, author, first line of the message itself. */
function busLine(m) {
  const lines = String(m.text).split('\n').map((l) => l.trim()).filter(Boolean);
  const first = (lines.length > 1 && POST_HEADER.test(lines[0]) ? lines[1] : lines[0]) ?? '';
  return [new Date(m.at).toISOString(), m.ticket, m.byOperator ? 'operator' : 'machine', m.author, first].join('\t');
}

/**
 * Read a `--since` value: an ISO time or milliseconds. Null when absent;
 * `{ error }` when it cannot be read, so a typo never reads as "everything".
 */
function parseSince(value) {
  if (value == null || value === '') return null;
  const n = /^\d+$/.test(String(value)) ? Number(value) : Date.parse(String(value));
  if (!Number.isFinite(n)) return { error: `--since must be a time like 2026-11-09T16:00:00Z, got ${JSON.stringify(value)}` };
  return n;
}

module.exports = {
  BUS_USES,
  TEAM_CHAT_STATUS,
  busLine,
  busMessages,
  mountainTime,
  parseSince,
  pickTeamChat,
  renderBusPost,
  renderTeamChatSeed,
};
