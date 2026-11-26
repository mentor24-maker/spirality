/**
 * Tests for the Projects page, a project's details, its forms and its setup pages. One file per page (SP-352),
 * so two tickets changing two pages no longer edit one test file; what they
 * share is tracker/webTestKit.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { escapeHtml, renderSetupNext, renderSetupSteps, renderSetupList, renderSetupForm, setupBody, setupSlug, setupSlugProblem, setupFollows, firstTicket } from './web/render.mjs';
import { startServer, setupSettingsOf } from './server.mjs';
import { saveAnswers, setupFields, setupOf } from './setup.mjs';
import { DANE_FIELDS as SETUP_FIELDS, STEPS as SETUP_STEPS } from '../scripts/onboard/onboard.mjs';
import { slugFromName } from '../lib/onboardAnswers.mjs';
import loopStatuses from '../lib/loopStatuses.js';
import { pageScript } from './pageScripts.mjs';
import { WEB, fixture, codes } from './webTestKit.mjs';

test('the Projects screen lists every project with its open count; an unknown project is 404; both need a token', async () => {
  const f = await fixture();
  try {
    const openIn = (slug) => f.store.listTickets(slug, { open: true }).length;
    assert.ok(openIn('alpha') > 0 && openIn('alpha') < f.store.listTickets('alpha').length, 'the demo data has open and Live tickets');
    // Each project's operator and members (the Projects page's Members column) ride with it.
    const dane = { id: f.operator.id, name: 'Dane' };
    assert.deepEqual((await f.call('GET', '/projects')).body.projects, [
      { slug: 'alpha', name: 'Alpha', prefix: 'AL', url: null, logo: null, owner: null, repo: null, open: openIn('alpha'), operator: dane, members: [dane] },
      { slug: 'beta', name: 'Beta', prefix: 'BE', url: null, logo: null, owner: null, repo: null, open: openIn('beta'), operator: dane, members: [dane] },
    ]);
    assert.equal((await f.call('GET', '/projects/beta/board')).body.projectName, 'Beta');
    assert.equal((await f.call('GET', '/projects/nope/board')).status, 404);
    assert.equal((await f.call('GET', '/projects', { token: null })).status, 401);
    assert.equal((await f.call('GET', '/projects/alpha/board', { token: null })).status, 401);
  } finally { await f.cleanup(); }
});

test('a project\'s details name its prefix, operator, open count and a count per status in STAGE_ORDER; an unknown slug is 404; it needs a token', async () => {
  const f = await fixture();
  try {
    const r = await f.call('GET', '/projects/alpha');
    assert.equal(r.status, 200);
    const tickets = f.store.listTickets('alpha');
    assert.deepEqual(r.body, {
      slug: 'alpha',
      name: 'Alpha',
      prefix: 'AL',
      operator: { id: f.operator.id, name: 'Dane' },
      url: null,
      logo: null,
      owner: null,
      repo: null,
      alertEmail: null,
      alertPhone: null,
      open: f.store.listTickets('alpha', { open: true }).length,
      statuses: loopStatuses.STAGE_ORDER.map((name) => ({
        status: name,
        count: tickets.filter((t) => t.status === loopStatuses.statusOf(name)).length,
      })),
      members: [{ id: f.operator.id, name: 'Dane', addedAt: r.body.members[0]?.addedAt, addedBy: null }],
      canEditMembers: true,
    });
    assert.equal(r.body.statuses.reduce((n, s) => n + s.count, 0), tickets.length, 'every ticket is counted once');
    assert.equal((await f.call('GET', '/projects/beta')).body.name, 'Beta');
    const unknown = await f.call('GET', '/projects/no-such-thing');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error, 'unknown-project');
    assert.equal((await f.call('GET', '/projects/alpha', { token: null })).status, 401);
  } finally { await f.cleanup(); }
});

test('a project with no operator shows none, not a guess', async () => {
  const f = await fixture();
  try {
    f.store.createProject({ slug: 'gamma', name: 'Gamma', prefix: 'GA' });
    const { body } = await f.call('GET', '/projects/gamma');
    assert.equal(body.operator, null);
    assert.equal(body.open, 0);
    assert.ok(body.statuses.every((s) => s.count === 0));
  } finally { await f.cleanup(); }
});

test('the Projects screen is a table whose View icon opens the details page; a name still selects the project and opens its tasks', () => {
  const app = pageScript();
  assert.match(app, /<table class="projects">/);
  assert.match(app, /<th class="actions">Actions<\/th><\/tr><\/thead><tbody>\$\{projects\.map\(row\)/);
  assert.match(app, /action\(`\/projects\/\$\{encodeURIComponent\(p\.slug\)\}`, 'View Project', ICONS\.view\)/);
  // SP-42's behaviour: the name goes to the project's tasks in the last view, and opening it selects it.
  assert.match(app, /<td class="name"><a href="\/\$\{savedView\(\)\}\/\$\{encodeURIComponent\(p\.slug\)\}"/);
  assert.match(app, /localStorage\.setItem\(PROJECT_KEY, board\.project\)/);
  // The details page links to the project's board and list, and says plainly when there is no such project.
  assert.match(app, /<a href="\$\{at\('board'\)\}">Board<\/a><a href="\$\{at\('list'\)\}">List<\/a>/);
  assert.match(app, /err\.status !== 404[\s\S]{0,200}There is no project \$\{escapeHtml\(slug\)\}\./);
});

test('the projects list names the project the server was given as its default, and none it does not hold', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call('GET', '/projects')).body.default, null, 'no project config named: the page takes the first');
    for (const [given, want] of [['beta', 'beta'], ['gamma', null]]) {
      const server = await startServer({ store: f.store, port: 0, defaultProject: given });
      try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/projects`, { headers: { authorization: `Bearer ${f.token}` } });
        assert.equal((await res.json()).default, want, given);
      } finally { await new Promise((r) => server.close(r)); }
    }
  } finally { await f.cleanup(); }
});

// ── Create Project ───────────────────────────────────────────────────────────

test('a project added from the page shows on the Projects screen and its details page with its logo, web address, GitHub repository and owner', async () => {
  const f = await fixture();
  try {
    const people = await f.call('GET', '/people');
    assert.deepEqual(people.body.people.map((p) => p.name), ['Dane'], 'the owner picker offers the people, not the loop');
    const made = await f.call('POST', '/projects', {
      body: {
        name: 'Try me', slug: 'try-me', prefix: 'TRY', url: 'https://try.example', logo: 'https://try.example/logo.png',
        repo: 'https://github.com/my-org/try-me', owner: f.operator.id,
      },
    });
    assert.equal(made.status, 201);
    const row = (await f.call('GET', '/projects')).body.projects.find((p) => p.slug === 'try-me');
    assert.deepEqual(row, {
      slug: 'try-me', name: 'Try me', prefix: 'TRY', url: 'https://try.example', logo: 'https://try.example/logo.png',
      owner: { id: f.operator.id, name: 'Dane' }, repo: 'my-org/try-me', open: 0,
      operator: null, members: [{ id: f.operator.id, name: 'Dane' }],
    });
    const details = (await f.call('GET', '/projects/try-me')).body;
    assert.deepEqual([details.url, details.logo, details.owner, details.repo], [row.url, row.logo, row.owner, row.repo]);
    // A box that is not a repository is refused with the store's own words, and nothing is added.
    const bad = await f.call('POST', '/projects', { body: { name: 'Bad', slug: 'bad', prefix: 'BAD', repo: 'https://gitlab.com/my-org/bad' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'bad-repo');
    assert.match(bad.body.message, /owner\/name/);
    assert.ok(!(await f.call('GET', '/projects')).body.projects.some((p) => p.slug === 'bad'));
    // The loop's sign-in cannot, and leaves the projects as they were.
    const before = (await f.call('GET', '/projects')).body.projects;
    const loop = await f.call('POST', '/projects', { token: f.store.issueToken(f.loop.id), body: { name: 'L', slug: 'loop-made', prefix: 'LM' } });
    assert.equal(loop.status, 403);
    assert.deepEqual((await f.call('GET', '/projects')).body.projects, before);
  } finally { await f.cleanup(); }
});

test('/projects/new is the page to a browser, and its logo can be drawn: the lock lets images in, never scripts', async () => {
  const f = await fixture();
  try {
    const page = await fetch(`${f.url}/projects/new`, { headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' } });
    assert.equal(page.status, 200);
    assert.equal(await page.text(), readFileSync(WEB('index.html'), 'utf8'));
    const csp = page.headers.get('content-security-policy');
    assert.match(csp, /img-src 'self' http: https:/);
    assert.match(csp, /script-src 'self';/);
    assert.match(csp, /default-src 'none'/);
  } finally { await f.cleanup(); }
});

test('the New project button and form are a person\'s only; a refused save keeps what was typed and says why; success opens the details page', () => {
  const app = pageScript();
  // SP-127: the Projects page's button is Set up a project; the bare form is a link on its page.
  assert.match(app, /<div class="title-row"><h1>Projects<\/h1>\s*\$\{me\?\.kind === 'human' \? '<div class="toolbar"><a class="btn btn-primary" href="\/setup\/new">Set Up a Project<\/a><\/div>' : ''\}<\/div>/);
  assert.match(app, /<a href="\/projects\/new">New project<\/a>/);
  const form = app.slice(app.indexOf('async function drawCreateProject'), app.indexOf('/**', app.indexOf('async function drawCreateProject')));
  assert.match(form, /if \(me\?\.kind !== 'human'\)[\s\S]{0,200}Only a person signed in to the tracker can add a project\./);
  for (const id of ['name', 'slug', 'prefix', 'url', 'logo', 'repo']) assert.match(form, new RegExp(`field\\('${id}',`), id);
  assert.match(form, /url: value\('url'\), logo: value\('logo'\), repo: value\('repo'\), owner:/);
  assert.match(form, /<select id="owner"><option value="">Nobody<\/option>\$\{people\.map/);
  assert.match(form, /api\('GET', '\/people'\)/);
  assert.match(form, /api\('POST', '\/projects', \{/);
  assert.match(form, /note\.textContent = `Not added: \$\{err\.message\}`;/);
  assert.ok(!/main\.innerHTML/.test(form.slice(form.indexOf("addEventListener('submit'"))), 'a refused save never redraws the form, so nothing typed is lost');
  assert.match(form, /history\.pushState\(null, '', `\/projects\/\$\{encodeURIComponent\(made\.slug\)\}`\)/);
  // /projects/new is the form, never a project called "new".
  assert.match(app, /const details = !newProject && /);
  // The table and details page draw a logo and web address only for an http(s) address, escaped.
  assert.match(app, /const isWebAddress = \(v\) => typeof v === 'string' && \/\^https\?:\\\/\\\/\/i\.test\(v\);/);
  assert.match(app, /<img class="\$\{cls\}" src="\$\{escapeHtml\(p\.logo\)\}"/);
  assert.match(app, /<td class="owner">\$\{p\.owner \? escapeHtml\(p\.owner\.name\)/);
  assert.match(app, /<dt>Owner<\/dt><dd>\$\{p\.owner \? escapeHtml\(p\.owner\.name\)/);
  // A GitHub repository is drawn as a link to it on GitHub only when it is owner/name, escaped; otherwise "none".
  assert.match(app, /const isRepo = \(v\) => typeof v === 'string' && \/\^\[A-Za-z0-9-\]\+\\\/\[A-Za-z0-9\._-\]\+\$\/\.test\(v\);/);
  assert.match(app, /<a href="https:\/\/github\.com\/\$\{escapeHtml\(p\.repo\)\}" target="_blank" rel="noopener noreferrer">\$\{escapeHtml\(p\.repo\)\}<\/a>/);
  assert.match(app, /<td class="repo">\$\{repoOf\(p\)\}<\/td>/);
  assert.match(app, /<th class="repo">GitHub Repository<\/th>/);
  assert.match(app, /<dt>GitHub repository<\/dt><dd>\$\{repoOf\(p\)\}<\/dd>/);
});

// ── Editing and deleting a project ───────────────────────────────────────────

test('a project edited from the page shows its new name, web address, logo, GitHub repository and owner on the table and its details page', async () => {
  const f = await fixture();
  try {
    await f.call('POST', '/projects', { body: { name: 'Try me', slug: 'try-me', prefix: 'TRY' } });
    const saved = await f.call('PATCH', '/projects/try-me', {
      body: { name: 'Tried', url: 'https://tried.example', logo: 'https://tried.example/l.png', repo: 'my-org/tried', owner: f.operator.id },
    });
    assert.equal(saved.status, 200);
    const row = (await f.call('GET', '/projects')).body.projects.find((p) => p.slug === 'try-me');
    assert.deepEqual(row, {
      slug: 'try-me', name: 'Tried', prefix: 'TRY', url: 'https://tried.example', logo: 'https://tried.example/l.png',
      owner: { id: f.operator.id, name: 'Dane' }, repo: 'my-org/tried', open: 0,
      operator: null, members: [{ id: f.operator.id, name: 'Dane' }],
    });
    const details = (await f.call('GET', '/projects/try-me')).body;
    assert.deepEqual([details.name, details.url, details.logo, details.owner, details.repo], [row.name, row.url, row.logo, row.owner, row.repo]);
    // An emptied box clears it.
    assert.equal((await f.call('PATCH', '/projects/try-me', { body: { repo: '' } })).body.repo, null);
    // The alert boxes save, read back on the Edit form's own GET, and never reach the projects table.
    await f.call('PATCH', '/projects/try-me', { body: { alertEmail: 'tried@example.com', alertPhone: '+1 801 555 0123' } });
    const edit = (await f.call('GET', '/projects/try-me')).body;
    assert.deepEqual([edit.alertEmail, edit.alertPhone], ['tried@example.com', '+18015550123']);
    const listed = (await f.call('GET', '/projects')).body.projects.find((p) => p.slug === 'try-me');
    assert.ok(!('alertEmail' in listed) && !('alertPhone' in listed));
  } finally { await f.cleanup(); }
});

test('both project forms carry an Alert email and an Alert phone box with their hints, and send them', () => {
  const app = pageScript();
  assert.match(app, /const ALERT_EMAIL_HINT = "Where hand-over alerts for this project go\. Empty: the tracker's default address\.";/);
  assert.match(app, /const ALERT_PHONE_HINT = 'For iMessage alerts, e\.g\. 801 555 0123, or \+44 20 7946 0000 outside the US\. Empty: no texts\.';/);
  for (const fn of ['drawCreateProject', 'drawEditProject']) {
    const form = app.slice(app.indexOf(`async function ${fn}`), app.indexOf('/**', app.indexOf(`async function ${fn}`)));
    assert.match(form, /field\('alertEmail', 'Alert Email', ALERT_EMAIL_HINT,/, fn);
    assert.match(form, /field\('alertPhone', 'Alert Phone', ALERT_PHONE_HINT,/, fn);
    assert.match(form, /alertEmail: value\('alertEmail'\), alertPhone: value\('alertPhone'\),/, fn);
  }
  const table = app.slice(app.indexOf('async function drawProjects'), app.indexOf('/**', app.indexOf('async function drawProjects')));
  assert.doesNotMatch(table, /alertEmail|alertPhone/, 'not in the projects table');
});

test('a project deleted from the page is gone; the demo\'s own project, which has tickets, is refused and stays', async () => {
  const f = await fixture();
  try {
    await f.call('POST', '/projects', { body: { name: 'Try me', slug: 'try-me', prefix: 'TRY' } });
    assert.equal((await f.call('DELETE', '/projects/try-me')).status, 200);
    assert.ok(!(await f.call('GET', '/projects')).body.projects.some((p) => p.slug === 'try-me'));
    const before = (await f.call('GET', '/projects')).body.projects;
    const full = before.find((p) => p.open > 0);
    const refused = await f.call('DELETE', `/projects/${full.slug}`);
    assert.equal(refused.status, 409);
    assert.match(refused.body.message, /^[A-Z][A-Z0-9]* has \d+ tickets?; a project with tickets cannot be deleted\.$/);
    assert.deepEqual((await f.call('GET', '/projects')).body.projects, before);
    // The loop's sign-in can do neither, and nothing changes.
    const loop = f.store.issueToken(f.loop.id);
    await f.call('POST', '/projects', { body: { name: 'Empty', slug: 'empty', prefix: 'EM' } });
    const now = (await f.call('GET', '/projects')).body.projects;
    assert.equal((await f.call('PATCH', '/projects/empty', { token: loop, body: { name: 'x' } })).status, 403);
    assert.equal((await f.call('DELETE', '/projects/empty', { token: loop })).status, 403);
    assert.deepEqual((await f.call('GET', '/projects')).body.projects, now);
  } finally { await f.cleanup(); }
});

test('the Projects table gives a person Edit and Delete on every row and a loop\'s sign-in neither; Delete asks first and a refusal says so', () => {
  const app = pageScript();
  const table = app.slice(app.indexOf('async function drawProjects'), app.indexOf('/**', app.indexOf('async function drawProjects')));
  // Both icons are drawn only for a person; otherwise the cell holds the View icon alone.
  assert.match(table, /const people = me\?\.kind === 'human';/);
  assert.match(table, /\$\{people\n\s+\? action\(`\/projects\/\$\{encodeURIComponent\(p\.slug\)\}\/edit`, 'Edit Project', ICONS\.edit\)\n\s+\+ actionButton\('Delete Project', ICONS\.delete, \{ delete: p\.slug, name: p\.name \}\)\n\s+: ''\}/);
  assert.equal((table.match(/ICONS\.edit/g) ?? []).length, 1, 'Edit is drawn in one place, behind the person check');
  assert.equal((table.match(/ICONS\.delete/g) ?? []).length, 1, 'Delete is drawn in one place, behind the person check');
  // Delete asks, by name, before anything is sent.
  const click = table.slice(table.indexOf("addEventListener('click'"));
  assert.ok(click.indexOf('if (!confirm(`Delete ${name}?`)) return;') < click.indexOf("api('DELETE'"), 'it asks before it deletes');
  assert.match(click, /api\('DELETE', `\/projects\/\$\{encodeURIComponent\(slug\)\}`\)/);
  // A refusal shows the server's own words and returns before any success line.
  assert.match(click, /note\.className = 'note error';\n\s+note\.textContent = `Not deleted: \$\{err\.message\}`;\n\s+button\.disabled = false;\n\s+return;/);
  assert.ok(click.indexOf('Not deleted:') < click.indexOf('Deleted ${name}.'), 'the success line is only reached after the call succeeded');
  // A deleted project is gone because the server's table says so: the table is read again.
  assert.match(click, /await drawProjects\(`Deleted \$\{name\}\.`\)/);
  assert.match(click, /localStorage\.removeItem\(PROJECT_KEY\)/);
  // Every name reaches the button's attributes escaped.
  assert.match(app, /Object\.entries\(data\)\.map\(\(\[k, v\]\) => ` data-\$\{k\}="\$\{escapeHtml\(v\)\}"`\)/);
});

test('the Edit project form is a person\'s only, filled in, with the slug and prefix shown but locked; a refused save keeps what was typed and says why', () => {
  const app = pageScript();
  const form = app.slice(app.indexOf('async function drawEditProject'), app.indexOf('/**', app.indexOf('async function drawEditProject')));
  assert.match(form, /if \(me\?\.kind !== 'human'\)[\s\S]{0,200}Only a person signed in to the tracker can change a project\./);
  assert.match(form, /p = await api\('GET', `\/projects\/\$\{encodeURIComponent\(slug\)\}`\)/);
  assert.match(form, /const filled = \(v\) => ` value="\$\{escapeHtml\(v \?\? ''\)\}"`;/);
  for (const id of ['name', 'url', 'logo', 'repo', 'alertEmail', 'alertPhone']) assert.match(form, new RegExp(`field\\('${id}',[^\\n]*filled\\(p\\.${id}\\)`), id);
  for (const id of ['slug', 'prefix']) assert.match(form, new RegExp(`field\\('${id}',[^\\n]* disabled\\$\\{filled\\(p\\.${id}\\)\\}`), id);
  assert.match(form, /o\.id === p\.owner\?\.id \? ' selected' : ''/);
  // The change names only what may change; never the slug or prefix.
  assert.match(form, /api\('PATCH', `\/projects\/\$\{encodeURIComponent\(p\.slug\)\}`, \{\n\s+name: value\('name'\), url: value\('url'\), logo: value\('logo'\), repo: value\('repo'\), owner: value\('owner'\) \? Number\(value\('owner'\)\) : null,\n\s+alertEmail: value\('alertEmail'\), alertPhone: value\('alertPhone'\),\n\s+\}\)/);
  assert.match(form, /note\.textContent = `Not saved: \$\{err\.message\}`;/);
  assert.ok(!/main\.innerHTML/.test(form.slice(form.indexOf("addEventListener('submit'"))), 'a refused save never redraws the form, so nothing typed is lost');
  // Saving opens the details page, which reads the project back from the server.
  assert.match(form, /history\.pushState\(null, '', `\/projects\/\$\{encodeURIComponent\(saved\.slug\)\}`\);\n\s+await route\(\);/);
  assert.match(app, /const editProject = \/\^\\\/projects\\\/\(\[\^\/\]\+\)\\\/edit\$\/\.exec\(location\.pathname\);/);
});

test('a project\'s details page lists its members, gives an admin Add Member and Remove (never on the owner or operator), reads each change back, and shows a refusal\'s reason', () => {
  const app = pageScript();
  const draw = app.slice(app.indexOf('async function drawProjectDetails'), app.indexOf('/** One labelled text box'));
  assert.match(draw, /<h2>Members<\/h2>/);
  for (const field of ['m.name', 'm.addedBy.name', 'x.name', 'x.id', 'm.id', 't']) assert.match(draw, new RegExp(`escapeHtml\\(${field.replace('.', '\\.')}\\)`), field);
  // Only an admin signed in as a person gets the controls; the owner and operator get a tag, no Remove.
  assert.match(draw, /const editing = me\?\.kind === 'human' && p\.canEditMembers === true;/);
  assert.match(draw, /fixedAs\(m\)\.length \? '' : `<button type="button" class="btn btn-danger btn-sm" data-remove=/);
  assert.match(draw, /<button type="submit" class="btn btn-primary">Add Member<\/button>/);
  assert.match(draw, />Remove<\/button>/);
  // The picker offers only people not on the project yet.
  assert.match(draw, /const addable = people\.filter\(\(x\) => !members\.some\(\(m\) => m\.id === x\.id\)\);/);
  assert.match(draw, /api\('POST', `\/projects\/\$\{encodeURIComponent\(slug\)\}\/members`, \{ person: id \}\)/);
  assert.match(draw, /api\('DELETE', `\/projects\/\$\{encodeURIComponent\(slug\)\}\/members\/\$\{encodeURIComponent\(id\)\}`\)/);
  // Each change is read back before the page says it worked; a refusal shows the server's reason.
  assert.match(draw, /const back = await api\('GET', `\/projects\/\$\{encodeURIComponent\(slug\)\}`\)\.catch\(\(\) => null\);/);
  assert.match(draw, /const ok = back != null && listed === wanted\.listed;/);
  assert.match(draw, /note\.textContent = `Not \$\{verb === 'add' \? 'added' : 'removed'\}: \$\{err\.message\}`;/);
  assert.match(draw, /Only its members \(and admins\) see this project/);
});

test('the Users page lists each user\'s projects, each a link to its details page', () => {
  const app = pageScript();
  const draw = app.slice(app.indexOf('async function drawUsers'), app.length);
  assert.match(draw, /<th class="projects">Projects<\/th>/);
  // Anyone but an admin sees the cell as before: links, or "none" (left out under an admin's "All projects (admin)").
  assert.match(draw, /if \(!editing\) return mine\.length \? mine\.map\(\(x\) => `<a href="\/projects\/\$\{encodeURIComponent\(x\.slug\)\}">\$\{escapeHtml\(x\.name\)\}<\/a>`\)\.join\(', '\) : none;/);
});

test('the Users page says "All projects (admin)" first in an admin\'s Projects cell, from the server\'s seesEveryProject, and leaves out "none" under it (SP-197)', () => {
  const app = pageScript();
  const draw = app.slice(app.indexOf('async function drawUsers'), app.length);
  assert.match(draw, /const every = p\.seesEveryProject === true;/);
  assert.match(draw, /<span class="every"[^>]*>All projects \(admin\)<\/span>/);
  assert.match(draw, /return `\$\{label\}\$\{memberCell\(p, every \? '' : '<span class="quiet">none<\/span>'\)\}`;/);
  // Both forms of the cell (a viewer's links, an admin's editing list) use the same "none".
  assert.match(draw, /\.join\(', '\) : none;/);
  assert.match(draw, /<\/span>`\)\.join\(''\) : none\}/);
  assert.match(readFileSync(WEB('app.css'), 'utf8'), /table\.people td span\.every \{/);
});

test('the Users page gives an admin Remove on each of a user\'s projects (never where they are its owner or operator) and an Add to Project picker, each change read back', () => {
  const app = pageScript();
  const draw = app.slice(app.indexOf('async function drawUsers'), app.length);
  // Only an admin signed in as a person: the flag comes from GET /projects, which a loop's sign-in never asks for here.
  assert.match(draw, /const \{ projects: all = \[\], canEditMembers = false \} = person \? await api\('GET', '\/projects'\) : \{\};/);
  assert.match(draw, /const editing = person && canEditMembers === true;/);
  // The owner and operator get a tag and no Remove.
  assert.match(draw, /pr\?\.owner\?\.id === p\.id \? 'Owner' : null, pr\?\.operator\?\.id === p\.id \? 'Operator' : null/);
  assert.match(draw, /\$\{fixedAs\(p, x\)\.length\s*\? ''\s*: `<button type="button" class="btn btn-danger btn-sm remove-member"/);
  // The picker offers only the projects they are not on yet.
  assert.match(draw, /const addable = all\.filter\(\(x\) => !mine\.some\(\(m\) => m\.slug === x\.slug\)\);/);
  assert.match(draw, /<option value="">Add to Project…<\/option>/);
  for (const field of ['x.slug', 'x.name', 'p.id', 'p.name', 't']) assert.match(draw, new RegExp(`escapeHtml\\(${field.replace('.', '\\.')}\\)`), field);
  // Each change goes through changeMember and is read back from GET /people.
  assert.equal(draw.match(/changeMember\(\{ control: /g).length, 2);
  assert.match(draw, /const back = \(await api\('GET', '\/people'\)\)\.people\?\.find\(\(x\) => String\(x\.id\) === String\(id\)\);/);
  assert.match(draw, /return back \? \(back\.projects \?\? \[\]\)\.some\(\(x\) => x\.slug === slug\) : null;/);
});

test('the Projects page has a Members column; an admin gets Remove on each member (never the owner or operator) and an Add Member picker, each change read back', () => {
  const app = pageScript();
  const draw = /async function drawProjects\(done = '', problem = ''\) \{[\s\S]*?\n\}/.exec(app)[0];
  assert.match(draw, /<th class="members">Members<\/th>/);
  assert.match(draw, /<td class="members">\$\{membersCell\(p\)\}<\/td>/);
  assert.match(draw, /const editing = people && canEditMembers === true;/);
  assert.match(draw, /const everyone = editing \? \(await api\('GET', '\/people'\)\)\.people \?\? \[\] : \[\];/);
  assert.match(draw, /m\.id === p\.owner\?\.id \? 'Owner' : null, m\.id === p\.operator\?\.id \? 'Operator' : null/);
  assert.match(draw, /\$\{editing && !fixedAs\(p, m\)\.length\s*\? `<button type="button" class="btn btn-danger btn-sm remove-member"/);
  assert.match(draw, /const addable = everyone\.filter\(\(x\) => !members\.some\(\(m\) => m\.id === x\.id\)\);/);
  assert.match(draw, /<option value="">Add Member…<\/option>/);
  for (const field of ['m.name', 'm.id', 'p.slug', 'p.name', 'x.id', 'x.name', 't']) assert.match(draw, new RegExp(`escapeHtml\\(${field.replace('.', '\\.')}\\)`), field);
  assert.equal(draw.match(/changeMember\(\{ control: /g).length, 2);
  assert.match(draw, /const back = \(await api\('GET', '\/projects'\)\)\.projects\?\.find\(\(x\) => x\.slug === slug\);/);
  // A refusal shows above the table, as an error.
  assert.match(draw, /<p class="note\$\{problem \? ' error' : \(done \? ' quiet' : ''\)\}" role="status">\$\{escapeHtml\(problem \|\| done\)\}<\/p>/);
});

test('changeMember sends the project page\'s own calls, shows a refusal\'s reason, and says it worked only when the list read back agrees', () => {
  const app = pageScript();
  const fn = /async function changeMember\(\{[\s\S]*?\n\}/.exec(app)[0];
  assert.match(fn, /api\('POST', `\/projects\/\$\{encodeURIComponent\(slug\)\}\/members`, \{ person: Number\(person\) \}\)/);
  assert.match(fn, /api\('DELETE', `\/projects\/\$\{encodeURIComponent\(slug\)\}\/members\/\$\{encodeURIComponent\(person\)\}`\)/);
  assert.match(fn, /note\.textContent = `Not \$\{done\}: \$\{err\.message\}`;/);
  assert.match(fn, /const listed = await listedNow\(\)\.catch\(\(\) => null\);/);
  assert.match(fn, /const ok = listed === adding;/);
  assert.match(fn, /again\(ok\s*\? `\$\{adding \? 'Added' : 'Removed'\} \$\{name\} \$\{where\}\.`/);
});

// ── Set up a project (SP-127) ────────────────────────────────────────────────

/**
 * A tracker home for the setup page, as tracker/server.test.mjs's: this
 * repository's settings file with its own log folder, read the way the
 * server reads it. `state(slug, ...)` writes a state file as the wizard
 * leaves it; `of(slug)` is the server's answer for that project.
 */
function setupHome() {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-setup-page-'));
  const home = join(dir, 'home');
  const logDir = join(dir, 'logs');
  mkdirSync(home);
  const settings = JSON.parse(readFileSync(new URL('../spirality.project.json', import.meta.url), 'utf8'));
  writeFileSync(join(home, 'spirality.project.json'), JSON.stringify({ ...settings, logDir }));
  const { setup, why } = setupSettingsOf({ db: join(dir, 'tracker.db'), folder: home });
  assert.ok(setup, why);
  const onboard = join(logDir, 'onboard');
  const state = (slug, { outcomes = {}, stop = null, finished = false } = {}) => {
    mkdirSync(onboard, { recursive: true });
    const steps = SETUP_STEPS.map((step) => ({ step, outcome: outcomes[step] ?? 'pending', at: null, why: outcomes[step] ? `${step} said so` : null }));
    writeFileSync(join(onboard, `${slug}.state.json`), JSON.stringify({ project: slug, updatedAt: '2026-11-05T08:15:00.000Z', steps, stop, finished }));
  };
  return { dir, setup, state, of: (slug) => setupOf(setup, slug), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The `<code>` texts in a box, and how many Copy buttons sit beside them. */
const copies = (html) => ({ codes: codes(html), buttons: (html.match(/<button type="button" class="btn copy-command">Copy<\/button>/g) ?? []).length });

test('the setup page\'s next-step box, for a state file of each kind: every command with a Copy button whose text is exactly it', () => {
  const h = setupHome();
  try {
    saveAnswers(h.setup, 'press-play', { projectName: 'Press Play', githubRepo: 'example-owner/press-play', description: 'A test project.', trackerPrefix: '', mergePhrases: '', autoMergeLanes: 'none', extraGovernancePaths: 'none' });
    const command = h.of('press-play').commands.resume;
    assert.match(command, /npm run onboard -- --project press-play --no-prompt$/);
    const kind = (html) => /data-next="([a-z]+)"/.exec(html)[1];

    // Nothing run yet: the start command, to paste on the Mini.
    let html = renderSetupNext(h.of('press-play'));
    assert.equal(kind(html), 'start');
    assert.match(html, /Paste this into a Terminal on the Mini/);
    assert.deepEqual(copies(html), { codes: [command], buttons: 1 });
    assert.match(renderSetupSteps(null), /Not started yet/);

    // Stopped for answers: the start command, and the way back to the form.
    h.state('press-play', { outcomes: { answers: 'stopped' }, stop: { step: 'answers', kind: 'answers', why: 'still to answer: description', commands: [], link: null } });
    html = renderSetupNext(h.of('press-play'));
    assert.equal(kind(html), 'answers');
    assert.match(html, /still to answer: description/);
    assert.match(html, /<a href="\/setup\/press-play\/answers">Fill in the answers<\/a>/);
    assert.deepEqual(copies(html), { codes: [command], buttons: 1 });

    // Stopped at the paste: "Your Move (Real Secret Values)", one Copy for every line, then the resume command.
    const block = ["cd '/x/spirality'", "doppler projects create 'press-play'", "TRACKER_DB='/x/t.db' npm run tracker:signins -- create --name 'Press Play' --prefix 'PR' --config '/x/p.json'"];
    h.state('press-play', { outcomes: { answers: 'done', look: 'done', clone: 'skip', settings: 'done', signins: 'stopped' }, stop: { step: 'signins', kind: 'paste', why: 'waiting on you to run the block above', commands: block, link: null } });
    html = renderSetupNext(h.of('press-play'));
    assert.equal(kind(html), 'paste');
    assert.match(html, /Your Move \(Real Secret Values\)/);
    assert.deepEqual(copies(html), { codes: [block.join('\n'), command], buttons: 2 });
    assert.ok(html.indexOf(escapeHtml(block[0])) < html.indexOf(escapeHtml(command)), 'the block first, then the resume command');

    // Stopped at the merge: the setup ticket's link (its Merge button is there), then the resume command.
    h.state('press-play', { outcomes: { answers: 'done', signins: 'done', copy: 'done', lanes: 'done', merge: 'stopped' }, stop: { step: 'merge', kind: 'merge', why: 'not merged yet', commands: [], link: 'http://mac-mini.local:4180/t/PR-1' } });
    html = renderSetupNext(h.of('press-play'));
    assert.equal(kind(html), 'merge');
    assert.match(html, /<a href="http:\/\/mac-mini\.local:4180\/t\/PR-1">Open the setup ticket<\/a>/);
    assert.deepEqual(copies(html), { codes: [command], buttons: 1 });
    // A link that is not a web address is not drawn as one.
    h.state('press-play', { outcomes: { merge: 'stopped' }, stop: { step: 'merge', kind: 'merge', why: 'not merged yet', commands: [], link: 'javascript:alert(1)' } });
    assert.doesNotMatch(renderSetupNext(h.of('press-play')), /javascript:/);

    // Failed: the FAILED text, then the resume command.
    h.state('press-play', { outcomes: { answers: 'done', look: 'failed' }, stop: { step: 'look', kind: 'failed', why: 'something is BLOCKED <here>', commands: [], link: null } });
    html = renderSetupNext(h.of('press-play'));
    assert.equal(kind(html), 'failed');
    assert.deepEqual(copies(html), { codes: ['FAILED: look: something is BLOCKED <here>', command], buttons: 1 });
    assert.match(renderSetupSteps(h.of('press-play').state), /<li class="step failed"><span class="step-name">look<\/span> <span class="outcome">failed<\/span>/);

    // A step running: says which, and still offers the command should its run have ended.
    h.state('press-play', { outcomes: { answers: 'done', look: 'running' } });
    html = renderSetupNext(h.of('press-play'));
    assert.equal(kind(html), 'running');
    assert.match(html, /Running: look/);
    assert.deepEqual(copies(html), { codes: [command], buttons: 1 });

    // Finished: "<name> is set up", its project and its first ticket; nothing to copy.
    h.state('press-play', { outcomes: Object.fromEntries(SETUP_STEPS.map((s) => [s, 'done'])), finished: true });
    const done = h.of('press-play');
    html = renderSetupNext(done, { firstTicketId: 'PR-1' });
    assert.equal(kind(html), 'finished');
    assert.match(html, /<h2>Press Play Is Set Up<\/h2>/);
    assert.match(html, /<a href="\/projects\/press-play">its project<\/a>/);
    assert.match(html, /<a href="\/t\/PR-1">its first ticket, PR-1<\/a>/);
    assert.deepEqual(copies(html), { codes: [], buttons: 0 });
    // Every step listed, in the wizard's order, with its outcome.
    const steps = renderSetupSteps(done.state);
    assert.deepEqual([...steps.matchAll(/<span class="step-name">([a-z]+)<\/span>/g)].map((m) => m[1]), SETUP_STEPS);
    assert.equal(steps.match(/<span class="outcome">done<\/span>/g).length, SETUP_STEPS.length);

    // The page follows the setup every few seconds until it is finished.
    assert.equal(setupFollows(done), false);
    assert.equal(setupFollows({ ...done, finished: false }), true);

    // A state file that does not read says so, and offers the command.
    writeFileSync(join(h.setup.homeConfig.logDir, 'onboard', 'press-play.state.json'), '{ not json');
    html = renderSetupNext(h.of('press-play'));
    assert.equal(kind(html), 'unreadable');
    assert.deepEqual(copies(html), { codes: [command], buttons: 1 });
  } finally { h.cleanup(); }
});

test('the first ticket is the lowest-numbered on its board; a board with none has none', () => {
  assert.equal(firstTicket({ columns: [{ tickets: [{ id: 'PR-12' }, { id: 'PR-3' }] }, { tickets: [{ id: 'PR-10' }] }] }), 'PR-3');
  assert.equal(firstTicket({ columns: [{ tickets: [] }] }), null);
  assert.equal(firstTicket(null), null);
});

test('the setup form asks the wizard\'s own questions with their defaults, and sends a default as null so it stays the wizard\'s', () => {
  const h = setupHome();
  try {
    const fields = setupFields(h.setup, 'press-play');
    const html = renderSetupForm(fields);
    assert.deepEqual([...html.matchAll(/name="([A-Za-z]+)"/g)].map((m) => m[1]), SETUP_FIELDS.map((f) => f.key));
    assert.match(html, /<label for="setup-projectName">Project Name<\/label>\s*<span class="hint" id="setup-projectName-hint">Project name, as the tracker shows it<\/span>/, 'a Title Case label, the wizard\'s question under it (SP-325)');
    assert.match(html, /name="trackerPrefix" data-default="PR" aria-describedby="setup-trackerPrefix-hint" autocapitalize="off" spellcheck="false" value="PR">/);
    // A list's hint says "commas between" once, and its box points a screen reader at the hint.
    assert.match(html, /<span class="hint" id="setup-autoMergeLanes-hint">Lanes that may merge without you\. Commas between; &quot;none&quot; for none\.<\/span>/);
    assert.doesNotMatch(html, /\(comma between\)/);
    assert.match(html, /<textarea id="setup-description"/);
    assert.match(html, /<span class="note field-note" data-for="githubRepo"><\/span>/);
    // Saved answers fill it in: a list with commas, an empty list as "none".
    const again = renderSetupForm(fields, { projectName: 'Press <Play>', autoMergeLanes: [], extraGovernancePaths: ['docs/A.md', 'ops/'] });
    assert.match(again, /name="projectName"[^>]*value="Press &lt;Play&gt;"/);
    assert.match(again, /name="autoMergeLanes"[^>]*value="none"/);
    assert.match(again, /name="extraGovernancePaths"[^>]*value="docs\/A\.md, ops\/"/);
    // The body: each answer as typed, a default as null; the server's checker accepts it.
    const values = Object.fromEntries(fields.map((f) => [f.key, f.default ?? '']));
    Object.assign(values, { projectName: 'Press Play', githubRepo: 'example-owner/press-play', description: 'A test project.', autoMergeLanes: 'relay' });
    const body = setupBody(fields, values);
    assert.equal(body.trackerPrefix, null);
    assert.equal(body.mergePhrases, null);
    assert.equal(body.autoMergeLanes, 'relay');
    assert.equal(body.projectName, 'Press Play');
    const saved = saveAnswers(h.setup, setupSlug('Press Play'), body);
    assert.equal(saved.project, 'press-play');
    assert.equal(saved.resolved.trackerPrefix, 'PR');
    assert.deepEqual(saved.resolved.autoMergeLanes, ['relay']);
  } finally { h.cleanup(); }
});

test('the setup form asks the ClickUp questions only for a project whose checkout runs a loop of its own, and saves them through the wizard\'s checker', () => {
  const h = setupHome();
  try {
    const dane = { projectName: 'Wave Thing', githubRepo: 'example-owner/wave-thing', description: 'A test project.' };
    const keys = (slug) => setupFields(h.setup, slug).map((f) => f.key);
    const clickupKeys = ['clickupListId', 'clickupOperatorId', 'clickupMachineUserId', 'clickupExtraLists'];
    // A new project: Dane's questions only, and a ClickUp answer is refused.
    saveAnswers(h.setup, 'wave-thing', dane);
    assert.deepEqual(keys('wave-thing'), SETUP_FIELDS.map((f) => f.key));
    assert.throws(() => saveAnswers(h.setup, 'wave-thing', { clickupListId: '7' }), /unknown field\(s\): clickupListId/);

    // Its checkout (the default, beside the tracker home) has an old loop's installer: the four ClickUp questions follow.
    const checkout = join(h.dir, 'wave-thing');
    mkdirSync(join(checkout, 'scripts'), { recursive: true });
    writeFileSync(join(checkout, 'scripts', 'install_loop_runner.sh'), '#!/bin/bash\n');
    assert.deepEqual(keys('wave-thing'), [...SETUP_FIELDS.map((f) => f.key), ...clickupKeys]);
    const fields = setupFields(h.setup, 'wave-thing');
    const html = renderSetupForm(fields);
    assert.match(html, /<label for="setup-clickupListId">ClickUp Loop Queue List<\/label>\s*<span class="hint" id="setup-clickupListId-hint">Does this project already run a loop on ClickUp\?/);
    assert.ok(!/name="clickupOperatorId"[^>]*required/.test(html), 'needed only with a list, which the checker says by name');

    // A list without the seats: refused, naming the field, nothing written.
    assert.throws(() => saveAnswers(h.setup, 'wave-thing', { clickupListId: '4242' }), (err) => err.status === 400 && err.field === 'clickupOperatorId');
    assert.equal(h.of('wave-thing').answers.clickupListId, undefined);

    // All of them: saved, and the wizard's checker reads them back.
    const values = { ...Object.fromEntries(fields.map((f) => [f.key, f.default ?? ''])), ...dane, clickupListId: '4242', clickupOperatorId: '700', clickupMachineUserId: '800', clickupExtraLists: '4343' };
    const saved = saveAnswers(h.setup, 'wave-thing', setupBody(fields, values));
    assert.deepEqual([saved.resolved.clickupListId, saved.resolved.clickupOperatorId, saved.resolved.clickupMachineUserId, [...saved.resolved.clickupExtraLists]], ['4242', '700', '800', ['4343']]);
    assert.match(renderSetupForm(setupFields(h.setup, 'wave-thing'), saved.answers), /name="clickupListId"[^>]*value="4242"/);

    // Blank is "not on ClickUp": kept, so the questions stay on the form and the wizard does not stop for them again.
    const no = saveAnswers(h.setup, 'wave-thing', { clickupListId: null, clickupOperatorId: null, clickupMachineUserId: null, clickupExtraLists: null });
    assert.equal(no.answers.clickupListId, null);
    assert.equal(no.resolved.clickupListId, null);
    assert.deepEqual(keys('wave-thing'), [...SETUP_FIELDS.map((f) => f.key), ...clickupKeys]);

    // Already on Spirality (its settings file is there): a new project's form again.
    rmSync(join(h.dir, 'logs', 'onboard', 'wave-thing.answers.json'));
    saveAnswers(h.setup, 'wave-thing', dane);
    writeFileSync(join(checkout, 'spirality.project.json'), '{}');
    assert.deepEqual(keys('wave-thing'), SETUP_FIELDS.map((f) => f.key));
  } finally { h.cleanup(); }
});

test('the page makes a slug by the wizard\'s rule, and refuses the two that are other pages\' addresses', () => {
  for (const name of ['Press Play', '  PressPlay!! 2 ', 'a--b', 'Ünïcode name', '---']) {
    assert.equal(setupSlug(name), slugFromName(name), name);
  }
  assert.equal(setupSlugProblem('press-play'), null);
  assert.match(setupSlugProblem(''), /letter or a digit/);
  assert.match(setupSlugProblem('new'), /another name/);
  assert.match(setupSlugProblem('fields'), /another name/);
});

test('the Projects page has Set up a project, lists the projects mid-setup, and keeps New project a link away', () => {
  const app = pageScript();
  const projects = /async function drawProjects\(done = '', problem = ''\) \{[\s\S]*?\n\}/.exec(app)[0];
  assert.match(projects, /<a class="btn btn-primary" href="\/setup\/new">Set Up a Project<\/a>/);
  assert.doesNotMatch(projects, /href="\/projects\/new">New project/);
  assert.match(projects, /api\('GET', '\/setup'\)/);
  assert.match(projects, /\$\{renderSetupList\(setups\)\}/);
  const setupNew = /async function drawSetupNew\(project\) \{[\s\S]*?\n\}/.exec(app)[0];
  assert.match(setupNew, /<a href="\/projects\/new">New project<\/a>/);
  assert.match(setupNew, /api\('PUT', `\/setup\/\$\{encodeURIComponent\(slug\)\}`, setupBody\(fields, values\)\)/);
  assert.match(setupNew, /history\.pushState\(null, '', `\/setup\/\$\{encodeURIComponent\(slug\)\}`\)/, 'Save opens its setup page');
  assert.match(setupNew, /err\.field \? form\.querySelector\(`\.field-note\[data-for="\$\{err\.field\}"\]`\)/, 'a refusal naming a field shows beside it');
  // The setup page wires the same Copy buttons as a ticket's, and follows the setup every few seconds.
  assert.match(/async function drawSetup\(slug\) \{[\s\S]*?\n\}/.exec(app)[0], /wireCopyButtons\(\);\s*return setupFollows\(setup\);/);
  assert.match(app, /const SETUP_REFRESH_EVERY_MS = 4_000;/);
  assert.match(app, /if \(lastDrawn\?\.fast\) refreshPage\(\);\s*\}, SETUP_REFRESH_EVERY_MS\);/);
  assert.match(app, /if \(kept && following\) lastDrawn = \{ address: here\(\), reads, fast: true \};/);

  // The list: each project not finished, linking its setup page; nothing when there are none.
  const list = renderSetupList({ setups: [
    { project: 'press-play', step: 'signins', finished: false, started: true, stateError: null },
    { project: 'done-one', step: null, finished: true, started: true, stateError: null },
    { project: 'fresh', step: null, finished: false, started: false, stateError: null },
  ] });
  assert.match(list, /<h2>Being Set Up<\/h2>/);
  assert.match(list, /<a href="\/setup\/press-play">press-play<\/a> <span class="quiet">at signins<\/span>/);
  assert.match(list, /<a href="\/setup\/fresh">fresh<\/a> <span class="quiet">not started yet<\/span>/);
  assert.doesNotMatch(list, /done-one/);
  assert.equal(renderSetupList({ setups: [] }), '');
});

test('the setup pages are served to a browser at /setup/new, /setup/<slug> and its answers form; the page\'s own call still gets the data', async () => {
  const f = await fixture();
  try {
    const html = { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' };
    const page = readFileSync(WEB('index.html'), 'utf8');
    for (const path of ['/setup/new', '/setup/press-play', '/setup/press-play/answers']) {
      const r = await fetch(`${f.url}${path}`, { headers: html });
      assert.equal(r.status, 200, path);
      assert.equal(await r.text(), page, path);
    }
    // Without asking for HTML, /setup/<slug> is the call (this fixture's server has no tracker home: 503), and needs a sign-in.
    assert.equal((await f.call('GET', '/setup/press-play')).status, 503);
    assert.equal((await f.call('GET', '/setup/press-play', { token: null })).status, 401);
    // /setup/fields is only ever the call.
    assert.notEqual((await fetch(`${f.url}/setup/fields`, { headers: html })).headers.get('content-type'), 'text/html; charset=utf-8');
  } finally { await f.cleanup(); }
});
