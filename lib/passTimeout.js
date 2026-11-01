'use strict';

/**
 * WHAT A PASS WAS DOING WHEN THE TIME LIMIT STOPPED IT (task 86bccr85c).
 *
 * On 2026-10-04 the build lane on the Mini did no useful work from 1:54am to
 * past 1:42pm: five passes on "Galaxy module 5/6", each stopped at the
 * two-hour limit by `run_with_time_limit.sh` (exit 124). The cause was one
 * render contract the pass kept fixing and re-running, an ~8-minute
 * `npm run check:render` each time. But `claude -p` prints its report only at
 * the end, so a stopped pass left NOTHING between START and END in the log and
 * nothing on the ticket — a stuck test and a dead machine were the same
 * picture, and finding the cause took a session copying the work to another
 * machine and re-running the check by hand.
 *
 * Two answers live here, both pure:
 *
 *   1. Name what was running. `run_with_time_limit.sh` writes the process tree
 *      under the pass at the moment of the stop (one tab-separated line per
 *      process: depth, pid, elapsed, command); `describeStuck` reads it and
 *      names the gate — `npm run check:render, running 7m 12s` — or says that
 *      nothing was running at all, which is the 2026-09-12 idle-pass shape.
 *
 *   2. Stop feeding the same ticket to the time limit. The next pass's
 *      `pass-reconcile` hands a stopped pass's ticket straight back to the
 *      claim line, where it is claimed first again — five times that day. So
 *      each stop leaves a note on the ticket, and the SECOND stop since the
 *      ticket last reached a pull request escalates to Dane with what is known
 *      instead of costing another two hours.
 */

/** Every timeout note starts with this, and it is how they are counted. */
const { operatorName, logDir } = require('./substrateConfig.js');

const TIMEOUT_MARK = '⏱ Time limit:';

/** The stop that escalates. Two, per the ticket: one stop can be bad luck. */
const ESCALATE_AT = 2;

/** How many process lines a note carries. The full tree is in the log. */
const NOTE_LINES = 8;

/** `ps -o etime` → seconds. Shapes: `mm:ss`, `hh:mm:ss`, `dd-hh:mm:ss`. */
function etimeToSeconds(etime) {
  const m = String(etime || '').trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  const [, d, h, mi, s] = m;
  return ((Number(d || 0) * 24 + Number(h || 0)) * 60 + Number(mi)) * 60 + Number(s);
}

/** "7m 12s", "1h 03m", "45s" — the register the operator reads. */
function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return 'for an unknown time';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/** The snapshot file → rows. Lines that are not the four-field shape are skipped. */
function parseSnapshot(text) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 4) continue;
    const depth = Number(parts[0]);
    if (!Number.isInteger(depth) || depth < 1) continue;
    rows.push({
      depth,
      pid: parts[1].trim(),
      etime: parts[2].trim(),
      seconds: etimeToSeconds(parts[2]),
      command: parts.slice(3).join('\t').trim(),
    });
  }
  return rows;
}

/**
 * The named command inside a process line, if it has one. A Bash-tool shell's
 * line carries the whole thing it was asked to run (`zsh -c ... eval 'cd x &&
 * npm run check:render 2>&1 | tail'`), so the gate is found there as readily
 * as in the npm process beneath it.
 */
function gateName(command) {
  const c = String(command || '');
  const npm = c.match(/\bnpm\s+(?:run(?:-script)?\s+(?:--\S+\s+)*([\w:.-]+)|(test|ci)\b)/);
  if (npm) return npm[1] ? `npm run ${npm[1]}` : `npm ${npm[2]}`;
  const npx = c.match(/\bnpx\s+(?:--?\S+\s+)*([\w@/.:-]+)/);
  if (npx) return `npx ${npx[1]}`;
  return '';
}

/** A Bash-tool shell: `<shell> -c <command>` directly under the pass. */
const SHELL_LINE = /(?:^|\/)(?:ba|z)?sh\s+(?:-\S+\s+)*-c\b/;

/**
 * What was the pass stuck on? Three answers, in this order:
 *
 *   gate     a named `npm run` / `npx` command — the shallowest one, since
 *            that is the step the pass chose; what it spawned is detail.
 *   command  no named gate, but a shell the pass ran was still going.
 *   idle     nothing was running under the pass at all: it was waiting on
 *            itself, the 2026-09-12 shape (eleven hours idle, 0% CPU).
 */
function describeStuck(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const named = list
    .map((r) => ({ ...r, gate: gateName(r.command) }))
    .filter((r) => r.gate)
    .sort((a, b) => a.depth - b.depth);
  if (named.length) {
    return { kind: 'gate', what: named[0].gate, seconds: named[0].seconds };
  }
  const shell = list.filter((r) => r.depth === 1 && SHELL_LINE.test(r.command));
  if (shell.length) {
    const r = shell[shell.length - 1];
    return { kind: 'command', what: truncate(r.command, 160), seconds: r.seconds };
  }
  return { kind: 'idle', what: '', seconds: null };
}

function truncate(text, max) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** One sentence: what it was doing. Used in the note, the card and the log. */
function stuckSentence(stuck) {
  if (!stuck || stuck.kind === 'idle') {
    return 'nothing was running under it — the pass itself had gone quiet';
  }
  const how = stuck.seconds == null ? '' : ` (${formatDuration(stuck.seconds)} in)`;
  return `it was running \`${stuck.what}\`${how}`;
}

/**
 * How many timeout notes this ticket carries since it last reached a pull
 * request. A `PR opened:` line means some pass got all the way through, so
 * the stops before it say nothing about the ticket as it stands now; a
 * send-back's rework is counted from that PR on.
 */
function priorTimeouts(comments) {
  const list = (Array.isArray(comments) ? comments : [])
    .map((c) => ({ text: String(c?.comment_text ?? ''), at: Number(c?.date) || 0 }))
    .sort((a, b) => a.at - b.at);
  let count = 0;
  for (const c of list) {
    if (/^PR opened:/m.test(c.text)) count = 0;
    else if (c.text.trimStart().startsWith(TIMEOUT_MARK)) count += 1;
  }
  return count;
}

/** This stop is number `prior + 1`; escalate at ESCALATE_AT. */
function timeoutDecision(prior) {
  const stop = (Number(prior) || 0) + 1;
  return { stop, escalate: stop >= ESCALATE_AT };
}

/** The note left on the ticket for every stop. */
function timeoutNote({ skill, limitSeconds, at, rows, stuck, decision }) {
  const lines = [
    `${TIMEOUT_MARK} a /${skill} pass was stopped at the ${formatDuration(limitSeconds)} limit at ${at} (stop ${decision.stop} on this ticket).`,
    `What it was doing: ${stuckSentence(stuck)}.`,
  ];
  const shown = (rows || []).slice(0, NOTE_LINES);
  if (shown.length) {
    lines.push('', 'Everything running under the pass at that moment (indented by depth · running for · command):', '```');
    for (const r of shown) {
      lines.push(`${'  '.repeat(r.depth - 1)}${formatDuration(r.seconds)} · ${truncate(r.command, 200)}`);
    }
    if (rows.length > shown.length) lines.push(`… and ${rows.length - shown.length} more (the full list is in ${logDir()}/${skill}.log)`);
    lines.push('```');
  }
  lines.push('', decision.escalate
    ? `This is stop ${decision.stop} on this ticket, so it goes to ${operatorName()} instead of back to the claim line — another pass would most likely spend another ${formatDuration(limitSeconds)} the same way.`
    : `The next pass hands this ticket back to the claim line. A second stop on it goes to ${operatorName()} instead.`);
  return lines.join('\n');
}

/**
 * The card for the escalation, in the `ask` shape. @@ASKED carries no
 * invented quote: no instruction of Dane's caused this hand-off, so it says
 * so and names what it descends from, as the card rules require.
 */
function escalationCard({ skill, limitSeconds, stuck, decision, at }) {
  const what = stuck && stuck.kind !== 'idle'
    ? `the last time while running ${truncate(stuck.what, 60).split(/\s+/).slice(0, 8).join(' ')}`
    : 'and the last one had nothing running under it at all';
  return [
    '@@ASKED',
    'No instruction of yours caused this hand-off. It descends from ticket 86bccr85c: after two time-limit stops on one ticket, the build loop stops claiming it and brings it to you with what it knows.',
    '',
    '@@WHEN',
    `${at}, from the ${skill} runner on this machine.`,
    '',
    '@@CONTEXT',
    `The automatic builder has now been stopped ${decision.stop} times on this ticket for running past its ${formatDuration(limitSeconds)} limit, ${what}. ` +
      'Each stop costs the whole build lane two hours, and on 2026-10-04 five of them in a row stalled it for ten. ' +
      'So instead of claiming it again, it is parked here. The notes above this card say exactly what was running at each stop.',
    '',
    '@@NEEDED',
    'Pick one: (A) send it back to Queued for another try, (B) have a session finish it by hand, or (C) narrow the ticket so a pass can finish it in time.',
    'Your move: Reply — A, B or C.',
  ].join('\n');
}

module.exports = {
  TIMEOUT_MARK,
  ESCALATE_AT,
  NOTE_LINES,
  etimeToSeconds,
  formatDuration,
  parseSnapshot,
  gateName,
  describeStuck,
  stuckSentence,
  priorTimeouts,
  timeoutDecision,
  timeoutNote,
  escalationCard,
};
