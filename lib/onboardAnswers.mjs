/**
 * onboardAnswers.mjs — the answers file that drives setting up a project on
 * Spirality (docs/onboarding/SETUP_REVIEW.md, part 3, "What a person
 * enters"). Every step of the setup wizard reads the same file, so nothing
 * is asked twice. Step 0, the read-only look (scripts/onboard/look.mjs), is
 * the first reader.
 *
 * The file lives at `<logDir>/onboard/<slug>.answers.json`, where `logDir`
 * is the tracker home's (the project whose settings file sets
 * `trackerPort`, today Spirality). That folder is outside every repository,
 * on purpose: this repository is public, and a project's answers may name
 * things about a private one.
 *
 * The fields, what each is, and its default (empty: it must be written):
 *
 *   projectName           what the tracker shows: "Normie"
 *   githubRepo            owner/name: "mentor24-maker/normie"
 *   projectSlug           short name for logs, locks and the tracker
 *                         project; default: projectName in lower case
 *   trackerPrefix         the start of every ticket id; default: the
 *                         slug's first two letters, upper case
 *   dopplerProject        where the project's loop keys live; default: slug
 *   dopplerConfig         that project's config; default "dev"
 *   launchdPrefix         the start of every job label; default com.<slug>
 *   checkoutDir           the project's main copy on the Mini; default: the
 *                         folder beside the tracker home's, named for the slug
 *   checkCommand          what CI and the loops run as `verify`; default
 *                         "npm run verify"
 *   nodeVersion           the Node the project needs, written as its
 *                         `.nvmrc` or `engines.node` would ("22", ">=22.12");
 *                         default null: read from the project itself
 *   mergePhrases          what the operator writes to mean "merge this";
 *                         default: the tracker home's
 *   autoMergeLanes        lanes that may merge without him; default none
 *   extraGovernancePaths  protected files added to the tracker home's
 *                         governancePaths; default none
 *   hosting               where the app deploys, in a few words; default null
 *   description           two or three sentences on what the project is,
 *                         for its CLAUDE.md
 *
 * A project that already runs a loop on ClickUp (SP-159: WaveCenter,
 * StarCaster) also has, in CLICKUP_ANSWER_FIELDS:
 *
 *   clickupListId         its Loop Queue list id; null (the default): the
 *                         project is not on ClickUp, and the setup is a new
 *                         project's
 *   clickupOperatorId     the operator's own ClickUp user id, so the import
 *                         files his old comments under him; required with
 *                         clickupListId
 *   clickupMachineUserId  the old loop's ClickUp machine user id, so the
 *                         import files its comments under the loops;
 *                         required with clickupListId
 *   clickupExtraLists     other ClickUp lists to keep a copy of in the
 *                         snapshot (StarCaster's alarm list); default none
 *
 * No default is typed into this module (CLAUDE.md engineering rule 2): each
 * one is made from the slug or read from the tracker home's own settings
 * file, passed in as `home`.
 *
 * A field nobody knows about is refused, naming it, so a typo never
 * silently becomes "use the default".
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { validateProjectConfig, ProjectConfigError, withProjectNames } from './projectConfig.mjs';

export class AnswersError extends Error {
  constructor(message) { super(message); this.name = 'AnswersError'; }
}

/** Every field, in the order "What a person enters" lists them. */
export const ANSWER_FIELDS = Object.freeze([
  'projectName', 'githubRepo', 'projectSlug', 'trackerPrefix', 'dopplerProject', 'dopplerConfig',
  'launchdPrefix', 'checkoutDir', 'checkCommand', 'nodeVersion', 'mergePhrases', 'autoMergeLanes',
  'extraGovernancePaths', 'hosting', 'description',
]);

/**
 * The answers only a project already on ClickUp has (SP-159). Kept apart
 * from ANSWER_FIELDS so a new project's answers read exactly as before; the
 * resolved answers always carry them (null, null, [] when not on ClickUp).
 */
export const CLICKUP_ANSWER_FIELDS = Object.freeze(['clickupListId', 'clickupOperatorId', 'clickupMachineUserId', 'clickupExtraLists']);

/** A leading "~/" is the home folder. */
export function expandHome(path, home = homedir()) {
  const p = String(path);
  if (p === '~') return home;
  return p.startsWith('~/') ? join(home, p.slice(2)) : p;
}

/** The folder every project's answers file is kept in: `<logDir>/onboard`. */
export function onboardDir(homeConfig, home = homedir()) {
  return join(expandHome(homeConfig.logDir, home), 'onboard');
}

/** Where one project's answers file is kept: `<logDir>/onboard/<slug>.answers.json`. */
export function answersFile(homeConfig, slug, home = homedir()) {
  return join(onboardDir(homeConfig, home), `${slug}.answers.json`);
}

/** "Normie" -> "normie"; "Press Play!" -> "press-play". */
export function slugFromName(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Check a parsed answers object and fill in every default. `homeConfig` is
 * the tracker home's checked project config (loadProjectConfig), and
 * `homeRoot` the folder its settings file is in. `file` only names the file
 * in messages. Returns a frozen object with every field in ANSWER_FIELDS;
 * throws AnswersError naming the field at fault.
 */
export function resolveAnswers(raw, { homeConfig, homeRoot, file = 'the answers file' } = {}) {
  if (!homeConfig || homeConfig.trackerPort == null) {
    throw new AnswersError('the tracker home\'s settings file is needed (the one that sets "trackerPort"); run this from its folder.');
  }
  if (!homeRoot) throw new AnswersError('the tracker home\'s folder is needed, for the default checkout folder.');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AnswersError(`${file}: must hold one JSON object of answers`);
  }
  // An answers file written before SP-130 uses the old names (productSlug
  // and the others);
  // they are read as the new ones (OLD_NAMES), and both names with
  // different values are refused, naming both.
  try {
    raw = withProjectNames(raw, { file });
  } catch (err) {
    if (err instanceof ProjectConfigError) throw new AnswersError(err.message);
    throw err;
  }
  for (const key of Object.keys(raw)) {
    if (!ANSWER_FIELDS.includes(key) && !CLICKUP_ANSWER_FIELDS.includes(key)) {
      throw new AnswersError(`${file}: unknown field "${key}" (the fields are: ${[...ANSWER_FIELDS, ...CLICKUP_ANSWER_FIELDS].join(', ')})`);
    }
  }
  const fail = (key, why) => { throw new AnswersError(`${file}: "${key}" ${why}`); };
  const given = (key) => Object.hasOwn(raw, key) && raw[key] !== null;
  const text = (key, { required = false, fallback = null } = {}) => {
    if (!given(key)) {
      if (required) fail(key, 'is missing; it is a decision only a person can make, so it has no default');
      return fallback;
    }
    if (typeof raw[key] !== 'string' || !raw[key].trim()) fail(key, `must be a non-empty string, got ${JSON.stringify(raw[key])}`);
    return raw[key].trim();
  };
  const list = (key, fallback) => {
    if (!given(key)) return fallback;
    if (!Array.isArray(raw[key]) || !raw[key].every((v) => typeof v === 'string' && v.trim())) {
      fail(key, `must be a list of non-empty strings, got ${JSON.stringify(raw[key])}`);
    }
    return raw[key].map((v) => v.trim());
  };

  const projectName = text('projectName', { required: true });
  const description = text('description', { required: true });
  const githubRepo = text('githubRepo', { required: true });
  const projectSlug = text('projectSlug', { fallback: slugFromName(projectName) });
  if (!projectSlug) fail('projectName', `has no letter or digit to make a slug from, so "projectSlug" must be written: got ${JSON.stringify(projectName)}`);
  const lettersOfSlug = projectSlug.replace(/[^a-z]/g, '');
  const trackerPrefix = text('trackerPrefix', { fallback: lettersOfSlug.length >= 2 ? lettersOfSlug.slice(0, 2).toUpperCase() : null });
  if (trackerPrefix == null) fail('trackerPrefix', `is missing, and the slug "${projectSlug}" has fewer than two letters to make one from`);
  const nodeVersion = text('nodeVersion');
  if (nodeVersion != null && !parseNodeNeed(nodeVersion)) {
    fail('nodeVersion', `must be a Node version as .nvmrc or engines.node writes it ("22", ">=22.12", ">=22 <23"), got ${JSON.stringify(nodeVersion)}`);
  }
  const extra = list('extraGovernancePaths', []);
  // A ClickUp id is digits, and "0" is ClickUp's "none" (lib/projectConfig.mjs).
  const clickupId = (key, value) => {
    if (!/^\d+$/.test(value) || /^0+$/.test(value)) fail(key, `must be a ClickUp id (digits, not all zeros), got ${JSON.stringify(value)}`);
    return value;
  };
  const clickupListId = text('clickupListId');
  if (clickupListId != null) clickupId('clickupListId', clickupListId);
  const clickupOperatorId = text('clickupOperatorId');
  if (clickupOperatorId != null) clickupId('clickupOperatorId', clickupOperatorId);
  const clickupMachineUserId = text('clickupMachineUserId');
  if (clickupMachineUserId != null) clickupId('clickupMachineUserId', clickupMachineUserId);
  const clickupExtraLists = list('clickupExtraLists', []);
  for (const id of clickupExtraLists) clickupId('clickupExtraLists', id);
  if (clickupListId == null && (clickupOperatorId != null || clickupMachineUserId != null || clickupExtraLists.length)) {
    fail('clickupListId', 'is missing, but the other ClickUp answers are given; write the Loop Queue list id, or take them out for a project not on ClickUp');
  }
  if (clickupListId != null && clickupOperatorId == null) {
    fail('clickupOperatorId', 'is missing; a project on ClickUp needs the operator\'s own ClickUp user id, so the import files his comments under him');
  }
  if (clickupListId != null && clickupMachineUserId == null) {
    fail('clickupMachineUserId', 'is missing; a project on ClickUp needs its old loop\'s ClickUp machine user id, so the import files the loop\'s comments under the loops');
  }
  if (clickupMachineUserId != null && clickupMachineUserId === clickupOperatorId) {
    fail('clickupMachineUserId', `is the same as "clickupOperatorId" (${clickupOperatorId}); the operator and the old loop are two different ClickUp users`);
  }
  if (clickupExtraLists.includes(clickupListId)) fail('clickupExtraLists', `names the Loop Queue list ${clickupListId} itself; it is saved anyway`);

  const answers = {
    projectName,
    githubRepo,
    projectSlug,
    trackerPrefix,
    dopplerProject: text('dopplerProject', { fallback: projectSlug }),
    dopplerConfig: text('dopplerConfig', { fallback: 'dev' }),
    launchdPrefix: text('launchdPrefix', { fallback: `com.${projectSlug}` }),
    checkoutDir: text('checkoutDir', { fallback: join(dirname(homeRoot), projectSlug) }),
    checkCommand: text('checkCommand', { fallback: 'npm run verify' }),
    nodeVersion,
    mergePhrases: list('mergePhrases', [...homeConfig.mergePhrases]),
    autoMergeLanes: list('autoMergeLanes', []),
    extraGovernancePaths: extra,
    hosting: text('hosting'),
    description,
  };

  // The fields a settings file shares are checked by the same rules every
  // loop's settings file is (lib/projectConfig.mjs), so an answer the
  // wizard would later write but no loop could load is refused now. The
  // ids are placeholders: the machine's is found at step 2.
  try {
    validateProjectConfig(settingsDraft(answers, homeConfig), { file });
  } catch (err) {
    if (err instanceof ProjectConfigError) throw new AnswersError(err.message);
    throw err;
  }
  if (answers.projectSlug === homeConfig.projectSlug) {
    fail('projectSlug', `is "${answers.projectSlug}", the tracker home's own slug; a new project needs its own`);
  }
  return Object.freeze({
    ...answers,
    clickupListId,
    clickupOperatorId,
    clickupMachineUserId,
    clickupExtraLists: Object.freeze(clickupExtraLists),
    mergePhrases: Object.freeze(answers.mergePhrases),
    autoMergeLanes: Object.freeze(answers.autoMergeLanes),
    extraGovernancePaths: Object.freeze(answers.extraGovernancePaths),
  });
}

/**
 * The settings file these answers would make, with the values the review
 * says are found rather than asked: the operator's and machine's ids are
 * "0" here (found at step 2), no ClickUp ("0"), the tracker home's
 * logDir, tracker addresses and operator name. For checking only; writing
 * a settings file is step 1's job.
 */
export function settingsDraft(answers, homeConfig) {
  const governancePaths = [...new Set([...homeConfig.governancePaths, ...answers.extraGovernancePaths])];
  return {
    workspaceId: '0',
    spaceId: '0',
    loopQueueListId: '0',
    operatorUserId: '0',
    machineUserId: '0',
    githubRepo: answers.githubRepo,
    dopplerProject: answers.dopplerProject,
    dopplerConfig: answers.dopplerConfig,
    launchdPrefix: answers.launchdPrefix,
    logDir: homeConfig.logDir,
    mergePhrases: [...answers.mergePhrases],
    governancePaths,
    autoMergeLanes: [...answers.autoMergeLanes],
    operatorName: homeConfig.operatorName,
    projectSlug: answers.projectSlug,
    legacyMachinePrefixes: [],
    projectScripts: {},
    trackerPrefix: answers.trackerPrefix,
    tracker: 'api',
    trackerUrl: homeConfig.trackerUrl,
    ...(homeConfig.trackerApiUrl && homeConfig.trackerApiUrl !== homeConfig.trackerUrl ? { trackerApiUrl: homeConfig.trackerApiUrl } : {}),
  };
}

/** Read, parse and check an answers file. Throws AnswersError naming the file. */
export function loadAnswers(path, { homeConfig, homeRoot }) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new AnswersError(`${path}: could not be read (${err.code || err.message})`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new AnswersError(`${path}: is not valid JSON (${err.message})`);
  }
  return resolveAnswers(raw, { homeConfig, homeRoot, file: path });
}

const VERSION = /^v?(\d+)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?$/;

/**
 * "22.12" -> { v: [22, 12, 0], given: 2 }; "22.x" -> { v: [22, 0, 0], given: 1 };
 * "v22.12.3" -> given 3. `given` counts the numbers actually written, which
 * is what a range operator needs: `<=22` means below 23.0.0, `<=22.12.3`
 * below 22.12.4. Anything else (a prerelease such as "23.0.0-rc.1") is null.
 */
function parseVersion(text) {
  const m = VERSION.exec(String(text).trim());
  if (!m) return null;
  const wild = (s) => s == null || s === 'x' || s === 'X' || s === '*';
  const given = wild(m[2]) ? 1 : wild(m[3]) ? 2 : 3;
  const n = (s) => (wild(s) ? 0 : Number(s));
  return { v: [Number(m[1]), n(m[2]), n(m[3])], given };
}

function compare(a, b) {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/** The first version past every one `p` names: 22 -> 23.0.0, 22.12 -> 22.13.0, 22.12.3 -> 22.12.4. */
function pastPartial({ v, given }) {
  if (given === 1) return [v[0] + 1, 0, 0];
  if (given === 2) return [v[0], v[1] + 1, 0];
  return [v[0], v[1], v[2] + 1];
}

/**
 * What a project says it needs of Node, as `.nvmrc` ("22", "v22.12.0") or
 * `engines.node` (">=22.12", ">=22 <23", "^22.12", "~22.12", "22.x") writes it.
 * Returns `{ text, min, below }`: the lowest version that satisfies it and
 * the first that no longer does (null for no upper end). The operators read
 * partial versions the way npm does: `>22` is 23.0.0 or later, `<=22` is
 * below 23.0.0, `~22.12` is below 22.13.0, `^22.12` below 23.0.0. A bare
 * version ("22", "22.12", "v22.12.0", "=22.12") is read more loosely than npm
 * would, as that version up to the next major, because an `.nvmrc` naming
 * the version a project was built on does not forbid a later patch or minor.
 * Anything else ("lts/*", "||" and hyphen ranges, prereleases) is null:
 * could not tell.
 */
export function parseNodeNeed(text) {
  // npm reads `>= 22.12` as `>=22.12`: join an operator to the version after it.
  const parts = String(text ?? '').trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1').split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  let min = [0, 0, 0];
  let below = null;
  const atLeast = (lo) => { if (compare(lo, min) > 0) min = lo; };
  const under = (hi) => { if (below == null || compare(hi, below) < 0) below = hi; };
  for (const part of parts) {
    const m = /^(>=|>|<=|<|\^|~|=)?(.+)$/.exec(part);
    const p = parseVersion(m[2]);
    if (!p) return null;
    const op = m[1] ?? '';
    const nextMajor = [p.v[0] + 1, 0, 0];
    if (op === '>=') atLeast(p.v);
    else if (op === '>') atLeast(pastPartial(p));
    else if (op === '<') under(p.v);
    else if (op === '<=') under(pastPartial(p));
    else if (op === '~') {
      atLeast(p.v);
      under(p.given === 1 ? nextMajor : [p.v[0], p.v[1] + 1, 0]);
    } else {
      atLeast(p.v);
      under(nextMajor);
    }
  }
  return { text: parts.join(' '), min, below };
}

/** Does Node `version` ("v22.23.3") meet `need` (parseNodeNeed)? */
export function nodeMeets(version, need) {
  const v = parseVersion(version)?.v;
  if (!v || !need) return null;
  return compare(v, need.min) >= 0 && (need.below == null || compare(v, need.below) < 0);
}
