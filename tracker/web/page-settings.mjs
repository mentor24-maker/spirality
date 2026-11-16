/**
 * The Settings page (/settings): its tabs, the stage colours and the pipeline controls.
 *
 * Part of Dane's page: app.mjs is the entry the page loads, holds what
 * every page shares (signing in, the API call, the header, routing and the
 * message strip) and imports this file. Moved out of app.mjs unchanged
 * (Spirality SP-352), so a ticket that changes one page no longer edits the
 * same file as a ticket that changes another.
 */
import { escapeHtml, renderPipelineControls, drainLine } from './render.mjs';
import { api, setTitle, main, showMessage, SignedOut, drawSignIn, action } from './app.mjs';

/**
 * The Settings page: every stage in the contract's order, as the server lists
 * them, each with a colour picker and a Clear button. One Save stores them
 * all; the page then reads the colours back and says they were saved only
 * when what it reads is what it sent. A loop's sign-in is refused by the
 * server, and the page shows that refusal as it is.
 *
 * Two tabs (SP-289), chosen from a menu under the heading: Pipeline Controls
 * (shown first) and Styles (Stage Colours). The chosen tab is kept in the
 * address (`#pipeline-controls`, `#styles`), so a reload or a shared link
 * opens the same one.
 */
export async function drawSettings() {
  const { stages } = await api('GET', '/stage-colours');
  const { projects: controls = [] } = await api('GET', '/pipeline-controls');
  setTitle('Settings · Tracker');
  /** What each stage will be saved as: `#rrggbb`, or null for no colour. */
  const chosen = Object.fromEntries(stages.map((s) => [s.status, s.colour]));
  const row = (s, i) => `
    <tr data-status="${escapeHtml(s.status)}">
      <td class="status"><label for="colour-${i}">${escapeHtml(s.status)}</label></td>
      <td class="picker"><input id="colour-${i}" type="color"></td>
      <td class="value"></td>
      <td class="clear"><button type="button" class="btn btn-sm">Clear</button></td>
    </tr>`;
  main.innerHTML = `
    <h1>Settings</h1>
    <nav class="tabs settings-tabs" aria-label="Settings">${SETTINGS_TABS.map((t) => `<a href="#${t.id}" data-tab="${t.id}">${t.title}</a>`).join('')}</nav>
    <div class="settings-tab" data-tab="pipeline-controls">
      <p class="quiet">How each project's loop runs, for experimenting with the pipeline. Everyone can see them; only a project's operator can change them. Every change is logged below its project.</p>
      <div class="pipeline-controls">${controls.length ? '' : '<p class="quiet">No projects to show.</p>'}</div>
    </div>
    <div class="settings-tab" data-tab="styles">
      <h2>Stage Colours</h2>
      <p class="quiet">Choose a colour for each stage of the loop. The same colours show for everyone.</p>
      <form class="colours">
        <div class="table-wrap"><table class="colours"><thead><tr><th>Stage</th><th>Colour</th><th></th><th></th></tr></thead><tbody>${stages.map(row).join('')}</tbody></table></div>
        <div class="row"><button type="submit" class="btn btn-save">Save</button></div>
      </form>
    </div>`;
  showSettingsTab(settingsTabAt());
  for (const a of main.querySelectorAll('nav.settings-tabs a')) {
    a.addEventListener('click', (e) => {
      // The tab changes in place: no redraw, so nothing typed is lost.
      e.preventDefault();
      e.stopPropagation();
      history.replaceState(null, '', `${location.pathname}${location.search}#${a.dataset.tab}`);
      showSettingsTab(a.dataset.tab);
    });
  }
  drawPipelineControls(main.querySelector('div.pipeline-controls'), controls);
  const form = main.querySelector('form.colours');
  const rows = [...form.querySelectorAll('tbody tr')];
  const show = (tr) => {
    const colour = chosen[tr.dataset.status];
    // A picker cannot show "none": it shows black, greyed, beside the words "no colour".
    tr.querySelector('input').value = colour ?? '#000000';
    tr.classList.toggle('unset', colour == null);
    tr.querySelector('.value').textContent = colour ?? 'no colour';
  };
  for (const tr of rows) {
    show(tr);
    tr.querySelector('input').addEventListener('input', (e) => { chosen[tr.dataset.status] = e.target.value; show(tr); });
    tr.querySelector('button').addEventListener('click', () => { chosen[tr.dataset.status] = null; show(tr); });
  }
  // The first Save on the message strip (UI_DOCTRINE 7, SP-323): its outcome
  // is said in the strip under the header, never beside the button.
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    showMessage({ kind: 'info', text: 'Saving…' });
    try {
      await api('PUT', '/stage-colours', { colours: chosen });
      // Read back before saying it worked.
      const back = await api('GET', '/stage-colours');
      const wrong = back.stages.filter((s) => s.colour !== (chosen[s.status] ?? null));
      if (wrong.length) throw new Error(`the tracker read back different colours for ${wrong.map((s) => s.status).join(', ')}.`);
      showMessage({ kind: 'success', text: 'Saved: the colours are stored on the tracker.' }, { afterSave: true });
    } catch (err) {
      if (err instanceof SignedOut) return drawSignIn('You were signed out; the colours were not saved.');
      showMessage({ kind: 'error', text: `Not saved: ${err.message}` });
    }
    button.disabled = false;
  });
}

/** The Settings page's tabs (SP-289), in menu order; the first opens by default. */
const SETTINGS_TABS = [
  { id: 'pipeline-controls', title: 'Pipeline Controls' },
  { id: 'styles', title: 'Styles' },
];

/** The Settings tab the address names (`#styles`), or the first one. */
function settingsTabAt() {
  const named = location.hash.slice(1);
  return SETTINGS_TABS.some((t) => t.id === named) ? named : SETTINGS_TABS[0].id;
}

/** Show one Settings tab, hide the others, and mark its menu item chosen. */
function showSettingsTab(id) {
  for (const tab of main.querySelectorAll('div.settings-tab')) tab.hidden = tab.dataset.tab !== id;
  for (const a of main.querySelectorAll('nav.settings-tabs a')) {
    if (a.dataset.tab === id) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

/**
 * The Settings page's Pipeline Controls (SP-224): one section per project
 * (renderPipelineControls), each control with its own Save. A Save sends the
 * one control and says "Saved" only when the value the tracker answers, read
 * back from its store, is the one sent; anything else, a refusal included,
 * says plainly that it did not save and why. The section is then drawn again
 * from that answer, so the change log shows the new row.
 */
function drawPipelineControls(box, views) {
  const notes = new Map();
  const draw = () => {
    // A box open before the redraw stays open after it (SP-289).
    const open = new Set([...box.querySelectorAll('details.pipeline-controls[open]')].map((d) => d.dataset.project));
    box.innerHTML = views.map((v) => renderPipelineControls(v, notes.get(v.project.slug) ?? {}, open.has(v.project.slug))).join('');
    for (const section of box.querySelectorAll('details.pipeline-controls')) {
      const slug = section.dataset.project;
      for (const tr of section.querySelectorAll('tr[data-control]')) {
        const button = tr.querySelector('button');
        if (button) button.addEventListener('click', () => save(slug, tr, button));
      }
      for (const button of section.querySelectorAll('button[data-release-action]')) {
        button.addEventListener('click', () => moveRelease(slug, button.dataset.releaseAction, section));
      }
    }
  };
  /**
   * Move to Newest or Roll Back (SP-275): the write, then the project's
   * controls read again, and "Now runs" only when the release read back is
   * the one the tracker says it named. A refusal shows its reason.
   */
  const moveRelease = async (slug, action, section) => {
    const mine = notes.get(slug) ?? {};
    notes.set(slug, mine);
    for (const b of section.querySelectorAll('button[data-release-action]')) b.disabled = true;
    const note = section.querySelector('.release-actions .note');
    if (note) { note.className = 'note quiet'; note.textContent = 'Saving…'; }
    try {
      const answer = await api('POST', `/releases/${encodeURIComponent(slug)}/${action}`, {});
      const to = answer.saved?.to;
      // Read back before saying it worked.
      const back = await api('GET', `/pipeline-controls/${encodeURIComponent(slug)}`);
      const now = back.release?.current?.release ?? null;
      if (!to || now !== to) throw new Error(`the tracker read it back as ${now ?? 'no release'}, not ${to ?? 'the one asked for'}.`);
      mine.release = { ok: true, text: answer.saved.changed ? `Saved: it now runs ${to}.` : `Saved (it already ran ${to}).` };
      views = views.map((v) => (v.project.slug === slug ? back : v));
    } catch (err) {
      if (err instanceof SignedOut) return drawSignIn('You were signed out; the release was not changed.');
      mine.release = { ok: false, text: `Not saved: ${err.message}` };
    }
    draw();
  };
  const save = async (slug, tr, button) => {
    const key = tr.dataset.control;
    const raw = tr.querySelector('input, select').value.trim();
    const numeric = ['seconds', 'count', 'days'].includes(tr.dataset.kind);
    const sent = numeric && /^-?[0-9]+$/.test(raw) ? String(Number(raw)) : raw;
    const mine = notes.get(slug) ?? {};
    notes.set(slug, mine);
    button.disabled = true;
    const note = tr.querySelector('.note');
    note.className = 'note quiet';
    note.textContent = 'Saving…';
    try {
      const answer = await api('PUT', `/pipeline-controls/${encodeURIComponent(slug)}`, { setting: key, value: sent });
      // Read back before saying it worked: the stored value must be the one sent.
      const stored = answer.controls?.find((c) => c.key === key)?.value;
      if (stored !== sent || answer.saved?.to !== sent) throw new Error(`the tracker read it back as ${stored ?? 'nothing'}, not ${sent}.`);
      mine[key] = { ok: true, text: answer.saved.changed ? 'Saved' : 'Saved (it already had that value)' };
      views = views.map((v) => (v.project.slug === slug ? answer : v));
    } catch (err) {
      if (err instanceof SignedOut) return drawSignIn('You were signed out; the setting was not saved.');
      mine[key] = { ok: false, text: `Not saved: ${err.message}` };
    }
    draw();
  };
  draw();
  // While a pause is draining (SP-237), its line is read again every
  // DRAIN_REFRESH_MS, so "Draining" turns to "Paused: nothing in flight" as
  // the last pass finishes. Only the drain lines are redrawn, never a control
  // being edited; it stops once the page is left.
  const timer = setInterval(async () => {
    if (!box.isConnected) return clearInterval(timer);
    if (!box.querySelector('.drain.draining')) return;
    let fresh;
    try {
      ({ projects: fresh = [] } = await api('GET', '/pipeline-controls'));
    } catch {
      return; // the next tick tries again; the line already shown stays
    }
    for (const v of fresh) {
      const slot = [...box.querySelectorAll('details.pipeline-controls')].find((s) => s.dataset.project === v.project.slug)?.querySelector('.drain-box');
      if (slot) slot.innerHTML = drainLine(v);
    }
  }, DRAIN_REFRESH_MS);
}

/** How often a draining pause's line is read again on the Settings page. */
const DRAIN_REFRESH_MS = 15_000;
