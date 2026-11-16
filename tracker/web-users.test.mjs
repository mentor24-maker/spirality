/**
 * Tests for the Users page. One file per page (SP-352),
 * so two tickets changing two pages no longer edit one test file; what they
 * share is tracker/webTestKit.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageScript } from './pageScripts.mjs';
import { WEB, fixture } from './webTestKit.mjs';

// ── Users ────────────────────────────────────────────────────────────────────

test('Users is in the header before Docs, served at /users to a browser, and its data needs a sign-in', async () => {
  const html = readFileSync(WEB('index.html'), 'utf8');
  assert.match(html, /<a href="\/users" data-nav="users">Users<\/a>\s*<a href="\/docs" data-nav="docs">Docs<\/a>/);
  assert.doesNotMatch(html, />People</);
  const f = await fixture();
  try {
    const page = await fetch(`${f.url}/users`, { headers: { accept: 'text/html' } });
    assert.equal(page.status, 200);
    assert.equal(await page.text(), html);
    assert.equal((await f.call('GET', '/people', { token: null })).status, 401);
  } finally { await f.cleanup(); }
  const app = pageScript();
  assert.match(app, /usersPage \? 'users' :/);
  assert.match(app, /\} else if \(usersPage\) \{\s*await drawUsers\(\);/);
});

test('a browser opening /people (an old bookmark) is sent on to /users, never cached; the data call to /people still answers the data', async () => {
  const f = await fixture();
  try {
    const old = await fetch(`${f.url}/people?x=1`, { headers: { accept: 'text/html' }, redirect: 'manual' });
    assert.equal(old.status, 302);
    assert.equal(old.headers.get('location'), '/users?x=1');
    assert.equal(old.headers.get('cache-control'), 'no-store');
    assert.match(old.headers.get('vary') ?? '', /accept/i);
    const followed = await fetch(`${f.url}/people`, { headers: { accept: 'text/html' } });
    assert.equal(followed.status, 200);
    assert.equal(new URL(followed.url).pathname, '/users');
    // The page's own call (and the onboarding scripts') asks for anything, not HTML: it gets the data.
    const data = await f.call('GET', '/people');
    assert.equal(data.status, 200);
    assert.ok(Array.isArray(data.body.people));
    // /users is a page only: it holds no data of its own.
    const users = await fetch(`${f.url}/users`);
    assert.match(users.headers.get('content-type'), /text\/html/);
  } finally { await f.cleanup(); }
});

test('the Users page escapes every name and email, offers the form and Cancel to a person only, and reads back before saying it worked', () => {
  const app = pageScript();
  const draw = app.slice(app.indexOf('async function drawUsers'), app.length);
  assert.ok(draw.length > 100);
  for (const field of ['p.name', 'p.email', 'i.email', 'i.invitedBy.name', 'x.id', 'x.name']) assert.match(draw, new RegExp(`escapeHtml\\(${field.replace('.', '\\.')}\\)`), field);
  assert.match(draw, /\$\{person \? `<form class="invite fields">/);
  assert.match(draw, /\$\{person \? `<button type="button" class="btn btn-sm" data-cancel=/);
  // "Send the link to": only when the tracker knows an outside site, the tracker page first and chosen by default.
  assert.match(draw, /\$\{sites\.length \? `<div class="beside"><label for="invite-site">Send the Link To<\/label>/);
  assert.match(draw, /<select id="invite-site"><option value="">the tracker page<\/option>\$\{sites\.map/);
  assert.match(draw, /api\('POST', '\/invites', site \? \{ email, site: Number\(site\) \} : \{ email \}\)/);
  assert.match(draw, /api\('DELETE', `\/invites\/\$\{encodeURIComponent\(id\)\}`\)/);
  // Each write (invite, cancel, role change) is read back with GET /people before the page says it worked.
  assert.equal(draw.match(/await api\('GET', '\/people'\)\.catch/g).length, 3);
  assert.match(draw, /putTrail\(\[\{ label: 'Users' \}\]\)/);
  assert.match(draw, /setTitle\('Users · Tracker'\)/);
  assert.match(draw, /<h1>Users<\/h1>/);
  assert.match(draw, /<h2>Users with an Account<\/h2>/);
});

test('the Users page shows each role, gives an admin a picker that reads back, shows a refusal\'s reason, and lists which role has which permission', () => {
  const app = pageScript();
  const draw = app.slice(app.indexOf('async function drawUsers'), app.length);
  assert.match(draw, /<th class="role">Role<\/th>/);
  // The picker is an admin's only; everyone else sees the role as text.
  assert.match(draw, /const picker = person && canEditRoles;/);
  assert.match(draw, /: escapeHtml\(p\.role \?\? ''\)\)/);
  for (const field of ['p.id', 'p.name', 'r.name', 'r.description', 'x.description']) assert.match(draw, new RegExp(`escapeHtml\\(${field.replace('.', '\\.')}\\)`), field);
  // A change is sent, then read back with GET /people before the page says it worked.
  assert.match(draw, /api\('PUT', `\/people\/\$\{encodeURIComponent\(id\)\}\/role`, \{ role \}\)/);
  assert.match(draw, /const now = back\?\.people\?\.find\(\(p\) => String\(p\.id\) === id\)\?\.role;/);
  assert.match(draw, /again\(now === role \? `\$\{name\} is now \$\{role\}\.` :/);
  // A refusal puts the picker back and shows the server's own reason.
  assert.match(draw, /select\.value = was;[\s\S]*?note\.textContent = `Not changed: \$\{err\.message\}`;/);
  assert.match(draw, /<h2>Roles and Permissions<\/h2>/);
  assert.match(draw, /recorded, not yet enforced/);
});
