/**
 * What one Claude session spent, read from its transcript (SP-398), for
 * `npm run clickup -- usage-record` and the API Usage report on the
 * Reporting page.
 *
 * WHERE THE NUMBERS COME FROM. Claude Code writes every session it runs to
 * `<config>/projects/<folder>/<session id>.jsonl`, one JSON object a line,
 * and a subagent's (the Task tool's) to `<session id>/subagents/*.jsonl`
 * beside it. Each answer Claude gave is a `type: "assistant"` line carrying
 * `message.model` and `message.usage`: the input, output, cache-write and
 * cache-read tokens of that request. Those tokens are what the plan's quota
 * is spent in; the transcript carries no dollars, so none are made up here.
 *
 * WHY EACH MESSAGE IS COUNTED ONCE. One answer is written as several lines
 * (one per block of its content), every one repeating the same
 * `message.id` and the same usage. Adding up lines counts an answer two or
 * three times. So lines are keyed by `message.id` (else `requestId`, else
 * the line's own `uuid`) and the last one of each counts.
 *
 * WHICH TICKET. A loop pass names its ticket in the door commands it runs:
 * the ticket it claimed (`clickup -- claim --task <id>`), else the first
 * `--task <id>` any Bash command named. A pass that named none has no
 * ticket.
 *
 * Pure apart from transcriptFiles, which only lists and reads files.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** A session id as Claude Code makes one: letters, digits and dashes only, so it can never reach outside the folder. */
export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,99}$/;

/** The four counts a row carries, by the transcript's own names. */
const COUNTS = Object.freeze([
  ['input', 'input_tokens'],
  ['output', 'output_tokens'],
  ['cacheWrite', 'cache_creation_input_tokens'],
  ['cacheRead', 'cache_read_input_tokens'],
]);

/** The model name Claude Code gives a line it made itself (an error, a stop): no request, no spend. */
const NOT_A_MODEL = '<synthetic>';

/** The folder Claude Code keeps its transcripts in: `CLAUDE_CONFIG_DIR/projects`, else `~/.claude/projects`. */
export function transcriptsRoot(env = process.env) {
  return join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
}

/**
 * Every transcript file of session `session` under `root`: the session's
 * own, in whichever project folder holds it, then its subagents', each
 * name sorted. None when the id is not a session id.
 */
export function transcriptFiles(root, session) {
  if (!SESSION_ID.test(String(session)) || !existsSync(root)) return [];
  const files = [];
  for (const folder of readdirSync(root).sort()) {
    const own = join(root, folder, `${session}.jsonl`);
    if (existsSync(own)) files.push(own);
    const subagents = join(root, folder, session, 'subagents');
    if (existsSync(subagents) && statSync(subagents).isDirectory()) {
      for (const name of readdirSync(subagents).sort()) if (name.endsWith('.jsonl')) files.push(join(subagents, name));
    }
  }
  return files;
}

/** Each line of a transcript's text that reads as JSON; a broken line (a write cut short) is skipped. */
export function transcriptLines(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skipped: a partial last line */ }
  }
  return out;
}

/** A count as a whole number of tokens; anything else is 0. */
function count(v) {
  return Number.isSafeInteger(v) && v > 0 ? v : 0;
}

/**
 * What the lines of one session (every file's, in any order) spent, per
 * model: `{ models: [{ model, input, output, cacheWrite, cacheRead,
 * total, requests }], startedAt, ticket }`. Most tokens first; a model
 * that spent nothing is left out. `startedAt` is the earliest line's time
 * (ISO) or null. `ticket` is ticketOf's answer.
 */
export function tallySession(lines) {
  const byMessage = new Map();
  let startedAt = null;
  for (const line of lines) {
    const when = Date.parse(line?.timestamp);
    if (!Number.isNaN(when) && (startedAt == null || when < startedAt)) startedAt = when;
    if (line?.type !== 'assistant' || !line.message?.usage) continue;
    const model = line.message.model;
    if (typeof model !== 'string' || !model || model === NOT_A_MODEL) continue;
    const key = line.message.id || line.requestId || line.uuid;
    if (!key) continue;
    byMessage.set(`${model}\u0000${key}`, { model, usage: line.message.usage });
  }
  const byModel = new Map();
  for (const { model, usage } of byMessage.values()) {
    const m = byModel.get(model) ?? { model, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0, requests: 0 };
    for (const [key, name] of COUNTS) m[key] += count(usage[name]);
    m.requests += 1;
    byModel.set(model, m);
  }
  const models = [...byModel.values()]
    .map((m) => ({ ...m, total: m.input + m.output + m.cacheWrite + m.cacheRead }))
    .filter((m) => m.total > 0)
    .sort((a, b) => b.total - a.total || a.model.localeCompare(b.model));
  return { models, startedAt: startedAt == null ? null : new Date(startedAt).toISOString(), ticket: ticketOf(lines) };
}

/** The Bash commands the session ran, in order. */
function bashCommands(lines) {
  const out = [];
  for (const line of lines) {
    if (line?.type !== 'assistant' || !Array.isArray(line.message?.content)) continue;
    for (const block of line.message.content) {
      if (block?.type === 'tool_use' && block.name === 'Bash' && typeof block.input?.command === 'string') out.push(block.input.command);
    }
  }
  return out;
}

/** A ticket id as a door command names one, quotes taken off; null for a shell variable or anything else. */
function ticketWord(word) {
  const clean = String(word).replace(/^["']|["']$/g, '');
  if (/^[A-Za-z][A-Za-z0-9]*-[0-9]+$/.test(clean)) return clean.toUpperCase();
  if (/^[0-9a-z]{6,12}$/.test(clean) && /[0-9]/.test(clean)) return clean; // a ClickUp task id
  return null;
}

/**
 * The ticket a session worked on: the one it claimed through the door
 * (`claim --task <id>`), else the first `--task <id>` any Bash command
 * named, else null. Lines are read in the order given (a session's own
 * file first, then its subagents', as transcriptFiles lists them).
 */
export function ticketOf(lines) {
  const commands = bashCommands(lines);
  for (const c of commands) {
    const m = c.match(/clickup\s+--\s+claim\s+--task[=\s]+(\S+)/);
    const id = m && ticketWord(m[1]);
    if (id) return id;
  }
  for (const c of commands) {
    for (const m of c.matchAll(/--task[=\s]+(\S+)/g)) {
      const id = ticketWord(m[1]);
      if (id) return id;
    }
  }
  return null;
}

/** Read session `session`'s transcripts under `root` and tally them: tallySession's answer plus `files`, the paths read. */
export function readSession(root, session) {
  const files = transcriptFiles(root, session);
  const lines = files.flatMap((f) => transcriptLines(readFileSync(f, 'utf8')));
  return { files, ...tallySession(lines) };
}
