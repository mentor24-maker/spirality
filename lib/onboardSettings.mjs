/**
 * onboardSettings.mjs — step 1 of setting up a project on Spirality: the
 * project's settings file (`spirality.project.json`), made from its answers
 * file instead of by hand (docs/onboarding/SETUP_REVIEW.md, part 3, "What
 * it does, in order", step 1). Pure: no file, no network. The command that
 * writes it is scripts/onboard/settings.mjs.
 *
 * The file holds every field the person entered (lib/onboardAnswers.mjs),
 * plus the ones that are found rather than asked:
 *
 *   operatorUserId   the operator's existing tracker actor, found by the
 *                    tracker home's operatorName
 *   machineUserId    the project's own build-loop sign-in
 *                    (`<slug> loop-build`). It does not exist until the
 *                    sign-ins step (step 2) makes it, and the settings
 *                    reader refuses a file without the key, so until then
 *                    it is MACHINE_PLACEHOLDER, and step 2 fills it in
 *                    (withMachineUser).
 *   logDir, trackerUrl, trackerApiUrl
 *                    the tracker home's
 *   tracker "api"; workspaceId, spaceId, loopQueueListId "0" (no ClickUp);
 *   legacyMachinePrefixes []; projectScripts {}; no trackerPort (only the
 *   tracker home runs the tracker service).
 *
 * The shape is settingsDraft's (lib/onboardAnswers.mjs), the one the
 * answers are already checked against, so the two can never drift. Nothing
 * project-specific is typed here (CLAUDE.md engineering rule 2): every value
 * is an answer or the tracker home's own.
 */

import { settingsDraft } from './onboardAnswers.mjs';
import { validateProjectConfig, ProjectConfigError } from './projectConfig.mjs';

/** What machineUserId holds until the project's build-loop sign-in exists. */
export const MACHINE_PLACEHOLDER = '0';

export class SettingsError extends Error {
  constructor(message) { super(message); this.name = 'SettingsError'; }
}

/** An actor id as the settings file writes it: digits, as a string. */
function idOf(value, what) {
  const s = String(value ?? '');
  if (!/^[0-9]+$/.test(s)) throw new SettingsError(`${what} must be a tracker actor id (digits), got ${JSON.stringify(value)}`);
  return s;
}

/**
 * The project's settings file, as a plain object in the order it is written.
 * `answers` is resolveAnswers' result, `homeConfig` the tracker home's
 * checked config. `operatorUserId` is required; `machineUserId` null means
 * "not made yet" (MACHINE_PLACEHOLDER). The result has passed the same check
 * every loop's settings file does; a failure throws SettingsError naming
 * the field.
 */
export function settingsFromAnswers(answers, homeConfig, { operatorUserId, machineUserId = null } = {}) {
  if (!homeConfig || homeConfig.trackerPort == null) {
    throw new SettingsError('the tracker home\'s settings file is needed (the one that sets "trackerPort")');
  }
  const settings = {
    ...settingsDraft(answers, homeConfig),
    operatorUserId: idOf(operatorUserId, 'operatorUserId'),
    machineUserId: machineUserId == null ? MACHINE_PLACEHOLDER : idOf(machineUserId, 'machineUserId'),
  };
  checkSettings(settings, `${answers.projectSlug}'s settings`);
  return settings;
}

/** The same settings with machineUserId set to the build-loop sign-in's id. */
export function withMachineUser(settings, machineUserId) {
  const next = { ...settings, machineUserId: idOf(machineUserId, 'machineUserId') };
  checkSettings(next, 'the settings with the machine id filled in');
  return next;
}

/** Is machineUserId still waiting for the sign-ins step? */
export function machineUserPending(settings) {
  return String(settings.machineUserId) === MACHINE_PLACEHOLDER;
}

function checkSettings(settings, file) {
  try {
    validateProjectConfig(settings, { file });
  } catch (err) {
    if (err instanceof ProjectConfigError) throw new SettingsError(err.message);
    throw err;
  }
}

/**
 * The one tracker actor named `name` among `actors` ({ id, name }), as an id
 * string; null when there is none. Two of the same name throw: the setup
 * cannot tell which one is meant.
 */
export function actorNamed(actors, name) {
  const found = (actors ?? []).filter((a) => a && a.name === name);
  if (found.length > 1) {
    throw new SettingsError(`the tracker has ${found.length} actors named "${name}" (${found.map((a) => a.id).join(', ')}); the setup cannot tell which is meant`);
  }
  return found.length ? idOf(found[0].id, `actor "${name}"`) : null;
}

/**
 * The fields where `written` (the file as read back through the settings
 * reader) differs from `meant` (what was to be written, checked the same
 * way). Empty: the write stuck.
 */
export function fieldsThatDiffer(meant, written) {
  const keys = [...new Set([...Object.keys(meant), ...Object.keys(written)])];
  return keys.filter((k) => JSON.stringify(meant[k]) !== JSON.stringify(written[k]));
}

/** The settings file's text: two-space JSON and a final newline, as Normie's is. */
export function settingsText(settings) {
  return `${JSON.stringify(settings, null, 2)}\n`;
}
