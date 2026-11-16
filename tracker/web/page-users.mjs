/**
 * The Users page (/users): everyone who can sign in, their roles and projects.
 *
 * Part of Dane's page: app.mjs is the entry the page loads, holds what
 * every page shares (signing in, the API call, the header, routing and the
 * message strip) and imports this file. Moved out of app.mjs unchanged
 * (Spirality SP-352), so a ticket that changes one page no longer edits the
 * same file as a ticket that changes another.
 */
import { escapeHtml } from './render.mjs';
import { api, setTitle, me, when, main, putTrail, SignedOut, drawSignIn, showError } from './app.mjs';
import { changeMember } from './page-projects.mjs';

/**
 * The Users page: everyone who has an account (name and email), the open
 * invites (email, who invited, when it expires) each with a Cancel button,
 * and an "Invite someone" form. When the tracker knows an outside site,
 * the form also asks where the link opens ("Send the link to": the tracker
 * page or that site's page). Inviting emails a 7-day link; the server
 * makes the invite only if the email went out, and says so if it did not.
 * After every invite or cancel the page reads the list again and says it
 * worked only when what it reads agrees. A loop's sign-in sees no form and
 * no buttons, and the server refuses it anyway. Each user's role shows in
 * the Role column; an admin gets a picker there instead, whose change is
 * read back the same way, and a refusal (the last admin) shows the server's
 * reason. The Projects column lists the projects each user is a member
 * of, each linking to its details page, under "All projects (admin)" for
 * an admin, who sees every project whatever they are a member of; an admin also gets Remove on each
 * (never where they are its owner or operator) and an Add to Project picker
 * of the projects they are not on, each change read back (changeMember).
 * Under it, which role has which permission.
 */
export async function drawUsers(done = '', problem = '') {
  const { people, invites = [], sites = [], roles = [], permissions = [], canEditRoles = false } = await api('GET', '/people');
  setTitle('Users · Tracker');
  const person = me?.kind === 'human';
  const picker = person && canEditRoles;
  // An admin, signed in as a person, also puts people on projects and takes them off here.
  const { projects: all = [], canEditMembers = false } = person ? await api('GET', '/projects') : {};
  const editing = person && canEditMembers === true;
  const bySlug = new Map(all.map((x) => [x.slug, x]));
  // A project's owner and operator are never taken off: a tag, no Remove.
  const fixedAs = (p, x) => { const pr = bySlug.get(x.slug); return [pr?.owner?.id === p.id ? 'Owner' : null, pr?.operator?.id === p.id ? 'Operator' : null].filter(Boolean); };
  // An admin sees every project, so their cell says so first; their
  // own memberships follow, and "none" is left out under that line.
  const projectsCell = (p) => {
    const every = p.seesEveryProject === true;
    const label = every ? '<span class="every" title="An admin sees every project, so they are never shut out of one.">All projects (admin)</span>' : '';
    return `${label}${memberCell(p, every ? '' : '<span class="quiet">none</span>')}`;
  };
  const memberCell = (p, none) => {
    const mine = p.projects ?? [];
    if (!editing) return mine.length ? mine.map((x) => `<a href="/projects/${encodeURIComponent(x.slug)}">${escapeHtml(x.name)}</a>`).join(', ') : none;
    const addable = all.filter((x) => !mine.some((m) => m.slug === x.slug));
    return `${mine.length ? mine.map((x) => `<span class="member"><a href="/projects/${encodeURIComponent(x.slug)}">${escapeHtml(x.name)}</a>${fixedAs(p, x).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}${fixedAs(p, x).length
      ? ''
      : `<button type="button" class="btn btn-danger btn-sm remove-member" data-remove-from="${escapeHtml(x.slug)}" data-project="${escapeHtml(x.name)}" data-person="${escapeHtml(p.id)}" data-name="${escapeHtml(p.name)}" aria-label="Remove ${escapeHtml(p.name)} from ${escapeHtml(x.name)}">Remove</button>`}</span>`).join('') : none}${addable.length
      ? `<select class="add-member" data-person="${escapeHtml(p.id)}" data-name="${escapeHtml(p.name)}" aria-label="Add ${escapeHtml(p.name)} to a project"><option value="">Add to Project…</option>${addable.map((x) => `<option value="${escapeHtml(x.slug)}">${escapeHtml(x.name)}</option>`).join('')}</select>`
      : ''}`;
  };
  const roleCell = (p) => (picker
    ? `<select data-role-of="${escapeHtml(p.id)}" data-name="${escapeHtml(p.name)}" aria-label="Role of ${escapeHtml(p.name)}">${roles.map((r) => `<option value="${escapeHtml(r.name)}"${r.name === p.role ? ' selected' : ''}>${escapeHtml(r.name)}</option>`).join('')}</select>`
    : escapeHtml(p.role ?? ''));
  const personRow = (p) => `
    <tr><td class="name">${escapeHtml(p.name)}</td><td class="email">${p.email ? escapeHtml(p.email) : '<span class="quiet">no email yet</span>'}</td><td class="role">${roleCell(p)}</td>
      <td class="projects">${projectsCell(p)}</td></tr>`;
  const roleRow = (r) => `
    <tr><td class="name"><b>${escapeHtml(r.name)}</b><span class="hint quiet">${escapeHtml(r.description)}</span></td>${permissions.map((x) => `<td class="has">${r.permissions.includes(x.name) ? '✓' : '<span class="hidden">no</span>'}</td>`).join('')}</tr>`;
  const inviteRow = (i) => `
    <tr><td class="email">${escapeHtml(i.email)}</td><td class="by">${escapeHtml(i.invitedBy.name)}</td><td class="expires">${escapeHtml(when(i.expiresAt))}</td>
      <td class="actions">${person ? `<button type="button" class="btn btn-sm" data-cancel="${escapeHtml(i.id)}" data-email="${escapeHtml(i.email)}">Cancel</button>` : ''}</td></tr>`;
  main.innerHTML = `
    <h1>Users</h1>
    <p class="note${problem ? ' error' : ' quiet'}" role="status">${escapeHtml(problem || done)}</p>
    ${person ? `<form class="invite fields">
      <label for="invite-email">Invite Someone</label>
      <span class="hint" id="invite-hint">Their email. They get an email with a link to choose their name and password. It works once, for 7 days.</span>
      <input id="invite-email" type="email" autocomplete="off" placeholder="their@email.com" aria-describedby="invite-hint" required>
      ${sites.length ? `<div class="beside"><label for="invite-site">Send the Link To</label>
      <select id="invite-site"><option value="">the tracker page</option>${sites.map((x) => `<option value="${escapeHtml(x.id)}">${escapeHtml(x.name)}</option>`).join('')}</select></div>` : ''}
      <div class="row"><button type="submit" class="btn btn-primary">Send Invite</button></div>
    </form>` : ''}
    <h2>Users with an Account</h2>
    <div class="table-wrap"><table class="projects people"><thead><tr><th class="name">Name</th><th class="email">Email</th><th class="role">Role</th><th class="projects">Projects</th></tr></thead><tbody>${people.map(personRow).join('')}</tbody></table></div>
    <h2>Open Invites</h2>
    ${invites.length
    ? `<div class="table-wrap"><table class="projects invites"><thead><tr><th class="email">Email</th><th class="by">Invited By</th><th class="expires">Expires</th><th class="actions"><span class="hidden">Actions</span></th></tr></thead><tbody>${invites.map(inviteRow).join('')}</tbody></table></div>`
    : '<p class="quiet">No open invites.</p>'}
    <h2>Roles and Permissions</h2>
    <p class="quiet">Each role's permissions are recorded, not yet enforced: for now everyone may do what they could before.</p>
    <div class="table-wrap"><table class="projects roles"><thead><tr><th class="name">Role</th>${permissions.map((x) => `<th class="has" title="${escapeHtml(x.name)}">${escapeHtml(x.description)}</th>`).join('')}</tr></thead><tbody>${roles.map(roleRow).join('')}</tbody></table></div>`;
  putTrail([{ label: 'Users' }]);
  const note = main.querySelector('p.note');
  const busy = (text) => { note.className = 'note quiet'; note.textContent = text; };
  const again = (text, failed) => drawUsers(failed ? '' : text, failed ? text : '')
    .catch((err) => (err instanceof SignedOut ? drawSignIn() : showError(err)));
  const form = main.querySelector('form.invite');
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = form.querySelector('input').value.trim();
    // "Send the link to": the tracker page (no site) or an outside site's page.
    const site = form.querySelector('#invite-site')?.value ?? '';
    const button = form.querySelector('button');
    button.disabled = true;
    busy(`Sending an invite to ${email}…`);
    let sent;
    try {
      sent = await api('POST', '/invites', site ? { email, site: Number(site) } : { email });
    } catch (err) {
      if (err instanceof SignedOut) return drawSignIn(`You were signed out; ${email} was not invited.`);
      note.className = 'note error';
      note.textContent = err.message;
      button.disabled = false;
      return;
    }
    // Read back before saying it worked.
    const back = await api('GET', '/people').catch(() => null);
    const listed = back?.invites?.some((i) => i.email === email.toLowerCase());
    again(listed ? sent.sent : `The tracker said the invite was sent, but it is not in the open invites when read back: ${sent.sent}`, !listed);
  });
  for (const select of main.querySelectorAll('select[data-role-of]')) {
    const was = select.value;
    select.addEventListener('change', async () => {
      const { roleOf: id, name } = select.dataset;
      const role = select.value;
      select.disabled = true;
      busy(`Changing ${name}'s role to ${role}…`);
      try {
        await api('PUT', `/people/${encodeURIComponent(id)}/role`, { role });
      } catch (err) {
        if (err instanceof SignedOut) return drawSignIn(`You were signed out; ${name}'s role was not changed.`);
        select.value = was;
        select.disabled = false;
        note.className = 'note error';
        note.textContent = `Not changed: ${err.message}`;
        return;
      }
      // Read back before saying it worked.
      const back = await api('GET', '/people').catch(() => null);
      const now = back?.people?.find((p) => String(p.id) === id)?.role;
      again(now === role ? `${name} is now ${role}.` : `The tracker said ${name}'s role was changed to ${role}, but it reads back as ${now ?? 'unknown'}.`, now !== role);
    });
  }
  if (editing) {
    // Read the person's projects back from GET /people: on it (true), off it (false), unknown person (null).
    const listedNow = (slug, id) => async () => {
      const back = (await api('GET', '/people')).people?.find((x) => String(x.id) === String(id));
      return back ? (back.projects ?? []).some((x) => x.slug === slug) : null;
    };
    for (const select of main.querySelectorAll('select.add-member')) {
      select.addEventListener('change', () => {
        if (!select.value) return;
        const { person: id, name } = select.dataset;
        const slug = select.value;
        const projectName = select.selectedOptions[0]?.textContent ?? slug;
        changeMember({ control: select, note, slug, person: id, name, projectName, verb: 'add', listedNow: listedNow(slug, id), again });
      });
    }
    for (const button of main.querySelectorAll('button.remove-member')) {
      button.addEventListener('click', () => {
        const { removeFrom: slug, project, person: id, name } = button.dataset;
        if (!confirm(`Remove ${name} from ${project}?`)) return;
        changeMember({ control: button, note, slug, person: id, name, projectName: project, verb: 'remove', listedNow: listedNow(slug, id), again });
      });
    }
  }
  for (const button of main.querySelectorAll('button[data-cancel]')) {
    button.addEventListener('click', async () => {
      const { cancel: id, email } = button.dataset;
      if (!confirm(`Cancel the invite to ${email}? Its link will stop working.`)) return;
      button.disabled = true;
      busy(`Cancelling the invite to ${email}…`);
      try {
        await api('DELETE', `/invites/${encodeURIComponent(id)}`);
      } catch (err) {
        if (err instanceof SignedOut) return drawSignIn(`You were signed out; the invite to ${email} was not cancelled.`);
        note.className = 'note error';
        note.textContent = `Not cancelled: ${err.message}`;
        button.disabled = false;
        return;
      }
      const back = await api('GET', '/people').catch(() => null);
      const gone = back && !back.invites?.some((i) => String(i.id) === id);
      again(gone ? `Cancelled the invite to ${email}; its link no longer works.` : `The tracker said the invite to ${email} was cancelled, but it is still listed when read back.`, !gone);
    });
  }
}
