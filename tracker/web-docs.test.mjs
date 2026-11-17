/**
 * Tests for the Docs page and its documentation and command pages. One file per page (SP-352),
 * so two tickets changing two pages no longer edit one test file; what they
 * share is tracker/webTestKit.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderMarkdown, unwrapDoc, headingId, renderLoopQueueAnatomy, renderDiagramCut, LOOP_QUEUE_FIGURE_ID, matchCommands, renderCommandList, renderCommandView, renderCommandDetails, commandSummary, commandAbout, commandHref, renderContextDocs, renderLoopQueueDiagram, LOOP_QUEUE_DIAGRAM, docInfo, docDay, docRows, sortDocs, filterDocs, renderDocHeadings, renderDocBody, docCountLine, renderDocumentation, DOC_KINDS } from './web/render.mjs';
import { pageScript } from './pageScripts.mjs';
import { WEB, fixture } from './webTestKit.mjs';

// ── Docs (SP-171) ───────────────────────────────────────────────────────────

test('Docs is in the header between Users and Settings, served at /docs to a browser, and lists the picked project\'s task files', async () => {
  const html = readFileSync(WEB('index.html'), 'utf8');
  assert.match(html, /<a href="\/users" data-nav="users">Users<\/a>\s*<a href="\/docs" data-nav="docs">Docs<\/a>\s*<a href="\/settings" data-nav="settings">Settings<\/a>/);
  const f = await fixture();
  try {
    const page = await fetch(`${f.url}/docs`, { headers: { accept: 'text/html' } });
    assert.equal(page.status, 200);
    assert.equal(await page.text(), html, 'opening /docs directly shows the page, never data or a 404');
    assert.equal((await f.call('GET', '/projects/alpha/attachments', { token: null })).status, 401);
  } finally { await f.cleanup(); }
  const app = pageScript();
  assert.match(app, /docsPage(?: \|\| docAny)? \? 'docs' :/);
  assert.match(app, /\} else if \(docsPage\) \{\s*await drawDocs\(\);/);
  const draw = app.slice(app.indexOf('async function drawDocs'), app.length);
  assert.match(draw, /projects\.find\(\(p\) => p\.slug === savedProject\(\)\) \?\? projects\[0\]/, 'the project picked in the header, else the first');
  assert.match(draw, /const listPath = `\/projects\/\$\{encodeURIComponent\(project\.slug\)\}\/attachments`;/);
  assert.match(draw, /api\('GET', listPath\)/);
  assert.match(draw, /`\/tickets\/\$\{encodeURIComponent\(a\.ticket\)\}\/attachments\/\$\{encodeURIComponent\(a\.id\)\}`/, 'downloads use the task\'s own download address');
  assert.match(draw, /download="\$\{escapeHtml\(a\.name\)\}"/);
  assert.match(draw, /<a href="\/t\/\$\{encodeURIComponent\(a\.ticket\)\}">/);
  assert.match(draw, /<h2>Task Files<\/h2>/);
  for (const heading of ['File', 'Task', 'Type', 'Size', 'Added By', 'Added On']) assert.match(draw, new RegExp(`<th>${heading}</th>`), heading);
  assert.match(draw, /No task in .* has a file yet\./, 'an empty project says so in a line');
  assert.doesNotMatch(draw, /\$\{a\.(name|ticketName|addedByName|type)\}/, 'every name is escaped');
});

test('the Docs table adds, renames and removes task files, each read back, a removal confirmed by file and task (SP-177)', () => {
  const app = pageScript();
  const draw = app.slice(app.indexOf('async function drawDocs'), app.length);
  // Add File: pick one of the project's tasks and a file; the same upload the New Task form uses.
  assert.match(draw, /\{ tickets \}\] = await Promise\.all\(\[[\s\S]*?api\('GET', `\/projects\/\$\{encodeURIComponent\(project\.slug\)\}\/tickets`\),\s*\]\);/);
  assert.match(draw, /<button type="submit" class="btn btn-primary">Add File<\/button>/);
  assert.match(draw, /made = await uploadFile\(ticket, file\)/);
  assert.match(draw, /file\.size > MAX_FILE/, 'too large is said before sending');
  // Rename: the file's name only, an empty one refused on the page before any call.
  assert.match(draw, />Rename<\/button>/);
  assert.match(draw, /if \(!typed\.trim\(\)\) return refused\(null, `Not renamed: a file needs a name/);
  assert.match(draw, /api\('PATCH', `\/tickets\/\$\{encodeURIComponent\(ticket\)\}\/attachments\/\$\{encodeURIComponent\(file\)\}`, \{ name: typed \}\)/);
  // Remove: a confirmation naming the file and its task; cancelled, no call.
  assert.match(draw, />Remove<\/button>/);
  assert.match(draw, /if \(!confirm\(`Remove \$\{name\} from \$\{ticket\} \$\{taskName\}\?[^`]*`\)\) return;\s*button\.disabled = true;/);
  assert.match(draw, /api\('DELETE', `\/tickets\/\$\{encodeURIComponent\(ticket\)\}\/attachments\/\$\{encodeURIComponent\(file\)\}`\)/);
  // Every change is read back from the table's own list before the page says it worked, and a failure is said.
  assert.equal((draw.match(/await listedNow\(\)/g) ?? []).length, 3);
  for (const word of ['Not added', 'Not renamed', 'Not removed']) assert.match(draw, new RegExp(`${word}: \\$\\{err\\.message\\}`), word);
  assert.match(draw, /but it is not in the table when read back/);
  assert.match(draw, /but it reads back as/);
  assert.match(draw, /but it is still listed when read back/);
  assert.doesNotMatch(draw, /\$\{(a|t)\.(name|ticketName|id)\}/, 'every name is escaped');
  // Task Files and Context Documents each have their own line; a change's outcome shows only in the section it came from.
  assert.match(draw, /async function drawDocs\(done = '', problem = '', section = 'files'\)/);
  assert.match(draw, /const fileLine = section === 'files' \? \{ done, problem \} : \{ done: '', problem: '' \};/);
  assert.match(draw, /<p class="note file-note\$\{fileLine\.problem \? ' error' : ' quiet'\}" role="status">\$\{escapeHtml\(fileLine\.problem \|\| fileLine\.done\)\}<\/p>/);
  assert.match(draw, /const note = main\.querySelector\('\.file-note'\);/, 'never the Context Documents line above it');
  assert.match(draw, /drawAgain\(\(\) => drawDocs\(failed \? '' : text, failed \? text : '', 'files'\)\)/);
  assert.match(draw, /wireContextDocs\(project, docsPath, section === 'docs' \? done : '', section === 'docs' \? problem : ''\);/);
  assert.match(draw, /const again = \(text, failed\) => drawDocs\(failed \? '' : text, failed \? text : '', 'docs'\)/);
});

test('the Docs page\'s Context Documents list the project\'s own files, each a download and a Remove button, every name escaped; an empty one says so (SP-176)', () => {
  const words = { size: (n) => `${n} B`, timeOf: (iso) => `at ${iso}` };
  const project = { slug: 'al pha', name: 'Alpha <One>' };
  const html = renderContextDocs({ project, docs: [
    { id: 7, project: 'al pha', name: 'brief "<b>".pdf', type: 'application/pdf', size: 1234, addedByName: 'Dane <D>', createdAt: '2026-11-10T12:00:00Z' },
    { id: 8, project: 'al pha', name: 'notes.txt', type: 'text/plain', size: 2, addedByName: null, createdAt: '2026-11-09T12:00:00Z' },
  ] }, words);
  assert.match(html, /<h2>Context Documents<\/h2>/);
  assert.match(html, /<button type="button" class="btn btn-primary upload-doc">Upload Document<\/button><input type="file" class="doc-file" aria-label="Document to Upload" hidden>/, 'one file at a time');
  for (const heading of ['File', 'Type', 'Size', 'Added By', 'Added On']) assert.match(html, new RegExp(`<th>${heading}</th>`), heading);
  assert.match(html, /<a href="\/projects\/al%20pha\/docs\/7" download="brief &quot;&lt;b&gt;&quot;\.pdf">Download<\/a>/, 'always saved, through the project\'s own address');
  assert.match(html, /data-remove-doc="7" data-name="brief &quot;&lt;b&gt;&quot;\.pdf" aria-label="Remove brief &quot;&lt;b&gt;&quot;\.pdf">Remove<\/button>/);
  assert.match(html, /<td class="size">1234 B<\/td>/);
  assert.match(html, /<td class="by">Dane &lt;D&gt;<\/td>/);
  assert.match(html, /<td class="by"><span class="quiet">unknown<\/span><\/td>/);
  assert.match(html, /<td class="when">at 2026-11-10T12:00:00Z<\/td>/);
  assert.ok(html.indexOf('data-doc="7"') < html.indexOf('data-doc="8"'), 'in the order the server lists them (newest first)');
  assert.doesNotMatch(html, /<b>|<One>|<D>/, 'nothing unescaped');
  const empty = renderContextDocs({ project, docs: [] }, words);
  assert.match(empty, /Alpha &lt;One&gt; has no context documents yet\./);
  assert.doesNotMatch(empty, /<table/);
  assert.match(empty, /Upload Document/, 'an empty project can still upload');
});

test('the Docs page uploads one context document as the file itself, asks before removing one, reads the list back, and says when either did not happen (SP-176)', () => {
  const app = pageScript();
  const draw = app.slice(app.indexOf('async function drawDocs'), app.length);
  assert.match(draw, /const docsPath = `\/projects\/\$\{encodeURIComponent\(project\.slug\)\}\/docs`;/);
  assert.match(draw, /api\('GET', docsPath\)/);
  assert.ok(draw.indexOf('<h1>Docs</h1>\n    ${docsColumns(`\n    ${renderContextDocs({ project, docs }') > 0 && draw.indexOf('renderContextDocs({ project, docs }') < draw.lastIndexOf('<h2>Task Files</h2>'), 'Context Documents come first, before Task Files (SP-195 moved the docs folder\'s list to the bottom)');
  const wire = draw.slice(draw.indexOf('function wireContextDocs'));
  assert.match(wire, /picker\.files\?\.\[0\]/, 'one file at a time');
  assert.match(wire, /file\.size > MAX_FILE/, 'an 11 MB file is refused before it is sent');
  assert.match(wire, /is over 10 MB\. Upload a smaller file; nothing was saved\./);
  assert.match(wire, /await uploadFile\(null, file, docsPath\);/, 'the same raw-file upload a ticket\'s attachment uses');
  assert.match(wire, /Not uploaded: \$\{err\.message\}/);
  assert.match(wire, /if \(!confirm\(`Remove \$\{name\} from \$\{project\.name\}\? It cannot be brought back\.`\)\) return;/, 'asks first, naming the file; cancelled, nothing is sent');
  assert.ok(wire.indexOf('confirm(') < wire.indexOf("api('DELETE'"), 'asks before it removes');
  assert.match(wire, /await api\('DELETE', `\$\{docsPath\}\/\$\{encodeURIComponent\(id\)\}`\);/);
  assert.match(wire, /Not removed: \$\{err\.message\}/);
  assert.match(wire, /const back = await api\('GET', docsPath\)\.catch\(\(\) => null\);/, 'the removal is read back');
  assert.match(wire, /but \$\{back \? 'it is still listed when read back' : 'the list could not be read back'\}/);
  assert.match(wire, /note\.textContent = text;/, 'the note is text, never HTML');
  const up = /async function uploadFile[\s\S]*?\n\}/.exec(app)[0];
  assert.match(up, /to = `\/tickets\/\$\{encodeURIComponent\(ticketId\)\}\/attachments`/, 'a ticket\'s upload still goes to its own address');
  assert.match(up, /res = await fetch\(to, \{/);
});

test('the Docs page lists Spirality\'s documentation by title above Task Files, and a file opens at /docs/spirality/<path> drawn as Markdown (SP-175)', async () => {
  const f = await fixture();
  try {
    const html = readFileSync(WEB('index.html'), 'utf8');
    const page = await fetch(`${f.url}/docs/spirality/LOOP_CONTRACT.md`, { headers: { accept: 'text/html' } });
    assert.equal(page.status, 200);
    assert.equal(await page.text(), html, 'opening a documentation file directly shows the page');
    const list = await f.call('GET', '/documentation');
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.files.find((d) => d.path === 'LOOP_CONTRACT.md'), { path: 'LOOP_CONTRACT.md', title: 'The loop contract' }, 'its first heading, as written');
    assert.equal((await f.call('GET', '/documentation', { token: null })).status, 401);
  } finally { await f.cleanup(); }
  const app = pageScript();
  const draw = app.slice(app.indexOf('async function drawDocs'), app.indexOf('/** The page address of a documentation file'));
  assert.match(draw, /api\('GET', '\/documentation'\)/);
  assert.match(draw, /const documentation = renderDocumentation\(files, docAddress\);/, 'each file by its title, linking to its page (SP-195 draws the list in render.mjs)');
  assert.match(app, /const docAddress = \(path\) => `\/docs\/spirality\/\$\{String\(path\)\.split\('\/'\)\.map\(encodeURIComponent\)\.join\('\/'\)\}`/);
  assert.match(app, /\} else if \(docAny\) \{\s*await drawDoc\(docPath\);/, 'any /docs/<name>/<path> draws through drawDoc');
  assert.match(app, /const underDocs = \(\) => \/\^\\\/docs\\\/\[\^\/\]\+\\\/\.\+\$\/\.test\(location\.pathname\);/, 'the same addresses the server serves as the page');
  assert.match(app, /docsPage \|\| docAny \? 'docs' :/, 'a documentation file keeps Docs underlined in the header');
  assert.match(draw, /api\('GET', '\/documentation'\)\.then\(\(r\) => r\.files, \(\) => null\)/, 'a failed documentation call is caught on its own, so Task Files still draws');
  assert.match(renderDocumentation(null, (p) => p), /The reference docs and work log could not be read\./);
  const one = app.slice(app.indexOf('async function drawDoc('), app.length);
  assert.match(one, /renderMarkdown\(unwrapDoc\(body\)[,)]/, 'drawn with the ticket page\'s Markdown drawing, never as raw text');
  assert.match(one, /<a href="\/docs">Back to Docs<\/a>/);
  assert.match(one, /<h1>\$\{escapeHtml\(doc\.title\)\}<\/h1>/);
  assert.match(one, /There is no documentation file at/, 'a missing file says so');
  assert.match(one, /if \(!path\) return missing\(location\.pathname\);/, 'an address under /docs the page does not know says the same, never another page');
  // What a contract-like file looks like once drawn: headings, lists and code, not raw text.
  const drawn = renderMarkdown('## Statuses\n\n- Queued\n- Building\n\n```\nnpm run verify\n```\n');
  assert.match(drawn, /<h4>Statuses<\/h4>/);
  assert.match(drawn, /<ul><li>Queued<\/li><li>Building<\/li><\/ul>/);
  assert.match(drawn, /<pre><code>npm run verify<\/code><\/pre>/);
});

test('a documentation page gives each heading an id from its words, a repeat a distinct one; a ticket description gives none (SP-331)', () => {
  assert.equal(headingId('Needs your input'), 'needs-your-input');
  assert.equal(headingId('**Ready to launch**'), 'ready-to-launch');
  assert.equal(headingId('`npm run verify` — the gates!'), 'npm-run-verify-the-gates');
  assert.equal(headingId('???'), 'section');
  const doc = renderMarkdown('## Rework\n\ntext\n\n## Rework\n\n### In review', { headingIds: true });
  assert.match(doc, /<h4 id="rework">Rework<\/h4>/);
  assert.match(doc, /<h4 id="rework-2">Rework<\/h4>/);
  assert.match(doc, /<h5 id="in-review">In review<\/h5>/);
  // A ticket description is drawn exactly as before: no id anywhere, so none can clash with #comments or #reply.
  assert.equal(renderMarkdown('## Comments\n\n## Reply'), '<h4>Comments</h4>\n<h4>Reply</h4>');
  const app = pageScript();
  const one = app.slice(app.indexOf('async function drawDoc('), app.length);
  assert.match(one, /renderMarkdown\(unwrapDoc\(body\), \{ headingIds: true \}\)/, 'a documentation page asks for the ids');
  assert.match(one, /const named = location\.hash\.slice\(1\);\s*if \(named\) document\.getElementById\(named\)\?\.scrollIntoView\(\{ block: 'start' \}\);/, 'drawn after load, so it scrolls to the heading the address names');
  assert.match(app, /<section class="description">\$\{renderMarkdown\(t\.description\) \|\|/, 'the ticket page still draws its description without ids');
});

test('the Loop Queue Anatomy page has the eight statuses in order, each about 200 words, each with its anchor (SP-331)', () => {
  const text = readFileSync(new URL('../docs/LOOP_QUEUE_ANATOMY.md', import.meta.url), 'utf8');
  assert.match(text, /^# Loop Queue Anatomy\n/);
  const sections = text.split(/^## /m).slice(1).map((s) => { const [h, ...rest] = s.split('\n'); return { h, words: rest.join(' ').split(/\s+/).filter(Boolean).length }; });
  assert.deepEqual(sections.map((s) => s.h), ['Requested', 'Needs your input', 'Queued', 'Rework', 'Building', 'In review', 'Ready to launch', 'Live']);
  for (const { h, words } of sections) assert.ok(words >= 180 && words <= 220, `${h}: ${words} words`);
  const drawn = renderMarkdown(unwrapDoc(text.replace(/^#[ \t]+.*\n/, '')), { headingIds: true });
  for (const id of ['requested', 'needs-your-input', 'queued', 'rework', 'building', 'in-review', 'ready-to-launch', 'live']) assert.match(drawn, new RegExp(`id="${id}"`), id);
});

test('unwrapDoc joins a documentation file\'s hard-wrapped lines, keeps list items, headings, tables and code as written (SP-175)', () => {
  const text = '# Title\nintro line one\nline two\n\n- **Code rules**: the script\n  does it.\n- Next item\n1. first\n   still first\n\n| a | b |\n| - | - |\n\n```\nkeep\nthese apart\n```\nafter\n---\nend';
  assert.equal(unwrapDoc(text), '# Title\nintro line one line two\n\n- **Code rules**: the script does it.\n- Next item\n1. first still first\n\n| a | b |\n| - | - |\n\n```\nkeep\nthese apart\n```\nafter\n---\nend');
  const drawn = renderMarkdown(unwrapDoc('- **Code rules**: the script\n  does it.\n'));
  assert.equal(drawn, '<ul><li><strong>Code rules</strong>: the script does it.</li></ul>');
  assert.equal(unwrapDoc(''), '');
});

test('unwrapDoc joins a quote\'s lines with their ">" taken off, and never joins a quote onto the text around it (SP-175)', () => {
  const text = 'still the rule:\n> StarCaster still describes a two-account\n> model, where the machine posts. The\n> code does not do that.\nSo every comment\nends here.\n>\n> - a quoted item\n> second para';
  assert.equal(unwrapDoc(text), 'still the rule:\n> StarCaster still describes a two-account model, where the machine posts. The code does not do that.\nSo every comment ends here.\n>\n> - a quoted item second para');
  // The real file: no ">" left in the middle of a sentence once drawn.
  const contract = readFileSync(new URL('../docs/LOOP_CONTRACT.md', import.meta.url), 'utf8');
  for (const line of unwrapDoc(contract).split('\n')) assert.doesNotMatch(line, /\S\s+>\s/, line);
});

// ── Docs: Commands (SP-179) ─────────────────────────────────────────────────

const COMMANDS = [
  { name: 'why-stuck', source: 'Your command', description: 'Find out why a ticket is stuck.', steps: '# Why Stuck\n\n1. Read the ticket.\n2. Say why.\n\n```\nnpm run clickup -- waiting\n```\n' },
  { name: 'loop-review', source: 'Loop skill', description: 'Review the next pull request.', steps: '# Loop: Review\n\n- one\n' },
  { name: 'loop-spec', source: 'Loop skill', description: 'Turn an idea into tickets.', steps: 'x' },
];

test('the Commands search keeps a command whose name or description holds the words typed, case set aside', () => {
  assert.deepEqual(matchCommands(COMMANDS, 'stuck').map((c) => c.name), ['why-stuck']);
  assert.deepEqual(matchCommands(COMMANDS, 'REVIEW').map((c) => c.name), ['loop-review']);
  assert.deepEqual(matchCommands(COMMANDS, 'tickets').map((c) => c.name), ['loop-spec'], 'by what it does, too');
  assert.deepEqual(matchCommands(COMMANDS, '  ').map((c) => c.name), ['why-stuck', 'loop-review', 'loop-spec']);
  const mentions = [{ name: 'loop-build', description: 'then move it to In review' }, { name: 'loop-review', description: 'Check a pull request.' }];
  assert.deepEqual(matchCommands(mentions, 'review').map((c) => c.name), ['loop-review', 'loop-build'], 'a name match comes before a description match');
});

test('the search also matches a command\'s summary and plain explanation (SP-212)', () => {
  const withWords = [
    { name: 'loop-build', source: 'Loop skill', description: 'For Claude Code.', summary: 'Builds the next ticket', about: 'Opens a pull request for approval.' },
    { name: 'loop-spec', source: 'Loop skill', description: 'For Claude Code.', summary: null, about: null },
  ];
  assert.deepEqual(matchCommands(withWords, 'NEXT TICKET').map((c) => c.name), ['loop-build'], 'by the summary');
  assert.deepEqual(matchCommands(withWords, 'approval').map((c) => c.name), ['loop-build'], 'by the explanation');
});

test('a command shows its summary, or the first seven words of its description and "…"; its pop-up its about, or its description (SP-212)', () => {
  assert.equal(commandSummary({ summary: 'Builds the next ticket', description: 'x' }), 'Builds the next ticket');
  assert.equal(commandSummary({ description: 'one two three four five six seven eight nine' }), 'one two three four five six seven…');
  assert.equal(commandSummary({ description: 'Find out why a ticket is stuck.' }), 'Find out why a ticket is stuck.', 'seven words or fewer: as written, no "…"');
  assert.equal(commandAbout({ about: 'Plain words.', description: 'x' }), 'Plain words.');
  assert.equal(commandAbout({ about: null, description: 'The description.' }), 'The description.');
});

test('the Quick Claude Commands list shows only /<name> and its short line, each opening its pop-up; no match and nothing copied yet each say so', () => {
  const html = renderCommandList(COMMANDS, 'review');
  assert.match(html, /<li><a class="command-open" href="\/docs\/commands\/loop-review" data-command="loop-review"><code>\/loop-review<\/code> <span class="command-summary">Review the next pull request\.<\/span><\/a><\/li>/);
  assert.doesNotMatch(html, /Loop skill|Your command/, 'where it comes from waits for the pop-up');
  assert.doesNotMatch(html, /why-stuck|loop-spec/);
  assert.doesNotMatch(html, /not been copied/, 'a copied command is listed, so no such line');
  const long = renderCommandList([{ name: 'x', source: 'Loop skill', description: 'Pick the next claimable task from the queue and build it.', steps: '' }]);
  assert.match(long, /<span class="command-summary">Pick the next claimable task from the…<\/span>/);
  assert.doesNotMatch(long, /and build it/, 'the long description leaves the row');
  assert.match(renderCommandList(COMMANDS, 'zebra'), /No command matches “zebra”\./);
  const skillsOnly = renderCommandList(COMMANDS.filter((c) => c.source === 'Loop skill'));
  assert.match(skillsOnly, /\/loop-review[\s\S]*\/loop-spec/);
  assert.match(skillsOnly, /Your own commands have not been copied here yet: run <code>npm run commands:copy<\/code>/);
  const evil = renderCommandList([{ name: 'x', source: 'Your command', description: '<img src=x onerror=alert(1)>', steps: '' }], '<b>');
  assert.doesNotMatch(evil, /<img|<b>/);
  assert.equal(commandHref('a b'), '/docs/commands/a%20b');
  assert.match(renderCommandList([{ name: 'x', source: 'Loop skill', description: 'Runs `npm run verify` first.', steps: '' }]), /Runs <code>npm run verify<\/code> first\./, 'code in a summary is drawn as code');
});

test('a command\'s pop-up shows its name, source, plain explanation and a link to its steps, escaped (SP-212)', () => {
  const html = renderCommandDetails({ name: 'loop-review', source: 'Loop skill', description: 'For Claude Code.', about: 'Checks the work again.' });
  assert.match(html, /<h2 id="command-details-title"><code>\/loop-review<\/code><\/h2>/);
  assert.match(html, /<p class="quiet">Loop skill<\/p>/);
  assert.match(html, /<p>Checks the work again\.<\/p>/);
  assert.doesNotMatch(html, /For Claude Code/, 'the about line, not the description');
  assert.match(html, /<a href="\/docs\/commands\/loop-review">See All the Steps<\/a>/);
  assert.match(renderCommandDetails({ name: 'mine', source: 'Your command', description: 'My own words.' }), /<p>My own words\.<\/p>/, 'no about line: the description');
  assert.doesNotMatch(renderCommandDetails({ name: '<x>', source: '<s>', description: '<y>' }), /<x>|<s>|<y>/);
});

test('a command\'s own page draws its steps formatted (headings, lists, code) with a Back to Docs link, and escapes its words', () => {
  const html = renderCommandView(COMMANDS[0]);
  assert.match(html, /<h1><code>\/why-stuck<\/code><\/h1>/);
  assert.match(html, /Your command/);
  assert.match(html, /<h\d[^>]*>Why Stuck<\/h\d>/, 'a heading, not "# Why Stuck"');
  assert.match(html, /<ol>[\s\S]*<li>Read the ticket\.<\/li>/);
  assert.match(html, /<pre[^>]*>[\s\S]*npm run clickup -- waiting/);
  assert.doesNotMatch(html, /# Why Stuck/);
  assert.match(html, /<a href="\/docs">Back to Docs<\/a>/);
  assert.doesNotMatch(renderCommandView({ ...COMMANDS[0], name: '<x>', description: '<y>' }), /<x>|<y>/);
});

test('the Docs page carries the Commands section; /docs/commands/<name> opens one command, served as the page to a browser', async () => {
  const html = readFileSync(WEB('index.html'), 'utf8');
  const f = await fixture();
  try {
    const page = await fetch(`${f.url}/docs/commands/loop-review`, { headers: { accept: 'text/html' } });
    assert.equal(page.status, 200);
    assert.equal(await page.text(), html);
    const list = await f.call('GET', '/commands');
    assert.equal(list.status, 200);
    for (const name of ['loop-build', 'loop-intake', 'loop-review', 'loop-spec']) {
      assert.ok(list.body.commands.some((c) => c.name === name && c.source === 'Loop skill'), name);
    }
    // Other loop skills mention review in their descriptions; the one named for it comes first.
    assert.equal(matchCommands(list.body.commands, 'review')[0].name, 'loop-review');
  } finally { await f.cleanup(); }
  const app = pageScript();
  const draw = app.slice(app.indexOf('async function drawDocs'), app.length);
  assert.match(draw, /await api\('GET', '\/commands'\)/);
  assert.match(draw, /<h2 id="commands-pod-title">Quick Claude Commands<\/h2>/);
  assert.match(draw, /<div class="docs-columns">\$\{commandsSection\(\)\}<div class="docs-main">\$\{renderLoopQueueDiagram\(docAddress\)\}\$\{rest\}<\/div><\/div>/, 'the pod on the left, the rest on the right, under the Loop Queue diagram (SP-337)');
  assert.equal((draw.match(/\$\{docsColumns\(`/g) ?? []).length, 2, 'with projects and without, the page is drawn in the two columns');
  assert.doesNotMatch(draw, /\$\{commandsSection\(\)\}\s*\$\{documentation\}/, 'the pod is no longer a section between the others');
  assert.match(draw, /<dialog class="command-details" aria-labelledby="command-details-title">[\s\S]*<button type="submit" class="btn">Close<\/button>[\s\S]*<\/dialog>/);
  assert.match(draw, /renderCommandDetails\(command\);\s*dialog\.showModal\(\);/);
  assert.match(draw, /e\.preventDefault\(\);\s*e\.stopPropagation\(\);/, 'a click opens the pop-up, not the steps page');
  const css = readFileSync(WEB('app.css'), 'utf8');
  assert.match(css, /section\.commands-pod \{ background: var\(--pod-bg\); border: 1px solid var\(--navy-soft\); border-radius: var\(--radius-container\);/);
  assert.match(css, /\.docs-columns \{ display: grid; grid-template-columns: minmax\(0, 1fr\) minmax\(0, 2fr\);/, 'the pod takes a third');
  assert.match(css, /@media \(max-width: 800px\) \{ \.docs-columns \{ grid-template-columns: minmax\(0, 1fr\); \} \}/, 'stacked on a narrow screen');
  assert.match(draw, /<input type="search" id="command-search"/);
  assert.match(draw, /box\.addEventListener\('input', show\)/);
  assert.match(draw, /renderCommandList\(commands, box\.value\)/);
  assert.match(draw, /api\('GET', '\/commands'\)\.then\(\(r\) => r\.commands, \(\) => null\)/, 'a failed commands call is caught on its own, so the rest still draws');
  assert.match(draw, /The commands could not be read\./);
  assert.match(draw, /renderCommandView\(\{ \.\.\.command, steps: unwrapDoc\(command\.steps\) \}\)/, 'wrapped lines joined, as a documentation file\'s are');
  assert.match(app, /const m = \/\^\\\/docs\\\/commands\\\/\(\[\^\/\]\+\)\$\/\.exec\(location\.pathname\);/);
  // Before the documentation pages' catch-all, which would otherwise say "no documentation file" for a command.
  assert.match(app, /\} else if \(docsCommand != null\) \{\s*await drawCommand\(docsCommand\);\s*\} else if \(docAny\) \{/);
  assert.match(app, /docsPage \|\| docAny \? 'docs' :/, 'Docs stays underlined in the header (docAny covers /docs/commands/<name>)');
});

test('Reference Docs and Work Log: each docs/ file\'s kind comes from its folder and its date from its name (SP-195)', () => {
  assert.deepEqual(docInfo('work-log/2026-11-10-docs-page-spirality-docs.md'), { kind: 'Work Log', date: '2026-11-10' });
  assert.deepEqual(docInfo('PLAN.md'), { kind: 'Reference', date: null });
  assert.deepEqual(docInfo('onboarding/WIZARD.md'), { kind: 'Onboarding', date: null });
  assert.deepEqual(docInfo('drafts/2026-01-02-idea.md'), { kind: 'drafts', date: '2026-01-02' }, 'any other folder is its own kind');
  assert.deepEqual(docInfo('work-log/2026-13-01-x.md'), { kind: 'Work Log', date: null }, 'not a real month, no date');
  assert.deepEqual(docInfo('work-log/20261110-x.md'), { kind: 'Work Log', date: null });
  assert.equal(docDay('2026-11-10'), 'Nov 10, 2026', 'a calendar day, never shifted by time zone');
  assert.equal(docDay(null), '');
  assert.deepEqual(DOC_KINDS, ['Reference', 'Onboarding', 'Work Log', 'Operator Prompts']);
});

test('Operator Prompts: each thread\'s own file is grouped under its own kind and dated, newest first after the Work Log (SP-293)', () => {
  assert.deepEqual(docInfo('operator-prompts/2026-11-08-moving-off-clickup.md'), { kind: 'Operator Prompts', date: '2026-11-08' });
  const rows = docRows([
    { path: 'operator-prompts/2026-11-08-older.md', title: 'Older thread' },
    { path: 'OPERATOR_PROMPTS.md', title: 'Operator prompts' },
    { path: 'work-log/2026-11-01-entry.md', title: 'Entry' },
    { path: 'operator-prompts/2026-11-11-newer.md', title: 'Newer thread' },
  ]);
  assert.deepEqual(rows.map((r) => r.path), ['OPERATOR_PROMPTS.md', 'work-log/2026-11-01-entry.md',
    'operator-prompts/2026-11-11-newer.md', 'operator-prompts/2026-11-08-older.md']);
  assert.deepEqual(filterDocs(rows, { kind: 'Operator Prompts' }).map((r) => r.title), ['Newer thread', 'Older thread']);
  const html = renderDocumentation(rows, (p) => `/docs/spirality/${p}`);
  assert.match(html, /<option value="Operator Prompts">Operator Prompts<\/option>/);
  assert.match(html, /2026-11-11-newer\.md">Newer thread<\/a><\/td>\s*<td class="kind">Operator Prompts<\/td>\s*<td class="date">Nov 11, 2026<\/td>/);
});

const DOCS = [
  { path: 'work-log/2026-10-12-first.md', title: 'First entry' },
  { path: 'PLAN.md', title: 'The plan' },
  { path: 'work-log/2026-11-10-docs-page-spirality-docs.md', title: 'Docs page' },
  { path: 'onboarding/WIZARD.md', title: 'WIZARD' },
  { path: 'LOOP_CONTRACT.md', title: 'The loop contract' },
  { path: 'work-log/2026-11-01-middle.md', title: 'Middle entry' },
];

test('Reference Docs and Work Log opens Reference, then Onboarding, then Work Log newest first; Title, Kind and Date sort both ways (SP-195)', () => {
  const rows = docRows(DOCS);
  assert.deepEqual(rows.map((r) => r.path), ['LOOP_CONTRACT.md', 'PLAN.md', 'onboarding/WIZARD.md',
    'work-log/2026-11-10-docs-page-spirality-docs.md', 'work-log/2026-11-01-middle.md', 'work-log/2026-10-12-first.md']);
  const up = sortDocs(rows, { column: 'date', direction: 'ascending' }).map((r) => r.path);
  assert.deepEqual(up.slice(0, 3), ['work-log/2026-10-12-first.md', 'work-log/2026-11-01-middle.md', 'work-log/2026-11-10-docs-page-spirality-docs.md'], 'oldest first');
  assert.deepEqual(up.slice(3), ['LOOP_CONTRACT.md', 'PLAN.md', 'onboarding/WIZARD.md'], 'no date goes last, in the opening order');
  const down = sortDocs(rows, { column: 'date', direction: 'descending' }).map((r) => r.path);
  assert.equal(down[3], 'work-log/2026-11-10-docs-page-spirality-docs.md', 'newest first after the undated ones');
  assert.deepEqual(sortDocs(rows, { column: 'title', direction: 'ascending' }).map((r) => r.title), ['Docs page', 'First entry', 'Middle entry', 'The loop contract', 'The plan', 'WIZARD']);
  assert.deepEqual(sortDocs(rows, { column: 'title', direction: 'descending' }).map((r) => r.title)[0], 'WIZARD');
  assert.deepEqual(sortDocs(rows, { column: 'kind', direction: 'descending' }).map((r) => r.kind), ['Work Log', 'Work Log', 'Work Log', 'Onboarding', 'Reference', 'Reference']);
  assert.deepEqual(sortDocs(rows, null), rows, 'no sort, the opening order');
  assert.equal(rows.length, DOCS.length);
  assert.equal(DOCS[0].path, 'work-log/2026-10-12-first.md', 'the list is never changed');
});

test('Reference Docs and Work Log: the Kind drop-down and the search box narrow the rows together, and the count line agrees (SP-195)', () => {
  const rows = docRows(DOCS);
  assert.equal(filterDocs(rows, {}).length, 6);
  assert.deepEqual(filterDocs(rows, { kind: 'Work Log' }).map((r) => r.title), ['Docs page', 'Middle entry', 'First entry']);
  assert.deepEqual(filterDocs(rows, { kind: 'Work Log', text: 'DOCS' }).map((r) => r.title), ['Docs page'], 'title or path, any case');
  assert.deepEqual(filterDocs(rows, { text: 'plan.md' }).map((r) => r.path), ['PLAN.md'], 'the path');
  assert.deepEqual(filterDocs(rows, { text: 'spirality-docs' }).map((r) => r.title), ['Docs page'], 'a path word not in the title');
  assert.deepEqual(filterDocs(rows, { text: '  ' }).length, 6, 'blank matches all');
  assert.deepEqual(filterDocs(rows, { kind: 'Onboarding', text: 'plan' }), []);
  assert.equal(docCountLine(1, 6), 'Showing 1 of 6');
  assert.equal(docCountLine(0, 6), 'No document matches.');
});

test('Reference Docs and Work Log is folded, counted, sortable by Title, Kind and Date, every word escaped (SP-195)', () => {
  const html = renderDocumentation([...DOCS, { path: 'x/<b>.md', title: 'Bad <i>' }], (p) => `/docs/spirality/${p}`);
  assert.match(html, /^<details class="spirality-docs"><summary><h2>Reference Docs and Work Log \(7\)<\/h2><\/summary>/, 'closed when the page opens: no open attribute');
  assert.doesNotMatch(html, /<details[^>]*\sopen/);
  for (const k of ['All', 'Reference', 'Onboarding', 'Work Log', 'x']) assert.match(html, new RegExp(`<option value="${k === 'All' ? '' : k}">${k}</option>`), k);
  assert.match(html, /<input type="search" id="doc-search"/);
  assert.match(html, /Showing 7 of 7/);
  assert.match(html, /<th class="title"><button type="button" class="sort" data-sort="title">Title<\/button><\/th><th class="kind">.*data-sort="kind">Kind<\/button><\/th><th class="date">.*data-sort="date">Date<\/button><\/th><th class="path">Path<\/th>/);
  assert.match(html, /<a href="\/docs\/spirality\/work-log\/2026-11-10-docs-page-spirality-docs\.md">Docs page<\/a><\/td>\s*<td class="kind">Work Log<\/td>\s*<td class="date">Nov 10, 2026<\/td>/);
  assert.match(html, /<a href="\/docs\/spirality\/PLAN\.md">The plan<\/a><\/td>\s*<td class="kind">Reference<\/td>\s*<td class="date"><\/td>/);
  assert.doesNotMatch(html, /<b>|<i>/, 'nothing unescaped');
  assert.match(renderDocHeadings({ column: 'date', direction: 'descending' }), /<th class="date" aria-sort="descending"><button type="button" class="sort" data-sort="date">Date <span class="arrow" aria-hidden="true">▼<\/span>/);
  assert.match(renderDocHeadings({ column: 'title', direction: 'ascending' }), /<th class="title" aria-sort="ascending">.*▲/);
  assert.doesNotMatch(renderDocHeadings(null), /aria-sort/);
  assert.match(renderDocBody([{ path: 'a b.md', title: 'T', kind: 'Reference', date: null }], (p) => `/x/${encodeURIComponent(p)}`), /href="\/x\/a%20b\.md"/);
  assert.match(renderDocumentation(null, String), /Reference Docs and Work Log<\/h2>.*could not be read/s);
  assert.match(renderDocumentation([], String), /Reference Docs and Work Log \(0\)<\/h2>.*no Markdown files/s);
});

test('the Docs page puts Reference Docs and Work Log last in the right column, with or without projects, and wires its controls (SP-195, SP-212)', () => {
  const app = pageScript();
  const draw = app.slice(app.indexOf('async function drawDocs'), app.indexOf('/** The command a `/docs/commands/<name>` address opens'));
  assert.match(draw, /\$\{docsColumns\(`<h2>Task Files<\/h2><p class="quiet">There are no projects yet\.<\/p>\$\{documentation\}`\)\}`;\s*showCommands\(commands\);\s*wireDocumentation\(files\);/, 'no projects: last too');
  assert.match(draw, /has a file yet\.<\/p>`\}\n    \$\{documentation\}`\)\}`;/, 'below Task Files, last on the right');
  assert.equal((draw.match(/\$\{documentation\}/g) ?? []).length, 2, 'drawn once in each case, never above');
  assert.equal((draw.match(/wireDocumentation\(files\);/g) ?? []).length, 2);
  const wire = draw.slice(draw.indexOf('function wireDocumentation'));
  assert.match(wire, /kind\.addEventListener\('change', show\);/);
  assert.match(wire, /search\.addEventListener\('input', show\);/);
  assert.match(wire, /sortDocs\(filterDocs\(rows, \{ kind: kind\.value, text: search\.value \}\), sort\)/, 'both filters together, then the sort');
  assert.match(wire, /sort = nextSort\(sort, button\.dataset\.sort\);/, 'a second click reverses it');
  assert.match(wire, /count\.textContent = docCountLine\(shown\.length, rows\.length\);/, 'the count line is text, matching the rows shown');
});

test('the Docs page opens with the Loop Queue diagram, each status box a link to its section of the anatomy page (SP-337)', () => {
  const address = (path) => `/docs/spirality/${path}`;
  const html = renderLoopQueueDiagram(address);
  assert.match(html, /<img src="\/web\/loop-queue-diagram\.png" alt="Spirality Loop Queue: how a ticket moves from Requested to Live" width="3200" height="1800">/);
  // The links are an SVG over the picture with the picture's own size as its viewBox, so they scale with it; never an inline style, which the page's lock refuses.
  assert.match(html, /<svg class="loop-diagram-links" viewBox="0 0 3200 1800"/);
  assert.doesNotMatch(html, /style=/);
  const links = [...html.matchAll(/<a class="diagram-box" href="([^"]+)" aria-label="([^"]+)">/g)].map((m) => [m[2], m[1]]);
  assert.deepEqual(links, [
    ['Requested', '/docs/spirality/LOOP_QUEUE_ANATOMY.md#requested'],
    ['Needs your input', '/docs/spirality/LOOP_QUEUE_ANATOMY.md#needs-your-input'],
    ['Queued', '/docs/spirality/LOOP_QUEUE_ANATOMY.md#queued'],
    ['Rework', '/docs/spirality/LOOP_QUEUE_ANATOMY.md#rework'],
    ['Building', '/docs/spirality/LOOP_QUEUE_ANATOMY.md#building'],
    ['In review', '/docs/spirality/LOOP_QUEUE_ANATOMY.md#in-review'],
    ['Ready to launch', '/docs/spirality/LOOP_QUEUE_ANATOMY.md#ready-to-launch'],
    ['Live', '/docs/spirality/LOOP_QUEUE_ANATOMY.md#live'],
  ]);
  // Every anchor is a heading the anatomy page really carries, drawn the way its page draws it.
  const page = renderMarkdown(unwrapDoc(readFileSync(new URL('../docs/LOOP_QUEUE_ANATOMY.md', import.meta.url), 'utf8')), { headingIds: true });
  for (const { anchor } of LOOP_QUEUE_DIAGRAM.boxes) assert.match(page, new RegExp(` id="${anchor}"`), anchor);
  // Each box lies inside the picture and on none of the others.
  const boxes = LOOP_QUEUE_DIAGRAM.boxes.map((b) => b.box);
  for (const [l, t, r, b] of boxes) assert.ok(l >= 0 && t >= 0 && r <= 3200 && b <= 1800 && l < r && t < b);
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const [a, c] = [boxes[i], boxes[j]];
      assert.ok(a[2] <= c[0] || c[2] <= a[0] || a[3] <= c[1] || c[3] <= a[1], `${LOOP_QUEUE_DIAGRAM.boxes[i].label} overlaps ${LOOP_QUEUE_DIAGRAM.boxes[j].label}`);
    }
  }
  // The Docs page draws it first in its right-hand column, on both of its screens (with and without projects).
  const app = pageScript();
  assert.match(app, /<div class="docs-main">\$\{renderLoopQueueDiagram\(docAddress\)\}\$\{rest\}<\/div>/);
  const css = readFileSync(WEB('app.css'), 'utf8');
  assert.match(css, /a\.diagram-box:focus-visible rect \{[^}]*stroke: var\(--focus-ring-color\)/);
  assert.match(css, /a\.diagram-box \{[^}]*cursor: pointer/);
});

test('the Loop Queue Anatomy page is a table: each status box cut from the diagram beside its copy, linking to the diagram (SP-361)', () => {
  const text = readFileSync(new URL('../docs/LOOP_QUEUE_ANATOMY.md', import.meta.url), 'utf8');
  const body = text.replace(/^(?:[ \t]*\n)*#[ \t]+.*\n?/, '');
  const html = renderLoopQueueAnatomy(body);
  // The opening paragraph first, drawn as before, then the table.
  assert.ok(html.startsWith('<p>The Spirality Loop Queue diagram shows the eight statuses'), html.slice(0, 80));
  assert.ok(html.indexOf('<table class="anatomy">') > html.indexOf('</p>'));
  assert.doesNotMatch(html, /<h\d/, 'no heading per section: the box carries the name');
  assert.doesNotMatch(html, /style=/, 'the page\'s lock refuses inline styles');
  const rows = [...html.matchAll(/<tr id="([^"]+)"><td class="anatomy-cut-cell">(.*?)<\/td><td class="anatomy-copy">(.*?)<\/td><\/tr>/gs)];
  assert.equal(rows.length, 8);
  assert.deepEqual(rows.map((r) => r[1]), LOOP_QUEUE_DIAGRAM.boxes.map((b) => b.anchor), 'each row carries the id the diagram links to, in order');
  assert.deepEqual(rows.map((r) => r[1]), ['requested', 'needs-your-input', 'queued', 'rework', 'building', 'in-review', 'ready-to-launch', 'live']);
  rows.forEach(([, , left, copy], i) => {
    const { label, box: [l, t, r, b] } = LOOP_QUEUE_DIAGRAM.boxes[i];
    const link = /^<a class="anatomy-box" href="([^"]+)" aria-label="([^"]+)"><svg class="anatomy-cut" viewBox="(\d+) (\d+) (\d+) (\d+)"[^>]*aria-hidden="true"[^>]*><image href="\/web\/loop-queue-diagram\.png" x="0" y="0" width="3200" height="1800"><\/image><\/svg><\/a>$/.exec(left);
    assert.ok(link, `${label}: ${left}`);
    assert.equal(link[1], `/docs#${LOOP_QUEUE_FIGURE_ID}`);
    assert.equal(link[1], '/docs#loop-queue-diagram');
    assert.equal(link[2], `${label}: show it on the Loop Queue diagram`);
    const [x, y, w, h] = link.slice(3, 7).map(Number);
    assert.ok(x <= l && y <= t && x + w >= r && y + h >= b, `${label}: the cut holds its whole box`);
    assert.ok(x >= 0 && y >= 0 && x + w <= 3200 && y + h <= 1800, `${label}: the cut stays inside the picture`);
    assert.ok(l - x <= 40 && r - (x + w) >= -40, `${label}: only a small margin`);
    // The copy is the section's own words, drawn by the same Markdown drawing.
    const section = text.split(/^## /m)[i + 1].split('\n').slice(1).join('\n');
    assert.equal(copy, renderMarkdown(unwrapDoc(section)));
  });
  // The links are drawn the same in Markdown: code and links survive.
  assert.match(html, /<a href="LOOP_CONTRACT\.md"|<code>/);
  // Every box is drawn at one scale: width over viewBox width is the same for all eight.
  const scales = [...html.matchAll(/viewBox="\d+ \d+ (\d+) \d+" width="(\d+)"/g)].map((m) => Number(m[1]) / Number(m[2]));
  for (const s of scales) assert.ok(Math.abs(s - scales[0]) < 0.05, `scale ${s} vs ${scales[0]}`);
  // A cut keeps inside the picture at its edges.
  assert.match(renderDiagramCut([0, 0, 3200, 1800]), /viewBox="0 0 3200 1800"/);
  // A section the diagram has no box for keeps its name as text; a file with no sections is drawn as plain Markdown.
  assert.match(renderLoopQueueAnatomy('Intro.\n\n## Odd one\n\nWords.'), /<tr id="odd-one"><td class="anatomy-cut-cell"><strong>Odd one<\/strong><\/td><td class="anatomy-copy"><p>Words\.<\/p><\/td><\/tr>/);
  assert.equal(renderLoopQueueAnatomy('Just words.'), '<p>Just words.</p>');
  assert.match(renderLoopQueueAnatomy('<b>x</b>\n\n## Live\n\n<i>y</i>'), /&lt;b&gt;x.*&lt;i&gt;y/s, 'every character escaped');
});

test('the Docs page draws the anatomy file as that table, gives the diagram its id and scrolls to the address\'s id after drawing (SP-361)', () => {
  assert.match(renderLoopQueueDiagram((p) => `/docs/spirality/${p}`), /^<figure class="loop-diagram" id="loop-queue-diagram">/);
  const app = pageScript();
  const one = app.slice(app.indexOf('async function drawDoc('), app.indexOf('function scrollToNamed('));
  assert.match(one, /doc\.path === LOOP_QUEUE_DIAGRAM\.page \? renderLoopQueueAnatomy\(body\) : renderMarkdown\(unwrapDoc\(body\), \{ headingIds: true \}\)/);
  assert.match(one, /scrollToNamed\(\);/);
  const docs = app.slice(app.indexOf('async function drawDocs('), app.indexOf('const docsColumns ='));
  assert.match(docs, /const firstDraw = !done && !problem;/, 'a redraw after a change does not jump back to the diagram');
  assert.equal(docs.match(/if \(firstDraw\) scrollToNamed\(\);/g)?.length, 2, 'both of the Docs page\'s screens scroll to the id');
  const css = readFileSync(WEB('app.css'), 'utf8');
  assert.match(css, /table\.anatomy td \{[^}]*vertical-align: top/);
  assert.match(css, /a\.anatomy-box:focus-visible \{[^}]*outline: 2px solid var\(--focus-ring-color\)/);
  assert.match(css, /svg\.anatomy-cut \{[^}]*max-width: 100%/);
});
