/**
 * The files that make up Dane's page script (tracker/web/), in reading
 * order: app.mjs, the entry index.html loads, which holds what every page
 * shares, then one file per page (SP-352). The server serves exactly these
 * (with render.mjs, which draws for them all), and the tests that read the
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
