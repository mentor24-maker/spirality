/**
 * The pipeline's controls (SP-224): the settings Dane changes on the
 * Settings page to experiment with the loop, one set per project, in the
 * tracker's own data (tracker/store.mjs keeps them; never a committed file).
 *
 * This file is the one list of them: each control's name, what kind of value
 * it takes, the range it must sit in and its default. The defaults are
 * today's behaviour, read from where that behaviour lives now, so a control
 * nobody has changed changes nothing:
 *
 *   wake.<lane>    seconds between one pass of the lane and the next,
 *                  60 to 86,400; default scripts/lib/loopSchedule.mjs
 *   paused         the whole pipeline, on or off; default off
 *   paused.<lane>  one lane, on or off; default off
 *   wip-cap        the most tickets in flight at once, 1 to 50;
 *                  default lib/wipCap.js (DEFAULT_WIP_CAP)
 *   model.<lane>   the model a lane's passes run on: `default` (Claude's
 *                  default, what the runner does today) or one of MODELS
 *
 * The lanes on the Mini read the wake times (SP-236: a lane before every
 * sleep, the relay after every ticked pass). A group they do not use yet
 * names the ticket that wires it in (`wiredBy`); the Settings page says so
 * under it, and that ticket sets its own to null.
 */
import { intervalOf, WAKE_RANGE } from '../scripts/lib/loopSchedule.mjs';
import wipCap from '../lib/wipCap.js';

/** The lanes that wake on a timer and can be paused. */
export const LANES = Object.freeze(['loop-intake', 'loop-build', 'loop-review', 'relay']);

/** The lanes that run a Claude session, so have a model. The relay runs none. */
export const MODEL_LANES = Object.freeze(['loop-intake', 'loop-build', 'loop-review']);

/** "Claude's default": the runner passes no model, as it does today. */
export const DEFAULT_MODEL = 'default';

/** The models a lane may be set to, the one place they are listed. */
export const MODELS = Object.freeze([
  Object.freeze({ id: 'claude-opus-5-5', label: 'Opus 5.5' }),
  Object.freeze({ id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }),
  Object.freeze({ id: 'claude-haiku-5-5', label: 'Haiku 5.5' }),
  Object.freeze({ id: 'claude-fable-5-2', label: 'Fable 5.2' }),
]);

/** The shortest and longest wake time, in seconds (kept with the defaults), and the cap's range. */
export { WAKE_RANGE };
export const CAP_RANGE = Object.freeze({ min: 1, max: 50 });

/** The groups the page shows, in order, each with the ticket that makes the lanes use it (null once they do). */
export const GROUPS = Object.freeze([
  Object.freeze({ key: 'wake', title: 'Wake Times', wiredBy: null }),
  Object.freeze({ key: 'pause', title: 'Pause and Resume', wiredBy: 'SP-237' }),
  Object.freeze({ key: 'cap', title: 'Work-in-Progress Cap', wiredBy: 'SP-238' }),
  Object.freeze({ key: 'model', title: 'Model per Lane', wiredBy: 'SP-239' }),
]);

const control = (fields) => Object.freeze(fields);

/** Every control, in the order the page and `settings` list them. */
export const CONTROLS = Object.freeze([
  ...LANES.map((lane) => control({
    key: `wake.${lane}`, group: 'wake', kind: 'seconds', label: `${lane} wake time`,
    default: String(intervalOf(lane)), ...WAKE_RANGE,
  })),
  control({ key: 'paused', group: 'pause', kind: 'switch', label: 'whole pipeline paused', default: 'off' }),
  ...LANES.map((lane) => control({ key: `paused.${lane}`, group: 'pause', kind: 'switch', label: `${lane} paused`, default: 'off' })),
  control({ key: 'wip-cap', group: 'cap', kind: 'count', label: 'work-in-progress cap', default: String(wipCap.DEFAULT_WIP_CAP), ...CAP_RANGE }),
  ...MODEL_LANES.map((lane) => control({
    key: `model.${lane}`, group: 'model', kind: 'model', label: `${lane} model`, default: DEFAULT_MODEL,
  })),
]);

const BY_KEY = new Map(CONTROLS.map((c) => [c.key, c]));

/** The control named `key`, or null. */
export function controlOf(key) {
  return BY_KEY.get(String(key ?? '')) ?? null;
}

/** A refusal with a plain message, which the store and server pass on as it is. */
export class ControlError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** A whole number written as one, or null. */
function wholeNumber(value) {
  const text = typeof value === 'number' ? String(value) : String(value ?? '').trim();
  return /^-?[0-9]+$/.test(text) ? Number(text) : null;
}

/**
 * `value` as `key` stores it (always text), or a ControlError saying what is
 * wrong in words Dane can act on. Seconds and the cap are whole numbers in
 * range; a switch is `on` or `off` (true and false are read as those); a
 * model is `default` or one of MODELS.
 */
export function checkControl(key, value) {
  const c = controlOf(key);
  if (!c) throw new ControlError('unknown-setting', `there is no pipeline setting "${key}"; the settings are ${CONTROLS.map((x) => x.key).join(', ')}.`);
  if (c.kind === 'seconds' || c.kind === 'count') {
    const n = wholeNumber(value);
    const unit = c.kind === 'seconds' ? ' seconds' : '';
    if (n == null || n < c.min || n > c.max) {
      throw new ControlError('bad-setting', `the ${c.label} must be a whole number from ${c.min.toLocaleString('en-US')} to ${c.max.toLocaleString('en-US')}${unit}; "${value}" is not.`);
    }
    return String(n);
  }
  if (c.kind === 'switch') {
    if (value === true || value === 'on') return 'on';
    if (value === false || value === 'off') return 'off';
    throw new ControlError('bad-setting', `"${c.label}" is on or off; "${value}" is neither.`);
  }
  if (value === DEFAULT_MODEL || MODELS.some((m) => m.id === value)) return value;
  throw new ControlError('bad-setting', `the ${c.label} must be "${DEFAULT_MODEL}" (Claude's default) or one of ${MODELS.map((m) => m.id).join(', ')}; "${value}" is not on the list.`);
}

/**
 * Every control with its value: the stored one, or its default when none is
 * stored. `stored` is `{ key: value }`. Answers `[{ ...control, value,
 * isDefault }]` in CONTROLS order.
 */
export function withValues(stored = {}) {
  return CONTROLS.map((c) => {
    const value = Object.hasOwn(stored, c.key) ? stored[c.key] : c.default;
    return { ...c, value, isDefault: value === c.default };
  });
}

/** The `settings` command's lines: `name=value`, one per control, defaults included. */
export function settingLines(controls) {
  return controls.map((c) => `${c.key}=${c.value}`);
}
