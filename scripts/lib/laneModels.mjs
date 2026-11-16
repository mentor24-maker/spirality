/**
 * laneModels.mjs — the Claude models a loop lane may run on, in one place
 * (SP-224, SP-239).
 *
 * The tracker's Settings page offers these (tracker/pipelineControls.mjs
 * re-exports them and refuses any other value) and a lane's runner checks
 * the chosen one against them again before it passes it to `claude --model`
 * (scripts/lib/modelSetting.mjs). It sits beside the other lane constants
 * (loopSchedule.mjs) so the runner side needs nothing from the tracker.
 */

/** The lanes that run a Claude session, so have a model. The relay runs none. */
export const MODEL_LANES = Object.freeze(['loop-intake', 'loop-build', 'loop-review']);

/** "Claude's default": the runner passes no model, as it always did. */
export const DEFAULT_MODEL = 'default';

/** The models a lane may be set to, the one place they are listed. */
export const MODELS = Object.freeze([
  Object.freeze({ id: 'claude-opus-5-5', label: 'Opus 5.5' }),
  Object.freeze({ id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }),
  Object.freeze({ id: 'claude-haiku-5-5', label: 'Haiku 5.5' }),
  Object.freeze({ id: 'claude-fable-5-2', label: 'Fable 5.2' }),
]);
