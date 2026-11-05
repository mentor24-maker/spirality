/**
 * setup.mjs — what the tracker's server tells the "Set up a project" page,
 * and the one file it writes for it (the routes are in tracker/server.mjs).
 *
 * The page never runs the setup: Dane copies a command and pastes it on the
 * Mini, and the page reads where it stands. So this module only reads files
 * and writes one: a project's answers file, `<logDir>/onboard/<slug>.answers.json`.
 * The wizard (scripts/onboard/onboard.mjs) owns everything else, including
 * the state file it leaves beside the answers file,
 * `<logDir>/onboard/<slug>.state.json`, which this module only reads.
 *
 * Nothing about any one project is typed in here (CLAUDE.md engineering
 * rule 2): the fields and their questions are the wizard's own list
 * (DANE_FIELDS), the defaults come from the tracker home's settings file,
 * the answers are checked by the wizard's own checker (resolveAnswers), and
 * the command the page shows is built from the server's own folder and
 * database.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AnswersError, answersFile, onboardDir, resolveAnswers, slugFromName } from '../lib/onboardAnswers.mjs';
import { ProjectConfigError, withProjectNames } from '../lib/projectConfig.mjs';
import { answerValue, DANE_FIELDS, fieldNamed, shellQuote, STEPS } from '../scripts/onboard/onboard.mjs';

/** A setup refusal: the HTTP status it answers with, a code, and a message. */
export class SetupError extends Error {
  constructor(status, code, message, field = null) {
    super(message);
    this.name = 'SetupError';
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

/** The outcomes a state file's step may have. */
export const OUTCOMES = Object.freeze(['done', 'skip', 'failed', 'stopped', 'running', 'pending']);

/** Outcomes that mean a step is behind the setup. */
const FINISHED_OUTCOMES = new Set(['done', 'skip']);

/** The step after which the page may no longer change the answers: the sign-ins are made from them. */
export const ANSWERS_LOCK_STEP = 'signins';

/** Where a project's state file is kept: beside its answers file. */
export function stateFile(homeConfig, slug) {
  return join(onboardDir(homeConfig), `${slug}.state.json`);
}

/** Refuse a project name in an address that is not a slug. */
export function checkSlug(slug) {
  if (typeof slug !== 'string' || !slug || slugFromName(slug) !== slug) {
    throw new SetupError(400, 'bad-slug', `"${slug}" is not a project slug (small letters, digits and single dashes).`);
  }
  return slug;
}

/** A file's text, or null when it is not there. */
function readOrNull(path) {
  try { return readFileSync(path, 'utf8'); } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
}

/** A JSON file as `{ value }`, `{ value: null }` when it is not there, or `{ error }` when it does not parse. */
function readJsonFile(path) {
  const text = readOrNull(path);
  if (text == null) return { value: null };
  try { return { value: JSON.parse(text) }; } catch (err) {
    return { value: null, error: `${path} is not valid JSON (${err.message})` };
  }
}

/**
 * The answer fields that are Dane's decisions, in the wizard's order, each
 * with its question and the default the wizard would show in brackets
 * (null: no default). `slug` fills the defaults made from a project's slug;
 * without one those are null.
 */
export function setupFields({ homeConfig }, slug = '') {
  return DANE_FIELDS.map((f) => ({
    key: f.key,
    question: f.question,
    required: Boolean(f.required),
    list: Boolean(f.list),
    default: f.fallback ? (f.fallback({ slug, homeConfig }) ?? null) : null,
  }));
}

/**
 * A state file read and checked against the contract. Answers
 * `{ state, error }`: state null with no error when the wizard has not
 * written one yet; null with an error naming what is wrong when it does
 * not read.
 */
export function readState(homeConfig, slug) {
  const path = stateFile(homeConfig, slug);
  const { value, error } = readJsonFile(path);
  if (error) return { state: null, error };
  if (value == null) return { state: null, error: null };
  const bad = (why) => ({ state: null, error: `${path} ${why}` });
  if (typeof value !== 'object' || Array.isArray(value)) return bad('does not hold one JSON object');
  if (!Array.isArray(value.steps)) return bad('has no "steps" list');
  for (const s of value.steps) {
    if (!s || !STEPS.includes(s.step)) return bad(`names a step the wizard does not have: ${JSON.stringify(s?.step ?? s)}`);
    if (!OUTCOMES.includes(s.outcome)) return bad(`gives step "${s.step}" an outcome the contract does not have: ${JSON.stringify(s.outcome)}`);
  }
  return { state: value, error: null };
}

/** The step a setup is at: the stop's, else the first step not behind it; null once every step is. */
export function currentStep(state) {
  if (!state) return null;
  if (state.stop && state.stop.step) return state.stop.step;
  const open = state.steps.find((s) => !FINISHED_OUTCOMES.has(s.outcome));
  return open ? open.step : null;
}

/** Whether the state file shows the answers' lock step behind the setup (or the setup finished). */
export function answersLocked(state) {
  if (!state) return false;
  if (state.finished === true) return true;
  return state.steps.some((s) => s.step === ANSWERS_LOCK_STEP && FINISHED_OUTCOMES.has(s.outcome));
}

/**
 * The command the page shows to start or resume a project's setup: from the
 * server's own folder, against its own database. The wizard skips every
 * step already done, so starting and resuming are the same line.
 */
export function setupCommand({ folder, trackerDb }, slug) {
  return `cd ${shellQuote(folder)} && TRACKER_DB=${shellQuote(trackerDb)} npm run onboard -- --product ${shellQuote(slug)} --no-prompt`;
}

/** One project's setup: its answers as written, as checked, its state file, and the command. */
export function setupOf(setup, slug) {
  const { homeConfig, homeRoot } = setup;
  checkSlug(slug);
  const aPath = answersFile(homeConfig, slug);
  const read = readJsonFile(aPath);
  let resolved = null;
  let answersError = read.error ?? null;
  if (read.value != null && !answersError) {
    try {
      resolved = resolveAnswers(read.value, { homeConfig, homeRoot, file: aPath });
    } catch (err) {
      if (!(err instanceof AnswersError)) throw err;
      answersError = err.message;
    }
  }
  const { state, error: stateError } = readState(homeConfig, slug);
  const command = setupCommand(setup, slug);
  // The page reads the answers by their new names, also from a file written
  // before the rename (resolveAnswers has already refused one that gives a
  // field under both names with different values).
  let answers = read.value;
  try { answers = withProjectNames(answers, { file: aPath }); } catch (err) {
    if (!(err instanceof ProjectConfigError)) throw err;
  }
  return {
    product: slug,
    answers,
    resolved,
    answersError,
    state,
    stateError,
    step: currentStep(state),
    finished: state?.finished === true,
    locked: answersLocked(state),
    commands: { start: command, resume: command },
  };
}

/** Every project with an answers file, by slug, each with its current step and whether it finished. */
export function setupList(setup) {
  const dir = onboardDir(setup.homeConfig);
  let names = [];
  try { names = readdirSync(dir); } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const suffix = '.answers.json';
  return {
    setups: names
      .filter((n) => n.endsWith(suffix) && slugFromName(n.slice(0, -suffix.length)) === n.slice(0, -suffix.length))
      .map((n) => n.slice(0, -suffix.length))
      .sort()
      .map((slug) => {
        const { state, error } = readState(setup.homeConfig, slug);
        return { product: slug, step: currentStep(state), finished: state?.finished === true, started: state != null, stateError: error };
      }),
  };
}

/**
 * A form value as the answers file holds it: text as the wizard reads a
 * typed answer (blank is the default, a list split on commas, "none" an
 * empty list); a list or null as it is.
 */
function formValue(field, value) {
  if (value === null) return null;
  if (typeof value === 'string') return answerValue(field, value);
  if (field.list && Array.isArray(value)) return value;
  throw new SetupError(400, 'bad-field', `"${field.key}" must be ${field.list ? 'text or a list of text' : 'text'}, not ${JSON.stringify(value)}.`);
}

/**
 * Save the answers form for `slug`: every field the body names must be one
 * of Dane's (DANE_FIELDS), the result is checked by the wizard's own checker
 * (a bad field is a 400 naming it), written beside and renamed into place,
 * and read back. Refused (409) once the state file shows the sign-ins step
 * done: after that the answers change only in the file.
 */
export function saveAnswers(setup, slug, body) {
  const { homeConfig, homeRoot } = setup;
  checkSlug(slug);
  const known = new Map(DANE_FIELDS.map((f) => [f.key, f]));
  const unknown = Object.keys(body).filter((k) => !known.has(k));
  if (unknown.length) {
    throw new SetupError(400, 'bad-field', `unknown field(s): ${unknown.join(', ')}; the form's fields are: ${[...known.keys()].join(', ')}.`);
  }
  const { state, error: stateError } = readState(homeConfig, slug);
  if (stateError) throw new SetupError(409, 'state-unreadable', `${stateError}; nothing was written, because it cannot tell how far the setup is.`);
  if (answersLocked(state)) {
    throw new SetupError(409, 'setup-under-way', `${slug}'s setup is past its ${ANSWERS_LOCK_STEP} step, which were made from these answers; change them in ${answersFile(homeConfig, slug)} by hand. Nothing was written.`);
  }
  const aPath = answersFile(homeConfig, slug);
  const existing = readJsonFile(aPath);
  if (existing.error) throw new SetupError(409, 'answers-unreadable', `${existing.error}; fix or remove it. Nothing was written.`);
  const raw = existing.value ?? {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new SetupError(409, 'answers-unreadable', `${aPath} does not hold one JSON object; fix or remove it. Nothing was written.`);
  let named;
  try { named = withProjectNames(raw, { file: aPath }); } catch (err) {
    if (!(err instanceof ProjectConfigError)) throw err;
    throw new SetupError(409, 'answers-unreadable', `${err.message}. Nothing was written.`);
  }
  if (Object.hasOwn(named, 'projectSlug') && named.projectSlug !== slug) {
    throw new SetupError(409, 'answers-other-product', `${aPath} is for "${named.projectSlug}", not ${slug}. Nothing was written.`);
  }
  const typed = Object.fromEntries(Object.entries(body).map(([k, v]) => [k, formValue(known.get(k), v)]));
  const next = { ...named, projectSlug: slug, ...typed };
  try {
    resolveAnswers(next, { homeConfig, homeRoot, file: 'the answers' });
  } catch (err) {
    if (!(err instanceof AnswersError)) throw err;
    throw new SetupError(400, 'bad-answer', err.message, fieldNamed(err.message));
  }
  const written = `${JSON.stringify(next, null, 2)}\n`;
  const beside = `${aPath}.${process.pid}.tmp`;
  try {
    mkdirSync(onboardDir(homeConfig), { recursive: true });
    writeFileSync(beside, written);
    renameSync(beside, aPath);
  } catch (err) {
    if (existsSync(beside)) rmSync(beside, { force: true });
    throw new SetupError(500, 'not-written', `could not write ${aPath}: ${err.code || err.message}.`);
  }
  if (readOrNull(aPath) !== written) {
    throw new SetupError(500, 'not-read-back', `${aPath} did not read back as written.`);
  }
  return setupOf(setup, slug);
}
