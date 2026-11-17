/**
 * Ticket text to HTML, for Dane's page. Runs in the browser and, unchanged,
 * in the Node tests (tracker/web-*.test.mjs), so what is tested is what draws.
 *
 * EVERY CHARACTER OF TICKET TEXT IS ESCAPED BEFORE IT IS DRAWN. Descriptions
 * and comments are written by loops, by Dane and, once imported, by whatever
 * was in ClickUp; a `<script>` in any of them must show as the text
 * "<script>", never run. So nothing here passes ticket text through as
 * markup: the Markdown (render-common.mjs) is recognised on the raw text, each piece is
 * escaped, and only the tags these files write themselves reach the page. A link
 * is drawn only for an http(s) address.
 *
 * The Markdown is the small part loops and cards actually write: headings,
 * paragraphs, bullet and numbered lists, `- [ ]` checkboxes, fenced code,
 * rules, **bold**, *italic*, `code`, [links](https://…) and bare addresses
 * (so `PR opened: https://…` is clickable). Anything else shows as written.
 */

// The drawing is split into one file per page (SP-364), so two tickets for
// two pages never edit the same file. This file only gathers them: every
// importer still names render.mjs. A new function goes in its page's file
// and needs nothing here; a new file needs its line here and its name in
// tracker/pageScripts.mjs's RENDER_SCRIPTS.
export * from './render-common.mjs';
export * from './render-shell.mjs';
export * from './render-ticket.mjs';
export * from './render-tasks.mjs';
export * from './render-console.mjs';
export * from './render-add-task.mjs';
export * from './render-settings.mjs';
export * from './render-projects.mjs';
export * from './render-docs.mjs';
export * from './render-topics.mjs';
