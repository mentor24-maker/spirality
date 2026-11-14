/**
 * Suggest five titles for a task (SP-245): the Add Task box sends a
 * description, and optionally the title the person typed, and gets back five
 * titles to choose from.
 *
 * The suggestions come from a Claude run on this machine, `claude -p` with
 * the `suggest-titles` skill (.claude/skills/suggest-titles/SKILL.md) as its
 * prompt. It uses the Claude sign-in the loops already use: no API key, no
 * new secret. The run gets no tools at all, a time limit (60 seconds unless
 * the caller says otherwise), and starts in the system's temporary folder so
 * no project's rules or files reach it. The person's words travel on
 * standard input, never on the command line, so they never show in a
 * process list.
 *
 * `readTitles` is the pure reader for the answer: exactly five non-empty
 * lines once numbering, bullets and quotes are stripped and repeats dropped,
 * each under MAX_TITLE_LENGTH characters. Anything else is a `bad-answer`
 * error, never a short list.
 *
 * Every failure is a TitleSuggestError with a code the server turns into an
 * answer: `no-claude` (no such command), `too-slow` (over the time limit),
 * `bad-answer` (not five usable titles) and `failed` (the run exited with an
 * error). Nothing is written anywhere.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseSkill } from './commands.mjs';

/** How many titles a good answer holds. */
export const SUGGESTION_COUNT = 5;
/** A suggested title this long or longer makes the answer a bad one. */
export const MAX_TITLE_LENGTH = 120;
/** How long one run may take before it is stopped. */
export const TIME_LIMIT_MS = 60_000;
/** The environment variable that names the `claude` command; `claude` on the PATH without it. */
export const CLAUDE_COMMAND_VAR = 'TRACKER_CLAUDE';
/** The skill whose steps are the run's prompt. */
export const SKILL_FILE = fileURLToPath(new URL('../.claude/skills/suggest-titles/SKILL.md', import.meta.url));

/** How much of the run's output is kept: far more than five titles need. */
const MAX_OUTPUT = 64 * 1024;

/** A suggestion that did not come back, with a code the server answers by. */
export class TitleSuggestError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TitleSuggestError';
    this.code = code;
  }
}

/** The `claude` command the server runs: TRACKER_CLAUDE when set, else `claude` on the PATH. */
export function claudeCommandOf(env = process.env) {
  const named = env[CLAUDE_COMMAND_VAR];
  return named && named.trim() ? named.trim() : 'claude';
}

/**
 * The run's arguments: the skill's steps as the prompt, no tools, nothing
 * saved. The person's words are never among them.
 */
export function claudeArgs(prompt) {
  return ['-p', prompt, '--tools', '', '--no-session-persistence', '--output-format', 'text'];
}

/** What the run reads on standard input: the description, and the title when one was typed. */
export function suggestInput({ description, title }) {
  const lines = [`Description: ${String(description).trim()}`];
  if (title != null && String(title).trim()) lines.push(`Title: ${String(title).trim()}`);
  return `${lines.join('\n')}\n`;
}

/** One answer line without its numbering, bullet, wrapping quotes or bold marks. */
function cleanLine(line) {
  let text = line.trim()
    .replace(/^(?:\d+[.):]|[-*•–])\s+/, '')
    .replace(/^\*\*(.*)\*\*$/, '$1')
    .trim();
  const pair = /^(["'`“‘])(.*)(["'`”’])$/.exec(text);
  if (pair) text = pair[2].trim();
  return text;
}

/**
 * The five titles in a run's answer, or a `bad-answer` error saying what was
 * wrong. Blank lines are skipped; a repeat (ignoring case) is dropped before
 * counting, so five lines with one repeat is four titles, a bad answer.
 */
export function readTitles(text) {
  const seen = new Set();
  const titles = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const title = cleanLine(line);
    if (!title) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    titles.push(title);
  }
  if (titles.length !== SUGGESTION_COUNT) {
    throw new TitleSuggestError('bad-answer', `the suggester gave ${titles.length} different title${titles.length === 1 ? '' : 's'}, not ${SUGGESTION_COUNT}.`);
  }
  const long = titles.find((t) => t.length >= MAX_TITLE_LENGTH);
  if (long) {
    throw new TitleSuggestError('bad-answer', `a suggested title is ${long.length} characters long; each must be under ${MAX_TITLE_LENGTH}.`);
  }
  return titles;
}

/** The skill's steps (the text below its front matter): the run's prompt. */
export function skillPrompt(file = SKILL_FILE, read = (p) => readFileSync(p, 'utf8')) {
  const text = read(file);
  const skill = parseSkill(text);
  return (skill ? skill.steps : text).trim();
}

/**
 * Run `claude -p` with the skill and answer the five titles. `command` is
 * the `claude` to run (claudeCommandOf), `timeoutMs` the limit, `run` the
 * spawn to use (a test may watch it). Rejects with a TitleSuggestError.
 */
export function suggestTitles({ description, title = null }, { command = 'claude', timeoutMs = TIME_LIMIT_MS, skillFile = SKILL_FILE, run = spawn } = {}) {
  if (typeof description !== 'string' || !description.trim()) {
    return Promise.reject(new TitleSuggestError('no-description', 'a description is needed to suggest titles from.'));
  }
  let prompt;
  try {
    prompt = skillPrompt(skillFile);
  } catch (err) {
    return Promise.reject(new TitleSuggestError('failed', `the suggest-titles skill could not be read (${err.message}).`));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let out = '';
    let err = '';
    let child;
    let timer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    try {
      child = run(command, claudeArgs(prompt), { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      finish(reject, startError(command, e));
      return;
    }
    timer = setTimeout(() => {
      child.kill('SIGTERM');
      // One that ignores the polite stop is stopped for good.
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
      finish(reject, new TitleSuggestError('too-slow', `the suggester took longer than ${Math.round(timeoutMs / 1000)} seconds and was stopped.`));
    }, timeoutMs);
    child.on('error', (e) => finish(reject, startError(command, e)));
    child.stdout.on('data', (chunk) => { if (out.length < MAX_OUTPUT) out += chunk; });
    child.stderr.on('data', (chunk) => { if (err.length < MAX_OUTPUT) err += chunk; });
    child.on('close', (code, signal) => {
      if (code !== 0) {
        const why = err.trim().split(/\r?\n/).filter(Boolean).pop();
        finish(reject, new TitleSuggestError('failed', `the suggester stopped with ${code == null ? `signal ${signal}` : `exit ${code}`}${why ? ` (${why.slice(0, 200)})` : ''}.`));
        return;
      }
      try {
        finish(resolve, readTitles(out));
      } catch (e) {
        finish(reject, e);
      }
    });
    // A run that exits without reading its input is not an error of ours.
    child.stdin.on('error', () => {});
    child.stdin.end(suggestInput({ description, title }));
  });
}

/** A run that could not start: no such command is `no-claude`, anything else `failed`. */
function startError(command, e) {
  if (e && (e.code === 'ENOENT' || e.code === 'EACCES')) {
    return new TitleSuggestError('no-claude', `there is no "${command}" command on this machine to suggest titles with; set ${CLAUDE_COMMAND_VAR} to its path.`);
  }
  return new TitleSuggestError('failed', `the suggester could not start (${e?.message ?? e}).`);
}
