/**
 * The ONE list of secret names Spirality expects in Doppler, and the configs
 * each one must be in. A ticket that adds a key adds a line here, so
 * `npm run doctor` starts reporting it the moment the code depends on it.
 * Names only: no value ever appears in this repository (it is public).
 *
 * The substrate holds no database and no deploy. The ClickUp token is a
 * reference to StarCaster's (one token to rotate for every project). The
 * tracker tokens are one sign-in per actor (docs/TRACKER_MVP.md, "Running
 * it"), made by `tracker/admin.mjs create-actor` and piped straight into
 * Doppler. The tracker's hand-over email needs the Resend key and the
 * address it goes to (tracker/notify.mjs).
 */
export const DOPPLER_PROJECT = 'spirality';
export const CONFIGS = ['dev'];

/**
 * Who signs in to the tracker, and the Doppler secret holding each one's
 * token. A loop's actor is named after its skill (the relay after itself);
 * the operator's actor takes the project config's `operatorName`. The
 * `handRun` seat is the one a session started by hand signs in as, when no
 * runner names a seat (scripts/tracker/apiTracker.mjs, trackerTokenEnv).
 * `tracker/signins.mjs create` makes exactly these.
 */
export const TRACKER_SEATS = [
  { secret: 'TRACKER_TOKEN_OPERATOR', kind: 'human', name: null, what: "the operator's own tracker sign-in, for the page" },
  { secret: 'TRACKER_TOKEN_LOOP_BUILD', kind: 'machine', name: 'loop-build', what: "the build loop's tracker sign-in" },
  { secret: 'TRACKER_TOKEN_LOOP_REVIEW', kind: 'machine', name: 'loop-review', what: "the review loop's tracker sign-in" },
  { secret: 'TRACKER_TOKEN_RELAY', kind: 'machine', name: 'relay', what: "the relay's tracker sign-in" },
  { secret: 'TRACKER_TOKEN_HAND_RUN', kind: 'machine', name: 'hand-run', handRun: true, what: "a hand-run session's tracker sign-in" },
];

export const EXPECTED_SECRETS = [
  { name: 'CLICKUP_API_TOKEN', configs: ['dev'], what: 'the ClickUp token, for scripts only' },
  ...TRACKER_SEATS.map(({ secret, what }) => ({ name: secret, configs: ['dev'], what })),
  { name: 'RESEND_API_KEY', configs: ['dev'], what: 'the Resend key the tracker sends the hand-over email with' },
  { name: 'TRACKER_NOTIFY_TO', configs: ['dev'], what: "the operator's address for the hand-over email" },
];

/**
 * Compare what Doppler holds against the list. `present` maps a config name
 * to the set of names it holds, or to null when the config could not be read.
 * Returns one row per expected name and whether everything required is there.
 */
export function doctorReport(present, expected = EXPECTED_SECRETS, configs = CONFIGS) {
  const rows = expected.map(({ name, configs: needed }) => ({
    name,
    cells: Object.fromEntries(configs.map((config) => {
      const names = present[config];
      if (!needed.includes(config)) return [config, 'not needed'];
      if (!names) return [config, 'unreadable'];
      return [config, names.has(name) ? 'present' : 'MISSING'];
    })),
  }));
  const ok = rows.every((row) => Object.values(row.cells).every((c) => c === 'present' || c === 'not needed'));
  return { rows, ok };
}

/** The report as a plain-text table, one line per name. */
export function formatReport({ rows }, configs = CONFIGS) {
  const width = Math.max(4, ...rows.map((r) => r.name.length));
  const col = 12;
  const lines = [['NAME'.padEnd(width), ...configs.map((c) => c.padEnd(col))].join('  ').trimEnd()];
  for (const row of rows) {
    lines.push([row.name.padEnd(width), ...configs.map((c) => row.cells[c].padEnd(col))].join('  ').trimEnd());
  }
  return lines.join('\n');
}
