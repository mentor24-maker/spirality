/**
 * Suggest a project's next few tasks (SP-250, slice 2 of SP-249's "Autosuggest
 * next tasks"). When someone asks, the tracker makes a shallow copy of the
 * project's `main` from its GitHub repository (the project's `repo`
 * setting) into a fresh folder under the system's temp folder, runs
 * `claude -p` there with the suggest-next skill and read-only tools (Read,
 * Grep, Glob), and reads back three to seven suggestions:
 * `[{ title, description, why }]`.
 *
 * - The copy is never the lanes' own checkout, and it is removed afterwards
 *   whatever happens (a good answer, a bad one, a crash, the time limit).
 * - The open tickets go to `claude` on standard input, never on its command
 *   line, where any other process on the machine could read them.
 * - The whole run (copy and Claude) has one time limit, 10 minutes unless
 *   set; past it the run is stopped and fails.
 * - Which `claude` to run comes from the server's settings
 *   (TRACKER_CLAUDE, the same one the title suggester runs; default `claude`
 *   on the PATH), so tests swap in a
 *   stub. It uses the Claude sign-in the Mini's loops already use: no new key.
 * - A run writes no ticket. The latest finished run per project is kept in
 *   the store (`saveNextSuggestions`), so a reload or a restart still shows it.
 *
 * `readSuggestions` is the pure reader for Claude's answer; `runSuggest` is
 * one run; `createSuggester` keeps at most one run per project going.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSkill, REPO_ROOT } from './commands.mjs';
import { CLAUDE_COMMAND_VAR } from './titleSuggest.mjs';

/** The time limit for one whole run: the copy and Claude together. */
export const SUGGEST_TIME_LIMIT_MS = 10 * 60 * 1000;
/** How many suggestions a good answer holds. */
export const MIN_SUGGESTIONS = 3;
export const MAX_SUGGESTIONS = 7;
/** The longest each field may be; longer is cut, with an ellipsis. */
export const FIELD_LIMITS = Object.freeze({ title: 160, description: 2000, why: 600 });
/** The read-only tools Claude may use in the copy; nothing that writes or runs a command. */
export const READ_ONLY_TOOLS = Object.freeze(['Read', 'Grep', 'Glob']);
/** The skill the run follows, in this checkout (the tracker's), not the project's copy. */
export const SKILL_FILE = join(REPO_ROOT, '.claude', 'skills', 'suggest-next', 'SKILL.md');
/** The setting that names which `claude` to run: one for every Claude run the tracker makes. */
export const CLAUDE_BIN_SETTING = CLAUDE_COMMAND_VAR;
/** How much of each open ticket goes to Claude: its newest comments, and caps on long text. */
const TICKET_COMMENTS = 5;
const TICKET_DESCRIPTION_LIMIT = 4000;
const COMMENT_LIMIT = 1500;
/** How much of a failed step's own output a failure message quotes. */
const QUOTE_LIMIT = 300;

/** A failed run, with a plain message saying why; `code` names the kind. */
export class SuggestError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SuggestError';
    this.code = code;
  }
}

/** `text` cut to `limit` characters, with an ellipsis when cut. */
function cap(text, limit) {
  const s = String(text ?? '').trim();
  return s.length > limit ? `${s.slice(0, limit - 1).trimEnd()}…` : s;
}

/** A title with any leading numbering taken off: "1. ", "2) ", "#3 ", "- ", "* ". */
function stripNumbering(title) {
  return title.replace(/^\s*(?:(?:#?\d+\s*[.):-]?|[-*•])\s+)+/, '').trim();
}

/**
 * Claude's answer as the suggestions it holds: `[{ title, description, why }]`,
 * three to seven of them. A code fence around the JSON is allowed, and so is
 * text before or after it (the array is found by its brackets). Numbering is
 * taken off each title, a title already given is dropped (case and spacing
 * ignored), and each field is cut to FIELD_LIMITS. Anything else (not JSON,
 * not a list, an item with no title, fewer than three or more than seven
 * after duplicates go) throws a SuggestError `bad-answer`: never a half list.
 */
export function readSuggestions(text) {
  const raw = String(text ?? '');
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end < start) throw new SuggestError('bad-answer', `Claude's answer held no list of suggestions${quote(raw)}.`);
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new SuggestError('bad-answer', `Claude's answer was not valid JSON${quote(raw)}.`);
  }
  if (!Array.isArray(parsed)) throw new SuggestError('bad-answer', 'Claude\'s answer was not a list of suggestions.');
  const out = [];
  const seen = new Set();
  for (const [i, item] of parsed.entries()) {
    if (item == null || typeof item !== 'object' || Array.isArray(item)) {
      throw new SuggestError('bad-answer', `suggestion ${i + 1} in Claude's answer is not a { title, description, why } item.`);
    }
    const title = cap(stripNumbering(typeof item.title === 'string' ? item.title : ''), FIELD_LIMITS.title);
    if (!title) throw new SuggestError('bad-answer', `suggestion ${i + 1} in Claude's answer has no title.`);
    const key = title.toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      title,
      description: cap(typeof item.description === 'string' ? item.description : '', FIELD_LIMITS.description),
      why: cap(typeof item.why === 'string' ? item.why : '', FIELD_LIMITS.why),
    });
  }
  if (out.length < MIN_SUGGESTIONS || out.length > MAX_SUGGESTIONS) {
    throw new SuggestError('bad-answer', `Claude gave ${out.length} suggestion${out.length === 1 ? '' : 's'}${out.length === parsed.length ? '' : ` once repeats were dropped (${parsed.length} in all)`}; a good answer has ${MIN_SUGGESTIONS} to ${MAX_SUGGESTIONS}.`);
  }
  return out;
}

/** `: "<the start of text>"`, for a failure message, or nothing for no text. */
function quote(text) {
  const s = String(text ?? '').trim().replace(/\s+/g, ' ');
  return s ? `: "${cap(s, QUOTE_LIMIT)}"` : '';
}

/**
 * What goes to Claude on standard input: the open tickets as JSON, each with
 * its id, name, status, priority, description and newest comments
 * (`commentsOf(id)` answers a ticket's comments, oldest first), long text cut.
 */
export function ticketsInput(tickets, commentsOf = () => []) {
  const open = tickets.map((t) => ({
    id: t.id,
    name: t.name,
    status: t.status,
    priority: t.priority ?? null,
    description: cap(t.description, TICKET_DESCRIPTION_LIMIT),
    recentComments: commentsOf(t.id).slice(-TICKET_COMMENTS).map((c) => ({ at: c.createdAt, body: cap(c.body, COMMENT_LIMIT) })),
  }));
  return `${JSON.stringify({ openTickets: open }, null, 2)}\n`;
}

/** The skill's steps (the text under its front matter), read from `file`. */
export function skillPrompt(file = SKILL_FILE) {
  const text = readFileSync(file, 'utf8');
  const steps = parseSkill(text)?.steps ?? text;
  return `${steps.trim()}\n\nThe open tickets follow as JSON on standard input.`;
}

/** Where a project's repository is copied from: GitHub, by its `owner/name`. */
export function githubSource(repo) {
  return `https://github.com/${repo}.git`;
}

/** A time limit in words: "10-minute", or "2-second" for a short one. */
function limitText(ms) {
  return ms >= 60000 && ms % 60000 === 0 ? `${ms / 60000}-minute` : `${Math.max(1, Math.round(ms / 1000))}-second`;
}

/**
 * Run `command` with `args` in `cwd`, `input` on standard input, until
 * `deadline` (a time in ms). Resolves `{ code, stdout, stderr }`; rejects a
 * SuggestError `time-limit` when the deadline passes (once the process has
 * been stopped), and `not-found` when the command is not there.
 */
function runProcess(command, args, { cwd, input = '', deadline, limitMs, env, what, now }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      // Its own process group, so the time limit stops whatever it started too.
      child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    } catch (err) {
      reject(new SuggestError('not-found', `${what} could not be started (${err.message}).`));
      return;
    }
    let stdout = '';
    let stderr = '';
    let done = false;
    let timedOut = false;
    let killer = null;
    const stop = (signal) => {
      try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* already gone */ } }
    };
    const finish = (fn) => { if (!done) { done = true; clearTimeout(timer); clearTimeout(killer); fn(); } };
    // Past the deadline the process is asked to stop, then made to; the run
    // fails only once it has gone, so nothing is still writing in the temp
    // folder when it is removed.
    const timer = setTimeout(() => {
      timedOut = true;
      stop('SIGTERM');
      killer = setTimeout(() => stop('SIGKILL'), 2000);
    }, Math.max(0, deadline - now()));
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => finish(() => reject(err.code === 'ENOENT'
      ? new SuggestError('not-found', `${what} was not found (no "${command}" on this machine).`)
      : new SuggestError('failed', `${what} could not be started (${err.message}).`))));
    // A stopped process may leave a pipe open behind it, so a timed-out run
    // ends when the process exits, not when its output closes.
    const tooLong = () => finish(() => reject(new SuggestError('time-limit', `${what} was still running when the ${limitText(limitMs)} limit for a run passed, so it was stopped.`)));
    child.on('exit', () => { if (timedOut) tooLong(); });
    child.on('close', (code) => (timedOut ? tooLong() : finish(() => resolve({ code, stdout, stderr }))));
    // A command that exits before reading its input is not an error here.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/**
 * One run: copy `repo`'s main into a fresh temp folder, run `claude` there
 * with the skill and `input` (ticketsInput) on standard input, and read its
 * answer. Resolves the suggestions; rejects a SuggestError with a plain
 * message. The temp folder is removed before it settles, either way.
 *
 * `claudeBin` is the command to run; `source(repo)` is where the copy comes
 * from (GitHub unless a test says otherwise); `timeLimitMs` covers the
 * whole run; `onFolder(path)` is told the temp folder (for tests).
 */
export async function runSuggest({ repo, input, claudeBin = 'claude', source = githubSource, timeLimitMs = SUGGEST_TIME_LIMIT_MS, skillFile = SKILL_FILE, tmpRoot = tmpdir(), env = process.env, now = Date.now, onFolder = () => {} }) {
  if (!repo) throw new SuggestError('no-repo', 'this project has no GitHub repository set, so there is nothing to read; set one on its Edit Project page.');
  const deadline = now() + timeLimitMs;
  const prompt = skillPrompt(skillFile);
  const folder = mkdtempSync(join(tmpRoot, 'spirality-suggest-'));
  onFolder(folder);
  try {
    const copy = join(folder, 'project');
    // Never asks for a password: a repository that needs one fails at once.
    const gitEnv = { ...env, GIT_TERMINAL_PROMPT: '0' };
    const git = await runProcess('git', ['clone', '--quiet', '--depth', '1', '--single-branch', '--branch', 'main', source(repo), copy], { cwd: folder, deadline, limitMs: timeLimitMs, env: gitEnv, what: 'Copying the project', now });
    if (git.code !== 0) throw new SuggestError('copy-failed', `the project's main branch could not be copied from ${repo}${quote(git.stderr)}.`);
    const args = ['-p', prompt, '--output-format', 'text', '--tools', READ_ONLY_TOOLS.join(','), '--allowedTools', READ_ONLY_TOOLS.join(','), '--strict-mcp-config', '--no-session-persistence'];
    const claude = await runProcess(claudeBin, args, { cwd: copy, input, deadline, limitMs: timeLimitMs, env, what: 'Claude', now }).catch((err) => {
      if (err.code === 'not-found') throw new SuggestError('not-found', `Claude was not found on this machine (no "${claudeBin}"); install Claude Code there, or set ${CLAUDE_BIN_SETTING} to where it is.`);
      throw err;
    });
    if (claude.code !== 0) throw new SuggestError('claude-failed', `Claude stopped with exit ${claude.code}${quote(claude.stderr || claude.stdout)}.`);
    return readSuggestions(claude.stdout);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/**
 * Keeps at most one run per project going. `start(project)` begins one
 * (or answers the run already going) and returns it at once:
 * `{ id, state: 'running', at }`. `latest(slug)` answers the run going, or
 * the latest finished one from the store, `{ state, suggestions?, message?,
 * at }`, or null when none was ever asked for.
 *
 * `run(options)` is runSuggest (tests swap it); `inputOf(project)` builds
 * the tickets' input; a finished run is saved with
 * `store.saveNextSuggestions` and read with `store.nextSuggestions`.
 */
export function createSuggester({ store, inputOf, run = runSuggest, options = {}, log = () => {}, now = () => new Date().toISOString() }) {
  const going = new Map();
  let counter = 0;

  function start(project) {
    const already = going.get(project.slug);
    if (already) return { ...already.run, already: true };
    counter += 1;
    const entry = { run: { id: `${project.slug}-${Date.now()}-${counter}`, state: 'running', at: now() } };
    going.set(project.slug, entry);
    log(`suggest-next: started run ${entry.run.id} for ${project.slug}`);
    entry.done = (async () => {
      let outcome;
      try {
        const suggestions = await run({ ...options, repo: project.repo, input: inputOf(project) });
        outcome = { state: 'done', suggestions, message: null };
      } catch (err) {
        outcome = { state: 'failed', suggestions: null, message: err instanceof SuggestError ? err.message : `the run failed (${err?.message ?? err}).` };
      }
      try {
        store.saveNextSuggestions({ project: project.slug, ...outcome, at: now() });
      } catch (err) {
        log(`suggest-next: run ${entry.run.id} for ${project.slug} finished ${outcome.state} but could not be kept (${err.message}).`);
      }
      going.delete(project.slug);
      log(`suggest-next: run ${entry.run.id} for ${project.slug} ${outcome.state}${outcome.message ? `: ${outcome.message}` : ` with ${outcome.suggestions.length} suggestions`}`);
      return outcome;
    })();
    return { ...entry.run };
  }

  function latest(slug) {
    const g = going.get(slug);
    if (g) return { ...g.run };
    const kept = store.nextSuggestions(slug);
    if (!kept) return null;
    const out = { state: kept.state, at: kept.at };
    if (kept.suggestions) out.suggestions = kept.suggestions;
    if (kept.message) out.message = kept.message;
    return out;
  }

  /** The run going for `slug`, as a promise of its outcome, or null (for tests and a clean shutdown). */
  function settled(slug) {
    return going.get(slug)?.done ?? null;
  }

  return { start, latest, settled };
}
