/**
 * The Topics page (page-topics.mjs): its topic and tag rows.
 *
 * Split out of render.mjs (SP-364), which re-exports it, so every importer
 * still names render.mjs. Its rule holds here too: every character of
 * ticket text is escaped before it is drawn.
 */
import { escapeHtml } from './render-common.mjs';
import { renderProjectPicker } from './render-tasks.mjs';

/**
 * SP-308: a Topics row being edited, drawn in place of the row: Name and
 * Description boxes holding the topic's words, then Save and Cancel. The
 * row keeps its `data-topic`, so the page finds it again. Every word escaped.
 */
export function renderTopicEditRow(t) {
  const id = escapeHtml(t.id);
  return `<td colspan="5" class="edit-topic-cell"><form class="edit-topic fields" data-topic="${id}">
      <label for="topic-name-${id}">Name</label>
      <input id="topic-name-${id}" name="name" maxlength="200" autocomplete="off" value="${escapeHtml(t.name)}">
      <label for="topic-description-${id}">Description</label>
      <textarea id="topic-description-${id}" name="description" rows="3" maxlength="5000">${escapeHtml(t.description ?? '')}</textarea>
      <div class="row"><button type="submit" class="btn btn-save btn-sm">Save</button><button type="button" class="btn btn-sm cancel-edit">Cancel</button></div>
    </form></td>`;
}

/** SP-308: the question asked before a topic is deleted, naming how many tasks carry it. */
export function topicDeleteQuestion(t) {
  const n = Number.isInteger(t?.tickets) && t.tickets > 0 ? t.tickets : 0;
  const carried = n === 0 ? 'No task carries it.' : `It comes off the ${n === 1 ? '1 task' : `${n} tasks`} that ${n === 1 ? 'carries' : 'carry'} it.`;
  return `Delete the topic ${t?.name ?? ''}? ${carried}`;
}

/**
 * SP-310: a Tags row being edited, drawn in place of the row: Name and
 * Description boxes holding the tag's words, then Save and Cancel. The row
 * keeps its `data-tag`, so the page finds it again. Every word escaped; the
 * boxes' ids are numbered by `index` (a tag's name may hold any character).
 */
export function renderTagEditRow(t, index = 0) {
  const n = Number.isInteger(index) && index >= 0 ? index : 0;
  return `<td colspan="4" class="edit-tag-cell"><form class="edit-tag fields" data-tag="${escapeHtml(t.name)}">
      <label for="tag-name-${n}">Name</label>
      <input id="tag-name-${n}" name="name" maxlength="100" autocomplete="off" value="${escapeHtml(t.name)}">
      <label for="tag-description-${n}">Description</label>
      <textarea id="tag-description-${n}" name="description" rows="3" maxlength="5000">${escapeHtml(t.description ?? '')}</textarea>
      <div class="row"><button type="submit" class="btn btn-save btn-sm">Save</button><button type="button" class="btn btn-sm cancel-edit">Cancel</button></div>
    </form></td>`;
}

/** SP-310: the question asked before a tag is deleted, naming how many tasks carry it. */
export function tagDeleteQuestion(t) {
  const n = Number.isInteger(t?.count) && t.count > 0 ? t.count : 0;
  const carried = n === 0 ? 'No task carries it.' : `It comes off the ${n === 1 ? '1 task' : `${n} tasks`} that ${n === 1 ? 'carries' : 'carry'} it.`;
  return `Delete the tag ${t?.name ?? ''}? ${carried}`;
}

/**
 * Whether a tag's name can be sent in an address: "." and ".." are folded
 * away by the browser (a request for one would reach another address), so
 * the page refuses to change or delete them by address.
 */
export function tagAddressable(name) {
  return typeof name === 'string' && name !== '' && name !== '.' && name !== '..';
}

/**
 * The Topics page (SP-243), in two equal halves (SP-307): Topics on the
 * left, Tags on the right; a narrow screen stacks them, Topics first
 * (app.css). Each half opens with its add form folded shut (a "colex", a
 * <details>): Add Topic, and Add Tag (SP-309). Then the Topics half lists
 * the picked project's topics, newest first, each with its description,
 * maker and time, and the Tags half every tag the project has saved or
 * uses, alphabetically, each with its description and how many tasks carry
 * it (`tags`, from GET /projects/<slug>/tags; null when they could not be
 * read). `done` and `problem` are the line the last create left; when
 * `problem` is set, the form it came from (`problemIn`, 'topic' or 'tag')
 * is drawn open, so a refused create is not hidden away. `timeOf` puts a
 * time in words. Every name, description and tag is escaped.
 */
export function renderTopics({ projects, project, topics = [], tags = [] }, { timeOf, done = '', problem = '', problemIn = 'topic' } = {}) {
  const row = (t) => `<tr data-topic="${escapeHtml(t.id)}">
      <td class="name">${escapeHtml(t.name)}</td>
      <td class="about">${t.description ? escapeHtml(t.description) : '<span class="quiet">none</span>'}</td>
      <td class="by">${t.createdByName ? escapeHtml(t.createdByName) : '<span class="quiet">unknown</span>'}</td>
      <td class="when">${escapeHtml(timeOf(t.createdAt))}</td>
      <td class="actions"><button type="button" class="btn btn-sm edit-topic" data-edit-topic="${escapeHtml(t.id)}" aria-label="Edit ${escapeHtml(t.name)}">Edit</button>
        <button type="button" class="btn btn-danger btn-sm delete-topic" data-delete-topic="${escapeHtml(t.id)}" aria-label="Delete ${escapeHtml(t.name)}">Delete</button></td></tr>`;
  const tagRow = ({ name, description, count }) => `<tr data-tag="${escapeHtml(name)}">
      <td class="name"><span class="tag">${escapeHtml(name)}</span></td>
      <td class="about">${description ? escapeHtml(description) : '<span class="quiet">none</span>'}</td>
      <td class="count">${count} ${count === 1 ? 'task' : 'tasks'}</td>
      <td class="actions"><button type="button" class="btn btn-sm edit-tag" data-edit-tag="${escapeHtml(name)}" aria-label="Edit ${escapeHtml(name)}">Edit</button>
        <button type="button" class="btn btn-danger btn-sm delete-tag" data-delete-tag="${escapeHtml(name)}" aria-label="Delete ${escapeHtml(name)}">Delete</button></td></tr>`;
  const tagList = tags === null
    ? '<p class="note error no-tags">The tags could not be read. Reload the page to try again.</p>'
    : tags.length
      ? `<div class="table-wrap"><table class="projects tag-list"><thead><tr><th>Tag</th><th>Description</th><th>Tasks</th><th></th></tr></thead>
        <tbody>${tags.map(tagRow).join('')}</tbody></table></div>`
      : '<p class="quiet no-tags">No tags yet.</p>';
  return `<div class="title-row"><h1>Topics</h1>
    <div class="toolbar">${renderProjectPicker(projects, project.slug)}</div></div>
    <p class="page-desc">The key aspects of ${escapeHtml(project.name)}: its features, mostly. Each topic belongs to one project. Tags are the labels on its tasks.</p>
    <p class="note topic-note${problem ? ' error' : ' quiet'}" role="status">${escapeHtml(problem || done)}</p>
    <div class="topics-columns">
      <section class="topics-half" aria-labelledby="topics-title">
        <details class="colex add-topic"${problem && problemIn !== 'tag' ? ' open' : ''}>
          <summary><span class="fold" aria-hidden="true"></span>Add Topic</summary>
          <form class="create-topic fields">
            <label for="topic-name">Name</label>
            <input id="topic-name" name="name" maxlength="200" autocomplete="off">
            <label for="topic-description">Description</label>
            <textarea id="topic-description" name="description" rows="3" maxlength="5000"></textarea>
            <div class="row"><button type="submit" class="btn btn-primary">Create Topic</button></div>
          </form>
        </details>
        <h2 id="topics-title">Topics</h2>
        ${topics.length
    ? `<div class="table-wrap"><table class="projects topic-list"><thead><tr><th>Name</th><th>Description</th><th>Created By</th><th>Created</th><th></th></tr></thead>
        <tbody>${topics.map(row).join('')}</tbody></table></div>`
    : '<p class="quiet no-topics">No topics yet.</p>'}
      </section>
      <section class="tags-half" aria-labelledby="tags-title">
        <details class="colex add-tag"${problem && problemIn === 'tag' ? ' open' : ''}>
          <summary><span class="fold" aria-hidden="true"></span>Add Tag</summary>
          <form class="create-tag fields">
            <label for="tag-name">Name</label>
            <input id="tag-name" name="name" maxlength="100" autocomplete="off">
            <label for="tag-description">Description</label>
            <textarea id="tag-description" name="description" rows="3" maxlength="5000"></textarea>
            <div class="row"><button type="submit" class="btn btn-primary">Create Tag</button></div>
          </form>
        </details>
        <h2 id="tags-title">Tags</h2>
        ${tagList}
      </section>
    </div>`;
}
