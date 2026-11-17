/**
 * The Settings page (page-settings.mjs): the pipeline controls and the
 * release group.
 *
 * Split out of render.mjs (SP-364), which re-exports it, so every importer
 * still names render.mjs. Its rule holds here too: every character of
 * ticket text is escaped before it is drawn.
 */
import { escapeHtml, mountainTime, option } from './render-common.mjs';
import { wakesEvery } from './render-shell.mjs';

/** A pipeline control's value in words: "1,800 seconds (Every 30 minutes)", "On", "Claude's default", "7 days". */
export function controlValueText(control, models = []) {
  const v = String(control?.value ?? '');
  if (control?.kind === 'seconds') return `${Number(v).toLocaleString('en-US')} seconds (${wakesEvery(Number(v))})`;
  if (control?.kind === 'switch') return v === 'on' ? 'On' : 'Off';
  if (control?.kind === 'model') return models.find((m) => m.id === v)?.label ?? v;
  if (control?.kind === 'days') return v === '0' ? '0 (moves only when named by hand)' : `${v} day${v === '1' ? '' : 's'}`;
  return v;
}

/** Seconds in words, as the page writes a wake time: "1,800 seconds". */
const secondsText = (n) => `${Number(n).toLocaleString('en-US')} seconds`;

/**
 * Under a wake time (SP-236): the seconds its lane last actually woke on and
 * whether that is the set value. The lane reads the set value before its
 * next sleep (the relay after its next pass), so for a while after a change
 * the two differ, and the page says so in plain words rather than claiming
 * the change has taken effect.
 */
export function wakeInEffectText(control) {
  if (control?.used == null) return 'Last used: not known on this machine yet.';
  if (control.inEffect) return `In effect: the lane last used ${secondsText(control.used)}.`;
  return `Last used: ${secondsText(control.used)}. Waiting for the lane's next pass to pick this up.`;
}

/**
 * Under a lane's model (SP-239): the model its last pass ran on, read from
 * the START line its runner writes. The runner reads the setting before each
 * pass, so after a change the next pass shows it; until then this names the
 * one the lane is still on.
 */
export function modelLastPassText(control, models = []) {
  const last = control?.lastModel;
  if (last == null) return 'Last pass ran on: not known on this machine yet.';
  const label = models.find((m) => m.id === last)?.label ?? last;
  if (last === control.value) return `In effect: the last pass ran on ${label}.`;
  return `Last pass ran on: ${label}. The lane's next pass picks this up.`;
}

/** One control's input, named by its key: a number box, an On/Off choice or a model choice. */
function controlInput(c, models, id, locked) {
  const off = locked ? ' disabled' : '';
  if (c.kind === 'seconds' || c.kind === 'count' || c.kind === 'days') {
    return `<input id="${id}" type="number" min="${c.min}" max="${c.max}" step="1" value="${escapeHtml(c.value)}"${off}>`;
  }
  const options = c.kind === 'switch' ? [{ id: 'off', label: 'Off' }, { id: 'on', label: 'On' }] : models;
  return `<select id="${id}"${off}>${options.map((o) => `<option value="${escapeHtml(o.id)}"${o.id === c.value ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}</select>`;
}

/**
 * What a pause is waiting on (SP-237), under the pause switches, from the
 * view's `inFlight` tickets (all of them for the whole pipeline; a lane's
 * own kind for one lane, so a paused intake or relay has nothing to drain):
 * nothing while no switch is on; "Draining: N
 * ticket(s) still finishing" and each one (linked) while a lane still works
 * on one; "Paused: nothing in flight" once none is left. A pause stops new
 * passes and never a running one, so this is what Dane waits for before the
 * deck is clear.
 */
const DRAIN_KINDS = Object.freeze({ 'paused.loop-build': 'a build', 'paused.loop-review': 'a review' });

export function drainLine(view) {
  const on = (view?.controls ?? []).filter((c) => c.group === 'pause' && c.value === 'on').map((c) => c.key);
  if (!on.length) return '';
  // The whole pipeline waits on every ticket in flight; one lane only on its own kind of pass.
  const whole = on.includes('paused');
  const kinds = new Set(on.map((k) => DRAIN_KINDS[k]).filter(Boolean));
  const tickets = (Array.isArray(view.inFlight) ? view.inFlight : []).filter((t) => whole || kinds.has(t.kind));
  if (!tickets.length) return '<p class="drain paused">Paused: nothing in flight.</p>';
  const item = (t) => `<li><a href="/t/${encodeURIComponent(t.id)}">${escapeHtml(t.id)}</a> ${escapeHtml(t.name)} <span class="quiet">(${escapeHtml(t.kind)})</span></li>`;
  return `<div class="drain draining"><p>Draining: ${tickets.length} ticket(s) still finishing.</p><ul>${tickets.map(item).join('')}</ul></div>`;
}

/**
 * Beside the work-in-progress cap (SP-238): how many tickets are in flight
 * now (in Building or In review, `view.capInFlight`), so a stalled build lane
 * is easy to see; marked when the count has reached the cap. Nothing when
 * the count is not known.
 */
export function capInFlightText(c, capInFlight) {
  const count = capInFlight?.count;
  if (!Number.isInteger(count)) return '';
  const full = count >= Number(c.value);
  const words = `${count} in flight now${full ? ': full, loop-build is not claiming new tickets' : ''}.`;
  return `<span class="in-flight${full ? ' full' : ''}">${escapeHtml(words)}</span>`;
}

/**
 * One project's Pipeline Controls section on the Settings page (SP-224),
 * from GET /pipeline-controls: each group of controls under its heading, each
 * control with its value, a "default" mark while it has its default, and a
 * Save button (none, and the inputs locked, for a reader who may not change
 * them), then, for a group the lanes do not use yet, a line saying so,
 * naming the ticket that wires it in, and under the pause switches, while
 * any is on, the drain line (drainLine). Each wake time also says what its
 * lane last used (wakeInEffectText), and each model what its lane's last
 * pass ran on (modelLastPassText). Quiet Days Before Moving comes after the
 * release group, the setting that moves it (SP-277). Under them, the change log, newest first, in
 * Mountain time. `notes` is `{ key: { ok, text } }`, a Save's outcome to show
 * beside its control. The section is a box that opens and closes (SP-289),
 * the project's name its header; it starts closed unless `open` is true (the
 * page passes the box's state from before a redraw, so a Save keeps it open).
 */
export function renderPipelineControls(view, notes = {}, open = false) {
  const slug = view.project.slug;
  const locked = view.canChange !== true;
  const models = view.models ?? [];
  const row = (c) => {
    const id = `control-${escapeHtml(slug)}-${escapeHtml(c.key.replace(/[^A-Za-z0-9-]/g, '-'))}`;
    const note = notes[c.key];
    const mark = c.isDefault ? ' <span class="default">default</span>' : '';
    return `<tr data-control="${escapeHtml(c.key)}" data-kind="${escapeHtml(c.kind)}">
      <td class="label"><label for="${id}">${escapeHtml(c.title ?? c.label)}</label>${mark}</td>
      <td class="input">${controlInput(c, models, id, locked)}</td>
      <td class="value">${escapeHtml(controlValueText(c, models))}${c.group === 'wake' ? `<span class="in-effect${c.inEffect === false ? ' waiting' : ''}">${escapeHtml(wakeInEffectText(c))}</span>` : ''}${c.group === 'model' ? `<span class="in-effect${c.lastModel != null && c.lastModel !== c.value ? ' waiting' : ''}">${escapeHtml(modelLastPassText(c, models))}</span>` : ''}${c.key === 'wip-cap' ? capInFlightText(c, view.capInFlight) : ''}</td>
      <td class="save">${locked ? '' : '<button type="button" class="btn btn-save btn-sm">Save</button>'}<span class="note${note ? (note.ok ? ' quiet' : ' error') : ''}">${note ? escapeHtml(note.text) : ''}</span></td>
    </tr>`;
  };
  const group = (g) => {
    if (g.notOnOwnProject && view.own) return '';
    const controls = view.controls.filter((c) => c.group === g.key);
    if (!controls.length) return '';
    const notYet = g.wiredBy ? `<p class="quiet not-yet">Saved, but the lanes do not use this yet (${escapeHtml(g.wiredBy)}).</p>` : '';
    return `<h4>${escapeHtml(g.title)}</h4>
    <table class="controls"><tbody>${controls.map(row).join('')}</tbody></table>
    ${notYet}${g.key === 'pause' ? `<div class="drain-box">${drainLine(view)}</div>` : ''}`;
  };
  const who = view.operator ? escapeHtml(view.operator.name) : 'nobody (this project has no operator)';
  const lockedLine = locked ? `<p class="quiet">Only ${who}, the project's operator, may change these.</p>` : '';
  const changes = view.changes ?? [];
  const log = changes.length
    ? `<div class="table-wrap"><table class="control-changes"><thead><tr><th>When</th><th>Who</th><th>Setting</th><th>Old Value</th><th>New Value</th></tr></thead><tbody>${changes.map((x) => `<tr><td>${escapeHtml(mountainTime(x.at))}</td><td>${escapeHtml(x.actorName)}</td><td>${escapeHtml(x.label)}</td><td>${escapeHtml(x.from)}</td><td>${escapeHtml(x.to)}</td></tr>`).join('')}</tbody></table></div>`
    : '<p class="quiet">No changes yet.</p>';
  return `<details class="pipeline-controls" data-project="${escapeHtml(slug)}"${open ? ' open' : ''}>
    <summary>${escapeHtml(view.project.name)}</summary>
    <div class="project-body">
    ${lockedLine}
    ${(view.groups ?? []).filter((g) => g.key !== 'release-move').map(group).join('')}
    ${view.release ? renderReleaseGroup(view.release, notes.release) : ''}
    ${(view.groups ?? []).filter((g) => g.key === 'release-move').map(group).join('')}
    <h4>Change Log</h4>
    ${log}
    </div>
  </details>`;
}

/**
 * One project's release group on the Settings page (SP-275), from
 * the `release` part of GET /pipeline-controls: the release it runs, when
 * and who named it, and the one before it; a Move to Newest button (names
 * the newest release cut) and a Roll Back button (names the earlier one
 * again), for the operator only. The tracker's home project shows its
 * `ownLine` and no buttons. A project with no release named shows
 * "No release named yet" and only Move to Newest. Under it, the line saying
 * the lanes do not run from it yet, naming the ticket that wires it in.
 * `note` is `{ ok, text }`, a button's outcome.
 */
export function renderReleaseGroup(r, note = null) {
  const notYet = `<p class="quiet not-yet">Named, but the lanes do not run from it yet (${escapeHtml(r.wiredBy)}).</p>`;
  const head = `<h4>${escapeHtml(r.title)}</h4>`;
  if (r.own) return `<div class="release-group">${head}<p class="release-own">${escapeHtml(r.ownLine)}</p></div>`;
  const when = (e) => `${escapeHtml(e.release)}</strong>, named ${escapeHtml(mountainTime(e.at))} by ${escapeHtml(e.actorName)}`;
  const lines = [];
  if (!r.known) lines.push('<p class="quiet">This tracker cannot tell which project is its home (its project config was not usable when it started), so no release can be named here.</p>');
  lines.push(r.current
    ? `<p class="release-current">Runs <strong>${when(r.current)}.</p>`
    : '<p class="release-current">No release named yet.</p>');
  if (r.previous) lines.push(`<p class="release-previous quiet">Before that: <strong>${when(r.previous)}.</p>`);
  const newestLine = r.newestProblem
    ? `The newest release could not be read: ${escapeHtml(r.newestProblem)}`
    : r.newest ? `The newest release is <strong>${escapeHtml(r.newest)}</strong>.` : 'No release has been cut yet.';
  lines.push(`<p class="release-newest quiet">${newestLine}</p>`);
  let buttons = '';
  if (r.canChange) {
    const upToDate = r.newest != null && r.current?.release === r.newest;
    const canMove = r.newest != null && !upToDate;
    const move = `<button type="button" class="btn" data-release-action="newest"${canMove ? '' : ' disabled'}>Move to Newest</button>`;
    const back = r.current
      ? (r.rollBackTo
        ? `<button type="button" class="btn" data-release-action="back">Roll Back to ${escapeHtml(r.rollBackTo)}</button>`
        : '<span class="quiet">No earlier release to roll back to.</span>')
      : '';
    const why = upToDate ? '<span class="quiet">It runs the newest release.</span>' : '';
    buttons = `<div class="row release-actions">${move}${back}${why}<span class="note${note ? (note.ok ? ' quiet' : ' error') : ''}">${note ? escapeHtml(note.text) : ''}</span></div>`;
  }
  return `<div class="release-group">${head}${lines.join('')}${buttons}${notYet}</div>`;
}
