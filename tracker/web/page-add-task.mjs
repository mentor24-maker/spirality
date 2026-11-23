/**
 * The Tasks page's Add Task box: filing a request, its suggested titles, the filed pod, and the Suggest Next Tasks switch and list.
 *
 * Part of Dane's page: app.mjs is the entry the page loads, holds what
 * every page shares (signing in, the API call, the header, routing and the
 * message strip) and imports this file. Moved out of app.mjs unchanged
 * (Spirality SP-352), so a ticket that changes one page no longer edits the
 * same file as a ticket that changes another.
 */
import { escapeHtml, renderTitleChoices, titleModeOf, SUGGEST_POLL_MS, moveSuggestion, suggestState, filingPlan, orderPlan, andList, suggestRunLine, renderSuggestRows, renderSuggestionInfo } from './render.mjs';
import { main, DRAFT_KEY, TITLE_MODE_KEY, SUGGEST_SWITCH_KEY, api, SignedOut, drawSignIn, Refused, MAX_FILE, uploadFile, drawAgain, SUGGEST_STATE_KEY, refreshing } from './app.mjs';
import { drawProject } from './page-tasks.mjs';

/**
 * The "Filed SP-n" pod (SP-223): the new ticket's id, linked, and the names
 * of any files that went up with it. It floats centred on the Tasks
 * heading's row, out of the page flow, so nothing moves; the stylesheet
 * holds it 3 seconds and fades it over the next 1, and wireFiledPod takes
 * it off the page once it has faded.
 */
export function filedPod(filed, uploaded) {
  const names = uploaded.map((n) => `<strong>${escapeHtml(n)}</strong>`).join(', ');
  return `<output class="filed-pod">Filed <a href="/t/${encodeURIComponent(filed)}">${escapeHtml(filed)}</a>${uploaded.length ? `. Uploaded ${names}` : ''}</output>`;
}

/** How long the filed pod stays on the page: 3 seconds shown, 1 fading. */
const FILED_POD_MS = 4000;

/** Take the filed pod off the page once it has faded, so it catches no clicks. */
export function wireFiledPod() {
  const pod = main.querySelector('.filed-pod');
  if (pod) setTimeout(() => pod.remove(), FILED_POD_MS);
}

/**
 * The lasting line's words about files that did not go up, each by name with
 * why. A warning stays under the toolbar rather than in the fading pod, so it
 * cannot vanish before it is read. Nothing when every file went up.
 */
export function notUploadedNote(notUploaded) {
  if (!notUploaded.length) return '';
  return ` <span class="error">Not uploaded: ${notUploaded.map((f) => `<strong>${escapeHtml(f.name)}</strong> (${escapeHtml(f.why)})`).join(', ')}. The ticket is filed without ${notUploaded.length === 1 ? 'it' : 'them'}.</span>`;
}

/** The lasting line's words when the Add Task box's project check could not run. */
export const UNCHECKED_NOTE = 'The project check could not run, so it went into the project shown.';

/** The draft kept for the Add Task box, or empty fields. */
function savedDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? '{}');
    return { title: String(d.title ?? ''), description: String(d.description ?? '') };
  } catch { return { title: '', description: '' }; }
}

/** The Add Task box's kept title mode (titleModeOf): Suggest a Title unless Write My Own Title was left picked. */
function savedTitleMode() {
  try { return titleModeOf(localStorage.getItem(TITLE_MODE_KEY)); } catch { return 'suggest'; }
}

/** What the box says when the title suggester did not answer at all (no word from the tracker). */
const SUGGEST_UNANSWERED = 'No titles could be suggested: the tracker did not answer. Write your own title.';

/**
 * The Tasks page's Add Task box: a title and a description, filed into
 * `shown`, the project the page is showing, in `Requested`, which no loop
 * builds from, unassigned and under the signed-in person. What he types is
 * kept in this browser as he types it, so a refused submit, a sign-out or a
 * reload never loses it, and a kept draft with text in it opens the box on
 * its own; it is forgotten once the ticket is filed, and the page redraws
 * with the box closed and the new ticket in its stage.
 *
 * The title is picked from suggestions (SP-248). A toggle at the top picks
 * how: Suggest a Title shows only the Description (required), Write My Own
 * Title shows the Title too. The toggle is kept in this browser beside the
 * draft and outlives a filing. In Suggest a Title the first submit
 * ("Suggest Titles") sends the words to the title suggester
 * (`/tickets/suggest-titles`) and shows its five titles as a choice list.
 * In Write My Own Title the button reads "Submit Task" from the start and
 * files his title as typed; a "Suggest Titles" button beside it asks for
 * the list anyway, his own title first. "Suggest Again" asks for a fresh
 * five, the words untouched. Editing the words after that puts the box back
 * to its first stage, so a list never names stale words. When
 * the suggester fails, the box says why in one line and shows the Title
 * field, and the next submit files what he types there. The picked title
 * is filed exactly as shown.
 *
 * Before filing, the box asks the server whether the words fit another
 * project better (tracker/projectGuess.mjs). If one does, the
 * question box asks "Did you mean for that to be associated with project
 * X?": File in X files there and opens X's board; Keep in files here;
 * closing it files nothing and leaves the text in the form. A check that
 * fails never stops the filing: the task goes into the project shown and
 * the note says the check could not run.
 *
 * With no `shown` (All Projects, SP-402) the box has a Project picker of its
 * own, and asks for one before it suggests a title or files: it never
 * guesses. Filed, the page draws All Projects again with the new ticket.
 */
export function wireAddTask(shown, view, adding) {
  const box = main.querySelector('details.add-task');
  const form = box.querySelector('form.request');
  const title = form.querySelector('#title');
  const description = form.querySelector('#description');
  const files = form.querySelector('#files');
  const ownTitle = form.querySelector('.own-title');
  const modes = [...form.querySelectorAll('input[name="title-mode"]')];
  const choices = form.querySelector('fieldset.title-choices');
  const choiceList = choices.querySelector('.choices');
  const button = form.querySelector('button.submit-task');
  const again = form.querySelector('button.suggest-again');
  const pickProject = form.querySelector('#add-project');
  // The project the task goes into: the one shown, or the one picked in All Projects (null until one is).
  const target = () => shown ?? (pickProject?.value || null);
  const draft = savedDraft();
  title.value = draft.title;
  description.value = draft.description;
  let mode = savedTitleMode();
  // 'ask': the next submit asks for titles; 'pick': the choice list is up;
  // 'type': the suggester failed, so he types the title himself.
  let stage = 'ask';
  const show = () => {
    for (const m of modes) m.checked = m.value === mode;
    const typing = mode === 'own' || stage === 'type';
    ownTitle.hidden = !typing;
    title.required = typing;
    description.required = mode === 'suggest';
    choices.hidden = stage !== 'pick';
    if (stage !== 'pick') choiceList.innerHTML = '';
    // Write My Own Title files his title straight away; Suggest Titles beside it is optional.
    const asking = stage === 'ask' && mode === 'suggest';
    again.hidden = asking;
    again.textContent = stage === 'ask' ? 'Suggest Titles' : 'Suggest Again';
    button.textContent = asking ? 'Suggest Titles' : 'Submit Task';
  };
  const firstField = () => (mode === 'own' ? title : description);
  show();
  // Opened from the bar (a click or Enter, which focus the <summary>), the
  // form's first field takes focus; opened by the Suggest checkbox, which
  // marks the box first (wireSuggestSwitch), focus stays on the checkbox.
  box.addEventListener('toggle', () => {
    const bySwitch = box.dataset.openedBySwitch === '1';
    delete box.dataset.openedBySwitch;
    if (box.open && !form.hidden && !bySwitch) firstField().focus();
  });
  // The old New request address (adding) always opens on the form: it
  // unticks Suggest and keeps that, so the page and the checkbox agree (SP-303).
  if (adding) {
    const tick = box.querySelector('summary .suggest-switch input');
    if (tick) tick.checked = false;
    form.hidden = false;
    const part = box.querySelector('.suggest-next');
    if (part) part.hidden = true;
    try { localStorage.setItem(SUGGEST_SWITCH_KEY, '0'); } catch { /* the form still shows; a reload shows the kept side */ }
  }
  // A kept draft opens the box only on the Add Task side; it never flips the checkbox (SP-303).
  if (adding || ((draft.title || draft.description) && !savedSuggestSwitch())) box.open = true;
  const keep = () => {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ title: title.value, description: description.value }));
    } catch { /* the form still works; a sign-out would lose the text */ }
  };
  form.addEventListener('input', (e) => {
    keep();
    // New words make the list stale: ask again. A failed suggestion's typed title stays.
    if (stage === 'pick' && (e.target === title || e.target === description)) {
      stage = 'ask';
      show();
    }
  });
  const note = form.querySelector('.note');
  const say = (text, kind = 'quiet') => {
    note.className = kind ? `note ${kind}` : 'note';
    note.textContent = text;
  };
  for (const m of modes) {
    m.addEventListener('change', () => {
      if (!m.checked) return;
      mode = titleModeOf(m.value);
      try { localStorage.setItem(TITLE_MODE_KEY, mode); } catch { /* the box still works; it opens on Suggest a Title next time */ }
      stage = 'ask';
      show();
      say('', '');
    });
  }
  const busy = (on) => {
    button.disabled = on;
    again.disabled = on;
  };

  // In All Projects, no project picked yet: say so and send him to the picker.
  const noProject = () => {
    if (target()) return false;
    say('Pick the project this task is for first.', 'error');
    pickProject?.focus();
    return true;
  };
  // Ask for five titles from the words as typed; show them, or say why not and show the Title field.
  const askTitles = async () => {
    if (noProject()) return;
    const slug = target();
    busy(true);
    say('Suggesting titles…');
    let titles;
    try {
      ({ titles } = await api('POST', `/projects/${encodeURIComponent(slug)}/tickets/suggest-titles`,
        mode === 'own' ? { description: description.value, title: title.value } : { description: description.value }));
    } catch (err) {
      if (err instanceof SignedOut) return drawSignIn('You were signed out; your request was not filed. What you typed is kept: it will be back in the form once you sign in.');
      stage = 'type';
      show();
      say(err instanceof Refused ? err.message : SUGGEST_UNANSWERED, 'error');
      busy(false);
      title.focus();
      return;
    }
    choiceList.innerHTML = renderTitleChoices({ own: mode === 'own' ? title.value : null, titles });
    stage = 'pick';
    show();
    say('', '');
    busy(false);
    choiceList.querySelector('input:checked')?.focus();
  };
  again.addEventListener('click', () => { keep(); askTitles(); });

  const question = main.querySelector('dialog.project-check');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    keep();
    if (stage === 'ask' && mode === 'suggest') return askTitles();
    if (noProject()) return;
    const slug = target();
    // The title as shown: the picked choice, or what he typed (Write My Own Title, or after a failed suggestion).
    const picked = stage === 'pick' ? choiceList.querySelector('input[name="title-choice"]:checked')?.value : title.value;
    if (!picked) {
      say('Pick a title first.', 'error');
      return;
    }
    busy(true);
    say('Checking the project…');
    // The check reads the words and writes nothing; a failed check files here as before.
    let suggest = null;
    let unchecked = false;
    try {
      ({ suggest } = await api('POST', `/projects/${encodeURIComponent(slug)}/tickets/check`, {
        name: picked, description: description.value,
      }));
    } catch (err) {
      if (err instanceof SignedOut) return drawSignIn('You were signed out; your request was not filed. What you typed is kept: it will be back in the form once you sign in.');
      unchecked = true;
    }
    let into = slug;
    if (suggest) {
      const choice = await askProject(question, suggest, shown == null ? pickProject.selectedOptions[0]?.textContent : null);
      if (choice === 'move') into = suggest.slug;
      else if (choice !== 'keep') {
        // Closed: nothing filed, the text and the choice stay in the form.
        say('', '');
        busy(false);
        button.focus();
        return;
      }
    }
    say('Filing…');
    let ticket;
    try {
      // Exactly as typed: no trimming, no formatting, the same rule as the reply box.
      ticket = await api('POST', `/projects/${encodeURIComponent(into)}/tickets`, {
        name: picked, description: description.value, status: 'Requested',
      });
    } catch (err) {
      if (err instanceof SignedOut) return drawSignIn('You were signed out; your request was not filed. What you typed is kept: it will be back in the form once you sign in.');
      say(`Not filed: ${err.message}`, 'error');
      busy(false);
      return;
    }
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* nothing kept */ }
    // The ticket is filed first; then each file goes up on its own, so one
    // that fails is named and the rest, and the ticket, still stand.
    const uploaded = [];
    const notUploaded = [];
    for (const file of [...(files?.files ?? [])]) {
      if (file.size > MAX_FILE) {
        notUploaded.push({ name: file.name, why: 'over 10 MB' });
        continue;
      }
      note.textContent = `Filed ${ticket.id}. Uploading ${file.name}…`;
      try {
        await uploadFile(ticket.id, file);
        uploaded.push(file.name);
      } catch (err) {
        if (err instanceof SignedOut) return drawSignIn(`You were signed out; ${ticket.id} was filed, but ${file.name} and any files after it were not uploaded.`);
        notUploaded.push({ name: file.name, why: err.message });
      }
    }
    // Filed in another project: open its board, where the new ticket is. All Projects shows it where it is.
    if (shown != null && into !== shown) history.pushState(null, '', `/${view}/${encodeURIComponent(into)}`);
    try {
      await drawAgain(() => drawProject(shown == null ? null : into, view, { filed: ticket.id, unchecked, uploaded, notUploaded }));
    } catch (err) {
      if (err instanceof SignedOut) return drawSignIn(`You were signed out; ${ticket.id} was filed.`);
      say(`Filed ${ticket.id}, but the page could not be drawn again: ${err.message}`, 'error');
    }
  });
}

/** The Add Task bar's kept Suggest checkbox (SP-303): ticked only when it was left ticked. */
export function savedSuggestSwitch() {
  try { return localStorage.getItem(SUGGEST_SWITCH_KEY) === '1'; } catch { return false; }
}

/**
 * SP-303: the Suggest checkbox at the right of the Add Task bar. Ticked, the
 * box shows the Suggest Next Tasks part; unticked, the Add Task form. Both
 * stay drawn and are only hidden, so a typed draft, a picked title, the
 * suggestions' order and ticks, and a run already going are all still there
 * on switching back. Either way the box opens if it was shut, and the click
 * never folds it: a click on a control inside a <summary> (the checkbox, or
 * its label's word) works that control and does not fold the box. The tick is kept in this browser, as the title toggle
 * is, so the minute's redraw and a reload keep the side he picked.
 */
export function wireSuggestSwitch() {
  const box = main.querySelector('details.add-task');
  const tick = box.querySelector('summary .suggest-switch input');
  const form = box.querySelector('form.request');
  const part = box.querySelector('.suggest-next');
  tick.addEventListener('change', () => {
    try { localStorage.setItem(SUGGEST_SWITCH_KEY, tick.checked ? '1' : '0'); } catch { /* the box still works; a reload shows the Add Task side */ }
    form.hidden = tick.checked;
    part.hidden = !tick.checked;
    // A shut box opened by the checkbox leaves focus on the checkbox (wireAddTask's toggle).
    if (!box.open) box.dataset.openedBySwitch = '1';
    box.open = true;
  });
}

/** The Suggest Next Tasks box's kept state for `slug`, or null. */
function savedSuggestState(slug) {
  try { return JSON.parse(localStorage.getItem(SUGGEST_STATE_KEY) ?? '{}')[slug] ?? null; } catch { return null; }
}

/** Keep `state` as `slug`'s Suggest Next Tasks state in this browser. */
function keepSuggestState(slug, state) {
  try {
    const all = JSON.parse(localStorage.getItem(SUGGEST_STATE_KEY) ?? '{}');
    all[slug] = state;
    localStorage.setItem(SUGGEST_STATE_KEY, JSON.stringify(all));
  } catch { /* the box still works; a redraw starts the list over */ }
}

/** What the box says when a suggestion run could not be started or read (no word from the tracker). */
const SUGGEST_NEXT_UNANSWERED = 'the tracker did not answer.';

/**
 * SP-251: the Tasks page's Suggest Next Tasks box, beside Add Task. Its
 * button starts a run of the next-task suggester (POST
 * /projects/<slug>/suggest-next, tracker/nextSuggest.mjs); while it runs
 * the box says so and checks back every SUGGEST_POLL_MS. When the page
 * opens it shows the last list on its own (GET), and opens itself when
 * a run is going or a list has rows still to file.
 *
 * Each suggestion is a row (renderSuggestRows). Dragging a row, the arrow
 * keys on its handle, or a number from its dropdown moves it there and the
 * rest renumber (moveSuggestion). The order, the ticks and what was filed
 * are kept in this browser per project, for that run (suggestState), so a
 * redraw keeps them.
 *
 * "File in This Order" files each kept row not yet filed (filingPlan) the
 * way the Add Task box does: the project check, then POST .../tickets in
 * Requested, title and description as shown. Then every kept row's ticket
 * gets its place, in the order shown (POST .../tickets/order, one call per
 * project they went into). A step that fails says which and stops; each
 * filed ticket is kept at once, so pressing it again files nothing twice.
 * A failed run says why and offers Try Again.
 */
export function wireSuggestNext(slug, view) {
  // The Suggest Next Tasks part of the Add Task box (SP-303), and the box it folds in.
  const box = main.querySelector('details.add-task .suggest-next');
  const fold = box.closest('details.add-task');
  const run = box.querySelector('button.suggest-run');
  const runNote = box.querySelector('.run-note');
  const runRow = box.querySelector('.run-row');
  const list = box.querySelector('ol.suggestions');
  const fileRow = box.querySelector('.file-row');
  const fileButton = box.querySelector('button.file-order');
  const fileNote = box.querySelector('.file-note');
  const question = main.querySelector('dialog.project-check');
  const path = `/projects/${encodeURIComponent(slug)}/suggest-next`;
  let suggestions = [];
  // The project's GitHub repository, from the latest run's answer: where a suggestion's file links go (SP-305).
  let repo = null;
  let state = null;
  let polling = false;
  let filing = false;
  // A run is going: File in This Order's end must not turn the Suggest button back on.
  let running = false;
  // A run's answer that came while filing: drawn when filing ends, so the
  // filing loop never writes into rows it did not plan from.
  let held;
  // The box opens on its own only when the page is first drawn: a minute's
  // redraw (refreshing) keeps the fold keepPlace put back.
  const mayOpen = !refreshing;
  const say = (el, text, kind = 'quiet') => {
    el.classList.remove('quiet', 'error');
    if (text && kind) el.classList.add(kind);
    el.textContent = text;
  };
  const save = () => keepSuggestState(slug, state);

  // Draw the rows from `state`, putting focus back on a moved row's handle.
  const drawRows = (focusIndex = null) => {
    list.innerHTML = state ? renderSuggestRows(suggestions, state) : '';
    fileRow.hidden = !state;
    // SP-319: with suggestions showing, the one run button (Suggest Again)
    // sits at the right of the bottom row, across from File in This Order;
    // with none, it is back at the top. Its status line stays at the top.
    if (state) { if (run.parentNode !== fileRow) fileRow.append(run); }
    else if (run.parentNode !== runRow) runRow.prepend(run);
    if (focusIndex != null) list.querySelector(`li[data-index="${focusIndex}"] .drag-handle`)?.focus();
  };
  const move = (from, to, focus = false) => {
    // While filing, put a changed dropdown back as it was.
    if (filing) { drawRows(); return; }
    const index = state.order[from];
    state.order = moveSuggestion(state.order, from, to);
    save();
    drawRows(focus ? index : null);
  };
  const placeOf = (li) => state.order.indexOf(Number(li.dataset.index));

  // A run's answer, as drawn: running (check back), failed (Try Again), or done (the rows).
  const show = (latest) => {
    if (!box.isConnected) return;
    if (filing) { held = latest; return; }
    say(runNote, suggestRunLine(latest), latest?.state === 'failed' ? 'error' : 'quiet');
    running = latest?.state === 'running';
    run.disabled = running;
    // While a run is going its rows are about to be replaced: nothing is filed from them.
    fileButton.disabled = running;
    run.textContent = latest?.state === 'failed' ? 'Try Again' : latest?.state === 'done' ? 'Suggest Again' : 'Suggest Next Tasks';
    if (latest?.state === 'done' && Array.isArray(latest.suggestions)) {
      suggestions = latest.suggestions;
      repo = typeof latest.repo === 'string' ? latest.repo : null;
      state = suggestState(savedSuggestState(slug), latest.at, suggestions.length);
      save();
      drawRows();
    } else if (latest?.state !== 'running') {
      if (latest?.state === 'failed') { suggestions = []; state = null; }
      drawRows();
    }
    if (latest?.state === 'running') checkBack();
  };
  const read = async () => {
    try {
      return await api('GET', path, undefined, { unrecorded: true });
    } catch (err) {
      if (err instanceof SignedOut) { drawSignIn(); return undefined; }
      if (err instanceof Refused && err.status === 404) return null;
      say(runNote, `Could not read the suggestions: ${err instanceof Refused ? err.message : SUGGEST_NEXT_UNANSWERED}`, 'error');
      return undefined;
    }
  };
  // While a run is going, read again about every SUGGEST_POLL_MS, until it ends or the page is drawn over.
  const checkBack = () => {
    if (polling) return;
    polling = true;
    setTimeout(async () => {
      polling = false;
      if (!box.isConnected) return;
      const latest = await read();
      if (latest === undefined) {
        // Not answered: try again next time round, the line already says so.
        if (box.isConnected) checkBack();
        return;
      }
      show(latest);
    }, SUGGEST_POLL_MS);
  };

  run.addEventListener('click', async () => {
    run.disabled = true;
    say(runNote, 'Starting…');
    let started;
    try {
      ({ run: started } = await api('POST', path, {}));
    } catch (err) {
      if (err instanceof SignedOut) return drawSignIn('You were signed out; no suggestions were asked for.');
      say(runNote, `No suggestions this time: ${err instanceof Refused ? err.message : SUGGEST_NEXT_UNANSWERED}`, 'error');
      run.textContent = 'Try Again';
      run.disabled = filing;
      return;
    }
    show(started);
  });

  // The i on a row (SP-304): its suggestion's About box, found by the
  // suggestion's own index, so a moved row's i opens its own. Close, Escape
  // or a click outside the box shuts it, and focus goes back to that i.
  const info = main.querySelector('dialog.suggestion-info');
  let infoOpener = null;
  list.addEventListener('click', (e) => {
    const button = e.target.closest('button.suggestion-info-open');
    if (!button) return;
    const suggestion = suggestions[Number(button.dataset.index)];
    if (!suggestion) return;
    infoOpener = button;
    info.querySelector('.suggestion-info-body').innerHTML = renderSuggestionInfo(suggestion, { repo });
    info.showModal();
  });
  // A click on the backdrop lands on the dialog itself; one on its own
  // padding does too, so only a click beyond its edges closes it.
  info.addEventListener('click', (e) => {
    if (e.target !== info) return;
    const r = info.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) info.close();
  });
  info.addEventListener('close', () => {
    // A redraw since may have replaced the row: focus the i drawn for the same suggestion.
    const index = infoOpener?.dataset.index;
    infoOpener = null;
    const again = index != null ? list.querySelector(`button.suggestion-info-open[data-index="${index}"]`) : null;
    again?.focus();
  });

  // The dropdown: pick a number, the row goes there.
  list.addEventListener('change', (e) => {
    const li = e.target.closest('li.suggestion');
    if (!li || !state) return;
    if (e.target.matches('select.place')) move(placeOf(li), Number(e.target.value) - 1);
    else if (e.target.matches('.keep input')) {
      // While filing, the plan is already made: a tick now would not be what was filed.
      if (filing) { e.target.checked = !e.target.checked; return; }
      const i = Number(li.dataset.index);
      state.dropped = e.target.checked ? state.dropped.filter((d) => d !== i) : [...new Set([...state.dropped, i])];
      save();
    }
  });
  // The keyboard: the arrow keys on a row's handle move it up or down one, Home and End to the ends.
  list.addEventListener('keydown', (e) => {
    if (!e.target.matches('.drag-handle') || !state) return;
    const from = placeOf(e.target.closest('li.suggestion'));
    const to = { ArrowUp: from - 1, ArrowDown: from + 1, Home: 0, End: state.order.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    move(from, to, true);
  });
  // The mouse: drag a row onto another and it takes that row's place.
  let dragging = null;
  list.addEventListener('dragstart', (e) => {
    const li = e.target.closest?.('li.suggestion');
    if (!li || filing) return;
    dragging = placeOf(li);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', li.dataset.index);
    li.classList.add('dragging');
  });
  list.addEventListener('dragover', (e) => {
    if (dragging == null || !e.target.closest('li.suggestion')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  });
  list.addEventListener('drop', (e) => {
    const li = e.target.closest('li.suggestion');
    if (dragging == null || !li) return;
    e.preventDefault();
    const from = dragging;
    dragging = null;
    move(from, placeOf(li));
  });
  list.addEventListener('dragend', () => {
    dragging = null;
    for (const li of list.querySelectorAll('.dragging')) li.classList.remove('dragging');
  });

  // File in This Order: file what is kept and not yet filed, then put the kept ones still waiting in order.
  fileButton.addEventListener('click', async () => {
    if (!state || filing || running) return;
    const plan = filingPlan(state);
    if (!plan.kept.length) {
      say(fileNote, 'Tick at least one suggestion to file.', 'error');
      return;
    }
    filing = true;
    fileButton.disabled = true;
    run.disabled = true;
    const done = (text, kind) => {
      filing = false;
      fileButton.disabled = running;
      run.disabled = running;
      // A run that answered while filing is drawn now, over the rows just filed from.
      if (held !== undefined) {
        const latest = held;
        held = undefined;
        show(latest);
      } else drawRows();
      say(fileNote, text, kind);
    };
    const filedNow = [];
    const unchecked = [];
    const named = () => (filedNow.length ? `Filed ${andList(filedNow)}. ` : '');
    const uncheckedLine = () => (unchecked.length
      ? `The project check could not run for ${andList(unchecked.map((t) => `"${t}"`))}, so ${unchecked.length === 1 ? 'it' : 'they'} went into the project shown. `
      : '');
    for (const i of plan.file) {
      const s = suggestions[i];
      say(fileNote, `${named()}Checking the project for "${s.title}"…`);
      // The same check as Add Task; one that cannot run files here, and the note says so.
      let suggest = null;
      try {
        ({ suggest } = await api('POST', `/projects/${encodeURIComponent(slug)}/tickets/check`, { name: s.title, description: s.description ?? '' }));
      } catch (err) {
        if (err instanceof SignedOut) return drawSignIn(`You were signed out; ${filedNow.length ? `${andList(filedNow)} ${filedNow.length === 1 ? 'was' : 'were'} filed and the rest were not` : 'nothing was filed'}. Press File in This Order again once signed in.`);
        unchecked.push(s.title);
      }
      let into = slug;
      if (suggest) {
        const choice = await askProject(question, suggest);
        if (choice === 'move') into = suggest.slug;
        else if (choice !== 'keep') return done(`${named()}${uncheckedLine()}Stopped before "${s.title}": nothing more was filed, and no order was set. Press File in This Order again to go on.`, 'error');
      }
      say(fileNote, `${named()}Filing "${s.title}"…`);
      let ticket;
      try {
        ticket = await api('POST', `/projects/${encodeURIComponent(into)}/tickets`, { name: s.title, description: s.description ?? '', status: 'Requested' });
      } catch (err) {
        if (err instanceof SignedOut) return drawSignIn(`You were signed out; "${s.title}" may not have been filed. Check the Requested stage before pressing File in This Order again.`);
        return done(`${named()}${uncheckedLine()}Not filed: "${s.title}": ${err instanceof Refused ? err.message : SUGGEST_NEXT_UNANSWERED} No order was set. Press File in This Order again to file the rest.`, 'error');
      }
      // Kept at once, so a retry never files it again.
      state.filed[i] = { id: ticket.id, project: into };
      save();
      filedNow.push(ticket.id);
    }
    // Tickets an earlier press filed may have moved on since: read each back, so only the ones still waiting get a place.
    const now = {};
    const fresh = new Set(plan.file);
    for (const i of plan.kept) {
      if (fresh.has(i) || !state.filed[i]) continue;
      const f = state.filed[i];
      try {
        now[i] = await api('GET', `/tickets/${encodeURIComponent(f.id)}`, undefined, { unrecorded: true });
      } catch (err) {
        if (err instanceof SignedOut) return drawSignIn(`You were signed out; ${named() || 'nothing new was filed. '}Their order was not set: press File in This Order again once signed in.`);
        if (err instanceof Refused && err.status === 404) { now[i] = null; continue; }
        return done(`${named()}${uncheckedLine()}Their order was not set: ${f.id} could not be read (${err instanceof Refused ? err.message : SUGGEST_NEXT_UNANSWERED}) Press File in This Order again: nothing is filed twice.`, 'error');
      }
    }
    const order = orderPlan(plan.kept, state.filed, now);
    // A ticket that is gone is unticked, so no later press names it and every later order call can still work.
    if (order.gone.length) {
      state.dropped = [...new Set([...state.dropped, ...order.gone.map((g) => g.index)])];
      save();
    }
    const aside = [
      order.leftAlone.length ? `${andList(order.leftAlone.map((t) => t.id))} ${order.leftAlone.length === 1 ? 'is' : 'are'} already past Requested, so ${order.leftAlone.length === 1 ? 'its' : 'their'} place was left alone.` : '',
      order.gone.length ? `${andList(order.gone.map((t) => t.id))} ${order.gone.length === 1 ? 'is' : 'are'} no longer in this project (deleted or moved), so ${order.gone.length === 1 ? 'it was' : 'they were'} left out of the order and unticked.` : '',
    ].filter(Boolean).join(' ');
    say(fileNote, `${named()}Setting their order…`);
    for (const [project, ids] of order.byProject) {
      try {
        await api('POST', `/projects/${encodeURIComponent(project)}/tickets/order`, { ids });
      } catch (err) {
        if (err instanceof SignedOut) return drawSignIn(`You were signed out; ${named() || 'nothing new was filed. '}Their order was not set: press File in This Order again once signed in.`);
        return done(`${named()}${uncheckedLine()}Their order was not set (${andList(ids)}): ${err instanceof Refused ? err.message : SUGGEST_NEXT_UNANSWERED} Press File in This Order again: nothing is filed twice.`, 'error');
      }
    }
    const ordered = [...order.byProject.values()].flat();
    const inOrder = ordered.length ? `In order: ${ordered.join(', ')}.` : 'No order was set: none of them is still in Requested.';
    done(`${named() || 'Nothing new to file. '}${uncheckedLine()}${inOrder}${aside ? ` ${aside}` : ''}`, unchecked.length || order.gone.length ? 'error' : 'quiet');
    // The new tickets show in their stage once the page reads again; the box keeps its rows and says what was filed.
    const note = fileNote.textContent;
    const noteKind = fileNote.classList.contains('error') ? 'error' : 'quiet';
    try {
      await drawAgain(() => drawProject(slug, view));
      const again = main.querySelector('details.add-task .suggest-next');
      if (again) {
        again.closest('details.add-task').open = true;
        const n = again.querySelector('.file-note');
        n.classList.remove('quiet', 'error');
        n.classList.add(noteKind);
        n.textContent = note;
      }
    } catch (err) {
      if (err instanceof SignedOut) return drawSignIn(`You were signed out after filing: ${note}`);
    }
  });

  // On opening the page: the last list, on its own.
  (async () => {
    const latest = await read();
    if (!latest || !box.isConnected) return;
    show(latest);
    // Only on the Suggest side: a run or unfiled rows never flip the checkbox (SP-303).
    if (mayOpen && savedSuggestSwitch() && (running || (latest.state === 'done' && state && filingPlan(state).file.length))) fold.open = true;
  })();
}

/**
 * Ask in the Tasks page's question box whether the task belongs to
 * `suggest`, the project its words fit better. Answers 'move' (File in X),
 * 'keep' (Keep in the project shown) or '' (closed: file nothing).
 */
function askProject(question, suggest, keepName = null) {
  question.querySelector('.project-name').textContent = suggest.name;
  question.querySelector('button[value="move"]').textContent = `File in ${suggest.name}`;
  // All Projects: Keep names the project picked in the box, not the page's.
  if (keepName) question.querySelector('button[value="keep"]').textContent = `Keep in ${keepName}`;
  question.returnValue = '';
  return new Promise((resolve) => {
    question.addEventListener('close', () => resolve(question.returnValue), { once: true });
    question.showModal();
  });
}
