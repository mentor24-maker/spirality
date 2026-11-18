/**
 * The Docs page (/docs): a project's files and context documents, the commands list, and the substrate's own documentation pages (/docs/spirality/<path>).
 *
 * Part of Dane's page: app.mjs is the entry the page loads, holds what
 * every page shares (signing in, the API call, the header, routing and the
 * message strip) and imports this file. Moved out of app.mjs unchanged
 * (Spirality SP-352), so a ticket that changes one page no longer edits the
 * same file as a ticket that changes another.
 */
import { escapeHtml, renderMarkdown, unwrapDoc, renderCommandList, renderCommandView, renderCommandDetails, renderArrowDetails, LOOP_QUEUE_ARROWS, renderContextDocs, renderLoopQueueDiagram, renderLoopQueueAnatomy, LOOP_QUEUE_DIAGRAM, nextSort, renderDocumentation, docRows, sortDocs, filterDocs, renderDocHeadings, renderDocBody, docCountLine } from './render.mjs';
import { api, setTitle, main, putTrail, savedProject, sizeOf, when, drawAgain, SignedOut, drawSignIn, showError, MAX_FILE, uploadFile, Refused } from './app.mjs';

/**
 * The Docs page (SP-171): the selected project's Context
 * Documents (SP-176, files kept on the project itself, uploaded, downloaded
 * and removed here); then every file on its tasks in one Task Files table,
 * newest first. The project is the one picked on the Projects page (shown
 * in the header), else the first. A task file's name downloads it through
 * the task's own download address; the task links to its page. SP-177 makes
 * the Task Files table changeable: Add File puts a file on one of the
 * project's tasks (the same upload the New Task form uses), Rename changes a
 * file's name only, and Remove, once confirmed by name and task, deletes it.
 * Each is read back from the table's own list before the page says it
 * worked. `done` and `problem` are the line the last change left, and
 * `section` says whose it is: 'docs' (Context Documents) or 'files' (Task
 * Files), so it shows in that section only. The Quick Claude Commands pod
 * (SP-179, SP-212) sits down the left third: every slash command,
 * searchable, each opening a pop-up. Last on the right, folded away, Reference Docs and Work Log (SP-175, SP-195): every
 * Markdown file in the repository's docs/ folder, each opening at
 * /docs/spirality/<path>, sortable and filtered on the page.
 */
export async function drawDocs(done = '', problem = '', section = 'files') {
  // The documentation call is caught on its own: a tracker not yet restarted onto it answers 404, and Task Files still draws.
  const [{ projects }, files, commands] = await Promise.all([
    api('GET', '/projects'),
    api('GET', '/documentation').then((r) => r.files, () => null),
    // The same for the Commands list (SP-179).
    api('GET', '/commands').then((r) => r.commands, () => null),
  ]);
  setTitle('Docs · Tracker');
  // SP-361: `/docs#loop-queue-diagram` (the anatomy page's boxes) opens with the diagram in view; a redraw after a change stays put.
  const firstDraw = !done && !problem;
  const documentation = renderDocumentation(files, docAddress);
  if (!projects.length) {
    main.innerHTML = `<h1>Docs</h1>${docsColumns(`<h2>Task Files</h2><p class="quiet">There are no projects yet.</p>${documentation}`)}`;
    showCommands(commands);
    wireDocumentation(files);
    wireDiagramArrows();
    putTrail([{ label: 'Docs' }]);
    if (firstDraw) scrollToNamed();
    return;
  }
  const project = projects.find((p) => p.slug === savedProject()) ?? projects[0];
  const listPath = `/projects/${encodeURIComponent(project.slug)}/attachments`;
  const docsPath = `/projects/${encodeURIComponent(project.slug)}/docs`;
  const [{ attachments }, { docs }, { tickets }] = await Promise.all([
    api('GET', listPath),
    api('GET', docsPath),
    api('GET', `/projects/${encodeURIComponent(project.slug)}/tickets`),
  ]);
  const fileLine = section === 'files' ? { done, problem } : { done: '', problem: '' };
  const row = (a) => {
    const href = `/tickets/${encodeURIComponent(a.ticket)}/attachments/${encodeURIComponent(a.id)}`;
    const data = `data-ticket="${escapeHtml(a.ticket)}" data-file="${escapeHtml(a.id)}" data-name="${escapeHtml(a.name)}" data-task-name="${escapeHtml(a.ticketName)}"`;
    return `<tr data-file="${escapeHtml(a.id)}">
      <td class="name"><a href="${href}" download="${escapeHtml(a.name)}">${escapeHtml(a.name)}</a></td>
      <td class="task"><a href="/t/${encodeURIComponent(a.ticket)}">${escapeHtml(a.ticket)}</a> ${escapeHtml(a.ticketName)}</td>
      <td class="type">${escapeHtml(a.type)}</td>
      <td class="size">${escapeHtml(sizeOf(a.size))}</td>
      <td class="by">${a.addedByName ? escapeHtml(a.addedByName) : '<span class="quiet">unknown</span>'}</td>
      <td class="when">${escapeHtml(when(a.createdAt))}</td>
      <td class="actions"><button type="button" class="btn btn-sm rename-file" ${data} aria-label="Rename ${escapeHtml(a.name)}">Rename</button>
        <button type="button" class="btn btn-danger btn-sm remove-file" ${data} aria-label="Remove ${escapeHtml(a.name)} from ${escapeHtml(a.ticket)}">Remove</button></td></tr>`;
  };
  main.innerHTML = `
    <h1>Docs</h1>
    ${docsColumns(`
    ${renderContextDocs({ project, docs }, { size: sizeOf, timeOf: when })}
    <h2>Task Files</h2>
    <p class="quiet">Files kept on the tasks of ${escapeHtml(project.name)}. Pick another project on the <a href="/projects">Projects</a> page.</p>
    <p class="note file-note${fileLine.problem ? ' error' : ' quiet'}" role="status">${escapeHtml(fileLine.problem || fileLine.done)}</p>
    ${tickets.length ? `<form class="add-file fields">
      <div class="beside"><label for="add-file-task">Task</label>
      <select id="add-file-task" required><option value="">Pick a task…</option>${tickets.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.id)} ${escapeHtml(t.name)}</option>`).join('')}</select></div>
      <div class="beside"><label for="add-file-file">File</label>
      <input id="add-file-file" type="file" required aria-describedby="add-file-hint">
      <span class="hint" id="add-file-hint">Up to 10 MB. It shows here and on the task's own page.</span></div>
      <div class="row"><button type="submit" class="btn btn-primary">Add File</button></div>
    </form>` : ''}
    ${attachments.length
    ? `<div class="table-wrap"><table class="projects task-files"><thead><tr><th>File</th><th>Task</th><th>Type</th><th>Size</th><th>Added By</th><th>Added On</th><th><span class="hidden">Actions</span></th></tr></thead>
      <tbody>${attachments.map(row).join('')}</tbody></table></div>`
    : `<p class="quiet">No task in ${escapeHtml(project.name)} has a file yet.</p>`}
    ${documentation}`)}`;
  const note = main.querySelector('.file-note');
  const busy = (text) => { note.className = 'note file-note quiet'; note.textContent = text; };
  const refused = (control, text) => { note.className = 'note file-note error'; note.textContent = text; if (control) control.disabled = false; };
  const again = (text, failed) => drawAgain(() => drawDocs(failed ? '' : text, failed ? text : '', 'files'))
    .catch((err) => (err instanceof SignedOut ? drawSignIn() : showError(err)));
  // The table's own list, read again: what each change is checked against.
  const listedNow = async () => (await api('GET', listPath, undefined, { unrecorded: true })).attachments;
  const form = main.querySelector('form.add-file');
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const ticket = form.querySelector('#add-file-task').value;
    const file = form.querySelector('#add-file-file').files?.[0];
    const button = form.querySelector('button');
    if (!ticket || !file) return refused(null, 'Pick a task and a file first; nothing was added.');
    if (file.size > MAX_FILE) return refused(null, `${file.name} is over 10 MB. Add a smaller one; nothing was added.`);
    button.disabled = true;
    busy(`Adding ${file.name} to ${ticket}…`);
    let made;
    try {
      made = await uploadFile(ticket, file);
    } catch (err) {
      if (err instanceof SignedOut) return drawSignIn(`You were signed out; ${file.name} was not added.`);
      return refused(button, `Not added: ${err.message}`);
    }
    const back = await listedNow().catch(() => null);
    const listed = back?.some((a) => a.id === made.id && a.ticket === ticket);
    again(listed ? `Added ${made.name} to ${ticket}.` : `The tracker said ${made.name} was added to ${ticket}, but it is not in the table when read back.`, !listed);
  });
  for (const button of main.querySelectorAll('button.rename-file')) {
    button.addEventListener('click', async () => {
      const { ticket, file, name } = button.dataset;
      const typed = prompt(`New name for ${name} (on ${ticket}):`, name);
      if (typed == null) return;
      if (!typed.trim()) return refused(null, `Not renamed: a file needs a name. ${name} is unchanged.`);
      button.disabled = true;
      busy(`Renaming ${name}…`);
      let renamed;
      try {
        renamed = await api('PATCH', `/tickets/${encodeURIComponent(ticket)}/attachments/${encodeURIComponent(file)}`, { name: typed });
      } catch (err) {
        if (err instanceof SignedOut) return drawSignIn(`You were signed out; ${name} was not renamed.`);
        return refused(button, `Not renamed: ${err.message}`);
      }
      const back = await listedNow().catch(() => null);
      const now = back?.find((a) => String(a.id) === file)?.name;
      if (!renamed.changed && now === name) return again(`${name} already has that name; nothing changed.`, false);
      again(now === renamed.name ? `Renamed ${name} to ${now}.` : `The tracker said ${name} was renamed to ${renamed.name}, but it reads back as ${now ?? 'missing'}.`, now !== renamed.name);
    });
  }
  for (const button of main.querySelectorAll('button.remove-file')) {
    button.addEventListener('click', async () => {
      const { ticket, file, name, taskName } = button.dataset;
      if (!confirm(`Remove ${name} from ${ticket} ${taskName}? This cannot be undone from the page.`)) return;
      button.disabled = true;
      busy(`Removing ${name} from ${ticket}…`);
      try {
        await api('DELETE', `/tickets/${encodeURIComponent(ticket)}/attachments/${encodeURIComponent(file)}`);
      } catch (err) {
        if (err instanceof SignedOut) return drawSignIn(`You were signed out; ${name} was not removed.`);
        return refused(button, `Not removed: ${err.message}`);
      }
      const back = await listedNow().catch(() => null);
      const gone = back != null && !back.some((a) => String(a.id) === file);
      again(gone ? `Removed ${name} from ${ticket}.` : `The tracker said ${name} was removed from ${ticket}, but it is still listed when read back.`, !gone);
    });
  }
  wireContextDocs(project, docsPath, section === 'docs' ? done : '', section === 'docs' ? problem : '');
  showCommands(commands);
  wireDocumentation(files);
  wireDiagramArrows();
  putTrail([{ label: 'Docs' }]);
  if (firstDraw) scrollToNamed();
}

/**
 * The Docs page in two columns (SP-212): the Quick Claude Commands pod down
 * the left third, `rest` (Context Documents, Task Files, Reference Docs and
 * Work Log) on the right, under the Loop Queue diagram whose boxes open the
 * anatomy page (SP-337). A narrow screen stacks the pod above the rest
 * (app.css).
 */
const docsColumns = (rest) => `<div class="docs-columns">${commandsSection()}<div class="docs-main">${renderLoopQueueDiagram(docAddress)}${rest}</div></div>`;

/**
 * The Quick Claude Commands pod (SP-179, SP-212): a search box over every
 * slash command (GET /commands), each a name and a few words that open its
 * pop-up. Typing filters the list by name, summary or explanation as it is
 * typed; nothing is read again.
 */
function commandsSection() {
  return `<section class="commands-pod" aria-labelledby="commands-pod-title">
    <h2 id="commands-pod-title">Quick Claude Commands</h2>
    <p class="quiet">Every slash command you can give a session: your own and the loop skills. Click one to see what it does.</p>
    <label for="command-search">Find a Command</label>
    <input type="search" id="command-search" placeholder="loop-build" autocomplete="off">
    <div id="command-list"></div>
    <dialog class="command-details" aria-labelledby="command-details-title">
      <form method="dialog">
        <button type="submit" class="close" aria-label="Close">×</button>
        <div class="command-details-body"></div>
        <div class="row"><button type="submit" class="btn">Close</button></div>
      </form>
    </dialog>
  </section>`;
}

/**
 * Fill the Quick Claude Commands list and keep it filtered as the search box
 * is typed in; null (the list could not be read) says so. A click on a
 * command opens its pop-up (SP-212); Escape or Close shuts it, and focus
 * goes back to the command clicked. A click with Ctrl, Cmd or Shift held
 * still follows the link to its steps page.
 */
function showCommands(commands) {
  const box = document.getElementById('command-search');
  const list = document.getElementById('command-list');
  if (!commands) {
    box.hidden = true;
    list.innerHTML = '<p class="quiet">The commands could not be read.</p>';
    return;
  }
  const show = () => { list.innerHTML = renderCommandList(commands, box.value); };
  box.addEventListener('input', show);
  show();
  const dialog = main.querySelector('dialog.command-details');
  let opener = null;
  list.addEventListener('click', (e) => {
    const link = e.target.closest('a.command-open');
    if (!link || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    const command = commands.find((c) => c.name === link.dataset.command);
    if (!command) return;
    // Not on to the page's own link handler, which would open the steps page instead.
    e.preventDefault();
    e.stopPropagation();
    opener = link;
    dialog.querySelector('.command-details-body').innerHTML = renderCommandDetails(command);
    dialog.showModal();
  });
  dialog.addEventListener('close', () => opener?.focus());
}

/**
 * The Loop Queue diagram's arrows and notes (SP-391): a click on one, or
 * Enter or Space on it once the keyboard reaches it, opens its pop-up, the
 * same shape as a command's. Escape or Close shuts it, and focus goes back
 * to the arrow it came from.
 */
function wireDiagramArrows() {
  const svg = main.querySelector('svg.loop-diagram-links');
  const dialog = main.querySelector('dialog.arrow-details');
  if (!svg || !dialog) return;
  let opener = null;
  const open = (target) => {
    const arrow = LOOP_QUEUE_ARROWS.find((a) => a.id === target.dataset.arrow);
    if (!arrow) return;
    opener = target;
    dialog.querySelector('.arrow-details-body').innerHTML = renderArrowDetails(arrow);
    dialog.showModal();
  };
  svg.addEventListener('click', (e) => {
    const target = e.target.closest('g.diagram-arrow');
    if (target) open(target);
  });
  svg.addEventListener('keydown', (e) => {
    const target = e.target.closest('g.diagram-arrow');
    if (!target || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    open(target);
  });
  dialog.addEventListener('close', () => opener?.focus());
}

/**
 * The Reference Docs and Work Log section's controls (SP-195): the Kind
 * drop-down and the search box narrow the rows together as they change, and
 * a click on Title, Kind or Date sorts by it, the other way on a second
 * click. Only the table body and the count line are drawn again; nothing is
 * read again, and no choice is kept between visits. null (the list could
 * not be read) or an empty list has no controls.
 */
function wireDocumentation(files) {
  const table = main.querySelector('table.spirality-docs');
  if (!files?.length || !table) return;
  const rows = docRows(files);
  const kind = main.querySelector('#doc-kind');
  const search = main.querySelector('#doc-search');
  const count = main.querySelector('.doc-count');
  let sort = null;
  const show = () => {
    const shown = sortDocs(filterDocs(rows, { kind: kind.value, text: search.value }), sort);
    table.tBodies[0].innerHTML = renderDocBody(shown, docAddress);
    table.hidden = !shown.length;
    count.textContent = docCountLine(shown.length, rows.length);
  };
  kind.addEventListener('change', show);
  search.addEventListener('input', show);
  table.tHead.addEventListener('click', (e) => {
    const button = e.target.closest('button[data-sort]');
    if (!button) return;
    sort = nextSort(sort, button.dataset.sort);
    table.tHead.innerHTML = renderDocHeadings(sort);
    show();
    table.tHead.querySelector(`button[data-sort="${sort.column}"]`).focus();
  });
}

/** The command a `/docs/commands/<name>` address opens, or null. */
export const commandAt = () => {
  const m = /^\/docs\/commands\/([^/]+)$/.exec(location.pathname);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return null; }
};

/**
 * One command's own page, `/docs/commands/<name>`: its steps drawn as
 * formatted text (hard-wrapped lines joined back up first, as a
 * documentation file's are), and a way back.
 */
export async function drawCommand(name) {
  const { commands } = await api('GET', '/commands');
  const command = commands.find((c) => c.name === name);
  setTitle(command ? `/${name} · Docs · Tracker` : 'Docs · Tracker');
  main.innerHTML = command
    ? renderCommandView({ ...command, steps: unwrapDoc(command.steps) })
    : `<h1>No Such Command</h1><p class="quiet">There is no command named /${escapeHtml(name)}.</p><p><a href="/docs">Back to Docs</a></p>`;
  putTrail([{ label: 'Docs', href: '/docs' }, { label: command ? `/${command.name}` : 'Not Found' }]);
}

/**
 * The Context Documents section's buttons (SP-176). Upload Document opens
 * the file picker and sends the one file picked (one over 10 MB is refused
 * here before it is sent); the server reads it back before it answers, and
 * the list is read again. Remove asks first, naming the file, then reads
 * the list back to check it is gone. A failure says so in the note and
 * changes nothing on the page.
 */
function wireContextDocs(project, docsPath, done, problem) {
  const note = main.querySelector('.doc-note');
  if (problem || done) {
    note.className = `note doc-note ${problem ? 'error' : 'quiet'}`;
    note.textContent = problem || done;
  }
  const say = (text, failed = false) => {
    note.className = `note doc-note ${failed ? 'error' : 'quiet'}`;
    note.textContent = text;
  };
  const again = (text, failed) => drawDocs(failed ? '' : text, failed ? text : '', 'docs')
    .catch((err) => (err instanceof SignedOut ? drawSignIn() : showError(err)));
  const picker = main.querySelector('input.doc-file');
  const upload = main.querySelector('button.upload-doc');
  upload.addEventListener('click', () => picker.click());
  picker.addEventListener('change', async () => {
    const file = picker.files?.[0];
    picker.value = '';
    if (!file) return;
    if (file.size > MAX_FILE) return say(`Not uploaded: ${file.name} is over 10 MB. Upload a smaller file; nothing was saved.`, true);
    upload.disabled = true;
    say(`Uploading ${file.name}…`);
    try {
      await uploadFile(null, file, docsPath);
    } catch (err) {
      if (err instanceof SignedOut) return drawSignIn(`You were signed out; ${file.name} was not uploaded.`);
      upload.disabled = false;
      return say(`Not uploaded: ${err.message}`, true);
    }
    again(`Uploaded ${file.name} to ${project.name}.`, false);
  });
  for (const button of main.querySelectorAll('button[data-remove-doc]')) {
    button.addEventListener('click', async () => {
      const { removeDoc: id, name } = button.dataset;
      if (!confirm(`Remove ${name} from ${project.name}? It cannot be brought back.`)) return;
      button.disabled = true;
      say(`Removing ${name}…`);
      try {
        await api('DELETE', `${docsPath}/${encodeURIComponent(id)}`);
      } catch (err) {
        if (err instanceof SignedOut) return drawSignIn(`You were signed out; ${name} was not removed.`);
        button.disabled = false;
        return say(`Not removed: ${err.message}`, true);
      }
      const back = await api('GET', docsPath).catch(() => null);
      const gone = back != null && !back.docs.some((d) => String(d.id) === String(id));
      again(gone ? `Removed ${name} from ${project.name}.` : `The tracker said ${name} was removed, but ${back ? 'it is still listed when read back' : 'the list could not be read back'}.`, !gone);
    });
  }
}

/** The page address of a documentation file, `path` relative to docs/: each piece encoded. */
const docAddress = (path) => `/docs/spirality/${String(path).split('/').map(encodeURIComponent).join('/')}`;
/** Whether the address is a page under the Docs page, `/docs/<name>/<path>`: Spirality's own files or not. */
export const underDocs = () => /^\/docs\/[^/]+\/.+$/.test(location.pathname);
/** The documentation file a `/docs/spirality/<path>` address opens, or null. */
export const docAt = () => {
  const m = /^\/docs\/spirality\/(.+)$/.exec(location.pathname);
  if (!m) return null;
  try { return m[1].split('/').map(decodeURIComponent).join('/'); } catch { return null; }
};

/**
 * One of Spirality's documentation files (SP-175), drawn with the same
 * Markdown drawing as a ticket's description, its hard-wrapped lines joined
 * back up first (unwrapDoc). Its first "# " heading is the page's own
 * heading, so it is not drawn twice. Read only.
 */
export async function drawDoc(path) {
  setTitle('Docs · Tracker');
  const back = '<p><a href="/docs">Back to Docs</a></p>';
  const missing = (where) => {
    main.innerHTML = `<h1>Docs</h1><p>There is no documentation file at <code>${escapeHtml(where)}</code>.</p>${back}`;
    putTrail([{ label: 'Docs', href: '/docs' }, { label: 'Not Found' }]);
  };
  // Any /docs/<name>/... the page does not know (another project's name, a typo): the same message, never a different page.
  if (!path) return missing(location.pathname);
  let doc;
  try {
    doc = await api('GET', `/documentation/${String(path).split('/').map(encodeURIComponent).join('/')}`);
  } catch (err) {
    if (!(err instanceof Refused) || err.status !== 404) throw err;
    return missing(`docs/${path}`);
  }
  setTitle(`${doc.title} · Docs · Tracker`);
  const body = doc.text.replace(/^(?:[ \t]*\n)*#[ \t]+.*\n?/, '');
  // SP-361: the Loop Queue Anatomy page is a table of the diagram's boxes beside their copy; every other file is drawn as written.
  const drawn = doc.path === LOOP_QUEUE_DIAGRAM.page ? renderLoopQueueAnatomy(body) : renderMarkdown(unwrapDoc(body), { headingIds: true });
  main.innerHTML = `
    ${back}
    <h1>${escapeHtml(doc.title)}</h1>
    <p class="quiet"><code>docs/${escapeHtml(doc.path)}</code></p>
    <section class="description doc">${drawn || '<p class="quiet">This file is empty.</p>'}</section>
    ${back}`;
  putTrail([{ label: 'Docs', href: '/docs' }, { label: doc.title }]);
  // SP-331: the page is drawn after it loads, so the browser cannot jump to `#rework` itself; scroll to the heading the address names.
  scrollToNamed();
}

/** Scroll to the id the address names (`#rework`, `#loop-queue-diagram`): a page drawn after it loads cannot jump there itself (SP-331, SP-361). */
function scrollToNamed() {
  const named = location.hash.slice(1);
  if (named) document.getElementById(named)?.scrollIntoView({ block: 'start' });
}
