/**
 * onboardLanes — the pure parts of the setup wizard's lanes step (SP-111,
 * scripts/onboard/lanes.mjs): reading the installer's `--status`, reading a
 * lane's passes out of its log, and judging whether a lane's first pass did
 * its lane's work.
 *
 * WHY THE FIRST PASS IS READ, NOT ONLY ITS START LINE (SETUP_REVIEW.md
 * hold-up 14). On 11/4 at 9:39 AM Normie's review lane started, logged START,
 * and then stood down on itself: its copy of the review skill said not to run
 * by hand while the lane was loaded, and the pass took itself for a hand-run
 * session. A START line proves launchd ran the job; only the pass's report
 * says whether the lane works.
 *
 * Nothing here names a product: lanes, logs and labels come from the
 * installer's own output and the product's settings file.
 */

/** The lanes install_loop_runner.sh installs for every product. */
export const LANES = Object.freeze(['relay', 'loop-build', 'loop-review', 'loop-intake']);

/**
 * `install_loop_runner.sh --status` as { job: { installed, loaded } }, one
 * entry per `── <job>` section it printed.
 */
export function parseStatus(text) {
  const jobs = {};
  let job = null;
  for (const line of String(text || '').split('\n')) {
    const head = /^── (\S+)\s*$/.exec(line);
    if (head) { job = head[1]; jobs[job] = { installed: false, loaded: false }; continue; }
    if (!job) continue;
    if (/^schedule: INSTALLED\b/.test(line)) jobs[job].installed = true;
    if (/^loaded:\s+yes\b/.test(line)) jobs[job].loaded = true;
  }
  return jobs;
}

// The runners write "YYYY-MM-DD HH:MM:SS" in the machine's own time.
function localTime(stamp) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(stamp);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}

/**
 * Every pass in a lane's log, oldest first: { start, end, endLine, report,
 * after }. `report` is what the pass printed between its START and END lines;
 * `after` is what the runner logged after END and before the next START (its
 * sign-in and time-limit warnings land there). `end` is null for a pass still
 * running.
 */
export function readPasses(logText, lane) {
  const marker = lane === 'relay' ? 'relay' : `/${lane}`;
  const start = new RegExp(`^===== (\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}) START ${escapeRe(marker)}(?: |=)`);
  const end = new RegExp(`^===== (\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}) END ${escapeRe(marker)}(?: |=)`);
  const passes = [];
  let cur = null;
  for (const line of String(logText || '').split('\n')) {
    const s = start.exec(line);
    if (s) { cur = { start: localTime(s[1]), end: null, endLine: '', report: [], after: [] }; passes.push(cur); continue; }
    if (!cur) continue;
    const e = cur.end ? null : end.exec(line);
    if (e) { cur.end = localTime(e[1]); cur.endLine = line; continue; }
    (cur.end ? cur.after : cur.report).push(line);
  }
  return passes.map((p) => ({ ...p, report: p.report.join('\n').trim(), after: p.after.join('\n').trim() }));
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * Did this pass stand down on its lane? Only when its report has a line
 * starting `LANE STOOD DOWN:`, the one line the build and review skills say
 * to print whenever they stop because the lane is loaded (SP-117), and that
 * nothing else starts with. Never guessed from wording: Dane's answer A on
 * SP-111, after a wording check run over Normie's real lane logs flagged five
 * passes and only one had stood down. A pass that IS the lane says "I am the
 * lane's own pass, not a second reviewer", which reads just like a stand-down.
 */
export const STAND_DOWN_LINE = /^[ \t]*LANE STOOD DOWN:/m;
export function standsDownOnItsLane(report) {
  return STAND_DOWN_LINE.test(String(report || ''));
}

/**
 * The verdict on a lane's first pass after `since` (when the lanes were
 * installed):
 *   { verdict: 'ok' | 'failed' | 'waiting', why }
 * 'waiting' means no pass has started yet, or one is running but has not run
 * long enough to rule out a stand-down (a stand-down ends in seconds; Normie's
 * took 15). A pass still running after `workingAfterMs` is doing its lane's
 * work, and counts as 'ok'.
 */
export function judgeFirstPass(passes, lane, { since, now = new Date(), workingAfterMs = 3 * 60 * 1000 } = {}) {
  // A relay START that only found another relay pass holding the lock
  // (run_relay.sh exits 0 with no END) is the lock working, not a pass.
  const counted = (p) => !(lane === 'relay' && /a relay pass is already running/.test(p.report));
  const at = passes.findIndex((p) => p.start && p.start.getTime() >= since.getTime() - 1000 && counted(p));
  if (at < 0) return { verdict: 'waiting', why: 'no pass has started since the install' };
  const first = passes[at];
  if (!first.end) {
    const said = lastLine(first.report);
    // Another START after it: this pass stopped without logging END (an early
    // exit, a crash), so it never did its lane's work.
    if (at < passes.length - 1) return { verdict: 'failed', why: `its first pass stopped without an END line${said ? `: ${said}` : ''}` };
    const ran = now.getTime() - first.start.getTime();
    if (ran < workingAfterMs) return { verdict: 'waiting', why: 'its first pass is still running' };
    // A relay pass takes seconds. One with START and no END after minutes
    // exited early (run_relay.sh: "a relay pass is already running", "the
    // lock could not be retaken") or is stuck; neither merges anything.
    if (lane === 'relay') return { verdict: 'failed', why: `its first pass logged START ${Math.round(ran / 60000)} minutes ago and no END (a relay pass takes seconds)${said ? `: ${said}` : ''}` };
    return { verdict: 'ok', why: `a pass has been working for ${Math.round(ran / 60000)} minutes` };
  }
  if (lane === 'relay') {
    if (/pass complete \(exit 0\)/.test(first.endLine)) return { verdict: 'ok', why: 'its first pass completed (exit 0)' };
    return { verdict: 'failed', why: `its first pass ended: ${first.endLine.replace(/=+/g, '').trim()}` };
  }
  if (/THIS PASS COULD NOT SIGN IN TO CLAUDE/.test(first.after)) return { verdict: 'failed', why: 'its first pass could not sign in to Claude (claude login on this machine)' };
  if (/\(exit 124\b/.test(first.endLine)) return { verdict: 'failed', why: 'its first pass hit the time limit and was stopped' };
  // claude missing, crashed or refused: the pass never did its lane's work,
  // whatever it printed on the way out.
  const exit = /\(exit (\d+)\b/.exec(first.endLine);
  if (!exit) return { verdict: 'failed', why: `its first pass ended without an exit code: ${first.endLine.replace(/=+/g, '').trim()}` };
  if (exit[1] !== '0') return { verdict: 'failed', why: `its first pass exited ${exit[1]}${lastLine(first.report) ? `: ${lastLine(first.report)}` : ''}` };
  if (!first.report) return { verdict: 'failed', why: 'its first pass printed no report' };
  if (standsDownOnItsLane(first.report)) return { verdict: 'failed', why: 'its first pass stood down, taking its own lane for another runner (SETUP_REVIEW.md hold-up 14)' };
  return { verdict: 'ok', why: 'its first pass finished with a report of its own work' };
}

function lastLine(text) { return String(text || '').split('\n').map((l) => l.trim()).filter(Boolean).pop() || ''; }

/**
 * Where to judge a lane from on a rerun, when every lane was already loaded
 * and nothing was installed: the start of the lane's newest pass, so that
 * pass is the one judged (a lane that stood down before still stands down
 * until a pass after the fix says otherwise). With no pass in the log yet,
 * `now`: the next pass is the one to wait for.
 */
export function rerunSince(passes, now = new Date()) {
  const starts = passes.map((p) => p.start).filter(Boolean);
  return starts.length ? starts[starts.length - 1] : now;
}

/**
 * The ids of the tickets in `queue` output (id, status, priority, created,
 * name, tab-separated) whose name is exactly `name`. A rerun after a filed
 * ticket's Ticket: line failed to reach the pull request finds that ticket
 * here instead of filing a second.
 */
export function ticketsNamed(queueText, name) {
  return String(queueText || '').split('\n')
    .map((l) => l.split('\t'))
    .filter((cols) => cols.length >= 5 && cols.slice(4).join('\t') === name)
    .map((cols) => cols[0].trim());
}

/** `--wait-minutes` as a number of minutes, or null when it is not one. */
export function waitMinutesFrom(value, fallback = 10) {
  if (value === undefined) return fallback;
  const n = Number(value);
  return /^\s*\d+(?:\.\d+)?\s*$/.test(String(value)) && Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The description of the setup ticket filed in the product's own project, so
 * its review lane reviews the setup pull request and asks Dane to merge it.
 * `asked` is Dane's own words, verbatim, or empty: never invented.
 */
export function setupTicketBody({ productSlug, githubRepo, prUrl, branch, asked }) {
  const words = String(asked || '').trim();
  return [
    '## Asked',
    '~~~',
    words || '(not recorded: the setup was started without Dane\'s words passed in)',
    '~~~',
    '',
    '## Goal',
    `${productSlug}'s setup pull request is reviewed and merged by its own lanes, on Dane's merge phrase, like any other ticket. The lanes run from the setup branch until it merges; then the runners put the checkout back on main.`,
    '',
    '## What is in it',
    `- Pull request: ${prUrl}`,
    `- Branch: \`${branch}\` in \`${githubRepo}\``,
    '- Made by the setup wizard (scripts/onboard in Spirality): the settings file, the `verify` CI workflow, the ticket door, the loop skills, the main-branch hook and the loop rules. Its body names the Spirality commit every copied file was checked against.',
    '',
    '## How to test',
    '- The pull request\'s `verify` check is green.',
    '- `npm run clickup -- whoami` from the branch answers as this product\'s hand-run seat.',
    '- `./scripts/install_loop_runner.sh --status` on the Mini shows every lane loaded.',
  ].join('\n');
}

/** `body` with `line` added on a line of its own, unless it is already there. */
export function withLine(body, line) {
  const text = String(body || '');
  if (text.split('\n').some((l) => l.trim() === line)) return text;
  return `${text.replace(/\s+$/, '')}\n\n${line}\n`;
}
