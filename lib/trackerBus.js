'use strict';

/**
 * THE BUS, IN THE TRACKER (SP-24).
 *
 * StarCaster raises its alarms on "the bus": a ClickUp chat channel (the
 * party line), which ClickUp refuses on the free plan, so in practice every
 * post lands on a standing "Team chat" ticket instead (lib/busFallback.js),
 * plus a second ClickUp list, "Agent Response", where the steward asks the operator
 * things and the relay watches for the operator's replies. The tracker has no chat and
 * needs none: the smallest equivalent is a tracker project, named in the
 * project config as `busProject`, holding
 *
 *   - the same standing "Team chat" ticket, found by name (oldest wins),
 *     whose comments are the posts, and
 *   - any ticket the steward files for the operator (the Agent Response list's job).
 *
 * Normally (SP-356) the bus is the project's OWN queue: `busProject` equals
 * `projectSlug`, and the bus is its noticeboard tickets (lib/loopNoticeboards.js:
 * Team chat by name, and anything tagged `noticeboard`), each in Live, which
 * no loop claims from. Only those tickets are read as the bus, never the
 * work beside them. A project set up before then may still name a second
 * project, "<slug>-bus", as its bus; there every ticket is the bus, as
 * before, and no loop claims from it because the lanes read `projectSlug`
 * only. Every comment in the tracker carries
 * its author's own actor id, so "only the operator's words" is a fact read off the row,
 * not the machine-stamp guess the party line needed (task 86bbt038u).
 *
 * The door's `bus-post` and `bus-read` commands are the two halves; this file
 * holds their decisions so a test reaches them without a network.
 */

const { FALLBACK_TASK_NAME, FALLBACK_TASK_STATUS, isTeamChatTask } = require('./busFallback.js');
const { NOTICEBOARD_TAG, hasNoticeboardTag, isNoticeboard } = require('./loopNoticeboards.js');
const { operatorName } = require('./substrateConfig.js');
const { stripMachineMarker, authorKind, isOperatorAuthored } = require('./machineComment.js');

/**
 * Every way StarCaster posts to or reads the bus today, beside its tracker
 * equivalent. `docs/TRACKER_MVP.md` prints the same table; a test holds the
 * two together, so a use added here and not there (or the other way) fails.
 */
const BUS_USES = Object.freeze([
  {
    use: 'Alarms and reports posted to the party line (`postBusMessage`, the `chat` command): heartbeat, throughput, report_job_failure, reconcile, stale_answer, stale_ready, checkout_currency, ai_keys_check, site_import_watch, unapplied_sql_watch, pulse_publish, weekly_report, repair',
    tracker: '`npm run clickup -- bus-post --body-file -`: one comment on the bus\'s "Team chat" ticket, read back; made in Live and tagged `noticeboard` when missing, both read back. The heartbeat is Spirality\'s own (SP-266): the relay runs `npm run heartbeat -- --check` on every wake, which reads each lane\'s log and posts one `ALARM:` per lane that has gone quiet, at most once every 6 hours per lane, and one closing line when it runs again',
  },
  {
    use: 'Direct chat posts that skip `postBusMessage`: the pause switch\'s `announce` (pipeline.mjs), the review gate\'s `announceWaiver`, the reconciler\'s `postBus`',
    tracker: '`bus-post`, the same one command',
  },
  {
    use: 'The relay\'s own notices (`postToBus` / `postOrSaveToBus`): merged, merge refused or deferred, stalled hand-off, auto-merge latched off, lane armed, "<operator> replied on ..."',
    tracker: 'The relay posts them itself, through the same read-back post as `bus-post`, when the project names a `busProject` (SP-207): one line for each merge it makes, each refusal and each conflict hand-off the first time it is written on the ticket (a quiet pass posts nothing), and the lanes\' own notices (SP-202). A post that does not land is an UNCHECKED line and the pass exits 1; the merge is never undone or retried for it. A conflict hand-off still stuck a day later (or at once, with nothing filed to fix it) is said again, at most once a day: StarCaster\'s stall rule, without its "failed N times" alarm, because this relay\'s markers count reminders, not tries. Not carried over: the "replied on" relay, because the steward reads the operator\'s replies with `bus-read --operator`',
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
    tracker: 'Two commands, both needed: `npm run clickup -- task --list <busProject> --status Live --tags noticeboard` files it where no loop claims (Live; `task` refuses a `noticeboard` ticket in any other status, because in the project\'s own queue Queued is claimable, SP-356), then `ask --task <id> --status "Needs your input"` with the operator card puts it on the operator\'s Waiting on You list, and when the operator answers, the relay sends it back to Live, never to Queued or Rework (a noticeboard is not work, `handbackPlan` in lib/relayLane.js), and the build lane\'s `queue --claimable` and `claim` skip any noticeboard',
  },
  {
    use: 'Reading the party line for the operator\'s stop and resume words (`readBusSwitchSignals`)',
    tracker: '`bus-read --operator`: only comments whose author is the operator\'s own actor, no machine-stamp guess',
  },
  {
    use: 'The relay watching Agent Response tickets ("pending response", "responding") for the operator\'s comments',
    tracker: '`bus-read --operator --since <time>`, across every noticeboard ticket of the bus (the steward\'s questions carry the tag), or every ticket when the bus is a project of its own',
  },
  {
    use: '`waiting` sweeping the Agent Response list for "what actually needs me?"',
    tracker: 'The page\'s Waiting on You list, which reads every project the operator is on, but shows only tickets in the operator\'s statuses: a steward question shows there once it has been through `ask`, never straight after `task`',
  },
  {
    use: 'The operator seeing a new post: the "Team chat" ticket puts itself in their ClickUp "Assigned to me" list',
    tracker: 'An alarm (a post whose message starts with `ALARM:`) is texted to the bus project\'s alert phone; every post, alarm or not, counts in the "New on the Bus" number in the page\'s header until the operator opens "Team chat" (SP-163, the operator\'s choice D)',
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
 * `{ at, ticket, ticketName, author, authorId, authorKind, byOperator, text }`
 * (`authorKind` is 'human', 'machine' or null when the door did not say).
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
      const byOperator = isOperatorAuthored(c, operatorId);
      if (operatorOnly && !byOperator) continue;
      if (since != null && at <= since) continue;
      out.push({
        at,
        ticket: String(t.id),
        ticketName: String(t.name ?? ''),
        author: String(c.user?.username ?? (authorId == null ? 'unknown' : `actor ${authorId}`)),
        authorId,
        authorKind: authorKind(c),
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
 * THE ALARM RULE (SP-163, Dane's choice D, 2026-11-09): a text for an alarm,
 * the page's count for everything else. An alarm is a post whose message
 * itself, below the "**From <machine>** · <time>" line, starts with
 * `ALARM:` (any capitals). The word is the whole contract, so a machine that
 * wants to wake the operator says so in the post, and a routine report never can
 * by accident.
 */
const ALARM_PREFIX = 'ALARM:';

/**
 * The message of a post, without the "**From …**" header bus-post puts first
 * and without a "[machine] …" stamp line (the tracker's door writes none
 * since SP-26, but a post imported from ClickUp still ends in one), so an
 * alarm text never carries it.
 */
function postMessage(text) {
  const lines = stripMachineMarker(String(text ?? '')).split('\n');
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i += 1;
  if (i < lines.length && POST_HEADER.test(lines[i].trim())) i += 1;
  return lines.slice(i).join('\n').trim();
}

/** True when a comment's text is an alarm by the rule above. */
function isAlarmPost(text) {
  return postMessage(text).toUpperCase().startsWith(ALARM_PREFIX);
}

/**
 * The bus the setup wizard names for a project with a bus
 * (lib/onboardAnswers.mjs): the project itself (SP-356). The one place the
 * choice is made.
 */
function busProjectFor(projectSlug) {
  return projectSlug;
}

/** The second project a project set up before SP-356 may have as its bus. */
function separateBusSlug(projectSlug) {
  return `${projectSlug}-bus`;
}

/** Is this project config's bus its own queue (busProject equal to projectSlug)? */
function busIsOwnQueue(config) {
  return Boolean(config?.busProject) && config.busProject === config.projectSlug;
}

/**
 * The tickets of the bus project that ARE the bus: in the project's own
 * queue only its noticeboards, never the work beside them (an operator
 * comment on a work ticket is no stop word); in a bus project of its own,
 * every ticket.
 */
function busTickets(tasks, { ownQueue }) {
  const list = Array.isArray(tasks) ? tasks : [];
  return ownQueue ? list.filter((t) => isNoticeboard(t)) : list;
}

/**
 * Where another project's bus is, for the release step (SP-277): its
 * "<slug>-bus" project when the tracker has one, else the project itself
 * when its own queue (`tasks`, its tickets as the door read them) holds a
 * Team chat noticeboard, else null (it has no bus). `slugs` is every
 * project slug the tracker lists.
 */
function busOfProject(projectSlug, { slugs, tasks }) {
  const separate = separateBusSlug(projectSlug);
  if (slugs && typeof slugs.has === 'function' && slugs.has(separate)) return separate;
  return pickTeamChat(busTickets(tasks, { ownQueue: true })) ? projectSlug : null;
}

/**
 * What did not stick on a Team chat ticket just made, read back (SP-356):
 * its status (Live, or a loop could claim it) and its `noticeboard` tag (or
 * it counts as work, and bus-read in the project's own queue skips it).
 * Empty when both did.
 */
function teamChatReadBackProblems(chat) {
  const problems = [];
  const status = String(chat?.status?.status ?? chat?.status ?? '').toLowerCase();
  if (status !== TEAM_CHAT_STATUS.toLowerCase()) problems.push(`it read back in status ${JSON.stringify(status)}, not "${TEAM_CHAT_STATUS}", so a loop could claim it`);
  if (!hasNoticeboardTag(chat)) problems.push(`it read back without the ${NOTICEBOARD_TAG} tag, so it would count as work`);
  return problems;
}

/**
 * Why `task` must not file this ticket, or null: a `noticeboard` ticket is
 * filed in Live and nothing else, because in the project's own queue the
 * default Queued (or Rework) is a status a build pass claims (SP-356).
 */
function noticeboardFilingProblem({ status, tags }) {
  if (!hasNoticeboardTag({ tags })) return null;
  const want = TEAM_CHAT_STATUS.toLowerCase();
  if (String(status ?? '').trim().toLowerCase() === want) return null;
  return `a ticket tagged ${NOTICEBOARD_TAG} is not work, so it is filed in ${TEAM_CHAT_STATUS} (--status ${TEAM_CHAT_STATUS}), never ${status ? `"${status}"` : 'Queued, the default'}, which a build pass could claim`;
}

/** The machine named in a post's "**From <machine>**" header, or null. */
function postSender(text) {
  const first = String(text ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const m = /^\*\*From (.+?)\*\*( · .*)?$/.exec(first);
  return m ? m[1] : null;
}

/** The alarm, cut for a text: one line, about 300 characters at most. */
const ALARM_TEXT_LIMIT = 300;

/**
 * The text for one alarm: which bus and machine, the alarm cut to one line
 * of about ALARM_TEXT_LIMIT characters, and the link to the Team chat
 * ticket. `pageUrl` is the tracker's address as it opens on his phone.
 */
function alarmText({ ticketId, projectName, text, pageUrl }) {
  const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  let alarm = oneLine(postMessage(text));
  if (alarm.length > ALARM_TEXT_LIMIT) alarm = `${alarm.slice(0, ALARM_TEXT_LIMIT - 1).trimEnd()}…`;
  const from = postSender(text);
  return [
    `Alarm on ${oneLine(projectName)}${from ? ` from ${oneLine(from)}` : ''}`,
    alarm,
    `${String(pageUrl).replace(/\/+$/, '')}/t/${encodeURIComponent(ticketId)}`,
  ].join('\n');
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
  ALARM_PREFIX,
  ALARM_TEXT_LIMIT,
  BUS_USES,
  alarmText,
  isAlarmPost,
  busProjectFor,
  busIsOwnQueue,
  busOfProject,
  busTickets,
  noticeboardFilingProblem,
  teamChatReadBackProblems,
  separateBusSlug,
  NOTICEBOARD_TAG,
  postMessage,
  postSender,
  TEAM_CHAT_STATUS,
  busLine,
  busMessages,
  mountainTime,
  parseSince,
  pickTeamChat,
  renderBusPost,
  renderTeamChatSeed,
};
