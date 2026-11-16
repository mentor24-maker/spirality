/**
 * The Topics page (/topics): a project's topics and tags.
 *
 * Part of Dane's page: app.mjs is the entry the page loads, holds what
 * every page shares (signing in, the API call, the header, routing and the
 * message strip) and imports this file. Moved out of app.mjs unchanged
 * (Spirality SP-352), so a ticket that changes one page no longer edits the
 * same file as a ticket that changes another.
 */
import { renderTopics, renderTopicEditRow, topicDeleteQuestion, renderTagEditRow, tagDeleteQuestion, tagAddressable } from './render.mjs';
import { api, setTitle, putTrail, main, savedProject, SignedOut, when, drawAgain, drawSignIn, showError, PROJECT_KEY, PROJECT_NAME_KEY, showProject } from './app.mjs';

/**
 * The Topics page (SP-243): the topics of the project picked here (or on
 * the Projects page, else the first) and a Create Topic form, beside the
 * project's tags and a Create Tag form (SP-307, SP-309; tags that cannot be
 * read say so in the Tags half and leave Topics working). Picking another
 * project here selects it, as the Tasks page's picker does. A blank name is
 * refused on the page before anything is sent; after a create the list is
 * read again, and the page says it worked only when the new topic or tag is
 * on it. `done` and `problem` are the line the last create left, and
 * `problemIn` which form it came from.
 */
export async function drawTopics(done = '', problem = '', problemIn = 'topic') {
  const { projects } = await api('GET', '/projects');
  setTitle('Topics · Tracker');
  putTrail([{ label: 'Topics' }]);
  if (!projects.length) {
    main.innerHTML = '<h1>Topics</h1><p class="quiet">There are no projects yet.</p>';
    return;
  }
  const project = projects.find((p) => p.slug === savedProject()) ?? projects[0];
  const topicsPath = `/projects/${encodeURIComponent(project.slug)}/topics`;
  const tagsPath = `/projects/${encodeURIComponent(project.slug)}/tags`;
  const [{ topics }, tags] = await Promise.all([
    api('GET', topicsPath),
    api('GET', tagsPath).then((r) => (Array.isArray(r?.tags) ? r.tags : null), (err) => { if (err instanceof SignedOut) throw err; return null; }),
  ]);
  main.innerHTML = renderTopics({ projects, project, topics, tags }, { timeOf: when, done, problem, problemIn });
  const note = main.querySelector('.topic-note');
  const say = (text, failed = false) => { note.className = `note topic-note ${failed ? 'error' : 'quiet'}`; note.textContent = text; };
  const again = (text, failed, from = 'topic') => drawAgain(() => drawTopics(failed ? '' : text, failed ? text : '', from))
    .catch((err) => (err instanceof SignedOut ? drawSignIn() : showError(err)));
  main.querySelector('.project-picker select').addEventListener('change', (e) => {
    const chosen = projects.find((p) => p.slug === e.target.value);
    if (!chosen) return;
    try {
      localStorage.setItem(PROJECT_KEY, chosen.slug);
      localStorage.setItem(PROJECT_NAME_KEY, chosen.name);
    } catch { /* the page still works; it is only not remembered */ }
    showProject();
    again('', false);
  });
  const form = main.querySelector('form.create-topic');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = form.querySelector('#topic-name').value.trim();
    const description = form.querySelector('#topic-description').value.trim();
    const button = form.querySelector('button');
    if (!name) return say('Not created: a topic needs a name.', true);
    button.disabled = true;
    say(`Creating ${name}…`);
    let made;
    try {
      made = await api('POST', topicsPath, { name, description });
    } catch (err) {
      if (err instanceof SignedOut) return drawSignIn(`You were signed out; ${name} was not created.`);
      button.disabled = false;
      return say(`Not created: ${err.message}`, true);
    }
    const back = await api('GET', topicsPath, undefined, { unrecorded: true }).catch(() => null);
    const listed = back?.topics?.some((t) => t.id === made.id);
    again(listed ? `Created ${made.name} in ${project.name}.` : `The tracker said ${made.name} was created, but ${back ? 'it is not listed when read back' : 'the list could not be read back'}.`, !listed);
  });
  // SP-309: Add Tag, the same way: refused blank before sending, said to
  // have worked only when the tag reads back on the list with 0 tasks.
  const tagForm = main.querySelector('form.create-tag');
  tagForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = tagForm.querySelector('#tag-name').value.trim();
    const description = tagForm.querySelector('#tag-description').value.trim();
    const button = tagForm.querySelector('button');
    if (!name) return say('Not created: a tag needs a name.', true);
    button.disabled = true;
    say(`Creating ${name}…`);
    let made;
    try {
      made = await api('POST', tagsPath, { name, description });
    } catch (err) {
      if (err instanceof SignedOut) return drawSignIn(`You were signed out; ${name} was not created.`);
      button.disabled = false;
      return say(`Not created: ${err.message}`, true);
    }
    const back = await api('GET', tagsPath, undefined, { unrecorded: true }).catch(() => null);
    const listed = back?.tags?.some((t) => t.name === made.name && t.count === 0);
    again(listed ? `Created the tag ${made.name} in ${project.name}.` : `The tracker said the tag ${made.name} was created, but ${back ? 'it is not listed when read back' : 'the list could not be read back'}.`, !listed, 'tag');
  });
  wireTopicRows(project, topics, topicsPath, say, again);
  if (Array.isArray(tags)) wireTagRows(project, tags, tagsPath, say, again);
}

/**
 * SP-310: each Tags row's Edit and Delete, as wireTopicRows does for
 * topics. Edit draws the row as Name and Description boxes (a blank name is
 * refused before anything is sent); Cancel draws the page again. Delete asks
 * first, naming how many tasks carry the tag. After either, the list is read
 * again and the page says it worked only when the read-back shows it: the
 * new name and words with the same task count for an edit, the tag gone for
 * a delete. A tag named "." or ".." is refused on the page (tagAddressable).
 */
function wireTagRows(project, tags, tagsPath, say, again) {
  const byName = new Map(tags.map((t) => [t.name, t]));
  const pathOf = (name) => `${tagsPath}/${encodeURIComponent(name)}`;
  const readBack = () => api('GET', tagsPath, undefined, { unrecorded: true }).catch((err) => { if (err instanceof SignedOut) throw err; return null; });
  const unsendable = (tag) => (tagAddressable(tag.name) ? '' : `the tag ${tag.name} cannot be changed here; take it off its tasks on the List view.`);
  const editButtons = [...main.querySelectorAll('button[data-edit-tag]')];
  editButtons.forEach((button, index) => {
    button.addEventListener('click', () => {
      const tag = byName.get(button.dataset.editTag);
      const row = button.closest('tr');
      if (!tag || !row) return;
      if (unsendable(tag)) return say(`Not changed: ${unsendable(tag)}`, true);
      row.innerHTML = renderTagEditRow(tag, index);
      const form = row.querySelector('form.edit-tag');
      form.querySelector('input').focus();
      form.querySelector('.cancel-edit').addEventListener('click', () => again('', false, 'tag'));
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = form.querySelector('input[name="name"]').value.trim();
        const description = form.querySelector('textarea[name="description"]').value.trim();
        if (!name) return say('Not saved: a tag needs a name.', true);
        for (const control of form.querySelectorAll('button')) control.disabled = true;
        say(`Saving ${name}…`);
        let changed;
        try {
          changed = await api('PATCH', pathOf(tag.name), { name, description });
        } catch (err) {
          if (err instanceof SignedOut) return drawSignIn(`You were signed out; ${tag.name} was not saved.`);
          for (const control of form.querySelectorAll('button')) control.disabled = false;
          return say(`Not saved: ${err.message}`, true);
        }
        let back;
        try { back = await readBack(); } catch { return drawSignIn(); }
        const listed = back?.tags?.find((x) => x.name === name);
        const oldGone = name === tag.name || !back?.tags?.some((x) => x.name === tag.name);
        const ok = Boolean(listed && oldGone && listed.description === description && listed.count === tag.count);
        const n = changed?.tickets?.length ?? 0;
        const moved = name === tag.name ? '' : ` (was ${tag.name}${n ? `, on ${n === 1 ? '1 task' : `${n} tasks`}` : ''})`;
        again(ok
          ? `Saved the tag ${name}${moved}.`
          : `The tracker said the tag ${name} was saved, but ${back ? 'the list does not show it that way when read back' : 'the list could not be read back'}.`, !ok, 'tag');
      });
    });
  });
  for (const button of main.querySelectorAll('button[data-delete-tag]')) {
    button.addEventListener('click', async () => {
      const tag = byName.get(button.dataset.deleteTag);
      if (!tag) return;
      if (unsendable(tag)) return say(`Not deleted: ${unsendable(tag)}`, true);
      if (!confirm(tagDeleteQuestion(tag))) return;
      button.disabled = true;
      say(`Deleting ${tag.name}…`);
      let gone;
      try {
        gone = await api('DELETE', pathOf(tag.name));
      } catch (err) {
        if (err instanceof SignedOut) return drawSignIn(`You were signed out; ${tag.name} was not deleted.`);
        button.disabled = false;
        return say(`Not deleted: ${err.message}`, true);
      }
      let back;
      try { back = await readBack(); } catch { return drawSignIn(); }
      const stillThere = !back || back.tags?.some((x) => x.name === tag.name);
      const n = gone?.tickets?.length ?? 0;
      again(stillThere
        ? `The tracker said the tag ${tag.name} was deleted, but ${back ? 'it is still listed when read back' : 'the list could not be read back'}.`
        : `Deleted the tag ${tag.name} from ${project.name}${n ? ` and from the ${n === 1 ? '1 task' : `${n} tasks`} that carried it` : ''}.`, stillThere, 'tag');
    });
  }
}

/**
 * SP-308: each Topics row's Edit and Delete. Edit draws the row as Name and
 * Description boxes (a blank name is refused before anything is sent);
 * Cancel draws the page again. Delete asks first, naming how many tasks
 * carry the topic. After either, the list is read again and the page says
 * it worked only when the read-back shows it: the new words for an edit,
 * the topic gone for a delete.
 */
function wireTopicRows(project, topics, topicsPath, say, again) {
  const byId = new Map(topics.map((t) => [String(t.id), t]));
  const readBack = () => api('GET', topicsPath, undefined, { unrecorded: true }).catch((err) => { if (err instanceof SignedOut) throw err; return null; });
  for (const button of main.querySelectorAll('button[data-edit-topic]')) {
    button.addEventListener('click', () => {
      const topic = byId.get(button.dataset.editTopic);
      const row = button.closest('tr');
      if (!topic || !row) return;
      row.innerHTML = renderTopicEditRow(topic);
      const form = row.querySelector('form.edit-topic');
      form.querySelector('input').focus();
      form.querySelector('.cancel-edit').addEventListener('click', () => again('', false));
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = form.querySelector('input[name="name"]').value.trim();
        const description = form.querySelector('textarea[name="description"]').value.trim();
        if (!name) return say('Not saved: a topic needs a name.', true);
        for (const control of form.querySelectorAll('button')) control.disabled = true;
        say(`Saving ${name}…`);
        try {
          await api('PATCH', `${topicsPath}/${encodeURIComponent(topic.id)}`, { name, description });
        } catch (err) {
          if (err instanceof SignedOut) return drawSignIn(`You were signed out; ${topic.name} was not saved.`);
          for (const control of form.querySelectorAll('button')) control.disabled = false;
          return say(`Not saved: ${err.message}`, true);
        }
        let back;
        try { back = await readBack(); } catch { return drawSignIn(); }
        const listed = back?.topics?.find((x) => x.id === topic.id);
        const ok = listed && listed.name === name && listed.description === description;
        again(ok ? `Saved ${name}.` : `The tracker said ${name} was saved, but ${back ? 'the list does not show the new words when read back' : 'the list could not be read back'}.`, !ok);
      });
    });
  }
  for (const button of main.querySelectorAll('button[data-delete-topic]')) {
    button.addEventListener('click', async () => {
      const topic = byId.get(button.dataset.deleteTopic);
      if (!topic || !confirm(topicDeleteQuestion(topic))) return;
      button.disabled = true;
      say(`Deleting ${topic.name}…`);
      let gone;
      try {
        gone = await api('DELETE', `${topicsPath}/${encodeURIComponent(topic.id)}`);
      } catch (err) {
        if (err instanceof SignedOut) return drawSignIn(`You were signed out; ${topic.name} was not deleted.`);
        button.disabled = false;
        return say(`Not deleted: ${err.message}`, true);
      }
      let back;
      try { back = await readBack(); } catch { return drawSignIn(); }
      const stillThere = !back || back.topics?.some((x) => x.id === topic.id);
      const n = gone?.tickets?.length ?? 0;
      again(stillThere
        ? `The tracker said ${topic.name} was deleted, but ${back ? 'it is still listed when read back' : 'the list could not be read back'}.`
        : `Deleted ${topic.name} from ${project.name}${n ? ` and from the ${n === 1 ? '1 task' : `${n} tasks`} that carried it` : ''}.`, stillThere);
    });
  }
}
