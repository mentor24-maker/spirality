/**
 * The parts app.mjs draws on every page: the tab's title, the bell, the
 * pipeline pod and its health, the trail, the sign-in and password screens
 * and the message strip.
 *
 * Split out of render.mjs (SP-364), which re-exports it, so every importer
 * still names render.mjs. Its rule holds here too: every character of
 * ticket text is escaped before it is drawn.
 */
import { escapeHtml, link } from './render-common.mjs';

/**
 * The browser tab's title: `(N) Tracker` while N tickets wait on the person
 * signed in, so a pinned tab shows a hand-over without being opened, and the
 * page's own title when nothing waits (or the count could not be read).
 */
export function tabTitle(waitingCount, pageTitle) {
  return Number.isInteger(waitingCount) && waitingCount > 0 ? `(${waitingCount}) Tracker` : pageTitle;
}

/**
 * Why an open page must not be redrawn on this beat, or null when it may be.
 * `hidden`: the tab is in the background, so nothing is read at all.
 * `drawing`: a draw is already under way. `writing`: a save is in flight,
 * and it redraws the page itself when it lands. `fields`: the page's text
 * boxes and choosers as `{ focused, value, initial }`; one with focus, or
 * holding text that is not what it was drawn with, is him typing, and a
 * redraw would wipe it. `dialog`: a dialog on the page is open (the Pipeline
 * Status dialog has only buttons, so no field holds it, SP-173); a redraw
 * would drop it from under him, with focus lost, and it waits until it closes.
 */
export function redrawHold({ hidden = false, drawing = false, writing = false, dialog = false, fields = [] } = {}) {
  if (hidden) return 'hidden';
  if (drawing) return 'drawing';
  if (writing) return 'writing';
  if (dialog) return 'dialog';
  if (fields.some((f) => f.focused || f.value !== f.initial)) return 'typing';
  return null;
}

/**
 * The choice a chooser was drawn with: the option marked selected in the
 * page as drawn, else the first one ('' with none). `options` is the
 * chooser's options, each `{ value, defaultSelected }`.
 */
export function drawnChoice(options) {
  const all = [...options];
  return (all.find((o) => o.defaultSelected) ?? all[0])?.value ?? '';
}

/**
 * The header bell's colour for the same count: grey while nothing waits (or
 * the count is missing), yellow for one to three, red for more than three.
 */
export function bellColour(waitingCount) {
  if (!Number.isInteger(waitingCount) || waitingCount <= 0) return 'grey';
  return waitingCount <= 3 ? 'yellow' : 'red';
}

/**
 * The bus count in the header (Dane's choice D on the bus ticket: "the page count for
 * everything else"), from GET /bus: `{ text, href, title }`, or null when
 * nothing on the bus is unseen (or the answer is missing). It opens the
 * Team chat ticket with the most unseen posts at its comments (the ticket
 * page opens its Details fold for `#comments`); the title names each one.
 */
export function busLink(answer) {
  const unseen = Array.isArray(answer?.unseen) ? answer.unseen.filter((u) => Number(u.count) > 0) : [];
  const total = unseen.reduce((n, u) => n + Number(u.count), 0);
  if (!total) return null;
  return {
    text: `${total} New on the Bus`,
    href: `/t/${encodeURIComponent(unseen[0].id)}#comments`,
    title: unseen.map((u) => `${u.projectName}: ${u.count} new post${Number(u.count) === 1 ? '' : 's'} on ${u.name}`).join('; '),
  };
}

/** How near a stage's next time must be for the pod to draw it gold (SP-222): under 3 minutes. */
export const PIPELINE_SOON_MS = 3 * 60 * 1000;

/**
 * The pod's clock time with its am/pm in lowercase (SP-222): "10:45 AM"
 * becomes "10:45 am". Text with no AM or PM comes back unchanged.
 */
export function lowerMeridiem(text) {
  return String(text).replace(/\b(AM|PM)\b/g, (m) => m.toLowerCase());
}

/** Why a stage is paused, in words: "the whole pipeline is paused", "Build is paused". */
function pausedWords(s) {
  return s.paused === 'pipeline' ? 'the whole pipeline is paused' : `${s.name} is paused`;
}

/** What the Pipeline Status pod says when GET /pipeline could not be read. */
export const PIPELINE_UNAVAILABLE = 'Pipeline Status unavailable';

/**
 * The Pipeline Status pod's contents on the Tasks page (SP-168), from GET
 * /pipeline, as HTML: the heading "Pipeline Stages", then one column per
 * stage, name above time (SP-326): the names "Relay Build Review Intake"
 * along the top and each one's next time (or "running") under it. The pod is
 * a button, and a table is not allowed inside one, so the columns are a CSS
 * grid of spans (`.stages` in app.css), each stage's name then its time, which
 * the grid turns into columns. `timeOf` turns an ISO time into
 * the page's own clock time. A stage with no pass logged yet, or no next time
 * known, shows a dash, its title saying which. A running stage's two cells
 * carry `running`, which app.css draws green. A stage whose next time is
 * less than PIPELINE_SOON_MS from `now` (or already past: a pass that is due)
 * carries `soon` instead, which app.css draws gold (SP-222); a running stage
 * is never `soon`. A stage paused on the Settings page (`paused`, SP-237)
 * shows "Paused" and carries `paused` instead of a next time, never `soon`;
 * one still running its last pass shows "running", its title saying the
 * pause lets it finish. `now` is a time in milliseconds, given so a test can fix
 * the clock. A missing or malformed answer says PIPELINE_UNAVAILABLE.
 */
export function renderPipelinePod(answer, timeOf, now = Date.now()) {
  const stages = Array.isArray(answer?.stages) ? answer.stages : null;
  if (!stages || !stages.length) return `<span class="unavailable">${escapeHtml(PIPELINE_UNAVAILABLE)}</span>`;
  const item = (s) => {
    let shown;
    let title;
    let soon = false;
    if (s.running) {
      shown = 'running';
      title = `${s.name}: a pass is running now${s.paused ? `; ${pausedWords(s)}, so it finishes and no new one starts` : ''}`;
    } else if (s.paused) {
      shown = 'Paused';
      title = `${s.name}: ${pausedWords(s)} on the Settings page`;
    } else if (!s.logged) {
      shown = '–';
      title = `${s.name}: no passes logged yet`;
    } else if (!s.nextDue) {
      shown = '–';
      title = `${s.name}: the next pass's time is not known yet`;
    } else {
      shown = timeOf(s.nextDue);
      const away = Date.parse(s.nextDue) - now;
      soon = away < PIPELINE_SOON_MS;
      title = `${s.name}: next pass due ${shown}${away <= 0 ? ' (due now)' : soon ? ' (due within 3 minutes)' : ''}`;
    }
    const cls = s.running ? ' running' : s.paused ? ' paused' : soon ? ' soon' : '';
    const tip = escapeHtml(title);
    return `<span class="stage${cls}" title="${tip}">${escapeHtml(s.name)}</span><span class="time${cls}" title="${tip}">${escapeHtml(shown)}</span>`;
  };
  return `<span class="heading">Pipeline Stages</span><span class="stages">${stages.map(item).join('')}</span>`;
}

/**
 * The header's lane health lines (SP-218), from GET /pipeline: one sentence
 * per failing stage, "Relay can't reach the internet since 9:00 PM", in the
 * stages' order. The reason is the answer's own fixed words (tracker/
 * pipeline.mjs FAILING_REASONS); one that is missing says "keeps failing".
 * `timeOf` turns the ISO start of the failures into the page's own time. No
 * failing stage, or a missing or malformed answer, gives no lines: the line
 * is gone at the first passing pass.
 */
export function healthLines(answer, timeOf) {
  const stages = Array.isArray(answer?.stages) ? answer.stages : [];
  return stages
    .filter((s) => s?.failing === true)
    .map((s) => {
      const reason = typeof s.failingReason === 'string' && s.failingReason ? s.failingReason : 'keeps failing';
      return s.failingSince ? `${s.name} ${reason} since ${timeOf(s.failingSince)}` : `${s.name} ${reason}`;
    });
}

/** The header's health lines as HTML, one `<span>` each; empty when nothing is failing. */
export function renderHealth(answer, timeOf) {
  return healthLines(answer, timeOf).map((line) => `<span>${escapeHtml(line)}</span>`).join('');
}

/**
 * The pod button's accessible name (SP-173): "Pipeline Status: Relay 10:45,
 * Build running, Review –, Intake 11:04", so a screen reader names the button
 * for what it opens and still reads each stage. A missing or malformed answer
 * gives PIPELINE_UNAVAILABLE, which already names it.
 */
export function pipelinePodLabel(answer, timeOf) {
  const stages = Array.isArray(answer?.stages) ? answer.stages : null;
  if (!stages || !stages.length) return PIPELINE_UNAVAILABLE;
  const shown = (s) => (s.running ? 'running' : s.paused ? 'paused' : s.logged && s.nextDue ? timeOf(s.nextDue) : '–');
  return `Pipeline Status: ${stages.map((s) => `${s.name} ${shown(s)}`).join(', ')}`;
}

/**
 * How a pass ended, in plain words, from the exit code on its END line
 * (SP-173). The runners write these codes (scripts/run_relay.sh,
 * scripts/loop_runner.sh, scripts/run_with_time_limit.sh): 0 finished, 1 a
 * step failed and said so, 124 the time limit stopped it, anything else it
 * could not run. An END line with no code says only that it ended.
 */
export function passOutcome(code) {
  if (code === 0) return 'Finished';
  if (code === 1) return 'A step failed and said so';
  if (code === 124) return 'Hit its time limit and was stopped';
  if (Number.isInteger(code)) return `Could not run (exit ${code})`;
  return 'Ended';
}

/** How often a stage wakes, from its interval in seconds: "Every 30 minutes". */
export function wakesEvery(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '–';
  if (seconds % 3600 === 0) return seconds === 3600 ? 'Every hour' : `Every ${seconds / 3600} hours`;
  if (seconds % 60 === 0) return seconds === 60 ? 'Every minute' : `Every ${seconds / 60} minutes`;
  return `Every ${seconds} seconds`;
}

/**
 * The Pipeline Status dialog's rows (SP-173), from GET /pipeline: per stage,
 * its next pass (or "Running now, since …"), when its last pass started and
 * ended and how it ended, and how often it wakes, as an HTML table. `timeOf`
 * turns an ISO time into the page's own time format. A stage with no pass
 * logged yet says "No passes logged yet". While a stage runs, its Last Ended
 * cell is the previous pass's and says "Previous pass: …". A missing or malformed answer says
 * PIPELINE_UNAVAILABLE.
 */
export function renderPipelineDetails(answer, timeOf) {
  const stages = Array.isArray(answer?.stages) ? answer.stages : null;
  if (!stages || !stages.length) return `<p class="unavailable">${escapeHtml(PIPELINE_UNAVAILABLE)}.</p>`;
  const row = (s) => {
    const name = `<th scope="row">${escapeHtml(s.name)}</th>`;
    const wakes = `<td>${escapeHtml(wakesEvery(s.interval))}</td>`;
    if (!s.logged) return `<tr>${name}<td colspan="3" class="quiet">${s.paused ? `Paused (${escapeHtml(pausedWords(s))}); ` : ''}No passes logged yet</td>${wakes}</tr>`;
    let next;
    if (s.running) next = `${s.lastStart ? `Running now, since ${timeOf(s.lastStart)}` : 'Running now'}${s.paused ? ` (paused: this pass finishes, no new one starts)` : ''}`;
    else if (s.paused) next = `Paused (${pausedWords(s)})`;
    else next = s.nextDue ? timeOf(s.nextDue) : 'Not known yet';
    const started = s.lastStart ? timeOf(s.lastStart) : '–';
    // While a pass runs, the last END belongs to the pass before it: say so, so
    // a red outcome there does not read as the running pass failing.
    const ended = s.lastEnd ? `${s.running ? 'Previous pass: ' : ''}${timeOf(s.lastEnd)}: ${passOutcome(s.lastExit)}` : '–';
    const failed = s.lastEnd && s.lastExit !== 0 && s.lastExit != null;
    return `<tr${s.running ? ' class="running"' : ''}>${name}<td>${escapeHtml(next)}</td><td>${escapeHtml(started)}</td><td${failed ? ' class="failed"' : ''}>${escapeHtml(ended)}</td>${wakes}</tr>`;
  };
  return `<div class="table-wrap"><table class="pipeline-stages">
    <thead><tr><th scope="col">Stage</th><th scope="col">Next Pass</th><th scope="col">Last Started</th><th scope="col">Last Ended</th><th scope="col">Wakes</th></tr></thead>
    <tbody>${stages.map(row).join('')}</tbody>
  </table></div>`;
}

/**
 * The trail under the main menu: where the page sits, as `{ label, href }`
 * steps from the outside in (Spirality > Task SP-47 > Details). Every step
 * before the last is a link back up; the last is the page itself and never
 * a link. Every label is escaped: project and ticket names are typed by
 * people.
 */
export function renderTrail(steps) {
  const parts = steps.map(({ label, href }, i) => {
    if (i === steps.length - 1) return `<span aria-current="page">${escapeHtml(label)}</span>`;
    return href ? `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>` : `<span>${escapeHtml(label)}</span>`;
  });
  return `<nav class="trail" aria-label="You are here">${parts.join('<span class="sep"> &gt; </span>')}</nav>`;
}

/** The shortest password the tracker takes (store.mjs MIN_PASSWORD); the server holds the rule. */
export const MIN_PASSWORD = 12;

/**
 * Why an emailed link cannot be used, in plain words, from the store's code
 * (`unknown-link`, `used-link`, `expired-link`), or null for any other.
 */
export function linkProblem(code) {
  if (code === 'used-link') return 'This link has already been used. Nothing was changed. Ask for a new one if you still need to set your password.';
  if (code === 'expired-link') return 'This link has expired. Nothing was changed. Ask for a new one.';
  if (code === 'unknown-link') return 'This link is not one the tracker made. Nothing was changed. Check you opened the whole link from the email.';
  return null;
}

/**
 * What is wrong with a set-password form before it is sent, or null: the
 * same checks the server makes, said before a round trip. `purpose` is the
 * link's; only an invite asks for a name.
 */
export function passwordProblem({ purpose, name, password, confirm }) {
  if (purpose === 'invite' && !String(name ?? '').trim()) return 'Type your name.';
  if ([...String(password ?? '')].length < MIN_PASSWORD) return `A password must be at least ${MIN_PASSWORD} characters.`;
  if (password !== confirm) return 'The two passwords are not the same.';
  return null;
}

/** The set-password form for a link that can be used, as HTML. The email is shown, never changed here. */
export function renderSetPassword({ purpose, email }) {
  const nameBox = purpose === 'invite'
    ? `<label for="name">Your Name</label>
      <input id="name" type="text" autocomplete="name" required>`
    : '';
  return `<h1>Set Your Password</h1>
    <form class="sign-in set-password fields">
      <label for="email">Email</label>
      <input id="email" type="email" value="${escapeHtml(email)}" readonly autocomplete="username">
      ${nameBox}
      <label for="password">Password</label>
      <span class="hint" id="password-hint">At least ${MIN_PASSWORD} characters.</span>
      <input id="password" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD}" aria-describedby="password-hint" required>
      <label for="confirm">Confirm Password</label>
      <span class="hint" id="confirm-hint">The same password again.</span>
      <input id="confirm" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD}" aria-describedby="confirm-hint" required>
      <div class="row"><button type="submit" class="btn btn-save">Save Password</button></div>
      <p class="note"></p>
    </form>`;
}

/** What the page says once a password is set: where to sign in. */
export function renderPasswordSet(trackerAddress) {
  return `<h1>Password Set</h1>
    <p>Password set. Sign in at <a href="/">${escapeHtml(trackerAddress)}</a>.</p>`;
}

/** The sign-in form, as HTML: email, password, and "Forgot password?". `problem` is said under it. */
export function renderSignIn(problem) {
  return `<h1>Sign In</h1>
    <form class="sign-in fields">
      <label for="email">Email</label>
      <input id="email" type="email" autocomplete="username" required>
      <label for="password">Password</label>
      <input id="password" type="password" autocomplete="current-password" required>
      <div class="row"><button type="submit" class="btn btn-primary">Sign In</button>
      <button type="button" class="link forgot">Forgot Password?</button></div>
      <p class="note${problem ? ' error' : ''}">${problem ? escapeHtml(problem) : ''}</p>
    </form>`;
}

/** "Forgot password?", as HTML: one email box, and a way back to signing in. */
export function renderForgot(email = '') {
  return `<h1>Forgot Password</h1>
    <form class="sign-in forgot fields">
      <p>Type your email. If it has an account, a link to set a new password is emailed to it. The link works for 1 hour.</p>
      <label for="email">Email</label>
      <input id="email" type="email" autocomplete="username" value="${escapeHtml(email)}" required>
      <div class="row"><button type="submit" class="btn btn-primary">Email Me a Link</button>
      <a href="/">Back to Sign In</a></div>
      <p class="note"></p>
    </form>`;
}

/** How long a success or information message stays before it closes by itself; an error stays until its × is pressed. */
export const MESSAGE_CLOSES_MS = 4000;
/** How long the card after a Save stays before it fades by itself (it has nothing to close). */
export const SAVED_CARD_MS = 3000;

/** The strip's contents for one message: the words, and a × on an error, the only kind that waits to be closed. */
export function renderMessage({ kind, text }) {
  const role = kind === 'error' ? 'alert' : 'status';
  const close = kind === 'error' ? '<button type="button" class="message-close" aria-label="Close Message">×</button>' : '';
  return `<p class="message message-${escapeHtml(kind)}" role="${role}"><span class="message-text">${escapeHtml(text)}</span>${close}</p>`;
}

/** The small card after a Save: what was saved, with a check, and nothing to close. */
export function renderSavedCard(text) {
  return `<p class="saved-card" role="status"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg><span>${escapeHtml(text)}</span></p>`;
}
