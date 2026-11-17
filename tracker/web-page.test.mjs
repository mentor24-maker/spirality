/**
 * Tests for what every page shares: serving, signing in, the header, the trail and the once-a-minute redraw. One file per page (SP-352),
 * so two tickets changing two pages no longer edit one test file; what they
 * share is tracker/webTestKit.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderTrail, bellColour, busLink, contrast, linkProblem, passwordProblem, renderSetPassword, renderPasswordSet, renderSignIn, renderForgot, MIN_PASSWORD, redrawHold, drawnChoice, healthLines, renderHealth, passOutcome, wakesEvery } from './web/render.mjs';
import { PAGE_SCRIPTS, RENDER_SCRIPTS, pageScript, renderScript } from './pageScripts.mjs';
import { WEB, drawnCss, fixture } from './webTestKit.mjs';

// ── The page itself ──────────────────────────────────────────────────────────

test('the page script is app.mjs and one file per page, every one listed, served and loaded by import (SP-352)', async () => {
  const onDisk = readdirSync(fileURLToPath(new URL('./web/', import.meta.url))).filter((n) => /^page-[a-z-]+\.mjs$/.test(n)).sort();
  assert.deepEqual(PAGE_SCRIPTS.filter((n) => n !== 'app.mjs').sort(), onDisk, 'every page file is in PAGE_SCRIPTS, and nothing listed is missing');
  assert.equal(PAGE_SCRIPTS[0], 'app.mjs');
  const imported = new Set();
  for (const name of PAGE_SCRIPTS) {
    for (const m of readFileSync(WEB(name), 'utf8').matchAll(/^import \{[^}]*\} from '\.\/([\w-]+\.mjs)';$/gm)) imported.add(m[1]);
  }
  for (const name of onDisk) assert.ok(imported.has(name), `${name} is imported, so the page loads it`);
  assert.match(readFileSync(WEB('index.html'), 'utf8'), /<script type="module" src="\/web\/app\.mjs"><\/script>/, 'the page loads only its entry; the rest come by import');
  const f = await fixture();
  try {
    for (const name of PAGE_SCRIPTS) {
      const r = await f.call('GET', `/web/${name}`, { token: null });
      assert.equal(r.status, 200, name);
      assert.equal(r.headers.get('content-type'), 'text/javascript; charset=utf-8', name);
      assert.equal(r.text, readFileSync(WEB(name), 'utf8'), name);
    }
    assert.notEqual((await f.call('GET', '/web/page-nothing.mjs', { token: null })).status, 200, 'a page file not listed is not served');
  } finally {
    await f.cleanup();
  }
});

test('the drawing is render.mjs and one file per page, every one listed, re-exported and served (SP-364)', async () => {
  const onDisk = readdirSync(fileURLToPath(new URL('./web/', import.meta.url))).filter((n) => /^render-[a-z-]+\.mjs$/.test(n)).sort();
  assert.deepEqual(RENDER_SCRIPTS.filter((n) => n !== 'render.mjs').sort(), onDisk, 'every drawing file is in RENDER_SCRIPTS, and nothing listed is missing');
  assert.equal(RENDER_SCRIPTS[0], 'render.mjs');
  const hub = readFileSync(WEB('render.mjs'), 'utf8');
  const gathered = [...hub.matchAll(/^export \* from '\.\/([\w-]+\.mjs)';$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(gathered, onDisk, 'render.mjs re-exports every drawing file, so every importer still names render.mjs');
  assert.doesNotMatch(hub.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\/\/.*$/gm, ''), /\bfunction\b|\bconst\b/, 'render.mjs only gathers: what it draws lives in its page\'s file');
  const f = await fixture();
  try {
    for (const name of RENDER_SCRIPTS) {
      const r = await f.call('GET', `/web/${name}`, { token: null });
      assert.equal(r.status, 200, name);
      assert.equal(r.headers.get('content-type'), 'text/javascript; charset=utf-8', name);
      assert.equal(r.text, readFileSync(WEB(name), 'utf8'), name);
    }
    assert.notEqual((await f.call('GET', '/web/render-nothing.mjs', { token: null })).status, 200, 'a drawing file not listed is not served');
  } finally {
    await f.cleanup();
  }
  assert.ok(renderScript().includes('export function renderConsole('), 'renderScript() reads every drawing file');
});

test('the page is served at /, at a ticket\'s address, at Projects, at Tasks, at the board, at the list, at the Console and at the old New request address without a token, locked to its own scripts', async () => {
  const f = await fixture();
  try {
    for (const path of ['/', '/t/AL-1', '/tasks', '/board', '/board/alpha', '/list', '/list/alpha', '/console', '/new']) {
      const r = await f.call('GET', path, { token: null });
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type'), /^text\/html/);
      assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
      assert.equal(r.text, readFileSync(WEB('index.html'), 'utf8'));
    }
    for (const name of ['app.mjs', 'render.mjs', 'app.css']) {
      const r = await f.call('GET', `/web/${name}`, { token: null });
      assert.equal(r.status, 200, name);
      assert.equal(r.text, readFileSync(WEB(name), 'utf8'));
    }
    // The header's wordmark and the tab's icon, as images the page's lock allows.
    for (const name of ['wordmark.png', 'icon.png', 'loop-queue-diagram.png']) {
      const r = await fetch(`${f.url}/web/${name}`);
      assert.equal(r.status, 200, name);
      assert.equal(r.headers.get('content-type'), 'image/png');
      assert.deepEqual(Buffer.from(await r.arrayBuffer()), readFileSync(WEB(name)));
    }
    assert.match(readFileSync(WEB('index.html'), 'utf8'), /<img src="\/web\/wordmark\.png" alt="Spirality"/);
    // /projects is the page to a browser opening it, and still the data to the page's own call.
    const opened = await fetch(`${f.url}/projects`, { headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' } });
    assert.equal(opened.status, 200);
    assert.equal(await opened.text(), readFileSync(WEB('index.html'), 'utf8'));
    assert.equal((await f.call('GET', '/projects')).body.projects.length, 2);
    assert.equal((await f.call('GET', '/projects', { token: null })).status, 401);
    // So is a project's details page, known or not: the page itself says when there is no such project.
    for (const path of ['/projects/alpha', '/projects/no-such-thing']) {
      const page = await fetch(`${f.url}${path}`, { headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' } });
      assert.equal(page.status, 200, path);
      assert.equal(await page.text(), readFileSync(WEB('index.html'), 'utf8'), path);
    }
    assert.equal((await f.call('GET', '/projects/alpha')).body.slug, 'alpha');
    // The header: Projects picks a project, Tasks opens the one picked.
    assert.match(readFileSync(WEB('index.html'), 'utf8'), /<a href="\/projects" data-nav="projects">Projects<\/a>\s*<a href="\/tasks" data-nav="tasks">Tasks<\/a>/);
    // Only those files: nothing else on disk is reachable, with or without a token.
    for (const path of ['/web/../store.mjs', '/web/%2e%2e%2fstore.mjs', '/web/demo.mjs', '/store.mjs']) {
      assert.notEqual((await f.call('GET', path, { token: null })).status, 200, path);
      assert.notEqual((await f.call('GET', path)).status, 200, path);
    }
    // The ticket data still needs the token.
    assert.equal((await f.call('GET', '/tickets/AL-1', { token: null })).status, 401);
  } finally { await f.cleanup(); }
});

test('bellColour: grey while nothing waits, yellow for 1 to 3, red for more than 3', () => {
  assert.equal(bellColour(0), 'grey');
  assert.equal(bellColour(1), 'yellow');
  assert.equal(bellColour(2), 'yellow');
  assert.equal(bellColour(3), 'yellow');
  assert.equal(bellColour(4), 'red');
  assert.equal(bellColour(12), 'red');
  assert.equal(bellColour(null), 'grey');
  assert.equal(bellColour(undefined), 'grey');
});

test('Waiting on you is a bell on the right, just before "Signed in as", coloured from the count wherever it is read', () => {
  const html = readFileSync(WEB('index.html'), 'utf8');
  const nav = /<nav class="site" hidden>([\s\S]*?)<\/nav>/.exec(html)[1];
  assert.deepEqual([...nav.matchAll(/>([^<]+)<\/a>/g)].map((m) => m[1]), ['Projects', 'Tasks', 'Topics', 'Reporting', 'Users', 'Docs', 'Settings']);
  assert.doesNotMatch(nav, /Waiting on you/);
  const me = /<span class="me">([\s\S]*?)<\/span>\s*<\/header>/.exec(html)[1];
  assert.match(me, /<a id="bell" href="\/" title="Waiting on You" aria-label="Waiting on You" data-colour="grey" hidden><svg [^>]*aria-hidden="true">[\s\S]*?<\/svg><\/a>\s*<span id="who"><\/span>/);
  const app = pageScript();
  assert.match(app, /function showBell\(\) \{\s*bell\.dataset\.colour = bellColour\(waitingCount\);\s*\}/);
  // Every place the count is read colours the bell: the one-minute refresh and the Waiting on you page.
  const refresh = /async function refreshCount\(\) \{[\s\S]*?\n\}/.exec(app)[0];
  assert.match(refresh, /catch \(err\) \{[\s\S]*?return;\s*\}\s*document\.title = tabTitle\(waitingCount, pageTitle\);\s*showBell\(\);/, 'a failed read leaves the colour alone');
  assert.match(/async function drawWaiting\(\) \{[\s\S]*?\n\}/.exec(app)[0], /waitingCount = waiting\.length;\s*showBell\(\);/);
  assert.match(app, /async function beat\(\) \{\s*await refreshCount\(\);/);
  assert.match(app, /setInterval\(beat, REFRESH_EVERY_MS\);/);
  // Hidden while signed out, shown once signed in, and marked current on its own page.
  assert.match(/function signedOutHeader[\s\S]*?\n\}/.exec(app)[0], /bell\.hidden = true;/);
  assert.match(/function drawSignIn[\s\S]*?\n\}/.exec(app)[0], /signedOutHeader\(/);
  assert.match(/async function route\(\{ place = null \} = \{\}\) \{[\s\S]*?\n\}/.exec(app)[0], /signOut\.hidden = false;\s*bell\.hidden = false;/);
  assert.match(app, /bell\.classList\.toggle\('current', which === 'waiting'\);/);
  const css = drawnCss();
  for (const colour of ['grey', 'yellow', 'red']) assert.match(css, new RegExp(`header #bell\\[data-colour="${colour}"\\] \\{ color: #`));
  assert.match(css, /header #bell\[hidden\] \{ display: none; \}/, 'display: flex must not undo hidden');
});

test('the main menu shows only to someone signed in: hidden in the page, shown with "Signed in as", hidden on every signed-out view (SP-211)', () => {
  const html = readFileSync(WEB('index.html'), 'utf8');
  // Starts hidden, so it never shows during "Loading…" before the sign-in check answers.
  assert.match(html, /<nav class="site" hidden>/);
  assert.doesNotMatch(html, /<nav class="site">/);
  // The wordmark stays visible to everyone.
  assert.match(html, /<a class="brand" href="\/"><img src="\/web\/wordmark\.png"/);
  assert.doesNotMatch(/<a class="brand"[^>]*>/.exec(html)[0], /hidden/);
  const app = pageScript();
  assert.match(app, /const siteNav = document\.querySelector\('header nav\.site'\);/);
  // Shown in the same place as "Signed in as", once /me has answered.
  const route = /async function route\(\{ place = null \} = \{\}\) \{[\s\S]*?\n\}/.exec(app)[0];
  assert.match(route, /me = await api\('GET', '\/me'\);[\s\S]*?who\.textContent = `Signed in as \$\{me\.name\}`;\s*signOut\.hidden = false;\s*bell\.hidden = false;\s*siteNav\.hidden = false;/);
  assert.equal((app.match(/siteNav\.hidden = false;/g) ?? []).length, 1, 'shown in one place only');
  // Hidden on the sign-in screen, Forgot password, after Sign Out or an expired sign-in (all through signedOutHeader), and on Set Your Password.
  assert.match(/function signedOutHeader[\s\S]*?\n\}/.exec(app)[0], /siteNav\.hidden = true;/);
  assert.match(/async function drawSetPassword\(\) \{[\s\S]*?\n\}/.exec(app)[0], /siteNav\.hidden = true;/);
  assert.match(/function drawSignIn[\s\S]*?\n\}/.exec(app)[0], /signedOutHeader\(/);
  assert.match(/function drawForgot[\s\S]*?\n\}/.exec(app)[0], /signedOutHeader\(/);
  assert.match(app, /signOut\.addEventListener\('click', async \(\) => \{[\s\S]*?drawSignIn\(/);
  const css = readFileSync(WEB('app.css'), 'utf8');
  assert.match(css, /header nav\.site\[hidden\] \{ display: none; \}/, 'display: flex must not undo hidden');
});

// ── Keeping an open page current (SP-94) ─────────────────────────────────────

test('a beat leaves the page alone while the tab is hidden, a draw or a save is under way, or he is typing', () => {
  const idle = { focused: false, value: '', initial: '' };
  assert.equal(redrawHold(), null);
  assert.equal(redrawHold({ fields: [idle, { focused: false, value: 'SP-94', initial: 'SP-94' }] }), null, 'a box as drawn is not typing');
  assert.equal(redrawHold({ hidden: true }), 'hidden');
  assert.equal(redrawHold({ hidden: true, fields: [idle] }), 'hidden', 'hidden wins: nothing is read at all');
  assert.equal(redrawHold({ drawing: true }), 'drawing');
  assert.equal(redrawHold({ writing: true }), 'writing');
  assert.equal(redrawHold({ fields: [idle, { focused: true, value: '', initial: '' }] }), 'typing', 'a box with focus, even empty');
  assert.equal(redrawHold({ fields: [idle, { focused: false, value: 'half a repl', initial: '' }] }), 'typing', 'unsent text, focus gone');
  assert.equal(redrawHold({ fields: [{ focused: false, value: 'Old name, edited', initial: 'Old name' }] }), 'typing', 'an edited name');
});

test('a chooser picked and left (Copy to another project) holds the beat; one as drawn does not', () => {
  const opt = (value, defaultSelected = false) => ({ value, defaultSelected });
  assert.equal(drawnChoice([opt('normie'), opt('wavecenter')]), 'normie', 'nothing marked: the first option');
  assert.equal(drawnChoice([opt('low'), opt('high', true)]), 'high', 'the option drawn selected');
  assert.equal(drawnChoice([]), '');
  // Picked WaveCenter, then clicked somewhere blank: not his focus, but not as drawn.
  const copyTo = [opt('normie'), opt('wavecenter')];
  assert.equal(redrawHold({ fields: [{ focused: false, value: 'wavecenter', initial: drawnChoice(copyTo) }] }), 'typing');
  assert.equal(redrawHold({ fields: [{ focused: false, value: 'normie', initial: drawnChoice(copyTo) }] }), null);
  const app = pageScript();
  assert.match(/const fieldsOf = [\s\S]*?\n\}\)\);/.exec(app)[0], /initial: el\.tagName === 'SELECT' \? drawnChoice\(el\.options\) : el\.defaultValue,/);
});

test('an open page reads again once a minute and on coming back to the tab, never while hidden, and keeps his place', () => {
  const app = pageScript();
  assert.match(app, /const REFRESH_EVERY_MS = 60_000;/);
  assert.match(app, /document\.addEventListener\('visibilitychange', \(\) => \{\s*if \(!document\.hidden\) beat\(\);\s*\}\);/);
  // The guard reads the tab's visibility, the draws and saves under way, and every text box on the page.
  assert.match(app, /redrawHold\(\{ hidden: document\.hidden, drawing: drawing > 0, writing: writing > 0, dialog: Boolean\(main\.querySelector\('dialog\[open\]'\)\), fields: fieldsOf\(main\) \}\)/);
  const refresh = /async function refreshPage\(\) \{[\s\S]*?\n\}/.exec(app)[0];
  assert.match(refresh, /if \(checking \|\| !me \|\| !drawn \|\| drawn\.address !== here\(\) \|\| hold\(\)\) return;/, 'checked before any read');
  assert.match(refresh, /if \(!changed \|\| lastDrawn !== drawn \|\| drawn\.address !== here\(\) \|\| hold\(\)\) return;/, 'and again before drawing');
  assert.match(refresh, /await route\(\{ place: keepPlace\(\) \}\);/);
  assert.match(refresh, /catch \(err\) \{\s*if \(err instanceof SignedOut\) drawSignIn\(\);\s*\}/, 'a failed read leaves the page as it is');
  // Only Waiting on you, the board and list, and a ticket keep themselves current.
  const route = /async function route\(\{ place = null \} = \{\}\) \{[\s\S]*?\n\}/.exec(app)[0];
  assert.match(route, /lastDrawn = ticket \|\| project \|\| tasks \|\| isNew \|\| waiting \? \{ address: here\(\), reads \} : null;/);
  assert.match(route, /place\?\.restore\(\);\s*const kept = recording === reads;\s*if \(kept\) recording = null;\s*\/\/[^\n]*\n\s*if \(!waiting\) await refreshCount\(\);\s*if \(kept\) lastDrawn = /, 'his place is back before the page is shown, and the count is not part of what it was drawn from');
  assert.match(route, /me = await api\('GET', '\/me'\);\s*\/\/[^\n]*\n\s*recording = reads;/, 'who is signed in is not part of it either');
  // A save's own redraw keeps what the beat compares against, so the next beat does not undo its "Saved" note.
  assert.match(/async function drawAgain\(draw\) \{[\s\S]*?\n\}/.exec(app)[0], /await draw\(\);\s*if \(recording === reads && lastDrawn\?\.address === here\(\)\) lastDrawn = \{ address: here\(\), reads \};/);
  assert.equal(app.match(/await drawTicket\(t\.id/g), null, 'every in-page ticket redraw goes through drawAgain');
  assert.equal((app.match(/await drawAgain\(\(\) => draw(Ticket|Project)\(/g) ?? []).length, 9, 'SP-208 added the List view priority save; SP-251 the Suggest Next Tasks filing; SP-287 the bug report buttons; SP-291 the Add Comment box');
  assert.match(route, /if \(place && !\(err instanceof SignedOut\)\) return;/, "a beat's failed draw does not replace the page with an error");
  assert.match(app, /if \(location\.hash === '#reply' && !refreshing\) \{/, 'a beat does not jump to the reply box again');
  assert.match(/function keepPlace\(\) \{[\s\S]*?\n\}/.exec(app)[0], /main\.querySelectorAll\('details'\)[\s\S]*window\.scrollTo\(0, y\);/);
  // Every GET of a draw is kept; a write counts as a save under way until it answers.
  const api = /async function api\(method, path, body, \{ unrecorded = false \} = \{\}\) \{[\s\S]*?\n\}/.exec(app)[0];
  assert.match(api, /if \(write\) writing \+= 1;/);
  assert.match(api, /finally \{\s*if \(write\) writing -= 1;\s*\}/);
  assert.match(api, /if \(!write\) reads\?\.set\(path, JSON\.stringify\(json\)\);/);
});

test('the page has no inline script or style, so its lock does not have to be loosened', () => {
  const html = readFileSync(WEB('index.html'), 'utf8');
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/);
  assert.doesNotMatch(html, /\son[a-z]+=/i);
  assert.doesNotMatch(html + pageScript(), /style="/);
});

test('the trail links every step but the last, and the last is the page itself', () => {
  const html = renderTrail([
    { label: 'Spirality', href: '/board/spirality' },
    { label: 'Task SP-47', href: '/t/SP-47' },
    { label: 'Details' },
  ]);
  assert.equal(html, '<nav class="trail" aria-label="You are here">'
    + '<a href="/board/spirality">Spirality</a><span class="sep"> &gt; </span>'
    + '<a href="/t/SP-47">Task SP-47</a><span class="sep"> &gt; </span>'
    + '<span aria-current="page">Details</span></nav>');
  // A last step given an address is still not a link.
  assert.equal(renderTrail([{ label: 'Projects', href: '/projects' }]),
    '<nav class="trail" aria-label="You are here"><span aria-current="page">Projects</span></nav>');
});

test('every name in the trail is escaped, in its text and in its address', () => {
  const html = renderTrail([
    { label: 'R&D <b>', href: '/list/a"b' },
    { label: 'Task <script>alert(1)</script>' },
  ]);
  assert.doesNotMatch(html, /<b>|<script|a"b/);
  assert.match(html, /<a href="\/list\/a&quot;b">R&amp;D &lt;b&gt;<\/a>/);
  assert.match(html, /<span aria-current="page">Task &lt;script&gt;alert\(1\)&lt;\/script&gt;<\/span>/);
});

test('every page puts its trail at the top: ticket, board, list, Waiting on you, Projects', () => {
  const app = pageScript();
  const body = (name) => new RegExp(`async function ${name}\\(([^)]*)\\) \\{([\\s\\S]*?)\\n\\}`).exec(app)[2];
  // The ticket: its project in the view last used, then the ticket, then this page of it.
  assert.match(body('drawTicket'), /putTrail\(\[\s*\{ label: t\.projectName, href: `\/\$\{savedView\(\)\}\/\$\{encodeURIComponent\(t\.project\)\}` \},\s*\{ label: `Task \$\{t\.id\}`, href: `\/t\/\$\{encodeURIComponent\(t\.id\)\}` \},\s*\{ label: 'Details' \},\s*\]\)/);
  // A project's board or list climbs to Projects.
  assert.match(body('drawProject'), /putTrail\(\[\{ label: board\.projectName, href: '\/projects' \}, \{ label: view === 'board' \? 'Board' : 'List' \}\]\)/);
  assert.match(body('drawWaiting'), /putTrail\(\[\{ label: 'Waiting on You' \}\]\)/);
  assert.match(body('drawProjects'), /putTrail\(\[\{ label: 'Projects' \}\]\)/);
  // Each trail goes in after its page is drawn, so it sits first in main.
  assert.match(app, /main\.insertAdjacentHTML\('afterbegin', renderTrail\(steps\)\)/);
  assert.doesNotMatch(/function drawSignIn[\s\S]*?\n\}/.exec(app)[0], /putTrail/, 'no trail on the sign-in screen');
  const css = readFileSync(WEB('app.css'), 'utf8');
  assert.match(css, /nav\.trail \{ font-size: var\(--text-sm\);/, 'a small, quiet line, not a heading');
});

test('the set-password page is served without a token, drawn before any sign-in, and sends the link only in a body', async () => {
  const f = await fixture();
  try {
    const r = await f.call('GET', '/set-password?link=anything', { token: null });
    assert.equal(r.status, 200);
    assert.equal(r.text, readFileSync(WEB('index.html'), 'utf8'));
    assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  } finally { await f.cleanup(); }
  const app = pageScript();
  // The emailed link's page comes before GET /me, so nobody has to be signed in.
  assert.ok(app.indexOf("location.pathname === '/set-password'") < app.indexOf("me = await api('GET', '/me')"));
  assert.match(app, /linkCall\('\/account\/link', \{ link \}\)/);
  assert.match(app, /linkCall\('\/account\/set-password', \{ link, password: typed\.password/);
  assert.doesNotMatch(app, /fetch\(`[^`]*\$\{link\}/, 'the link never goes into an address the page fetches');
});

test('the set-password form shows the email read-only, two password boxes, a name box only for an invite, and escapes the email', () => {
  const setup = renderSetPassword({ purpose: 'setup', email: 'dane@example.com' });
  assert.match(setup, /<input id="email" type="email" value="dane@example\.com" readonly/);
  assert.equal((setup.match(/type="password"/g) ?? []).length, 2);
  assert.doesNotMatch(setup, /id="name"/);
  assert.match(renderSetPassword({ purpose: 'invite', email: 'new@example.com' }), /<input id="name" type="text"/);
  assert.match(renderSetPassword({ purpose: 'setup', email: '"><script>x</script>' }), /value="&quot;&gt;&lt;script&gt;x&lt;\/script&gt;"/);
  assert.match(renderPasswordSet('http://tracker.example:4180'), /Password set\. Sign in at <a href="\/">http:\/\/tracker\.example:4180<\/a>\./);
});

test('a used, expired or unknown link says which in plain words; a form with a short, unmatched or nameless password says why before sending', () => {
  assert.match(linkProblem('used-link'), /already been used/);
  assert.match(linkProblem('expired-link'), /expired/);
  assert.match(linkProblem('unknown-link'), /not one the tracker made/);
  for (const code of ['used-link', 'expired-link', 'unknown-link']) assert.match(linkProblem(code), /Nothing was changed\./);
  assert.equal(linkProblem('weak-password'), null);
  assert.equal(MIN_PASSWORD, 12);
  const good = 'twelve chars';
  assert.equal(passwordProblem({ purpose: 'setup', password: good, confirm: good }), null);
  assert.match(passwordProblem({ purpose: 'setup', password: 'eleven char', confirm: 'eleven char' }), /at least 12/);
  assert.match(passwordProblem({ purpose: 'setup', password: good, confirm: 'twelve charz' }), /not the same/);
  assert.match(passwordProblem({ purpose: 'invite', name: '  ', password: good, confirm: good }), /your name/);
  assert.equal(passwordProblem({ purpose: 'invite', name: 'New', password: good, confirm: good }), null);
});

test('the sign-in form is an email and a password with "Forgot password?"; the page keeps no token and signs in and out at the server', () => {
  const form = renderSignIn();
  assert.match(form, /<input id="email" type="email" autocomplete="username" required>/);
  assert.match(form, /<input id="password" type="password" autocomplete="current-password" required>/);
  assert.match(form, /<button type="button" class="link forgot">Forgot Password\?<\/button>/);
  assert.doesNotMatch(form, /token/i);
  assert.match(renderSignIn('<b>no</b>'), /<p class="note error">&lt;b&gt;no&lt;\/b&gt;<\/p>/);
  const forgot = renderForgot('a"b@example.com');
  assert.match(forgot, /value="a&quot;b@example\.com"/);
  assert.match(forgot, /works for 1 hour/);
  assert.match(forgot, /<a href="\/">Back to Sign In<\/a>/);

  const app = pageScript();
  assert.doesNotMatch(app, /authorization|Bearer/, 'the page never sends a token');
  assert.doesNotMatch(app, /localStorage\.(?:setItem|getItem)\(OLD_TOKEN_KEY/, 'the old token is never kept or read');
  assert.match(app, /localStorage\.removeItem\(OLD_TOKEN_KEY\)/, 'an old pasted token is cleared');
  assert.match(app, /linkCall\('\/signin', \{ email: [^,]+, password: /);
  assert.match(app, /linkCall\('\/signout', \{\}\)/);
  assert.match(app, /linkCall\('\/account\/forgot', \{ email: /);
  // Every write the page makes says it is JSON, which the server requires of a cookie's writes.
  assert.match(app, /headers: write \? \{ 'content-type': 'application\/json' \} : \{\}/);
});

test('the demo tracker prints an email and a password to sign in with, never a token', () => {
  const demo = readFileSync(fileURLToPath(new URL('./demo.mjs', import.meta.url)), 'utf8');
  assert.match(demo, /store\.setEmail\(operator\.id, DEMO_EMAIL\)/);
  assert.match(demo, /store\.setPassword\(operator\.id, password\)/);
  assert.match(demo, /email: {4}\$\{DEMO_EMAIL\}\\n {2}password: \$\{password\}/);
  assert.doesNotMatch(demo, /throwaway token/);
});

test('no page paints its buttons its own way: the ticket page\'s green (SP-76), Settings\' dark blue (SP-289), the header\'s and the black link are gone (SP-321)', () => {
  const css = readFileSync(WEB('app.css'), 'utf8');
  assert.doesNotMatch(css, /\.quick button|details\.edit button:not|div\.settings-tab button|^header button|^a\.button/m);
  assert.doesNotMatch(css, /--ticket-btn-/, 'the ticket page\'s green tokens are gone with its rule');
  // Delete is red again, as a removal (UI_DOCTRINE 3), and Reject with it.
  const render = renderScript();
  assert.match(render, /<form class="delete-action">\s*<button type="submit" class="btn btn-danger">Delete<\/button>/);
  // The plain button rule only sets the font and a padding for the listed exceptions; .btn overrides it.
  assert.match(css, /^button \{ font: inherit; padding: 0\.4rem 1rem; \}$/m);
});

test('a ticket or project on a project the person is not on draws a plain You Are Not on This Project page, never the ticket; a 404 to someone who sees everything still says there is none', () => {
  const app = pageScript();
  // The flag comes only from the server's own answer.
  assert.match(app, /json\?\.yourProjectsOnly === true\);/);
  assert.match(app, /const notOnProject = \(err\) => err instanceof Refused && err\.status === 404 && err\.yourProjectsOnly === true;/);
  const draw = app.slice(app.indexOf('function drawNotOnProject'), app.indexOf('/** Call the tracker as the signed-in person.'));
  assert.match(draw, /<h1>You Are Not on This Project<\/h1>/);
  assert.match(draw, /escapeHtml\(line\)/);
  assert.match(draw, /`Ticket \$\{ticket\} is on a project you are not a member of, or there is no such ticket\.`/);
  assert.match(draw, /`You are not a member of the project \$\{project\}, or there is no such project\.`/);
  assert.match(draw, /<a href="\/projects">Back to Projects<\/a>/);
  // The ticket page and a board or list fall to it from the page's one error path; the details and edit pages check first.
  assert.match(app, /else if \(notOnProject\(err\) && ticketAt\(\)\) drawNotOnProject\(\{ ticket: ticketAt\(\) \}\);/);
  assert.match(app, /else if \(notOnProject\(err\) && boardAt\(\)\) drawNotOnProject\(\{ project: boardAt\(\) \}\);/);
  const details = app.slice(app.indexOf('async function drawProjectDetails'), app.indexOf('/** One labelled text box'));
  assert.ok(details.indexOf('if (notOnProject(err))') < details.indexOf("setTitle('No Such Project"), 'details: not-on-project before no-such-project');
  const edit = app.slice(app.indexOf('async function drawEditProject'), app.indexOf('const { people } = await api(\'GET\', \'/people\');', app.indexOf('async function drawEditProject')));
  assert.match(edit, /if \(notOnProject\(err\)\) return drawNotOnProject/);
  // The members note no longer says everyone sees every project.
  assert.doesNotMatch(app, /everyone still sees every project/);
  assert.match(app, /Only its members \(and admins\) see this project and its tickets\./);
});

test('busLink: the header count of unseen bus posts, opening the Team chat with the most; nothing unseen, no link (SP-163)', () => {
  assert.equal(busLink(null), null);
  assert.equal(busLink({ total: 0, unseen: [] }), null);
  const link = busLink({ total: 4, unseen: [
    { id: 'SB-1', name: 'Team chat', projectName: 'StarCaster Bus', count: 3 },
    { id: 'WB-2', name: 'Team chat', projectName: 'WaveCenter Bus', count: 1 },
  ] });
  assert.equal(link.text, '4 New on the Bus');
  assert.equal(link.href, '/t/SB-1#comments', 'the posts are in the Details fold: #comments opens it');
  assert.equal(link.title, 'StarCaster Bus: 3 new posts on Team chat; WaveCenter Bus: 1 new post on Team chat');
});

test('each END exit code the runners write reads as its plain-words outcome (SP-173)', () => {
  assert.equal(passOutcome(0), 'Finished');
  assert.equal(passOutcome(1), 'A step failed and said so');
  assert.equal(passOutcome(124), 'Hit its time limit and was stopped');
  assert.equal(passOutcome(127), 'Could not run (exit 127)');
  assert.equal(passOutcome(2), 'Could not run (exit 2)');
  assert.equal(passOutcome(null), 'Ended');
  assert.equal(wakesEvery(1800), 'Every 30 minutes');
  assert.equal(wakesEvery(600), 'Every 10 minutes');
  assert.equal(wakesEvery(3600), 'Every hour');
  assert.equal(wakesEvery(7200), 'Every 2 hours');
  assert.equal(wakesEvery(90), 'Every 90 seconds');
  assert.equal(wakesEvery(null), '–');
});

// ── SP-218: the header's health line when a lane keeps failing ───────────────
test('the header says each failing stage in one plain line with when it began, and nothing when every stage passes (SP-218)', () => {
  const timeOf = (iso) => `[${iso.slice(11, 16)}]`;
  const stage = (name, extra = {}) => ({ name, logged: true, running: false, failing: false, failedPasses: 0, failingSince: null, failingReason: null, ...extra });
  const answer = { stages: [
    stage('Relay', { failing: true, failedPasses: 3, failingSince: '2026-11-11T04:00:00.000Z', failingReason: "can't reach the internet" }),
    stage('Build', { failedPasses: 2 }),
    stage('Review', { failing: true, failedPasses: 5, failingSince: '2026-11-10T21:30:00.000Z', failingReason: 'keeps failing' }),
    stage('Intake'),
  ] };
  assert.deepEqual(healthLines(answer, timeOf), [
    "Relay can't reach the internet since [04:00]",
    'Review keeps failing since [21:30]',
  ]);
  assert.equal(renderHealth(answer, timeOf), "<span>Relay can&#39;t reach the internet since [04:00]</span><span>Review keeps failing since [21:30]</span>");
  // Two failures in a row, or the first passing pass after them: no line.
  assert.deepEqual(healthLines({ stages: [stage('Relay', { failedPasses: 2 }), stage('Build')] }, timeOf), []);
  assert.equal(renderHealth({ stages: [stage('Relay')] }, timeOf), '');
  for (const failed of [null, undefined, {}, { stages: [] }, { error: 'no-pipeline' }]) assert.deepEqual(healthLines(failed, timeOf), []);
  // A reason missing from the answer says "keeps failing"; names are escaped like every other text.
  assert.deepEqual(healthLines({ stages: [stage('Relay', { failing: true, failingSince: null })] }, timeOf), ['Relay keeps failing']);
  assert.doesNotMatch(renderHealth({ stages: [stage('<b>x', { failing: true })] }, timeOf), /<b>x/);
});

test('every page carries the health line in its header, in the bell\'s warning yellow on the black header, hidden until a stage is failing (SP-218)', () => {
  const html = readFileSync(WEB('index.html'), 'utf8');
  const header = html.slice(html.indexOf('<header>'), html.indexOf('</header>'));
  assert.match(header, /<span id="health" class="health" role="status" hidden><\/span>\s*<span class="me">/);
  const css = drawnCss();
  const rule = (selector) => {
    const at = css.indexOf(`${selector} {`);
    assert.notEqual(at, -1, `app.css has a ${selector} rule`);
    return css.slice(at, css.indexOf('}', at));
  };
  const yellow = rule('header .health').match(/color: (#[0-9a-fA-F]{6});/)[1];
  assert.equal(yellow, css.match(/header #bell\[data-colour="yellow"\] \{ color: (#[0-9a-fA-F]{6}); \}/)[1], 'the same warning colour as the bell');
  assert.ok(contrast(yellow, '#000000') >= 4.5, 'it reads on the black header');
  assert.match(rule('header .health[hidden]'), /display: none;/);
  const app = pageScript();
  // Read on every page while signed in, not only where the pod is, on the pod's own timer.
  const refresh = app.slice(app.indexOf('async function refreshPipeline'), app.indexOf('/** The header\'s health lines from the last answer'));
  assert.match(refresh, /if \(!me\) return;/);
  assert.doesNotMatch(refresh, /querySelector\('\.pipeline-pod'\)/);
  assert.match(app, /setInterval\(refreshPipeline, PIPELINE_REFRESH_EVERY_MS\);/);
  const show = app.slice(app.indexOf('function showPipeline'), app.indexOf('function showPipeline') + 300);
  assert.match(show, /^function showPipeline\(read = false\) \{\n\s+showHealth\(\);/);
  assert.match(app, /function showHealth\(\) \{\n\s+const lines = me \? healthLines\(pipelineState, sinceTime\) : \[\];\n\s+health\.hidden = !lines\.length;/);
  const route = app.slice(app.indexOf('async function route('), app.indexOf('async function route(') + 1500);
  assert.match(route, /if \(pipelineState\) showHealth\(\);\n\s+else refreshPipeline\(\);/);
  // Signed out, it goes with the bell.
  assert.equal((app.match(/bell\.hidden = true;\n\s+busCount\.hidden = true;\n\s+health\.hidden = true;/g) || []).length, 2);
});

test('every page has one body width: main is capped at 1440px, padding included, and no page widens it (SP-184)', () => {
  const css = readFileSync(WEB('app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = css.split('}').map((r) => r.split('{')).filter((r) => r.length === 2)
    .map(([sel, body]) => ({ sel: sel.split(',').map((x) => x.trim()), body }));
  const plain = rules.filter((r) => r.sel.includes('main'));
  assert.equal(plain.length, 1, 'one rule for the page body');
  assert.match(plain[0].body, /max-width: 1440px/);
  assert.match(plain[0].body, /box-sizing: border-box/, 'the 1440px includes the side padding');
  assert.match(plain[0].body, /margin: 0 auto/, 'centred');
  const perPage = rules.filter((r) => r.sel.some((s) => /^main[.#:\[]/.test(s) && !/\s/.test(s) && /(?:max-|min-)?width/.test(r.body)));
  assert.deepEqual(perPage.map((r) => r.sel.join(', ')), [], 'no page gives the body a width of its own');
  const app = pageScript();
  assert.doesNotMatch(app, /main\.classList\.(?:add|remove|toggle)\(\s*['"]wide['"]/, 'no wide class on the page body');
});
