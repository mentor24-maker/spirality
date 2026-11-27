#!/usr/bin/env node
'use strict';

/**
 * Claude Code Stop hook -- the operator hand-off tripwire.
 * Enforces CLAUDE.md "CC runs the operational commands" / DOCTRINE.md §6.9.
 *
 * If the reply about to be delivered hands Dane a fenced command that CC could
 * have run itself, and does not name one of the four exceptions, refuse the
 * stop and say so. Exit 2 blocks the stop and shows stderr to the agent.
 *
 * WHY A STOP HOOK AND NOT A PRE-COMMIT CHECK
 * The failure is "the turn ended with a command block in it". Pre-commit
 * cannot see the message and neither can CI; the reply is the only place that
 * fact exists. Same reasoning as require_sql_handoff.cjs, and the same shape.
 *
 * `cli` SESSIONS ONLY -- WHICH IS NOT THE SAME AS "SOMEBODY IS READING"
 * A hand-off is only a hand-off if somebody is being handed something. The
 * loops run headless (`entrypoint: "sdk-cli"`) and report to a ticket, so
 * there is no operator at the other end and nothing to protect. Only `cli`
 * can trip this. But `cli` means "started at a terminal", not "watched": the
 * one `cli` session in this project's entire history (measured 2026-09-01 over
 * 1,615 transcripts) is a `/loop 30m loop-build` that ran unattended for seven
 * days. See isInteractive() in ../lib/operator_handoff.cjs. The brakes below
 * are what make that survivable, so treat them as load-bearing.
 *
 * IT FAILS OPEN, ON PURPOSE
 * If the transcript cannot be read, or the entrypoint cannot be determined,
 * this steps aside. That is the opposite of the pipeline switch's fail-safe
 * and the asymmetry is genuinely reversed here: a wrong refusal wedges a turn
 * and can strand an unattended pass in `Building`, while a miss just leaves
 * the written rule doing the work it was already doing. Three refusals per
 * session, then it stands down for the same reason.
 *
 * Escape hatch: SKIP_OPERATOR_HANDOFF=1 (say so and why, per CLAUDE.md).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  offendingCommands,
  statedException,
  lastAssistantTurn,
  isInteractive,
  stateDir,
  refusalMessage,
} = require('../lib/operator_handoff.cjs');

const MAX_REFUSALS = 3;

function stateFile(gitDir, sessionId) {
  const safe = String(sessionId || 'nosession').replace(/[^a-z0-9-]/gi, '').slice(0, 60);
  return path.join(gitDir, `operator-handoff-${safe}.json`);
}

function readState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { refusals: 0 };
  }
}

function writeState(file, state) {
  try {
    fs.writeFileSync(file, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

/**
 * Claim one of this session's three refusals. `true` means this turn may
 * refuse; `false` means stand aside.
 *
 * THE COUNTER MUST NOT SIT BEHIND `if (stateDir(...))`.
 * It used to, and that made the brake vanish in precisely the conditions where
 * it is needed most. `stateDir()` shells out to git, so it comes back empty
 * when the cwd is outside any repo, or when `git` is not on PATH -- a
 * documented condition in agent shells on this machine, where a bare PATH
 * without /opt/homebrew/bin is the normal starting state. With no counter the
 * hook refuses EVERY turn, forever, which is the wedged conversation this
 * file's header calls worse than the miss it prevents. So the state falls back
 * to the temp directory: a worse place to keep it, and infinitely better than
 * nowhere.
 *
 * If nothing at all is writable there is no brake to be had, and the honest
 * response is to let the turn end rather than refuse without a limit.
 */
function takeRefusalSlot(cwd, sessionId) {
  const candidates = [];
  for (const dir of [stateDir(cwd), os.tmpdir()]) {
    if (dir && !candidates.includes(dir)) candidates.push(dir);
  }

  for (const dir of candidates) {
    const file = stateFile(dir, sessionId);
    const state = readState(file);
    if (state.refusals >= MAX_REFUSALS) return false; // stood down deliberately
    if (writeState(file, { ...state, refusals: state.refusals + 1 })) return true;
    // Unwritable -- try the next place rather than refusing with no count.
  }

  return false;
}

function main(input) {
  if (process.env.SKIP_OPERATOR_HANDOFF === '1') process.exit(0);

  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    process.exit(0); // unparseable -- never wedge the session
  }

  // The harness's OWN infinite-loop guard: it sets this when the turn is
  // continuing because a Stop hook already blocked it once. Honouring it is
  // what keeps the refusal counter from being the only brake in the system --
  // two independent limits, so neither one failing can wedge the session.
  //
  // Both Stop hooks honour it as of 2026-09-04 (task 86bbt7mxe).
  // require_sql_handoff.cjs -- the other hook in the same settings array -- did
  // not, and this comment used to record the consequence as permanent: when it
  // blocked first, the next Stop carried the flag, this hook exited right here,
  // and a reply with BOTH problems only ever got the SQL complaint. That is
  // closed. What remains true is the ordering it implies, and it is deliberate:
  // on a continuation BOTH hooks stand down together, so a second problem is
  // reported on a later turn or not at all. Still the safe direction -- a miss,
  // not a wedge.
  //
  // WHERE the two hooks differ, and why this one may exit at the very top: it
  // keeps no state between turns. It judges the message text and nothing else,
  // so a continuation it never reads costs it nothing. The SQL hook carries
  // `handedOff` across the session, and a continuation is exactly where the
  // hand-off block arrives -- so its stand-down sits AFTER the reply is read
  // and recorded, not before. Placing it here by analogy is the defect that
  // sent PR #609 back on 2026-09-05.
  if (payload && payload.stop_hook_active) process.exit(0);

  // Only the main agent's Stop event. A subagent's reply is read by this
  // session, not by Dane.
  if (payload && payload.hook_event_name && payload.hook_event_name !== 'Stop') {
    process.exit(0);
  }

  const turn = lastAssistantTurn(payload && payload.transcript_path);

  // The harness may hand the message over directly; prefer it when it is
  // there, and fall back to what the transcript says.
  const direct = payload && payload.last_assistant_message;
  const message = (typeof direct === 'string' && direct.trim())
    ? direct
    : (turn && turn.text) || '';

  // Cannot tell who is reading -> step aside. See "IT FAILS OPEN" above.
  const entrypoint = turn && turn.entrypoint;
  if (!entrypoint) process.exit(0);
  if (!isInteractive(entrypoint)) process.exit(0);

  if (!message.trim()) process.exit(0);

  const offenders = offendingCommands(message);
  if (!offenders.length) process.exit(0);

  // The exception line is the sanctioned way through.
  if (statedException(message)) process.exit(0);

  const cwd = String((payload && payload.cwd) || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  if (!takeRefusalSlot(cwd, payload && payload.session_id)) process.exit(0);

  process.stderr.write(refusalMessage(offenders) + '\n');
  process.exit(2);
}

let stdin = '';
process.stdin.on('data', (c) => { stdin += c; });
process.stdin.on('end', () => main(stdin));
