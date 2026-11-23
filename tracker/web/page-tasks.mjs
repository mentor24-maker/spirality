/**
 * The Tasks page (/tasks): a project's queue as a board or a list, its sortable headings and list pickers, the Search field and results (/search), and the copy buttons other pages share.
 *
 * Part of Dane's page: app.mjs is the entry the page loads, holds what
 * every page shares (signing in, the API call, the header, routing and the
 * message strip) and imports this file. Moved out of app.mjs unchanged
 * (Spirality SP-352), so a ticket that changes one page no longer edits the
 * same file as a ticket that changes another.
 */
import { canDelete, deleteQuestion, deleteRefusal, escapeHtml, MOVED_MESSAGE, ANSWER_IN_NOTE, MERGE_STANDS_NOTE, renderProjectPicker, renderTopicPicker, stageLooks, renderSearchFilters, renderSearchResults, lookupTicket, renderSortHeadings, renderListPriority, renderListAssignee, renderListTags, renderListTopics, projectTags, renderClassFilters, filterByClass, sortTickets, nextSort } from './render.mjs';
import { api, setTitle, main, putTrail, savedProject, VIEW_KEY, PROJECT_KEY, PROJECT_NAME_KEY, showProject, statusIcon, action, ICONS, actionButton, statusName, when, viewSwitch, SignedOut, drawSignIn, showError, wirePipeline, refreshPipeline, route, drawAgain, Refused } from './app.mjs';
import { field } from './page-projects.mjs';
import { drawConsole } from './page-console.mjs';
import { savedSuggestSwitch, filedPod, UNCHECKED_NOTE, notUploadedNote, wireAddTask, wireSuggestNext, wireSuggestSwitch, wireFiledPod } from './page-add-task.mjs';

/**
 * SP-402: what the saved project holds when All Projects was picked last:
 * never a slug (a slug is letters, digits and dashes), so the two cannot be
 * mistaken. All Projects' own address is `/board` or `/list` with no project.
 */
export const ALL_PROJECTS = '*';
/** The Project picker's first choice, every project at once. */
const ALL_PROJECTS_LABEL = 'All Projects';

/**
 * "Tasks" in the header: the selected project, or All Projects when that
 * was picked last, in the view last used. With none selected, or one that
 * no longer exists, the first project.
 */
export async function drawTasks(view, opts = {}) {
  if (view === 'console') {
    history.replaceState(null, '', '/console');
    return drawConsole();
  }
  const { projects } = await api('GET', '/projects');
  if (!projects.length) {
    setTitle('Tasks · Tracker');
    main.innerHTML = '<h1>Tasks</h1><p class="quiet">There are no projects yet.</p>';
    putTrail([{ label: 'Tasks' }]);
    return;
  }
  if (savedProject() === ALL_PROJECTS) {
    history.replaceState(null, '', `/${view}`);
    return drawProject(null, view, opts);
  }
  const slug = projects.some((p) => p.slug === savedProject()) ? savedProject() : projects[0].slug;
  history.replaceState(null, '', `/${view}/${encodeURIComponent(slug)}`);
  await drawProject(slug, view, opts);
}

/**
 * SP-174: a click on a stage's table heading sorts that stage's rows by that
 * column, ascending first, the other way on a second click; each stage
 * sorts on its own. The rows already drawn are moved, not redrawn, so their
 * buttons keep working. `stages` are the drawn stages, each with its tickets
 * in the order the page drew them (the order a sort's ties keep). The sort
 * each table shows (null before any click) is kept in `sorted`, so the
 * minute's redraw puts it back (keepPlace); a reload or a fresh visit
 * shows the usual order.
 */
export const sorted = new WeakMap();
/** Each sortable table on the page, with its stage: what keepPlace reads and restores. */
export const sortableTables = () => [...main.querySelectorAll('[data-stage] table.sortable')]
  .map((table) => ({ table, stage: table.closest('[data-stage]').dataset.stage }));
function wireSortHeadings(stages) {
  const ticketsOf = new Map(stages.map((c) => [c.status, c.tickets]));
  for (const { table, stage } of sortableTables()) {
    const tickets = ticketsOf.get(stage);
    if (!tickets) continue;
    const apply = (sort) => {
      table.tHead.innerHTML = renderSortHeadings(sort);
      const rows = new Map([...table.tBodies[0].rows].map((tr) => [tr.dataset.id, tr]));
      for (const t of sortTickets(tickets, sort)) {
        const tr = rows.get(t.id);
        if (tr) table.tBodies[0].append(tr);
      }
      sorted.set(table, { sort, apply });
    };
    sorted.set(table, { sort: null, apply });
    table.tHead.addEventListener('click', (e) => {
      const button = e.target.closest('button[data-sort]');
      if (!button) return;
      const sort = nextSort(sorted.get(table)?.sort ?? null, button.dataset.sort);
      apply(sort);
      table.tHead.querySelector(`button[data-sort="${sort.column}"]`).focus();
    });
  }
}

/**
 * One project, as a board or as a list. Both draw the same object, the
 * server's board (pageData.mjs boardOf): the eight statuses in the
 * contract's order, each holding its tickets in `queue` order, so the two
 * views cannot disagree about what is where. Read-only: moves stay with the
 * door and the loops. Every stage folds by a click on its heading, or Enter
 * or Space on it (SP-196); `Live` starts folded in both, its count showing,
 * because it only grows, and every other stage starts open.
 *
 * The board is the working statuses as columns of cards, with Live under
 * them as a list section, newest change first (SP-165); the list is the same
 * statuses as groups of rows, with a ticket's priority, tags, assignee and
 * last change in their own columns, like ClickUp's List, and an Actions
 * column of icons. Each icon goes somewhere that already exists: the ticket,
 * the ticket's reply box, the ticket's pull request on GitHub. The one
 * exception is the bin, on a ticket nobody has started: it asks, then deletes.
 *
 * Each status wears the colour chosen for it on the Settings page: its
 * border, a light tint behind its heading, its heading text. The colours go
 * on as properties after drawing, never as markup (the page allows no inline
 * style), and a stage with none, or colours that cannot be read, looks as
 * it always did.
 *
 * Above the stages sits the Add Task box (wireAddTask), closed unless
 * `adding` asks for it open or a kept draft has text in it. `filed` is the
 * id of the ticket the box just filed, named after the redraw in a pod
 * that fades (filedPod); `unchecked` and `notUploaded` are warnings, kept
 * as a lasting line under the toolbar. The question box
 * (the Add Task box's "Did you mean ...?") is drawn here, closed.
 *
 * In the List view each row's priority (SP-208) and assignee (SP-244) is a
 * dropdown that saves on change, and its tags (SP-246) gain a × each and an
 * Add Tag dropdown, and its topics (SP-247) the same with Add Topic
 * (wireListPickers); `said` is
 * `{ id, field, text, error }`, the note that save leaves beside that
 * ticket's dropdown after the redraw.
 */
/**
 * SP-345: the Tasks page's Kind, Started By and How It Ended filters, key ->
 * value ('' for Any). Kept here so the minute's redraw and a save keep them,
 * across projects and both views; a reload clears them.
 */
const pickedClass = {};

/**
 * SP-402: with no `slug`, All Projects: the server's every-project board
 * (pageData.mjs everyProjectBoardOf), drawn the same way. Each card and row
 * names its project, and each List row's dropdowns offer that row's own
 * project's operator, tags and topics. The Add Task box asks which project
 * the task is for before it files it, and its Suggest side, which reads one
 * project, is left out.
 */
export async function drawProject(slug, view, { adding = false, filed = null, unchecked = false, uploaded = [], notUploaded = [], said = null } = {}) {
  const [board, looks, { projects }] = await Promise.all([
    api('GET', slug == null ? '/all-projects/board' : `/projects/${encodeURIComponent(slug)}/board`),
    api('GET', '/stage-colours').then(stageLooks, () => ({})),
    api('GET', '/projects'),
  ]);
  // Opening a project selects it, and remembers the view: "Tasks" comes back here.
  try {
    localStorage.setItem(VIEW_KEY, view);
    localStorage.setItem(PROJECT_KEY, board.project ?? ALL_PROJECTS);
    localStorage.setItem(PROJECT_NAME_KEY, board.projectName);
  } catch { /* the page still works; it is only not remembered */ }
  showProject();
  setTitle(`${board.projectName} ${view} · Tracker`);
  const at = (v, s) => (s ? `/${v}/${encodeURIComponent(s)}` : `/${v}`);
  const all = board.project == null;
  // All Projects: each ticket's own project, by slug, for its name and its List row's choices.
  const projectOf = new Map((board.projects ?? []).map((p) => [p.slug, p]));
  const projectName = (t) => (all ? `<span class="project-of quiet">${escapeHtml(t.projectName ?? t.project ?? '')}</span>` : '');
  /**
   * A stage's heading (SP-196): its name on the left, its count right-aligned,
   * then the fold arrow, which the stylesheet draws from the block's open
   * state (down when open, right when folded).
   */
  const head = (c) => `<h2><span class="stage-name">${escapeHtml(c.status)}</span><span class="count quiet">${c.tickets.length}</span></h2><span class="fold" aria-hidden="true"></span>`;
  /** Whether a stage starts open: every one but Live, which only grows. */
  const startsOpen = (c) => c.status !== 'Live';
  /** A status's block: every stage folds; its heading is the summary that folds it. */
  const block = (c, cls, body) => `<details class="${cls}" data-stage="${escapeHtml(c.status)}"${startsOpen(c) ? ' open' : ''}><summary>${head(c)}</summary>${body}</details>`;

  const card = (t) => `
    <a class="card" href="/t/${encodeURIComponent(t.id)}">
      <span class="name">${escapeHtml(t.name)}</span>
      ${projectName(t)}
      <span class="quiet">${escapeHtml(t.id)}${t.priority ? ` · ${escapeHtml(t.priority)}` : ''}</span>
      ${t.answerIn ? `<span class="answer-in">${escapeHtml(ANSWER_IN_NOTE)}</span>` : t.mergeStands ? `<span class="answer-in">${escapeHtml(MERGE_STANDS_NOTE)}</span>` : ''}
      ${t.tags.length ? `<span class="tags">${t.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</span>` : ''}
    </a>`;
  const column = (c) => block(c, 'column', c.tickets.map(card).join('') || `<p class="quiet">No tickets are in ${escapeHtml(c.status)} right now.</p>`);

  const actions = (t, status) => {
    const at = `/t/${encodeURIComponent(t.id)}`;
    return [
      statusIcon(t),
      action(at, 'Open Ticket', ICONS.open),
      action(`${at}#reply`, 'Reply', ICONS.reply),
      t.pullRequest ? action(t.pullRequest, 'Open Pull Request on GitHub', ICONS.pullRequest, true) : '',
      canDelete(status) ? actionButton('Delete Ticket', ICONS.delete, { delete: t.id }) : '',
    ].join('');
  };
  // The project's tags, for each List row's Add Tag dropdown (SP-246); in
  // All Projects, each row's own project's, its operator and its topics.
  const known = projectTags(board);
  const knownOf = new Map([...projectOf.values()].map((p) => [p.slug, projectTags({
    tags: p.tags,
    columns: board.columns.map((c) => ({ tickets: c.tickets.filter((t) => t.project === p.slug) })),
  })]));
  const choicesOf = (t) => (all
    ? { tags: knownOf.get(t.project) ?? [], topics: projectOf.get(t.project)?.topics ?? [], operator: projectOf.get(t.project)?.operator ?? null }
    : { tags: known, topics: board.topics, operator: board.operator });
  const row = (status) => (t) => `
    <tr data-id="${escapeHtml(t.id)}">
      <td class="id"><a href="/t/${encodeURIComponent(t.id)}">${escapeHtml(t.id)}</a></td>
      <td class="name"><a href="/t/${encodeURIComponent(t.id)}">${escapeHtml(t.name)}</a>${projectName(t)}</td>
      <td class="priority">${view === 'list' ? renderListPriority(t) : t.priority ? escapeHtml(statusName(t.priority)) : '<span class="quiet">–</span>'}</td>
      <td class="tags">${view === 'list' ? renderListTags(t, choicesOf(t).tags) : t.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</td>
      <td class="topics">${view === 'list' ? renderListTopics(t, choicesOf(t).topics) : (t.topics ?? []).map((topic) => `<span class="tag topic">${escapeHtml(topic.name)}</span>`).join('') || '<span class="quiet">–</span>'}</td>
      <td class="assignee">${view === 'list' ? renderListAssignee(t, choicesOf(t).operator) : t.assignee ? escapeHtml(t.assignee) : '<span class="quiet">nobody</span>'}</td>
      <td class="when">${escapeHtml(when(t.updatedAt))}</td>
      <td class="actions">${actions(t, status)}</td>
    </tr>`;
  const group = (c) => block(c, 'group', c.tickets.length
    ? `<div class="table-wrap"><table class="sortable"><thead>${renderSortHeadings(null)}</thead><tbody>${c.tickets.map(row(c.status)).join('')}</tbody></table></div>`
    : '');

  // The board's columns are the working stages; Live, which only grows, is a
  // list section under them (SP-165), newest change first.
  // SP-345: only the tickets the Kind, Started By and How It Ended filters let through.
  const columns = filterByClass(board.columns, pickedClass);
  const working = columns.filter((c) => c.status !== 'Live');
  const liveColumn = columns.find((c) => c.status === 'Live');
  const live = liveColumn && { ...liveColumn, tickets: liveColumn.tickets.slice().sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0)) };

  // Which side of the Add Task box shows: its Suggest checkbox, kept in this browser (SP-303).
  // All Projects has no Suggest side: it reads one project (SP-402).
  const suggesting = !all && savedSuggestSwitch();
  // SP-362: the title row holds only the title and the Board / List / Console
  // tabs, as on the Console; the pickers, search, pod and filters are the row under it.
  main.innerHTML = `
    <div class="tasks-head title-row"><h1>Tasks</h1>${filed ? filedPod(filed, uploaded) : ''}${viewSwitch(board.project, view)}</div>
    <div class="toolbar tasks-bar">
      ${renderProjectPicker(projects, board.project, { all: ALL_PROJECTS_LABEL })}
      ${renderTopicPicker(board.topics ?? [])}
      ${searchForm('')}
      <button type="button" class="pipeline-pod" aria-haspopup="dialog" title="Open Pipeline Status"></button>
      ${renderClassFilters(board.classes, pickedClass)}
    </div>
    ${filed && (unchecked || notUploaded.length) ? `<p class="filed-note">${unchecked ? UNCHECKED_NOTE : ''}${notUploadedNote(notUploaded)}</p>` : ''}
    <details class="add-task">
      <summary>Add Task${all ? '' : `<label class="suggest-switch">Suggest <input type="checkbox" value="on" aria-label="Suggest Next Tasks"${suggesting ? ' checked' : ''}></label>`}</summary>
      <form class="request fields"${suggesting ? ' hidden' : ''}>
        ${all ? `<div class="beside"><label for="add-project">Project</label>
        <select id="add-project" required><option value="" selected>Pick a Project</option>${projects.map((p) => `<option value="${escapeHtml(p.slug)}">${escapeHtml(p.name)}</option>`).join('')}</select></div>` : ''}
        <div class="title-mode" role="radiogroup" aria-label="How the Title Is Chosen">
          <label><input type="radio" name="title-mode" value="suggest"> Suggest a Title</label>
          <label><input type="radio" name="title-mode" value="own"> Write My Own Title</label>
        </div>
        <div class="own-title">
          <label for="title">Title</label>
          <input id="title" type="text" class="field-long">
        </div>
        <label for="description">Description</label>
        <textarea id="description"></textarea>
        <div class="beside"><label for="files">Files</label>
        <input id="files" type="file" multiple aria-describedby="files-hint">
        <span class="hint" id="files-hint">Screenshots, PDFs or notes, up to 10 MB each. Files are not kept in the saved draft: after a reload, pick them again.</span></div>
        <fieldset class="title-choices" hidden>
          <legend>Pick a Title</legend>
          <div class="choices"></div>
        </fieldset>
        <div class="row"><button type="submit" class="btn btn-primary submit-task">Suggest Titles</button><button type="button" class="btn suggest-again" hidden>Suggest Again</button><span class="note"></span></div>
      </form>
      ${all ? '' : `<div class="suggest-next"${suggesting ? '' : ' hidden'}>
        <p class="hint quiet">Reads the project (its plans, documents and code) and its open tickets, and suggests what to do next. Put them in order, untick any you do not want, and file the rest as requests.</p>
        <div class="row run-row"><button type="button" class="btn btn-primary suggest-run">Suggest Next Tasks</button><span class="run-note note" role="status"></span></div>
        <ol class="suggestions"></ol>
        <div class="row file-row" hidden><button type="button" class="btn btn-primary file-order">File in This Order</button><span class="file-note note" role="status"></span></div>
      </div>`}
    </details>
    <dialog class="suggestion-info" aria-labelledby="suggestion-info-title">
      <form method="dialog">
        <button type="submit" class="close" aria-label="Close">×</button>
        <div class="suggestion-info-body"></div>
        <div class="row"><button type="submit" class="btn">Close</button></div>
      </form>
    </dialog>
    <dialog class="project-check" aria-labelledby="project-check-question">
      <form method="dialog">
        <button type="submit" class="close" value="" aria-label="Close: file nothing">×</button>
        <p id="project-check-question">Did you mean for that to be associated with project <strong class="project-name"></strong>?</p>
        <div class="row">
          <button type="submit" class="btn btn-primary" value="move">File in</button>
          <button type="submit" class="btn" value="keep">Keep in ${escapeHtml(board.projectName)}</button>
        </div>
      </form>
    </dialog>
    <dialog class="pipeline-status" aria-labelledby="pipeline-status-title">
      <form method="dialog">
        <button type="submit" class="close" aria-label="Close">×</button>
        <h2 id="pipeline-status-title">Pipeline Status</h2>
        <div class="pipeline-details"></div>
        <div class="row"><button type="submit" class="btn">Close</button></div>
      </form>
    </dialog>
    <p class="error list-note" role="alert" hidden></p>
    ${view === 'board'
    ? `<div class="board">${working.map(column).join('')}</div>${live ? `<div class="list board-live">${group(live)}</div>` : ''}`
    : `<div class="list">${columns.map(group).join('')}</div>`}`;
  for (const el of main.querySelectorAll('[data-stage]')) {
    const look = looks[el.dataset.stage];
    if (!look) continue;
    el.classList.add('coloured');
    el.style.setProperty('--stage-border', look.border);
    el.style.setProperty('--stage-tint', look.tint);
    el.style.setProperty('--stage-text', look.text);
  }
  putTrail([{ label: board.projectName, href: '/projects' }, { label: view === 'board' ? 'Board' : 'List' }]);
  wireSortHeadings(view === 'board' ? (live ? [live] : []) : columns);
  // A class filter changed: keep it, and draw the project again through it.
  for (const select of main.querySelectorAll('.class-filters select')) {
    select.addEventListener('change', () => {
      pickedClass[select.name] = select.value;
      drawProject(board.project, view).catch((err) => (err instanceof SignedOut ? drawSignIn() : showError(err)));
    });
  }
  wireSearch();
  wireAddTask(board.project, view, adding);
  if (!all) {
    wireSuggestNext(board.project, view);
    wireSuggestSwitch();
  }
  wireFiledPod();
  wirePipeline();
  refreshPipeline();
  // Picking a project opens it in this same view, as a link would: Back returns here.
  main.querySelector('.project-picker select').addEventListener('change', (e) => {
    history.pushState(null, '', at(view, e.target.value));
    route();
  });
  wireListPickers(slug, view, board, said);
  // Delete: ask first, naming the ticket; then redraw from the server. A
  // refusal is said in words and nothing leaves the list until a redraw.
  const listNote = main.querySelector('.list-note');
  const names = new Map(board.columns.flatMap((c) => c.tickets).map((t) => [t.id, t.name]));
  for (const button of main.querySelectorAll('button[data-delete]')) {
    button.addEventListener('click', async () => {
      const id = button.dataset.delete;
      if (!confirm(deleteQuestion({ id, name: names.get(id) }))) return;
      button.disabled = true;
      listNote.hidden = true;
      try {
        await api('DELETE', `/tickets/${encodeURIComponent(id)}`);
      } catch (err) {
        if (err instanceof SignedOut) return drawSignIn(`You were signed out; ${id} was not deleted.`);
        listNote.textContent = deleteRefusal(id, err);
        listNote.hidden = false;
        button.disabled = false;
        return;
      }
      await drawAgain(() => drawProject(slug, view));
    });
  }
}

/**
 * The List view's dropdowns that save on change, by the field each sends:
 * priority (SP-208) as picked, assignee (SP-244) as the person's id, or null
 * for Nobody. `before` is the value the board drew, put back on a refusal.
 */
const LIST_PICKERS = Object.freeze({
  priority: { value: (select) => select.value, before: (t) => t.priority ?? '' },
  assignee: { value: (select) => (select.value ? Number(select.value) : null), before: (t) => String(t.assigneeId ?? '') },
});

/**
 * SP-208, SP-244, SP-246, SP-247: the List view's priority and assignee
 * dropdowns and its tag and topic controls. Each change sends only that field
 * (tags and topics as the whole new list), with the version the board drew (`ifVersion`), to the same PATCH
 * /tickets/:id the ticket page's Change panel uses. One save at a time: every
 * dropdown, ×, and tag box in the list is held while a save is in flight, and
 * "Saving…" shows beside the one changed. Saved, the list is drawn again from
 * the server with "Saved" beside it. A 409 means a loop moved the ticket: the
 * list is drawn again as stored, with the moved message beside it. Any other
 * refusal shows the server's words and puts the control back as it was.
 */
function wireListPickers(slug, view, board, said) {
  const fields = Object.keys(LIST_PICKERS);
  const selects = [...main.querySelectorAll(fields.map((f) => `select[data-${f}-of]`).join(', '))];
  const controls = [...selects, ...main.querySelectorAll('select[data-tags-of], button[data-untag-of], input[data-new-tag-of], select[data-topics-of], button[data-untopic-of]')];
  const fieldOf = (select) => fields.find((f) => select.hasAttribute(`data-${f}-of`));
  const noteOf = (field, id) => [...main.querySelectorAll(`[data-${field}-note]`)].find((n) => n.getAttribute(`data-${field}-note`) === id);
  if (said) {
    const note = noteOf(said.field, said.id);
    if (note) {
      note.className = `note${said.error ? ' error' : ' quiet'}`;
      note.textContent = said.text;
    }
  }
  const tickets = new Map(board.columns.flatMap((c) => c.tickets).map((t) => [t.id, t]));
  let saving = false;
  /** Sends `value` as `field` of ticket `id`; `undo` puts the control back when nothing is sent or it is refused. */
  const save = async (id, field, value, undo) => {
    const t = tickets.get(id);
    if (!t) return;
    if (saving) {
      undo();
      return;
    }
    saving = true;
    const was = field === 'tags' || field === 'topics' ? 'were' : 'was';
    const note = noteOf(field, id);
    const held = controls.filter((c) => !c.disabled);
    for (const c of held) c.disabled = true;
    note.className = 'note quiet';
    note.textContent = 'Saving…';
    let after;
    try {
      await api('PATCH', `/tickets/${encodeURIComponent(id)}`, { [field]: value, ifVersion: t.version });
      after = { id, field, text: 'Saved' };
    } catch (err) {
      if (err instanceof SignedOut) return drawSignIn(`You were signed out; the ${field} of ${id} ${was} not saved.`);
      if (err instanceof Refused && err.status === 409) {
        after = { id, field, text: MOVED_MESSAGE, error: true };
      } else {
        note.className = 'note error';
        note.textContent = `Not saved: ${err.message}`;
        undo();
        for (const c of held) c.disabled = false;
        saving = false;
        return;
      }
    }
    try {
      await drawAgain(() => drawProject(slug, view, { said: after }));
    } catch (err) {
      if (err instanceof SignedOut) return drawSignIn(`You were signed out; the ${field} of ${id} ${was} ${after.error ? 'not ' : ''}saved, but the page could not show it.`);
      note.className = 'note error';
      note.textContent = `The page could not refresh (${err.message}): the ${field} ${was} ${after.error ? 'not ' : ''}saved. Reload to see the list as stored.`;
    }
  };
  for (const select of selects) {
    const field = fieldOf(select);
    const picker = LIST_PICKERS[field];
    select.addEventListener('change', () => {
      const t = tickets.get(select.getAttribute(`data-${field}-of`));
      if (!t) return;
      const before = picker.before(t);
      save(t.id, field, picker.value(select), () => { select.value = before; });
    });
  }
  wireListTags(tickets, save, noteOf);
  wireListTopics(tickets, save);
}

/**
 * SP-247: a List row's topic controls, saving through wireListPickers' `save`
 * with the whole new list of topic ids. Picking a topic from Add Topic adds
 * it; a chip's × removes that topic.
 */
function wireListTopics(tickets, save) {
  const idsOf = (t) => (t.topics ?? []).map((topic) => topic.id);
  for (const select of main.querySelectorAll('select[data-topics-of]')) {
    select.addEventListener('change', () => {
      const t = tickets.get(select.getAttribute('data-topics-of'));
      const topic = Number(select.value);
      if (!t || !Number.isInteger(topic) || topic < 1) return;
      save(t.id, 'topics', [...idsOf(t), topic], () => { select.value = ''; });
    });
  }
  for (const button of main.querySelectorAll('button[data-untopic-of]')) {
    button.addEventListener('click', () => {
      const t = tickets.get(button.getAttribute('data-untopic-of'));
      if (!t) return;
      const topic = Number(button.dataset.topic);
      save(t.id, 'topics', idsOf(t).filter((id) => id !== topic), () => {});
    });
  }
}

/**
 * SP-246: a List row's tag controls, saving through wireListPickers' `save`.
 * Picking a tag from Add Tag adds it; New Tag… opens the row's text box
 * (Enter adds what is typed, trimmed, and a blank entry adds nothing; Escape
 * closes it); a chip's × removes that tag. A tag the ticket already has is
 * said, not sent.
 */
function wireListTags(tickets, save, noteOf) {
  const boxOf = (id) => [...main.querySelectorAll('input[data-new-tag-of]')].find((b) => b.getAttribute('data-new-tag-of') === id);
  const add = (t, tag, undo) => {
    if (t.tags.includes(tag)) {
      const note = noteOf('tags', t.id);
      note.className = 'note quiet';
      note.textContent = `${tag} is already a tag.`;
      undo();
      return;
    }
    save(t.id, 'tags', [...t.tags, tag], undo);
  };
  for (const select of main.querySelectorAll('select[data-tags-of]')) {
    select.addEventListener('change', () => {
      const t = tickets.get(select.getAttribute('data-tags-of'));
      if (!t) return;
      const reset = () => { select.value = ''; };
      if (select.selectedOptions[0]?.hasAttribute('data-new-tag')) {
        reset();
        const box = boxOf(t.id);
        box.hidden = false;
        box.focus();
        return;
      }
      if (!select.value) return;
      add(t, select.value, reset);
    });
  }
  for (const box of main.querySelectorAll('input[data-new-tag-of]')) {
    const t = tickets.get(box.getAttribute('data-new-tag-of'));
    if (!t) continue;
    const close = () => {
      box.value = '';
      box.hidden = true;
    };
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const tag = box.value.trim();
      if (!tag) return close();
      add(t, tag, () => {});
    });
  }
  for (const button of main.querySelectorAll('button[data-untag-of]')) {
    button.addEventListener('click', () => {
      const t = tickets.get(button.getAttribute('data-untag-of'));
      if (!t) return;
      save(t.id, 'tags', t.tags.filter((tag) => tag !== button.dataset.tag), () => {});
    });
  }
}

/** The Search field, holding `term`. The page allows no form to submit itself; wireSearch sends it. */
const searchForm = (term) => `
  <form class="search" role="search">
    <label for="search-q">Search</label>
    <input type="search" id="search-q" name="q" placeholder="merge conflict" value="${escapeHtml(term)}">
  </form>`;

/**
 * The search results page's address: the term, then each filter chosen on
 * the page's filter row, so a reload or a pasted link shows the same
 * results. On the Tasks page, which has no filter row, the project chosen
 * in its project picker goes in as the Project filter (SP-191), and the
 * topic in its Topic picker as the Topic filter.
 */
function searchAddress(term) {
  const params = new URLSearchParams({ q: term });
  for (const select of main.querySelectorAll('.project-picker select, .topic-picker select, .search-filters select')) {
    if (select.value) params.set(select.name, select.value);
  }
  // All Projects: a topic belongs to one project, so its project goes in as the Project filter (SP-402).
  const owner = main.querySelector('.topic-picker select')?.selectedOptions[0]?.dataset.project;
  if (owner && !params.has('project')) params.set('project', owner);
  return `/search?${params}`;
}

/** Enter in the Search field, or a filter changed, opens the results page at searchAddress. */
function wireSearch() {
  const form = main.querySelector('form.search');
  const go = () => {
    history.pushState(null, '', searchAddress(form.elements.q.value.trim()));
    route();
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    go();
  });
  // A topic belongs to one project, so changing Project drops the topic chosen.
  for (const select of main.querySelectorAll('.search-filters select')) {
    select.addEventListener('change', () => {
      const topic = main.querySelector('.search-filters select[name="topic"]');
      if (select.name === 'project' && topic) topic.value = '';
      go();
    });
  }
}

/**
 * The Search page's "Ticket number" field (SP-192): Enter, or picking one
 * of the tickets its list offers, opens that ticket's page; a number that
 * is not one of them (render.mjs lookupTicket) shows its plain line in
 * place of the results. `answer` is the server's: the tickets offered and
 * the Project filter, whose chosen name the line uses.
 */
function wireTicketLookup(answer) {
  const form = main.querySelector('form.ticket-lookup');
  if (!form) return;
  const box = form.elements.ticket;
  const project = answer.filters.find((f) => f.key === 'project');
  const projectName = project?.value == null ? null : project.options.find((o) => o.value === project.value)?.label ?? project.value;
  const look = (typed, { quiet = false } = {}) => {
    const found = lookupTicket(typed, answer.tickets, projectName);
    if (!found) return;
    if (found.href) {
      history.pushState(null, '', found.href);
      route();
    } else if (!quiet) {
      main.querySelector('.search-answer').innerHTML = `<p class="quiet search-note">${escapeHtml(found.note)}</p>`;
    }
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    look(box.value);
  });
  // A pick from the list arrives as an input with no typing behind it.
  box.addEventListener('input', (e) => {
    if (e.inputType == null || e.inputType === 'insertReplacementText') look(box.value, { quiet: true });
  });
}

/**
 * The search results page: every ticket in every project matching the
 * address's term and filters, best matches first, as the server ranks and
 * filters them (pageData.mjs searchTickets), drawn by render.mjs
 * renderSearchResults, which escapes each ticket's text before bolding the
 * term. The Search field holds the term and the filter row the filters,
 * each choice from the server's answer; changing either searches again. A
 * filter the server refuses shows its message in place of the results.
 * Read-only.
 */
export async function drawSearch(params) {
  const term = (params.get('q') ?? '').trim();
  let answer;
  let refusal = null;
  try {
    answer = await api('GET', `/search?${params}`);
  } catch (err) {
    if (!(err instanceof Refused) || err.status !== 400) throw err;
    refusal = err.message;
    answer = await api('GET', `/search?${new URLSearchParams({ q: term })}`);
  }
  setTitle(answer.query ? `Search: ${answer.query} · Tracker` : 'Search · Tracker');
  main.innerHTML = `
    <div class="title-row"><h1>Search</h1>
    <div class="toolbar">${searchForm(answer.query)}</div></div>
    ${renderSearchFilters(answer.filters, { tickets: answer.tickets ?? [] })}
    <div class="search-answer">${refusal ? `<p class="error">${escapeHtml(refusal)}</p>` : `
    ${answer.results.length ? `<p class="quiet">${answer.results.length} ${answer.results.length === 1 ? 'ticket matches' : 'tickets match'}</p>` : ''}
    ${renderSearchResults(answer)}`}</div>`;
  putTrail([{ label: 'Tasks', href: '/tasks' }, { label: 'Search' }]);
  wireSearch();
  wireTicketLookup({ ...answer, tickets: answer.tickets ?? [] });
  if (!answer.query) main.querySelector('form.search input').focus();
}

/**
 * Put `text` on the clipboard; true when it got there. The page is served
 * over plain http on the Mini, where the browser hides navigator.clipboard,
 * so off a secure page it copies from a hidden text box instead.
 */
async function copyText(text, button) {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch { /* fall through to the text box */ }
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.className = 'offscreen';
  document.body.append(area);
  // Safari copies the page's selection, which a text box only holds while focused.
  area.focus();
  area.setSelectionRange(0, area.value.length);
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
    button?.focus();
  }
}

/** Copy: each command exactly as drawn, onto the clipboard. The page never runs it. */
export function wireCopyButtons() {
  for (const button of main.querySelectorAll('button.copy-command')) {
    let reset;
    button.addEventListener('click', async () => {
      const text = button.parentElement.querySelector('code').textContent;
      button.textContent = (await copyText(text, button)) ? 'Copied' : 'Not Copied';
      clearTimeout(reset);
      reset = setTimeout(() => { button.textContent = 'Copy'; }, 1500);
    });
  }
}
