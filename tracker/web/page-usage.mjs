/**
 * The API Usage report (/reporting/usage, SP-398): what each action that used
 * the Claude plan's quota spent, per model, with its ticket. A loop pass adds
 * its rows when it ends (`npm run clickup -- usage-record`); here a person
 * adds one by hand, edits one or deletes one.
 *
 * Part of Dane's page: app.mjs is the entry the page loads and imports this
 * file. Its own file (SP-352), so a ticket that changes it never edits the
 * same file as one that changes another page.
 */
import {
  renderUsage, renderUsageHeadings, renderUsageBody, renderUsageEditRow, usageDeleteQuestion, usageCountLine,
  filterUsage, sortUsage, readUsageForm, nextSort,
} from './render.mjs';
import { api, setTitle, putTrail, main, savedProject, SignedOut, when, drawAgain, drawSignIn, showError, showMessage, PROJECT_KEY, PROJECT_NAME_KEY, showProject } from './app.mjs';

/**
 * Draw the report for the project picked here (or on another page, else the
 * first). After a write the rows are read again, and the strip says it
 * worked only when the read-back shows it: the new row listed, the changed
 * row holding what was sent, the deleted row gone. `said` is that message,
 * shown once the page is drawn again.
 */
export async function drawUsage(said = null) {
  const { projects } = await api('GET', '/projects');
  setTitle('API Usage · Tracker');
  if (!projects.length) {
    main.innerHTML = '<h1>API Usage</h1><p class="quiet">There are no projects yet.</p>';
    putTrail([{ label: 'Reporting', href: '/reporting' }, { label: 'API Usage' }]);
    return;
  }
  const project = projects.find((p) => p.slug === savedProject()) ?? projects[0];
  const path = `/projects/${encodeURIComponent(project.slug)}/usage`;
  const usage = await api('GET', path);
  main.innerHTML = renderUsage({ projects, project, usage }, { timeOf: when });
  putTrail([{ label: 'Reporting', href: '/reporting' }, { label: 'API Usage' }]);
  if (said) showMessage(said, { afterSave: Boolean(said.afterSave) });
  const again = (message) => drawAgain(() => drawUsage(message)).catch((err) => (err instanceof SignedOut ? drawSignIn() : showError(err)));
  const fail = (text) => showMessage({ kind: 'error', text });
  const readBack = () => api('GET', path, undefined, { unrecorded: true }).catch((err) => { if (err instanceof SignedOut) throw err; return null; });

  main.querySelector('.project-picker select').addEventListener('change', (e) => {
    const chosen = projects.find((p) => p.slug === e.target.value);
    if (!chosen) return;
    try {
      localStorage.setItem(PROJECT_KEY, chosen.slug);
      localStorage.setItem(PROJECT_NAME_KEY, chosen.name);
    } catch { /* the page still works; it is only not remembered */ }
    showProject();
    again(null);
  });

  // Add Usage opens the form under the title; Cancel closes it.
  const opener = main.querySelector('button.add-usage');
  const section = main.querySelector('#add-usage');
  const open = (on) => { section.hidden = !on; opener.setAttribute('aria-expanded', String(on)); if (on) section.querySelector('input[name="action"]').focus(); };
  opener.addEventListener('click', () => open(section.hidden));
  section.querySelector('.cancel-add').addEventListener('click', () => open(false));
  const form = section.querySelector('form.create-usage');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const { body, problem } = readUsageForm((name) => form.elements[name]?.value);
    if (problem) return fail(problem);
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    showMessage({ kind: 'info', text: 'Saving…' });
    let made;
    try {
      made = await api('POST', path, body);
    } catch (err) {
      if (err instanceof SignedOut) return drawSignIn('You were signed out; the row was not saved.');
      button.disabled = false;
      return fail(`Not saved: ${err.message}`);
    }
    let back;
    try { back = await readBack(); } catch { return drawSignIn(); }
    const listed = back?.rows?.some((r) => r.id === made.id);
    again(listed
      ? { kind: 'success', text: `Saved: ${made.action}, ${made.model}, on the report.`, afterSave: true }
      : { kind: 'error', text: `The tracker said the row was saved, but ${back ? 'it is not on the report when read back' : 'the report could not be read back'}.` });
  });

  wireRows(usage?.rows ?? [], path, { again, fail, readBack });
}

/**
 * The table's Model picker, Find box and sorting headings, redrawn in place
 * from the rows already read; and each row's Edit and Delete. Edit draws the
 * row as its fields (refused on the page, before anything is sent, as Add
 * Usage is); Cancel draws the page again. Delete asks first, naming what the
 * row spent.
 */
function wireRows(rows, path, { again, fail, readBack }) {
  const table = main.querySelector('table.usage-list');
  if (!table) return;
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  const model = main.querySelector('#usage-model-filter');
  const search = main.querySelector('#usage-search');
  const count = main.querySelector('.usage-count');
  let sort = null;
  const show = () => {
    const shown = sortUsage(filterUsage(rows, { model: model.value, text: search.value }), sort);
    table.tBodies[0].innerHTML = renderUsageBody(shown, { timeOf: when });
    count.textContent = usageCountLine(shown.length, rows.length);
  };
  model.addEventListener('change', show);
  search.addEventListener('input', show);
  table.tHead.addEventListener('click', (e) => {
    const button = e.target.closest('button[data-sort]');
    if (!button) return;
    sort = nextSort(sort, button.dataset.sort);
    table.tHead.innerHTML = renderUsageHeadings(sort);
    show();
    table.tHead.querySelector(`button[data-sort="${sort.column}"]`).focus();
  });
  const rowPath = (r) => `${path}/${encodeURIComponent(r.id)}`;

  // The body is redrawn by the filters, so its buttons are found on each click.
  table.tBodies[0].addEventListener('click', async (e) => {
    const edit = e.target.closest('button[data-edit-usage]');
    const remove = e.target.closest('button[data-delete-usage]');
    if (edit) {
      const r = byId.get(edit.dataset.editUsage);
      const tr = edit.closest('tr');
      if (!r || !tr) return;
      tr.innerHTML = renderUsageEditRow(r);
      const form = tr.querySelector('form.edit-usage');
      form.querySelector('input[name="action"]').focus();
      form.querySelector('.cancel-edit').addEventListener('click', () => again(null));
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const { body, problem } = readUsageForm((name) => form.elements[name]?.value);
        if (problem) return fail(problem);
        for (const control of form.querySelectorAll('button')) control.disabled = true;
        showMessage({ kind: 'info', text: 'Saving…' });
        try {
          await api('PATCH', rowPath(r), body);
        } catch (err) {
          if (err instanceof SignedOut) return drawSignIn('You were signed out; the row was not saved.');
          for (const control of form.querySelectorAll('button')) control.disabled = false;
          return fail(`Not saved: ${err.message}`);
        }
        let back;
        try { back = await readBack(); } catch { return drawSignIn(); }
        const found = back?.rows?.find((x) => x.id === r.id);
        const ok = Boolean(found) && Object.entries(body).every(([k, v]) => found[k] === v);
        again(ok
          ? { kind: 'success', text: `Saved: ${found.action}, ${found.model}.`, afterSave: true }
          : { kind: 'error', text: `The tracker said the row was saved, but ${back ? 'it does not read back as sent' : 'the report could not be read back'}.` });
      });
      return;
    }
    if (remove) {
      const r = byId.get(remove.dataset.deleteUsage);
      if (!r || !confirm(usageDeleteQuestion(r))) return;
      remove.disabled = true;
      showMessage({ kind: 'info', text: 'Deleting…' });
      try {
        await api('DELETE', rowPath(r));
      } catch (err) {
        if (err instanceof SignedOut) return drawSignIn('You were signed out; the row was not deleted.');
        remove.disabled = false;
        return fail(`Not deleted: ${err.message}`);
      }
      let back;
      try { back = await readBack(); } catch { return drawSignIn(); }
      const gone = back && !back.rows?.some((x) => x.id === r.id);
      again(gone
        ? { kind: 'success', text: `Deleted: ${r.action}, ${r.model}.` }
        : { kind: 'error', text: `The tracker said the row was deleted, but ${back ? 'it is still on the report when read back' : 'the report could not be read back'}.` });
    }
  });
}
