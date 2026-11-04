#!/usr/bin/env node
/**
 * Send one real hand-over text, to prove Messages on this Mac can send it:
 *
 *   npm run tracker:test-text -- --project <slug>
 *
 * It reads the project's alert phone from the running tracker, signed in as
 * the operator (TRACKER_TOKEN_OPERATOR, from Doppler: a loop's sign-in is
 * never shown a phone), then sends a text shaped like a real hand-over's
 * through the same sender the tracker server uses. Exit 0 once Messages
 * accepted it; 1, with the reason, when it did not, the project has no
 * alert phone, or this machine cannot send texts.
 *
 * The number is never printed: the project is in a public repository's logs.
 *
 * Run from Terminal, the first send makes macOS ask whether Terminal may
 * control Messages. The tracker server is a different program (node, started
 * by launchd) and macOS asks for it separately, on its first real hand-over
 * (docs/TRACKER_MVP.md, "How he hears about a hand-over").
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadProjectConfig } from '../lib/projectConfig.mjs';
import { handOverText, textSettings } from './notify.mjs';

const TOKEN = 'TRACKER_TOKEN_OPERATOR';

function fail(why) {
  console.error(`test-text: NOT sent. ${why}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const at = args.indexOf('--project');
const slug = at >= 0 ? args[at + 1] : null;
if (!slug || slug.startsWith('--')) {
  console.error('usage: npm run tracker:test-text -- --project <slug>');
  process.exit(2);
}

const config = loadProjectConfig();
const text = textSettings({ run: promisify(execFile) });
if (!text.sendText) fail(text.why);
if (!process.env[TOKEN]) fail(`${TOKEN} is not in Doppler ${config.dopplerProject}/${config.dopplerConfig}, so the project's alert phone cannot be read.`);

const api = String(config.trackerApiUrl).replace(/\/+$/, '');
let project;
try {
  const res = await fetch(`${api}/projects/${encodeURIComponent(slug)}`, {
    headers: { authorization: `Bearer ${process.env[TOKEN]}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) fail(`the tracker has no project "${slug}".`);
  if (!res.ok) fail(`the tracker answered ${res.status} when asked for project "${slug}".`);
  project = await res.json();
} catch (err) {
  fail(`the tracker at ${api} could not be reached (${err?.message ?? err}).`);
}
if (!project.alertPhone) fail(`project "${slug}" has no alert phone. Set one on its Edit project page: ${config.trackerUrl}/projects/${encodeURIComponent(slug)}/edit`);

const body = handOverText({
  ticket: { id: 'TEST-1', name: 'Test hand-over: the tracker can text you', status: 'needs your input' },
  ask: 'Nothing. This is a test text; if you are reading it, hand-over texts work.',
  pageUrl: config.trackerUrl,
});
try {
  await text.sendText({ to: project.alertPhone, text: body });
} catch (err) {
  fail(err?.message ?? String(err));
}
console.log(`test-text: Messages accepted it. It should reach project "${slug}"'s alert phone within a minute.`);
process.exit(0);
