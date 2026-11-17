/**
 * The Projects page (page-projects.mjs): setting up a project (SP-127).
 *
 * Split out of render.mjs (SP-364), which re-exports it, so every importer
 * still names render.mjs. Its rule holds here too: every character of
 * ticket text is escaped before it is drawn.
 */
import { escapeHtml, link, renderCopyRow } from './render-common.mjs';

/** A project's slug from its name, the wizard's own rule (lib/onboardAnswers.mjs slugFromName). */
export function setupSlug(name) {
  return String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Slugs the page cannot use: their setup page's address is another page's. */
export const SETUP_RESERVED_SLUGS = Object.freeze(['new', 'fields']);

/** Why a slug cannot be set up from the page, or null when it can. */
export function setupSlugProblem(slug) {
  if (!slug) return 'The project name needs a letter or a digit to make its slug from.';
  if (SETUP_RESERVED_SLUGS.includes(slug)) return `"${slug}" is the address of a page here; give the project another name.`;
  return null;
}

/** Each outcome the state file may give a step, as the step list says it. */
export const SETUP_OUTCOME_WORDS = Object.freeze({
  done: 'done',
  skip: 'skipped',
  running: 'running',
  stopped: 'stopped',
  failed: 'failed',
  pending: 'not yet',
});

/** The steps as a list, each with its outcome and what the wizard said of it; a plain line before the first run. */
export function renderSetupSteps(state) {
  if (!state) return '<p class="quiet setup-steps">Not started yet: no step has run.</p>';
  const item = (s) => {
    const outcome = Object.hasOwn(SETUP_OUTCOME_WORDS, s.outcome) ? s.outcome : 'pending';
    return `<li class="step ${outcome}"><span class="step-name">${escapeHtml(s.step)}</span> <span class="outcome">${escapeHtml(SETUP_OUTCOME_WORDS[outcome])}</span>${s.why ? `<span class="why quiet">${escapeHtml(s.why)}</span>` : ''}</li>`;
  };
  return `<ol class="setup-steps">${state.steps.map(item).join('')}</ol>`;
}

/** The step the state file says is running now, or null. */
export function runningStep(state) {
  return state?.steps?.find((s) => s.outcome === 'running')?.step ?? null;
}

/** The project's name as its answers give it; its slug until they do. */
export function setupName(setup) {
  return setup?.resolved?.projectName ?? setup?.answers?.projectName ?? setup?.project ?? '';
}

/** Whether the setup page reads again every few seconds: until the setup is finished, it is running or waiting on Dane. */
export function setupFollows(setup) {
  return !setup?.finished;
}

/** The lowest-numbered ticket on a project's board answer (`{ columns: [{ tickets: [{ id }] }] }`), or null. */
export function firstTicket(board) {
  const number = (id) => Number(/-(\d+)$/.exec(String(id))?.[1] ?? Infinity);
  const ids = (board?.columns ?? []).flatMap((c) => (c.tickets ?? []).map((t) => t.id));
  return ids.reduce((best, id) => (best == null || number(id) < number(best) ? id : best), null);
}

const PASTE_HERE = '<p>Paste this into a Terminal on the Mini:</p>';
const isLink = (v) => typeof v === 'string' && /^https?:\/\//i.test(v);

/**
 * The box under the steps: what is next, from the server's answer for one
 * project (tracker/setup.mjs setupOf). `firstTicketId` is the project's
 * first ticket, for the finished box (null: not known). Every command shown
 * comes with a Copy button whose text is that command exactly.
 */
export function renderSetupNext(setup, { firstTicketId = null } = {}) {
  const { project, state, stateError, finished, commands } = setup;
  const name = setupName(setup);
  const resume = (lead = 'Then run the setup again; it skips every step already done.') => `<p>${lead}</p>${renderCopyRow(commands.resume)}`;
  const box = (kind, body) => `<section class="setup-next ${kind}" data-next="${kind}">${body}</section>`;
  if (finished) {
    const projectLink = `<a href="/projects/${encodeURIComponent(project)}">its project</a>`;
    const ticket = firstTicketId ? ` and <a href="/t/${encodeURIComponent(firstTicketId)}">its first ticket, ${escapeHtml(firstTicketId)}</a>` : '';
    return box('finished', `<h2>${escapeHtml(name)} Is Set Up</h2><p>Every step is done. See ${projectLink}${ticket}.</p>`);
  }
  if (stateError) {
    return box('unreadable', `<h2>The Setup's State Cannot Be Read</h2><p class="error">${escapeHtml(stateError)}</p>${resume('Running the setup again writes it afresh:')}`);
  }
  if (!state) {
    return box('start', `<h2>Start the Setup</h2>${PASTE_HERE}${renderCopyRow(commands.start)}<p class="quiet">This page follows it as it runs.</p>`);
  }
  // What each kind of stop the wizard records (its STOP_KINDS) asks of him.
  const stop = state.stop;
  const STOPS = {
    answers: () => `<h2>Some Answers Are Missing</h2><p>${escapeHtml(stop.why)}</p><p><a href="/setup/${encodeURIComponent(project)}/answers">Fill in the answers</a>, then paste this into a Terminal on the Mini:</p>${renderCopyRow(commands.start)}`,
    paste: () => {
      const lines = Array.isArray(stop.commands) ? stop.commands : [];
      return `<h2>Your Move (Real Secret Values)</h2><p>${escapeHtml(stop.why)}</p>${PASTE_HERE}${renderCopyRow(lines.join('\n'))}<p class="quiet">It makes the sign-ins and writes their keys into Doppler. No key is shown.</p>${resume('Once it has finished, run the setup again:')}`;
    },
    merge: () => {
      const link = isLink(stop.link) ? `<p><a href="${escapeHtml(stop.link)}">Open the setup ticket</a>: its Merge button is there.</p>` : '';
      return `<h2>Your Move (A Decision): Merge the Setup</h2><p>${escapeHtml(stop.why)}</p>${link}${resume('Once it has merged, run the setup again:')}`;
    },
    failed: () => `<h2>A Step Failed</h2><pre class="failed"><code>${escapeHtml(`FAILED: ${stop.step}: ${stop.why}`)}</code></pre>${resume('Fix it, then run the setup again; it skips every step already done:')}`,
  };
  if (stop && Object.hasOwn(STOPS, stop.kind)) return box(stop.kind, STOPS[stop.kind]());
  const running = runningStep(state);
  if (running) {
    return box('running', `<h2>Running: ${escapeHtml(running)}</h2><p class="quiet">This page follows it every few seconds.</p>${resume('If nothing changes for a long while, its run may have ended; run it again:')}`);
  }
  return box('resume', `<h2>Carry On with the Setup</h2>${resume('Paste this into a Terminal on the Mini; it skips every step already done:')}`);
}

/** The Projects page's list of projects mid-setup (`GET /setup`'s answer), each linking to its setup page; '' with none. */
export function renderSetupList({ setups = [] } = {}) {
  const open = setups.filter((s) => !s.finished);
  if (!open.length) return '';
  const item = (s) => `<li><a href="/setup/${encodeURIComponent(s.project)}">${escapeHtml(s.project)}</a> <span class="quiet">${s.stateError ? 'its state cannot be read' : !s.started ? 'not started yet' : `at ${escapeHtml(s.step ?? '')}`}</span></li>`;
  return `<section class="setups"><h2>Being Set Up</h2><ul>${open.map(item).join('')}</ul></section>`;
}

/** An answer as the form's text box shows it: a list with commas, an empty list as "none", the default when there is none. */
export function setupFieldText(field, answers) {
  const has = answers && Object.hasOwn(answers, field.key) && answers[field.key] != null;
  if (!has) return field.default ?? '';
  const v = answers[field.key];
  if (Array.isArray(v)) return v.length ? v.join(', ') : 'none';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return String(v);
}

/**
 * The answers form: one box per field the server gives (`GET
 * /setup/fields`), in its order, each named by its label with its question
 * under it (SP-325), and filled in from
 * the saved answers or the default. Each has a note beside it for a
 * refusal naming it.
 */
export function renderSetupForm(fields, answers = null) {
  const box = (f) => {
    const id = `setup-${escapeHtml(f.key)}`;
    const value = setupFieldText(f, answers);
    // A list's question ends "(comma between)" for the command-line wizard; the hint says it once, so drop it there.
    const question = f.list ? String(f.question ?? '').replace(/\s*\(comma between\)$/, '') : f.question;
    const hint = [f.label && f.label !== f.question ? question : '', f.list ? 'Commas between; "none" for none.' : ''].filter(Boolean).join('. ');
    const attrs = `name="${escapeHtml(f.key)}" data-default="${escapeHtml(f.default ?? '')}"${f.required ? ' required' : ''}${hint ? ` aria-describedby="${id}-hint"` : ''} autocapitalize="off" spellcheck="false"`;
    const input = f.key === 'description'
      ? `<textarea id="${id}" ${attrs}>${escapeHtml(value)}</textarea>`
      : `<input type="text" id="${id}" ${attrs} value="${escapeHtml(value)}">`;
    return `
      <label for="${id}">${escapeHtml(f.label ?? f.question)}</label>
      ${hint ? `<span class="hint" id="${id}-hint">${escapeHtml(hint)}</span>` : ''}
      ${input}
      <span class="note field-note" data-for="${escapeHtml(f.key)}"></span>`;
  };
  return fields.map(box).join('');
}

/**
 * The body the answers form sends (`PUT /setup/<slug>`): each field's text
 * as typed, or null where it is its default, so the default stays the
 * wizard's.
 */
export function setupBody(fields, values) {
  return Object.fromEntries(fields.map((f) => {
    const typed = String(values[f.key] ?? '').trim();
    return [f.key, typed === String(f.default ?? '').trim() ? null : typed];
  }));
}
