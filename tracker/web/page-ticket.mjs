/**
 * The ticket page (/t/<id>): one ticket, its trail, comments and actions, and its edit panel.
 *
 * Part of Dane's page: app.mjs is the entry the page loads, holds what
 * every page shares (signing in, the API call, the header, routing and the
 * message strip) and imports this file. Moved out of app.mjs unchanged
 * (Spirality SP-352), so a ticket that changes one page no longer edits the
 * same file as a ticket that changes another.
 */
import { closeQuestion, deleteQuestion, deleteRefusal, escapeHtml, mergeQuestion, renderCommands, renderComment, renderFilesMade, renderDeleteAction, renderEditPanel, loopHasIt, renderCommentForm, MOVED_MESSAGE, renderMarkdown, renderCloseAction, renderGoAction, goQuestion, renderBugReportActions, approveQuestion, rejectQuestion, changeProblem, REJECT_COMMENT, WONT_DO_TAG, renderMergeAction, renderAnswerIn, renderHeldUp, renderSharedFiles, renderReplyForm, statusLabel, renderQuickAction } from './render.mjs';
import { api, setTitle, when, me, renderAttachments, main, sinceTime, refreshing, putTrail, savedView, route, SignedOut, drawSignIn, drawAgain, Refused, showMessage } from './app.mjs';
import { field } from './page-projects.mjs';
import { wireCopyButtons } from './page-tasks.mjs';

/**
 * One ticket. A person signed in also gets the Change panel above the
 * description: each change is sent on its own with the ticket's version as
 * `ifVersion`, and the page is then drawn again from the server, so what it
 * shows is what was stored. `said` is a line to show after that redraw:
 * `{ field, text, error }`, `field` naming the note it goes in (none: the
 * panel's own note at its top). `kept` is what was typed and not saved
 * when a save redrew the page (wireEditPanel's `typed`), put back as it was.
 */
export async function drawTicket(id, said = null, kept = null) {
  const [t, { projects }] = await Promise.all([
    api('GET', `/tickets/${encodeURIComponent(id)}/thread`),
    api('GET', '/projects'),
  ]);
  const others = projects.filter((p) => p.slug !== t.project);
  setTitle(`${t.name} · Tracker`);
  const comments = t.comments.map((c) => `
    <article class="comment${c.machine ? ' machine' : ''}">
      <div class="by">
        <span class="author">${escapeHtml(c.author.name)}</span>${c.machine ? '<span class="tag">loop</span>' : ''}
        · ${escapeHtml(when(c.createdAt))}${c.parent != null ? ` · a reply to comment ${escapeHtml(c.parent)}` : ''}
      </div>
      ${renderComment(c.body, { operatorName: me?.name })}
    </article>`).join('');
  // The ticket itself: what Details holds. While a loop has it (SP-291) nothing
  // asks him for a reply, so this goes in the right column, open, with the
  // Add Comment box under the comments; in his two statuses it stays folded
  // under Details, closed until he opens it, below the ask and the reply box.
  const inline = loopHasIt(t);
  const ticketBody = `
      <p class="meta">
        <span>${escapeHtml(t.id)}</span><span>${escapeHtml(t.projectName)}</span>
        <span>${escapeHtml(statusLabel(t))}</span>
        <span>${t.assignee ? `assigned to ${escapeHtml(t.assignee.name)}` : 'not assigned'}</span>
      </p>
      ${renderSharedFiles(t)}
      ${me?.kind === 'human' ? renderEditPanel(t) : ''}
      <section class="description">${renderMarkdown(t.description) || '<p class="quiet">No description.</p>'}</section>
      ${renderAttachments(t)}
      <h2 id="comments">Comments</h2>
      ${comments || '<p class="quiet">No comments yet.</p>'}
      ${renderCommentForm(t)}
      <h2>Copy to Another Project</h2>
      ${others.length ? `
      <form class="copy">
        <p class="hint" id="copy-to-hint">A new ticket with this title and description, in Requested there. This ticket stays exactly as it is.</p>
        <div class="row">
          <label for="copy-to">Copy To</label>
          <select id="copy-to" aria-describedby="copy-to-hint">${others.map((p) => `<option value="${escapeHtml(p.slug)}">${escapeHtml(p.name)}</option>`).join('')}</select>
          <button type="submit" class="btn">Copy</button><span class="note"></span>
        </div>
      </form>` : '<p class="quiet">There is no other project to copy into yet.</p>'}`;
  main.innerHTML = `
    <section class="quick${inline ? ' loop-has' : ''}">
      ${renderHeldUp(t, sinceTime)}
      <div class="ask">${renderQuickAction(t)}</div>
      <div class="act">
      ${renderCommands(t)}
      ${renderAnswerIn(t)}
      ${renderMergeAction(t)}
      ${renderCloseAction(t)}
      ${renderGoAction(t)}
      ${renderBugReportActions(t)}
      ${renderReplyForm(t, me?.name)}
      ${inline ? `<div class="details">${ticketBody}</div>` : ''}
      ${renderDeleteAction(t)}
      </div>
    </section>
    ${renderFilesMade(t)}
    ${inline ? '' : `<details class="details">
      <summary>Details</summary>${ticketBody}
    </details>`}`;
  // Details, when it is a fold (his two statuses), opened; while a loop has it there is nothing to open.
  const openDetails = () => {
    const fold = main.querySelector('details.details');
    if (fold) fold.open = true;
  };
  wireCopyButtons();
  // Arrived by the bus count in the header: open the fold at the comments, where the posts are.
  if (location.hash === '#comments' && !refreshing) {
    openDetails();
    document.getElementById('comments').scrollIntoView({ block: 'start' });
  }
  // The ticket's own project, in the view last used; then the ticket; then this page of it.
  putTrail([
    { label: t.projectName, href: `/${savedView()}/${encodeURIComponent(t.project)}` },
    { label: `Task ${t.id}`, href: `/t/${encodeURIComponent(t.id)}` },
    { label: 'Details' },
  ]);
  // SP-290: the status line's "i" opens and closes on a tap or Enter; hover and keyboard focus show it too (app.css).
  const statusInfo = main.querySelector('.status-info');
  statusInfo?.addEventListener('click', () => statusInfo.setAttribute('aria-expanded', String(statusInfo.getAttribute('aria-expanded') !== 'true')));
  statusInfo?.addEventListener('keydown', (e) => { if (e.key === 'Escape') statusInfo.setAttribute('aria-expanded', 'false'); });
  const copyForm = main.querySelector('form.copy');
  copyForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = copyForm.querySelector('button');
    const copyNote = copyForm.querySelector('.note');
    button.disabled = true;
    copyNote.className = 'note quiet';
    copyNote.textContent = 'Copying…';
    try {
      const copy = await api('POST', `/tickets/${encodeURIComponent(t.id)}/clone`, { project: copyForm.querySelector('#copy-to').value });
      history.pushState(null, '', `/t/${encodeURIComponent(copy.id)}`);
      await route();
    } catch (err) {
      if (err instanceof SignedOut) return drawSignIn('You were signed out; the ticket was not copied.');
      copyNote.className = 'note error';
      copyNote.textContent = `Not copied: ${err.message}`;
      button.disabled = false;
    }
  });
  // After any successful post from this page (the reply box, Merge, Close,
  // Go): Details open so the new reply is there when he scrolls down, and
  // the page kept at the top.
  const afterPost = () => {
    openDetails();
    window.scrollTo(0, 0);
  };
  // Merge, Close and Go: his word from the server (the project config's merge
  // phrase, the relay's close word, the intake card's go word), posted as his own reply through the
  // same call the reply box uses. The relay acts on it; the page never moves
  // a status itself.
  const wordButton = (selector, question, word, signedOut) => {
    const form = main.querySelector(selector);
    form?.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!confirm(question)) return;
      const button = form.querySelector('button');
      const note = form.querySelector('.note');
      button.disabled = true;
      note.className = 'note quiet';
      note.textContent = 'Posting…';
      try {
        await api('POST', `/tickets/${encodeURIComponent(t.id)}/comments`, { body: word });
        await drawAgain(() => drawTicket(t.id));
        afterPost();
      } catch (err) {
        if (err instanceof SignedOut) return drawSignIn(signedOut);
        note.className = 'note error';
        note.textContent = `Not posted: ${err.message}`;
        button.disabled = false;
      }
    });
  };
  wordButton('form.merge-action', mergeQuestion(t), t.mergePhrase, 'You were signed out; the merge word was not posted.');
  wordButton('form.close-action', closeQuestion(t), t.closePhrase, 'You were signed out; the close word was not posted.');
  wordButton('form.go-action', goQuestion(t), t.goPhrase, 'You were signed out; your go was not posted.');
  // A held bug report's Approve and Reject (SP-287): his own status changes,
  // the same PATCH the Change panel sends, guarded on the status and version
  // the page was drawn with, and each read back. Reject is two writes: the
  // status and the wont-do tag together (one change, so never one without the
  // other), then the note. A write that fails says which, and the page is not
  // redrawn over it; nothing is ever reported as done that did not stick.
  const bugButton = (selector, question, steps) => {
    const form = main.querySelector(selector);
    form?.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!confirm(question)) return;
      const buttons = [...main.querySelectorAll('form.approve-action button, form.reject-action button')];
      const note = form.querySelector('.note');
      for (const b of buttons) b.disabled = true;
      note.className = 'note quiet';
      note.textContent = 'Saving…';
      const fail = (text) => {
        note.className = 'note error';
        note.textContent = text;
      };
      let done = 0;
      for (const step of steps) {
        let problem;
        try {
          problem = await step.write();
        } catch (err) {
          if (err instanceof SignedOut) return drawSignIn(`You were signed out; ${step.what} was not saved.`);
          if (err instanceof Refused && err.status === 409) {
            return fail(`Not saved: ${step.what}. This ticket changed since the page was drawn (a loop moved it, or another page saved first), so nothing was overwritten. Reload to see it as it is now.`);
          }
          problem = err.message;
        }
        if (problem) {
          // Before the first write lands nothing has changed, so the buttons come back; after it, the ticket has moved, so only a reload is offered.
          if (!done) for (const b of buttons) b.disabled = false;
          const saved = steps.slice(0, done).map((s) => s.what).join(' and ');
          return fail(`Not saved: ${step.what}: ${problem.replace(/\.$/, '')}.${done ? ` ${saved.replace(/^./, (c) => c.toUpperCase())} did save. Reload to see the ticket as stored.` : ''}`);
        }
        done += 1;
      }
      try {
        await drawAgain(() => drawTicket(t.id));
        afterPost();
      } catch (err) {
        if (err instanceof SignedOut) return drawSignIn('You were signed out; the change was saved, but the page could not show it.');
        fail(`Saved, but the page could not refresh (${err.message}). Reload to see the ticket as stored.`);
      }
    });
  };
  const patch = (fields) => api('PATCH', `/tickets/${encodeURIComponent(t.id)}`, { ...fields, ifStatus: t.status, ifVersion: t.version });
  bugButton('form.approve-action', approveQuestion(t), [
    { what: 'the move to Requested', write: async () => changeProblem(await patch({ status: 'requested' }), { status: 'requested' }) },
  ]);
  bugButton('form.reject-action', rejectQuestion(t), [
    {
      what: `the move to Live with the ${WONT_DO_TAG} tag`,
      write: async () => changeProblem(await patch({ status: 'live', tags: [...new Set([...t.tags, WONT_DO_TAG])] }), { status: 'live', tags: [WONT_DO_TAG] }),
    },
    {
      what: 'the note saying nothing shipped',
      write: async () => {
        const posted = await api('POST', `/tickets/${encodeURIComponent(t.id)}/comments`, { body: REJECT_COMMENT });
        return posted?.body === REJECT_COMMENT ? '' : 'the tracker did not answer with the note as posted.';
      },
    },
  ]);
  // Delete: ask first, naming the ticket; on success go to its project's list.
  const deleteForm = main.querySelector('form.delete-action');
  deleteForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!confirm(deleteQuestion(t))) return;
    const button = deleteForm.querySelector('button');
    const deleteNote = deleteForm.querySelector('.note');
    button.disabled = true;
    deleteNote.className = 'note quiet';
    deleteNote.textContent = 'Deleting…';
    try {
      await api('DELETE', `/tickets/${encodeURIComponent(t.id)}`);
    } catch (err) {
      if (err instanceof SignedOut) return drawSignIn(`You were signed out; ${t.id} was not deleted.`);
      deleteNote.className = 'note error';
      deleteNote.textContent = deleteRefusal(t.id, err);
      button.disabled = false;
      return;
    }
    history.pushState(null, '', `/list/${encodeURIComponent(t.project)}`);
    await route();
  });
  const panel = wireEditPanel(t);
  if (kept) {
    // No box while his answer is in: nothing typed there to put back.
    const keptBox = main.querySelector('form.reply textarea, form.add-comment textarea');
    if (keptBox) keptBox.value = kept.reply;
    panel?.restore(kept);
  }
  if (said) {
    openDetails();
    const where = main.querySelector(said.field ? `.edit [data-note="${said.field}"]` : '.edit-note');
    if (where) {
      where.className = `note${said.error ? ' error' : ' quiet'}${said.field ? '' : ' edit-note'}`;
      where.textContent = said.text;
    } else if (STRIP_FIELDS[said.field]) {
      showMessage({ kind: said.error ? 'error' : 'success', text: `${STRIP_FIELDS[said.field]}: ${said.text}.` });
    }
  }
  // Add Comment (SP-291), on a ticket a loop has: posted exactly as typed
  // through the same call as the reply box, the page then drawn again from
  // the server so the comment shown is the one stored. A failed post says so
  // and keeps the words. A #reply address (the list's Reply icon) lands here.
  const commentForm = main.querySelector('form.add-comment');
  if (commentForm) {
    const commentBox = commentForm.querySelector('textarea');
    if (location.hash === '#reply' && !refreshing) {
      commentForm.scrollIntoView({ block: 'center' });
      commentBox.focus();
    }
    commentForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const button = commentForm.querySelector('button');
      const commentNote = commentForm.querySelector('.note');
      button.disabled = true;
      commentNote.className = 'note quiet';
      commentNote.textContent = 'Posting…';
      try {
        await api('POST', `/tickets/${encodeURIComponent(t.id)}/comments`, { body: commentBox.value });
      } catch (err) {
        if (err instanceof SignedOut) return drawSignIn('You were signed out; your comment was not posted.');
        commentNote.className = 'note error';
        commentNote.textContent = `Not posted: ${err.message}`;
        button.disabled = false;
        return;
      }
      try {
        await drawAgain(() => drawTicket(t.id));
        main.querySelector('form.add-comment')?.scrollIntoView({ block: 'center' });
      } catch (err) {
        if (err instanceof SignedOut) return drawSignIn('You were signed out; your comment was posted, but the page could not show it.');
        commentNote.className = 'note error';
        commentNote.textContent = `Posted, but the page could not refresh (${err.message}). Reload to see it.`;
      }
    });
  }
  // While his answer is in there is no reply box (renderReplyForm): the
  // notice is all the page says, and a #reply address just shows it.
  const form = main.querySelector('form.reply');
  if (!form) return;
  const box = form.querySelector('textarea');
  // Arrived by a Reply icon: go straight to the box.
  if (location.hash === '#reply' && !refreshing) {
    form.scrollIntoView({ block: 'center' });
    box.focus();
  }
  const note = form.querySelector('.note');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = form.querySelector('button');
    button.disabled = true;
    note.className = 'note quiet';
    note.textContent = 'Posting…';
    try {
      // Exactly as typed: no trimming, no formatting. "merge" arrives as "merge".
      await api('POST', `/tickets/${encodeURIComponent(t.id)}/comments`, { body: box.value });
      await drawAgain(() => drawTicket(t.id));
      afterPost();
    } catch (err) {
      if (err instanceof SignedOut) return drawSignIn('You were signed out; your reply was not posted.');
      note.className = 'note error';
      note.textContent = `Not posted: ${err.message}`;
      button.disabled = false;
    }
  });
}

/**
 * SP-345: the Change panel's class pickers, by field, with the label their
 * messages use. They write nothing beside themselves: a save reports in the
 * message strip (UI_DOCTRINE 7), through stripNote and drawTicket's `said`.
 */
const STRIP_FIELDS = Object.freeze({ kind: 'Kind', startedBy: 'Started By', outcome: 'How It Ended' });

/**
 * A stand-in for the element a save writes its progress into, for a picker
 * with none: "Saving…" is dropped (the panel is held meanwhile), and a
 * refusal or a failed redraw goes to the message strip as an error.
 */
function stripNote(field) {
  return {
    className: '',
    set textContent(text) {
      if (/\berror\b/.test(this.className)) showMessage({ kind: 'error', text: `${STRIP_FIELDS[field] ?? field}: ${text}` });
    },
  };
}

/**
 * The Change panel's controls (render.mjs renderEditPanel): selects save on
 * change, tags on add or remove, name and description on Save. Each sends
 * only its own field with `ifVersion: t.version`. One save at a time: the
 * whole panel is held while a save is in flight, so two quick changes never
 * both carry the same version and the second never reads as "has moved". A
 * 409 means a loop moved the ticket: the page says so, draws it again as
 * stored, and does not try again. Any other refusal shows the server's words
 * beside the field and keeps what was typed. Every redraw carries over what
 * is typed elsewhere on the page (the reply box, an open description edit,
 * an unsaved name or tag), so a save never wipes it.
 */
function wireEditPanel(t) {
  const panel = main.querySelector('details.edit');
  if (!panel) return;
  const descForm = panel.querySelector('form.edit-description');
  const editor = descForm.querySelector('.editor');
  const area = descForm.querySelector('textarea');
  const nameBox = panel.querySelector('input#edit-name');
  const tagBox = panel.querySelector('#edit-tag');
  // What is typed and not yet saved, except the field this save sends.
  const typed = (field) => ({
    reply: main.querySelector('form.reply textarea, form.add-comment textarea')?.value ?? '',
    tag: field === 'tags' ? '' : tagBox.value,
    name: field !== 'name' && nameBox && nameBox.value !== t.name ? nameBox.value : null,
    description: field !== 'description' && !editor.hidden ? area.value : null,
  });
  // Draw the ticket again; if that fails the save already happened (or was
  // refused), so say which, and leave the panel held: it shows an old version.
  const redraw = async (said, kept, note, outcome) => {
    try {
      await drawAgain(() => drawTicket(t.id, said, kept));
    } catch (err) {
      if (err instanceof SignedOut) return drawSignIn(`You were signed out; ${outcome}, but the page could not show it.`);
      note.className = 'note error';
      note.textContent = `The page could not refresh (${err.message}): ${outcome}. Reload to see the ticket as stored.`;
    }
  };
  let saving = false;
  const save = async (field, value, note) => {
    if (saving) return;
    saving = true;
    const held = [...panel.querySelectorAll('input, select, textarea, button')].filter((c) => !c.disabled);
    for (const c of held) c.disabled = true;
    note.className = 'note quiet';
    note.textContent = 'Saving…';
    try {
      await api('PATCH', `/tickets/${encodeURIComponent(t.id)}`, { [field]: value, ifVersion: t.version });
    } catch (err) {
      if (err instanceof SignedOut) return drawSignIn(`You were signed out; the ${field} was not saved.`);
      if (err instanceof Refused && err.status === 409) return redraw({ text: MOVED_MESSAGE, error: true }, typed(), note, `the ${field} was not saved`);
      note.className = 'note error';
      note.textContent = `Not saved: ${err.message}`;
      for (const c of held) c.disabled = false;
      saving = false;
      return;
    }
    await redraw({ field, text: 'Saved' }, typed(field), note, `the ${field} was saved`);
  };
  for (const select of panel.querySelectorAll('select[data-field]')) {
    select.addEventListener('change', () => {
      const { field } = select.dataset;
      const value = field === 'assignee' ? (select.value ? Number(select.value) : null) : (select.value || null);
      save(field, value, panel.querySelector(`[data-note="${field}"]`) ?? stripNote(field));
    });
  }
  const tagNote = panel.querySelector('[data-note="tags"]');
  tagBox.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const tag = tagBox.value.trim();
    if (!tag) return;
    if (t.tags.includes(tag)) {
      tagNote.className = 'note quiet';
      tagNote.textContent = `${tag} is already a tag.`;
      return;
    }
    save('tags', [...t.tags, tag], tagNote);
  });
  for (const button of panel.querySelectorAll('button.remove-tag')) {
    button.addEventListener('click', () => {
      save('tags', t.tags.filter((tag) => tag !== button.dataset.tag), tagNote);
    });
  }
  const nameForm = panel.querySelector('form.edit-name');
  nameForm.addEventListener('submit', (e) => {
    e.preventDefault();
    // Exactly as typed, the same rule as the reply box.
    if (nameBox) save('name', nameBox.value, nameForm.querySelector('[data-note="name"]'));
  });
  const shown = main.querySelector('section.description');
  const openEditor = () => {
    editor.hidden = false;
    shown.hidden = true;
  };
  descForm.querySelector('.edit-open').addEventListener('click', () => {
    openEditor();
    area.focus();
  });
  descForm.querySelector('.edit-cancel').addEventListener('click', () => {
    area.value = t.description ?? '';
    editor.hidden = true;
    shown.hidden = false;
  });
  descForm.addEventListener('submit', (e) => {
    e.preventDefault();
    save('description', area.value, descForm.querySelector('[data-note="description"]'));
  });
  return {
    // Put back what `typed` kept from the page before this redraw.
    restore(kept) {
      tagBox.value = kept.tag;
      if (kept.name != null && nameBox) nameBox.value = kept.name;
      if (kept.description != null) {
        area.value = kept.description;
        openEditor();
      }
    },
  };
}
