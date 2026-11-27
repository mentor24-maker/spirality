/**
 * The files that make up Dane's page script (tracker/web/), in reading
 * order: app.mjs, the entry index.html loads, which holds what every page
 * shares, then one file per page (SP-352). The server serves exactly these
 * (with RENDER_SCRIPTS, which draw for them all), and the tests that read the
 * page's source read all of them through pageScript(), so a page moved
 * into a file of its own is still checked.
 */
import { readFileSync } from 'node:fs';

export const PAGE_SCRIPTS = Object.freeze([
  'app.mjs',
  'page-projects.mjs',
  'page-tasks.mjs',
  'page-console.mjs',
  'page-ticket.mjs',
  'page-add-task.mjs',
  'page-reporting.mjs',
  'page-settings.mjs',
  'page-users.mjs',
  'page-docs.mjs',
  'page-topics.mjs',
  'page-usage.mjs',
  'page-mlist.mjs',
]);

/**
 * The page script's whole source, every file in PAGE_SCRIPTS joined in
 * order, read as it was when it was one file: without the `export` word the
 * split put in front of what one file shares with another, so a test
 * finding `\nasync function drawTicket(` still finds it.
 */
export function pageScript() {
  return PAGE_SCRIPTS.map((name) => readFileSync(new URL(`./web/${name}`, import.meta.url), 'utf8'))
    .join('\n').replace(/^export (?=(?:async function|function|const|let|class) )/gm, '');
}

/**
 * The files that make up the page's drawing (tracker/web/), split one per
 * page like the page script (SP-364): render.mjs, the one name every
 * importer uses, which only re-exports the others, then what every page
 * shares (render-common.mjs, render-shell.mjs), then one file per page. The
 * server serves exactly these, and the tests that read the drawing's source
 * read all of them through renderScript().
 */
export const RENDER_SCRIPTS = Object.freeze([
  'render.mjs',
  'render-common.mjs',
  'render-shell.mjs',
  'render-ticket.mjs',
  'render-tasks.mjs',
  'render-console.mjs',
  'render-add-task.mjs',
  'render-settings.mjs',
  'render-projects.mjs',
  'render-docs.mjs',
  'render-topics.mjs',
  'render-usage.mjs',
  'render-mlist.mjs',
]);

/**
 * The drawing's whole source, every file in RENDER_SCRIPTS joined in order.
 * Unlike pageScript() it keeps the word `export`: what render.mjs exported
 * before the split still starts with it, so a test finding
 * `export function renderConsole(` still finds it.
 */
export function renderScript() {
  return RENDER_SCRIPTS.map((name) => readFileSync(new URL(`./web/${name}`, import.meta.url), 'utf8')).join('\n');
}
