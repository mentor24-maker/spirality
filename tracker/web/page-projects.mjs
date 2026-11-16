/**
 * The Projects page (/projects), one project's details (/projects/<slug>), the Create and Edit Project forms, and a project's setup pages (/setup/<slug>).
 *
 * Part of Dane's page: app.mjs is the entry the page loads, holds what
 * every page shares (signing in, the API call, the header, routing and the
 * message strip) and imports this file. Moved out of app.mjs unchanged
 * (Spirality SP-352), so a ticket that changes one page no longer edits the
 * same file as a ticket that changes another.
 */
import { escapeHtml, renderSetupSteps, renderSetupNext, renderSetupList, renderSetupForm, setupBody, setupSlug, setupSlugProblem, setupName, setupFollows, firstTicket } from './render.mjs';
import { api, SignedOut, drawSignIn, me, setTitle, savedProject, PROJECT_NAME_KEY, showProject, logoOf, savedView, addressOf, repoOf, action, ICONS, actionButton, main, putTrail, showError, PROJECT_KEY, notOnProject, drawNotOnProject, Refused, when, route } from './app.mjs';
import { wireCopyButtons } from './page-tasks.mjs';

/**
 * One change to a project's members from the Users or Projects page: add
 * (`verb` 'add') or remove `person` (`name`) on project `slug`
 * (`projectName`), through the same calls the project's own page uses.
 * `control` (the Remove button or the add picker) is disabled while it runs.
 * Then `listedNow()` reads the page's list again (true: they are on it,
 * false: they are not, null: cannot tell) and `again(text, failed)` redraws
 * the page saying it worked only when that read agrees. A refusal shows the
 * server's own reason (the owner or operator, who cannot be taken off) and
 * leaves the page as it was.
 */
export async function changeMember({ control, note, slug, person, name, projectName, verb, listedNow, again }) {
  const adding = verb === 'add';
  const done = adding ? 'added' : 'removed';
  const where = `${adding ? 'to' : 'from'} ${projectName}`;
  control.disabled = true;
  note.className = 'note quiet';
  note.textContent = `${adding ? 'Adding' : 'Removing'} ${name} ${where}…`;
  try {
    if (adding) await api('POST', `/projects/${encodeURIComponent(slug)}/members`, { person: Number(person) });
    else await api('DELETE', `/projects/${encodeURIComponent(slug)}/members/${encodeURIComponent(person)}`);
  } catch (err) {
    if (err instanceof SignedOut) return drawSignIn(`You were signed out; ${name} was not ${done} ${where}.`);
    if (control.tagName === 'SELECT') control.value = '';
    control.disabled = false;
    note.className = 'note error';
    note.textContent = `Not ${done}: ${err.message}`;
    return;
  }
  // Read back before saying it worked.
  const listed = await listedNow().catch(() => null);
  const ok = listed === adding;
  return again(ok
    ? `${adding ? 'Added' : 'Removed'} ${name} ${where}.`
    : `The tracker said ${name} was ${done} ${where}, but the list read back ${listed == null ? 'could not be read' : (listed ? 'still lists them' : 'does not list them')}.`, !ok);
}

/**
 * Every project, one row each: its logo, name, slug, ticket ids, web
 * address, GitHub repository, owner, how many tickets are open, and an Actions column whose
 * View icon opens its details page. Choosing a name selects the project and
 * opens its tasks; the selected one is marked, and "Tasks" in the header
 * goes back to it. A person signed in gets a Set up a project button (its
 * page links the bare New project form), the projects being set up, and, on
 * each row, Edit and Delete icons; a loop's sign-in gets none of them, and
 * the server refuses it anyway. Delete asks first, then draws the table
 * again from the server, so a deleted project is gone because the server
 * says so; a refusal (a project with tickets) shows the server's own words
 * and the table is left as it was. The Members column names each project's
 * members; an admin also gets Remove on each (never on its owner or
 * operator) and an Add Member picker of the people not on it, each change
 * read back (changeMember). `done` and `problem` are lines to show above
 * the table.
 */
export async function drawProjects(done = '', problem = '') {
  const [{ projects, canEditMembers = false }, setups] = await Promise.all([
    api('GET', '/projects'),
    // Projects mid-setup; a tracker that cannot read setups (or a loop's sign-in) shows none.
    me?.kind === 'human' ? api('GET', '/setup').catch((err) => { if (err instanceof SignedOut) throw err; return { setups: [] }; }) : { setups: [] },
  ]);
  setTitle('Projects · Tracker');
  const selected = savedProject();
  const people = me?.kind === 'human';
  // Only an admin, signed in as a person, changes members here (as on a project's own page).
  const editing = people && canEditMembers === true;
  // The people an admin may add: everyone with an account.
  const everyone = editing ? (await api('GET', '/people')).people ?? [] : [];
  // The owner and operator are never taken off: a tag, no Remove.
  const fixedAs = (p, m) => [m.id === p.owner?.id ? 'Owner' : null, m.id === p.operator?.id ? 'Operator' : null].filter(Boolean);
  const memberOf = (p, m) => `<span class="member">${escapeHtml(m.name)}${fixedAs(p, m).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}${editing && !fixedAs(p, m).length
    ? `<button type="button" class="btn btn-danger btn-sm remove-member" data-remove="${escapeHtml(m.id)}" data-name="${escapeHtml(m.name)}" data-slug="${escapeHtml(p.slug)}" data-project="${escapeHtml(p.name)}" aria-label="Remove ${escapeHtml(m.name)} from ${escapeHtml(p.name)}">Remove</button>`
    : ''}</span>`;
  const membersCell = (p) => {
    const members = p.members ?? [];
    const addable = everyone.filter((x) => !members.some((m) => m.id === x.id));
    return `${members.length ? members.map((m) => memberOf(p, m)).join('') : '<span class="quiet">nobody</span>'}${editing && addable.length
      ? `<select class="add-member" data-slug="${escapeHtml(p.slug)}" data-project="${escapeHtml(p.name)}" aria-label="Add a member to ${escapeHtml(p.name)}"><option value="">Add Member…</option>${addable.map((x) => `<option value="${escapeHtml(x.id)}">${escapeHtml(x.name)}</option>`).join('')}</select>`
      : ''}`;
  };
  // A renamed project shows its new name in the header from here on.
  const chosen = projects.find((p) => p.slug === selected);
  if (chosen) {
    try { localStorage.setItem(PROJECT_NAME_KEY, chosen.name); } catch { /* not remembered */ }
    showProject();
  }
  const row = (p) => `
    <tr${p.slug === selected ? ' class="selected"' : ''}>
      <td class="logo">${logoOf(p)}</td>
      <td class="name"><a href="/${savedView()}/${encodeURIComponent(p.slug)}"${p.slug === selected ? ' aria-current="true"' : ''}>${escapeHtml(p.name)}</a>${p.slug === selected ? '<span class="tag">Selected</span>' : ''}</td>
      <td class="slug">${escapeHtml(p.slug)}</td>
      <td class="prefix">${escapeHtml(p.prefix)}</td>
      <td class="url">${addressOf(p)}</td>
      <td class="repo">${repoOf(p)}</td>
      <td class="owner">${p.owner ? escapeHtml(p.owner.name) : '<span class="quiet">nobody</span>'}</td>
      <td class="members">${membersCell(p)}</td>
      <td class="open">${p.open}</td>
      <td class="actions">${action(`/projects/${encodeURIComponent(p.slug)}`, 'View Project', ICONS.view)}${people
    ? action(`/projects/${encodeURIComponent(p.slug)}/edit`, 'Edit Project', ICONS.edit)
      + actionButton('Delete Project', ICONS.delete, { delete: p.slug, name: p.name })
    : ''}</td>
    </tr>`;
  main.innerHTML = `
    <div class="title-row"><h1>Projects</h1>
    ${me?.kind === 'human' ? '<div class="toolbar"><a class="btn btn-primary" href="/setup/new">Set Up a Project</a></div>' : ''}</div>
    <p class="note${problem ? ' error' : (done ? ' quiet' : '')}" role="status">${escapeHtml(problem || done)}</p>
    ${renderSetupList(setups)}
    ${projects.length
    ? `<p class="quiet">Choose a project's name to see its tasks.</p>
      <div class="table-wrap"><table class="projects"><thead><tr><th class="logo"><span class="hidden">Logo</span></th><th class="name">Name</th><th class="slug">Slug</th><th class="prefix">Ticket Prefix</th><th class="url">Web Address</th><th class="repo">GitHub Repository</th><th class="owner">Owner</th><th class="members">Members</th><th class="open">Open Tickets</th><th class="actions">Actions</th></tr></thead><tbody>${projects.map(row).join('')}</tbody></table></div>`
    : '<p class="quiet">There are no projects yet.</p>'}`;
  putTrail([{ label: 'Projects' }]);
  const note = main.querySelector('p.note');
  if (editing) {
    const again = (text, failed) => drawProjects(failed ? '' : text, failed ? text : '')
      .catch((err) => (err instanceof SignedOut ? drawSignIn() : showError(err)));
    // Read the project's members back from GET /projects: on it (true), off it (false), gone (null).
    const listedNow = (slug, person) => async () => {
      const back = (await api('GET', '/projects')).projects?.find((x) => x.slug === slug);
      return back ? (back.members ?? []).some((m) => String(m.id) === String(person)) : null;
    };
    for (const select of main.querySelectorAll('select.add-member')) {
      select.addEventListener('change', () => {
        if (!select.value) return;
        const { slug, project } = select.dataset;
        const name = select.selectedOptions[0]?.textContent ?? 'them';
        changeMember({ control: select, note, slug, person: select.value, name, projectName: project, verb: 'add', listedNow: listedNow(slug, select.value), again });
      });
    }
    for (const button of main.querySelectorAll('button.remove-member')) {
      button.addEventListener('click', () => {
        const { remove: id, name, slug, project } = button.dataset;
        if (!confirm(`Remove ${name} from ${project}?`)) return;
        changeMember({ control: button, note, slug, person: id, name, projectName: project, verb: 'remove', listedNow: listedNow(slug, id), again });
      });
    }
  }
  for (const button of main.querySelectorAll('button[data-delete]')) {
    button.addEventListener('click', async () => {
      const { delete: slug, name } = button.dataset;
      if (!confirm(`Delete ${name}?`)) return;
      button.disabled = true;
      note.className = 'note quiet';
      note.textContent = `Deleting ${name}…`;
      try {
        await api('DELETE', `/projects/${encodeURIComponent(slug)}`);
      } catch (err) {
        if (err instanceof SignedOut) return drawSignIn(`You were signed out; ${name} was not deleted.`);
        note.className = 'note error';
        note.textContent = `Not deleted: ${err.message}`;
        button.disabled = false;
        return;
      }
      // Deleted: forget it if it was the selected one, and read the table again.
      if (savedProject() === slug) {
        try {
          localStorage.removeItem(PROJECT_KEY);
          localStorage.removeItem(PROJECT_NAME_KEY);
        } catch { /* nothing remembered */ }
        showProject();
      }
      try {
        await drawProjects(`Deleted ${name}.`);
      } catch (err) {
        if (err instanceof SignedOut) return drawSignIn();
        showError(err);
      }
    });
  }
}

/**
 * One project's details: its logo, name, slug, ticket prefix, web address,
 * GitHub repository, owner, operator, how many
 * tickets are open and how many sit in each status, with links to its board
 * and its list, and its members. An unknown slug says so plainly. An admin
 * gets Add Member (a picker of the people not on it) and Remove on each
 * member but the owner and operator; after each change the page reads the
 * project again and says it worked only when the members it reads agree. A
 * refusal shows the server's own reason. `done` and `problem` are lines to
 * show above the members.
 */
export async function drawProjectDetails(slug, done = '', problem = '') {
  let p;
  try {
    p = await api('GET', `/projects/${encodeURIComponent(slug)}`);
  } catch (err) {
    if (notOnProject(err)) return drawNotOnProject({ project: slug });
    if (!(err instanceof Refused) || err.status !== 404) throw err;
    setTitle('No Such Project · Tracker');
    main.innerHTML = `<h1>Projects</h1><p>There is no project ${escapeHtml(slug)}.</p><p><a href="/projects">Back to Projects</a></p>`;
    putTrail([{ label: 'Projects' }]);
    return;
  }
  setTitle(`${p.name} · Tracker`);
  const at = (v) => `/${v}/${encodeURIComponent(p.slug)}`;
  const counts = p.statuses.map((s) => `<tr><td class="status">${escapeHtml(s.status)}</td><td class="count">${s.count}</td></tr>`).join('');
  const members = p.members ?? [];
  const editing = me?.kind === 'human' && p.canEditMembers === true;
  // The people an admin may add: everyone with an account who is not on it yet.
  const people = editing ? (await api('GET', '/people')).people ?? [] : [];
  const addable = people.filter((x) => !members.some((m) => m.id === x.id));
  const fixedAs = (m) => [m.id === p.owner?.id ? 'Owner' : null, m.id === p.operator?.id ? 'Operator' : null].filter(Boolean);
  const memberRow = (m) => `
    <tr><td class="name">${escapeHtml(m.name)}${fixedAs(m).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</td>
      <td class="by">${m.addedBy ? escapeHtml(m.addedBy.name) : '<span class="quiet">the tracker</span>'}</td>
      <td class="added">${escapeHtml(when(m.addedAt))}</td>
      ${editing ? `<td class="actions">${fixedAs(m).length ? '' : `<button type="button" class="btn btn-danger btn-sm" data-remove="${escapeHtml(m.id)}" data-name="${escapeHtml(m.name)}">Remove</button>`}</td>` : ''}</tr>`;
  main.innerHTML = `
    <div class="title-row"><h1 class="project">${logoOf(p, 'logo big')}${escapeHtml(p.name)}</h1>
    <div class="toolbar">
      <a href="/projects">All projects</a>
      <a href="${at('board')}">Board</a><a href="${at('list')}">List</a>
    </div></div>
    <dl class="details">
      <dt>Slug</dt><dd>${escapeHtml(p.slug)}</dd>
      <dt>Ticket prefix</dt><dd>${escapeHtml(p.prefix)}</dd>
      <dt>Web address</dt><dd>${addressOf(p)}</dd>
      <dt>GitHub repository</dt><dd>${repoOf(p)}</dd>
      <dt>Owner</dt><dd>${p.owner ? escapeHtml(p.owner.name) : '<span class="quiet">nobody</span>'}</dd>
      <dt>Operator</dt><dd>${p.operator ? escapeHtml(p.operator.name) : '<span class="quiet">nobody</span>'}</dd>
      <dt>Open tickets</dt><dd>${p.open}</dd>
    </dl>
    <h2>Tickets by Status</h2>
    <div class="table-wrap"><table class="counts"><thead><tr><th>Status</th><th class="count">Tickets</th></tr></thead><tbody>${counts}</tbody></table></div>
    <h2>Members</h2>
    <p class="note${problem ? ' error' : ' quiet'}" role="status">${escapeHtml(problem || done)}</p>
    ${members.length
    ? `<div class="table-wrap"><table class="projects people members"><thead><tr><th class="name">Name</th><th class="by">Added By</th><th class="added">Added</th>${editing ? '<th class="actions"><span class="hidden">Actions</span></th>' : ''}</tr></thead><tbody>${members.map(memberRow).join('')}</tbody></table></div>`
    : '<p class="quiet">Nobody is a member of this project yet.</p>'}
    ${editing ? (addable.length
    ? `<form class="invite members fields">
      <div class="row"><label for="add-member">Add a Member</label><select id="add-member">${addable.map((x) => `<option value="${escapeHtml(x.id)}">${escapeHtml(x.name)}</option>`).join('')}</select><button type="submit" class="btn btn-primary">Add Member</button></div>
    </form>`
    : '<p class="quiet">Everyone with an account is a member.</p>') : ''}
    <p class="quiet">Only its members (and admins) see this project and its tickets.</p>`;
  putTrail([{ label: p.name, href: '/projects' }, { label: 'Details' }]);
  if (!editing) return;
  const note = main.querySelector('p.note');
  const busy = (text) => { note.className = 'note quiet'; note.textContent = text; };
  const again = (text, failed) => drawProjectDetails(slug, failed ? '' : text, failed ? text : '')
    .catch((err) => (err instanceof SignedOut ? drawSignIn() : showError(err)));
  // Send one change, then read the project back before saying it worked.
  const change = async (control, name, send, wanted, said, verb) => {
    control.disabled = true;
    busy(`${verb === 'add' ? 'Adding' : 'Removing'} ${name}…`);
    try {
      await send();
    } catch (err) {
      if (err instanceof SignedOut) return drawSignIn(`You were signed out; ${name} was not ${verb === 'add' ? 'added' : 'removed'}.`);
      control.disabled = false;
      note.className = 'note error';
      note.textContent = `Not ${verb === 'add' ? 'added' : 'removed'}: ${err.message}`;
      return;
    }
    const back = await api('GET', `/projects/${encodeURIComponent(slug)}`).catch(() => null);
    const listed = back?.members?.some((m) => String(m.id) === String(wanted.id));
    const ok = back != null && listed === wanted.listed;
    again(ok ? said : `The tracker said ${name} was ${verb === 'add' ? 'added' : 'removed'}, but the members read back ${back ? (listed ? 'still list them' : 'do not list them') : 'could not be read'}.`, !ok);
  };
  const form = main.querySelector('form.members');
  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    const select = form.querySelector('select');
    const id = Number(select.value);
    const name = select.selectedOptions[0]?.textContent ?? 'them';
    change(form.querySelector('button'), name, () => api('POST', `/projects/${encodeURIComponent(slug)}/members`, { person: id }),
      { id, listed: true }, `Added ${name} to ${p.name}.`, 'add');
  });
  for (const button of main.querySelectorAll('button[data-remove]')) {
    button.addEventListener('click', () => {
      const { remove: id, name } = button.dataset;
      if (!confirm(`Remove ${name} from ${p.name}?`)) return;
      change(button, name, () => api('DELETE', `/projects/${encodeURIComponent(slug)}/members/${encodeURIComponent(id)}`),
        { id, listed: false }, `Removed ${name} from ${p.name}.`, 'remove');
    });
  }
}

/** One labelled text box of the project forms. `attrs` is its own extra attributes, already safe. */
export const field = (id, label, hint, attrs = '') => `
      <label for="${id}">${label}</label>
      ${hint ? `<span class="hint">${hint}</span>` : ''}
      <input id="${id}" type="text"${attrs}>`;

/** The GitHub repository box's hint, the same on both project forms. */
const REPO_HINT = 'Optional. Where its pull requests live: owner/name, like my-org/my-app, or its https://github.com/ address.';

/** The alert boxes' hints, the same on both project forms. */
const ALERT_EMAIL_HINT = "Where hand-over alerts for this project go. Empty: the tracker's default address.";
const ALERT_PHONE_HINT = 'For iMessage alerts, e.g. 801 555 0123, or +44 20 7946 0000 outside the US. Empty: no texts.';

/**
 * The Create Project form, for a person only: name, slug, ticket prefix, web
 * address, logo (an image's web address), GitHub repository, alert email and phone, and owner, picked from the
 * tracker's people. Saving files the project and opens its details page,
 * which reads it back from the server. A refused save shows the server's own
 * message and leaves every field as typed: the form is not redrawn.
 */
export async function drawCreateProject() {
  setTitle('New Project · Tracker');
  if (me?.kind !== 'human') {
    main.innerHTML = '<h1>New Project</h1><p>Only a person signed in to the tracker can add a project.</p><p><a href="/projects">Back to Projects</a></p>';
    return;
  }
  const { people } = await api('GET', '/people');
  main.innerHTML = `
    <h1>New Project</h1>
    <form class="request project fields">
      ${field('name', 'Name', '', ' required')}
      ${field('slug', 'Slug', 'Its part of every address, like my-project: small letters, digits and hyphens.', ' required autocapitalize="off" spellcheck="false"')}
      ${field('prefix', 'Ticket Prefix', 'The start of its ticket ids, like SP in SP-12: capital letters and digits.', ' required autocapitalize="characters" spellcheck="false"')}
      ${field('url', 'Web Address', 'Optional. Starts http:// or https://.', ' class="field-long" inputmode="url" spellcheck="false"')}
      ${field('logo', 'Logo', "Optional. An image's web address, starting http:// or https://.", ' class="field-long" inputmode="url" spellcheck="false"')}
      ${field('repo', 'GitHub Repository', REPO_HINT, ' class="field-long" autocapitalize="off" spellcheck="false"')}
      ${field('alertEmail', 'Alert Email', ALERT_EMAIL_HINT, ' inputmode="email" autocapitalize="off" spellcheck="false"')}
      ${field('alertPhone', 'Alert Phone', ALERT_PHONE_HINT, ' inputmode="tel" autocomplete="tel" spellcheck="false"')}
      <div class="beside"><label for="owner">Owner</label>
      <select id="owner"><option value="">Nobody</option>${people.map((p) => `<option value="${escapeHtml(p.id)}"${p.id === me.id ? ' selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}</select></div>
      <div class="row"><button type="submit" class="btn btn-primary">Add Project</button><a href="/projects">Cancel</a><span class="note"></span></div>
    </form>`;
  const form = main.querySelector('form.project');
  const value = (id) => form.querySelector(`#${id}`).value;
  const note = form.querySelector('.note');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = form.querySelector('button');
    button.disabled = true;
    note.className = 'note quiet';
    note.textContent = 'Adding…';
    try {
      const made = await api('POST', '/projects', {
        name: value('name'), slug: value('slug'), prefix: value('prefix'),
        url: value('url'), logo: value('logo'), repo: value('repo'), owner: value('owner') ? Number(value('owner')) : null,
        alertEmail: value('alertEmail'), alertPhone: value('alertPhone'),
      });
      history.pushState(null, '', `/projects/${encodeURIComponent(made.slug)}`);
      await route();
    } catch (err) {
      if (err instanceof SignedOut) return drawSignIn('You were signed out; the project was not added.');
      note.className = 'note error';
      note.textContent = `Not added: ${err.message}`;
      button.disabled = false;
    }
  });
  form.querySelector('#name').focus();
}

/**
 * The Edit project form, for a person only: the Create Project form filled
 * in with what the server holds. Name, web address, logo, GitHub repository, owner and the
 * alert email and phone change;
 * the slug and ticket prefix are shown but cannot, since every ticket's id
 * is built from them. Saving sends the change and opens the details page,
 * which reads it back from the server. A refused save shows the server's own
 * message and leaves every field as typed.
 */
export async function drawEditProject(slug) {
  setTitle('Edit Project · Tracker');
  if (me?.kind !== 'human') {
    main.innerHTML = '<h1>Edit Project</h1><p>Only a person signed in to the tracker can change a project.</p><p><a href="/projects">Back to Projects</a></p>';
    return;
  }
  let p;
  try {
    p = await api('GET', `/projects/${encodeURIComponent(slug)}`);
  } catch (err) {
    if (notOnProject(err)) return drawNotOnProject({ project: slug });
    if (!(err instanceof Refused) || err.status !== 404) throw err;
    main.innerHTML = `<h1>Edit Project</h1><p>There is no project ${escapeHtml(slug)}.</p><p><a href="/projects">Back to Projects</a></p>`;
    return;
  }
  const { people } = await api('GET', '/people');
  const filled = (v) => ` value="${escapeHtml(v ?? '')}"`;
  const fixed = 'It cannot change: every ticket\'s id is built from it.';
  main.innerHTML = `
    <h1>Edit Project</h1>
    <form class="request project fields">
      ${field('name', 'Name', '', ` required${filled(p.name)}`)}
      ${field('slug', 'Slug', fixed, ` disabled${filled(p.slug)}`)}
      ${field('prefix', 'Ticket Prefix', fixed, ` disabled${filled(p.prefix)}`)}
      ${field('url', 'Web Address', 'Optional. Starts http:// or https://.', ` class="field-long" inputmode="url" spellcheck="false"${filled(p.url)}`)}
      ${field('logo', 'Logo', "Optional. An image's web address, starting http:// or https://.", ` class="field-long" inputmode="url" spellcheck="false"${filled(p.logo)}`)}
      ${field('repo', 'GitHub Repository', REPO_HINT, ` class="field-long" autocapitalize="off" spellcheck="false"${filled(p.repo)}`)}
      ${field('alertEmail', 'Alert Email', ALERT_EMAIL_HINT, ` inputmode="email" autocapitalize="off" spellcheck="false"${filled(p.alertEmail)}`)}
      ${field('alertPhone', 'Alert Phone', ALERT_PHONE_HINT, ` inputmode="tel" autocomplete="tel" spellcheck="false"${filled(p.alertPhone)}`)}
      <div class="beside"><label for="owner">Owner</label>
      <select id="owner"><option value="">Nobody</option>${people.map((o) => `<option value="${escapeHtml(o.id)}"${o.id === p.owner?.id ? ' selected' : ''}>${escapeHtml(o.name)}</option>`).join('')}</select></div>
      <div class="row"><button type="submit" class="btn btn-save">Save</button><a href="/projects">Cancel</a><span class="note"></span></div>
    </form>`;
  putTrail([{ label: p.name, href: '/projects' }, { label: 'Edit' }]);
  const form = main.querySelector('form.project');
  const value = (id) => form.querySelector(`#${id}`).value;
  const note = form.querySelector('.note');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = form.querySelector('button');
    button.disabled = true;
    note.className = 'note quiet';
    note.textContent = 'Saving…';
    try {
      const saved = await api('PATCH', `/projects/${encodeURIComponent(p.slug)}`, {
        name: value('name'), url: value('url'), logo: value('logo'), repo: value('repo'), owner: value('owner') ? Number(value('owner')) : null,
        alertEmail: value('alertEmail'), alertPhone: value('alertPhone'),
      });
      history.pushState(null, '', `/projects/${encodeURIComponent(saved.slug)}`);
      await route();
    } catch (err) {
      if (err instanceof SignedOut) return drawSignIn('You were signed out; the project was not changed.');
      note.className = 'note error';
      note.textContent = `Not saved: ${err.message}`;
      button.disabled = false;
    }
  });
  form.querySelector('#name').focus();
}

/**
 * Set up a project, its answers (SP-127): `/setup/new`, for a person only.
 * The fields are the wizard's own (`GET /setup/fields`), each filled in with
 * its default; Save writes them (`PUT /setup/<slug>`, checked by the
 * wizard's checker) and opens the project's setup page. A refusal naming a
 * field shows beside it, and every box keeps what was typed.
 * `/setup/<slug>/answers` is the same form for a project already
 * started, filled in from its saved answers, until its sign-ins are made.
 * The bare New project form stays a link away, for a tracker project with
 * no repository.
 */
export async function drawSetupNew(project) {
  setTitle('Set Up a Project · Tracker');
  putTrail([{ label: 'Projects', href: '/projects' }, { label: 'Set Up a Project' }]);
  if (me?.kind !== 'human') {
    main.innerHTML = '<h1>Set Up a Project</h1><p>Only a person signed in to the tracker can set up a project.</p><p><a href="/projects">Back to Projects</a></p>';
    return;
  }
  let saved = null;
  if (project) {
    saved = await api('GET', `/setup/${encodeURIComponent(project)}`);
    if (saved.locked) {
      main.innerHTML = `<h1>Set Up ${escapeHtml(setupName(saved))}</h1><p>Its sign-ins are made from these answers, so they no longer change here.</p><p><a href="/setup/${encodeURIComponent(project)}">Back to its setup</a></p>`;
      return;
    }
  }
  let { fields } = await api('GET', `/setup/fields?project=${encodeURIComponent(project ?? '')}`);
  main.innerHTML = `
    <h1>${project ? `Set Up ${escapeHtml(setupName(saved))}: Its Answers` : 'Set Up a Project'}</h1>
    <p class="quiet">The setup runs on the Mini: after Save, its page shows the command to paste into a Terminal there, and follows every step. A tracker project with no GitHub repository? <a href="/projects/new">New project</a>.</p>
    <form class="request setup fields">
      ${renderSetupForm(fields, saved?.answers ?? null)}
      <p class="quiet">Its slug, in every address and file name: <span class="slug">${escapeHtml(project ?? '')}</span></p>
      <div class="row"><button type="submit" class="btn btn-save">Save</button><a href="${project ? `/setup/${encodeURIComponent(project)}` : '/projects'}">Cancel</a><span class="note form-note"></span></div>
    </form>`;
  const form = main.querySelector('form.setup');
  const note = form.querySelector('.form-note');
  const nameBox = form.querySelector('[name="projectName"]');
  const slugOf = () => project ?? setupSlug(nameBox?.value);
  const showSlug = () => { form.querySelector('.slug').textContent = slugOf() || '(none yet)'; };
  showSlug();
  if (!project && nameBox) {
    nameBox.addEventListener('input', showSlug);
    // Some defaults come from the slug (the ticket prefix): fill them again, where they are still the default.
    nameBox.addEventListener('change', async () => {
      let next;
      try {
        ({ fields: next } = await api('GET', `/setup/fields?project=${encodeURIComponent(slugOf())}`));
      } catch { return; }
      for (const f of next) {
        const box = form.querySelector(`[name="${f.key}"]`);
        if (!box) continue;
        if (box.value === box.dataset.default) box.value = f.default ?? '';
        box.dataset.default = f.default ?? '';
      }
      fields = next;
    });
  }
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    for (const n of form.querySelectorAll('.field-note')) { n.className = 'note field-note'; n.textContent = ''; }
    const slug = slugOf();
    const problem = setupSlugProblem(slug);
    if (problem) {
      note.className = 'note form-note error';
      note.textContent = `Not saved: ${problem}`;
      return;
    }
    const values = Object.fromEntries(fields.map((f) => [f.key, form.querySelector(`[name="${f.key}"]`)?.value ?? '']));
    const button = form.querySelector('button');
    button.disabled = true;
    note.className = 'note form-note quiet';
    note.textContent = 'Saving…';
    try {
      await api('PUT', `/setup/${encodeURIComponent(slug)}`, setupBody(fields, values));
    } catch (err) {
      if (err instanceof SignedOut) return drawSignIn('You were signed out; the answers were not saved.');
      const beside = err.field ? form.querySelector(`.field-note[data-for="${err.field}"]`) : null;
      if (beside) {
        beside.className = 'note field-note error';
        beside.textContent = err.message;
      }
      note.className = 'note form-note error';
      note.textContent = beside ? 'Not saved: see the note beside the field.' : `Not saved: ${err.message}`;
      button.disabled = false;
      return;
    }
    history.pushState(null, '', `/setup/${encodeURIComponent(slug)}`);
    await route();
  });
  nameBox?.focus();
}

/**
 * One project's setup page (SP-127): its steps as the wizard's state file
 * records them, and under them one box saying what is next, with a Copy
 * button for every command to paste on the Mini. The page runs nothing.
 * Answers whether it follows the setup (reads again every few seconds):
 * until the setup is finished.
 */
export async function drawSetup(slug) {
  let setup;
  try {
    setup = await api('GET', `/setup/${encodeURIComponent(slug)}`);
  } catch (err) {
    if (!(err instanceof Refused) || err.status !== 400) throw err;
    setTitle('No Such Setup · Tracker');
    main.innerHTML = `<h1>Set Up a Project</h1><p>${escapeHtml(err.message)}</p><p><a href="/projects">Back to Projects</a></p>`;
    putTrail([{ label: 'Projects', href: '/projects' }, { label: 'Set Up a Project' }]);
    return false;
  }
  const name = setupName(setup);
  // The finished box links its first ticket: the lowest-numbered on its board.
  const firstTicketId = setup.finished
    ? await api('GET', `/projects/${encodeURIComponent(setup.project)}/board`).then(firstTicket, (err) => { if (err instanceof SignedOut) throw err; return null; })
    : null;
  setTitle(`Set Up ${name} · Tracker`);
  main.innerHTML = `
    <section class="setup">
      <div class="title-row"><h1>Set Up ${escapeHtml(name)}</h1>
      <div class="toolbar"><a href="/projects">All projects</a>${setup.locked ? '' : `<a href="/setup/${encodeURIComponent(setup.project)}/answers">Change the answers</a>`}</div></div>
      ${setup.answersError ? `<p class="note error">The answers do not check: ${escapeHtml(setup.answersError)}</p>` : ''}
      <h2>Steps</h2>
      ${renderSetupSteps(setup.state)}
      ${renderSetupNext(setup, { firstTicketId })}
    </section>`;
  putTrail([{ label: 'Projects', href: '/projects' }, { label: `Set Up ${name}` }]);
  wireCopyButtons();
  return setupFollows(setup);
}
