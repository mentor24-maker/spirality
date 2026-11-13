/**
 * projectConfig.mjs — the one place a project's ids, names, paths and phrases
 * come from. Every substrate module reads this object instead of a literal,
 * so the same code serves StarCaster, WaveCenter and Spirality itself
 * (CLAUDE.md, engineering rule 2: a literal list id in a module is a bug).
 *
 * The values live in `spirality.project.json` at the consuming repository's
 * root. `loadProjectConfig()` finds it by walking up from the current folder,
 * applies the environment overrides StarCaster already uses, and checks every
 * key. A missing key, an id that is not a number, or a key nobody knows about
 * stops the caller with a message that names the key and the file — a typo
 * never silently becomes "use some other project's queue".
 *
 * THE FIELDS are written down once, in docs/PROJECT_MANIFEST.md: what each
 * is for, its kind, whether it is required, its default and an example, and
 * the manifest's version (`MANIFEST_VERSION`). `SCHEMA` below is the same
 * list in code; projectConfig.test.mjs fails when the two differ. A field
 * added, removed or given a new meaning raises the version, in both places.
 *
 * Ids may be written as numbers or as strings of digits; they come back as
 * strings, so `Number(config.operatorUserId)` is the caller's choice.
 *
 * THE OLD NAMES (SP-130). Until November 2026 two keys were spelled
 * `productSlug` and `productScripts` (and the setup's answers file had a
 * `productName`). A file that still uses them loads exactly as before: the
 * reader moves each old name to its new one (`OLD_NAMES`) before checking,
 * so every caller reads `projectSlug` / `projectScripts` only. A file that
 * gives one field under both names is accepted when the two values are the
 * same and refused, naming both, when they differ, so the reader never
 * silently picks one. Removing the old names is a later ticket, once every
 * project's own settings file has moved over.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const CONFIG_FILE = 'spirality.project.json';

/**
 * The manifest format this Spirality reads (docs/PROJECT_MANIFEST.md). A
 * manifest must say it, as `"manifestVersion": 2`; any other number is
 * refused before any lane runs, naming what it found and what it expects.
 */
export const MANIFEST_VERSION = 2;

/** Where a project's owner reads the format. */
export const MANIFEST_DOC = 'docs/PROJECT_MANIFEST.md';

/** Every key, its kind, and the environment variable that overrides it (if any). */
export const SCHEMA = Object.freeze({
  manifestVersion: { kind: 'version' },
  workspaceId:     { kind: 'id', env: 'CLICKUP_WORKSPACE_ID' },
  spaceId:         { kind: 'id', env: 'CLICKUP_SPACE_ID' },
  loopQueueListId: { kind: 'id', env: 'CLICKUP_LOOP_QUEUE_LIST' },
  operatorUserId:  { kind: 'id', env: 'CLICKUP_OPERATOR_ID' },
  machineUserId:   { kind: 'id', env: 'CLICKUP_MACHINE_ID' },
  githubRepo:      { kind: 'repo' },
  dopplerProject:  { kind: 'string' },
  dopplerConfig:   { kind: 'string' },
  launchdPrefix:   { kind: 'string' },
  logDir:          { kind: 'string' },
  mergePhrases:    { kind: 'phrases', nonEmpty: true },
  governancePaths: { kind: 'strings' },
  autoMergeLanes:  { kind: 'strings' },
  operatorName:    { kind: 'string' },
  projectSlug:     { kind: 'slug' },
  legacyMachinePrefixes: { kind: 'strings' },
  projectScripts:  { kind: 'pathMap' },
  tracker:         { kind: 'oneOf', values: ['clickup', 'api'], optional: true, default: 'clickup' },
  trackerPrefix:   { kind: 'prefix', optional: true, default: null },
  trackerPort:     { kind: 'port', optional: true, default: null },
  trackerHost:     { kind: 'string', optional: true, default: '127.0.0.1' },
  trackerDataDir:  { kind: 'string', optional: true, default: null },
  trackerUrl:      { kind: 'url', env: 'TRACKER_URL', optional: true, default: null },
  trackerApiUrl:   { kind: 'url', env: 'TRACKER_API_URL', optional: true, default: null },
  trackerPublicUrl: { kind: 'funnelUrl', optional: true, default: null, nullable: true },
  trackerPageUrl:  { kind: 'url', httpsOnly: true, optional: true, default: null, nullable: true },
  tailscaleLabel:  { kind: 'string', optional: true, default: null, nullable: true },
  tailscaleSocket: { kind: 'string', optional: true, default: null, nullable: true },
  busProject:      { kind: 'slug', optional: true, default: null, nullable: true },
  projectLanes:    { kind: 'lanes', optional: true, default: Object.freeze([]) },
  preMergeCommand: { kind: 'command', optional: true, default: null, nullable: true },
  applicationChecks: { kind: 'appChecks', optional: true, default: Object.freeze([]) },
});

/**
 * One entry of `applicationChecks` (SP-264): each field, and whether it may
 * be left out. The relay ticks every 10 minutes, so a check cannot run more
 * often than that; a check's time limit is at most 5 minutes, so one stuck
 * check cannot hold up the pass.
 */
export const APPLICATION_CHECK_FIELDS = Object.freeze({
  name: { required: true },
  command: { required: true },
  everyMinutes: { required: true },
  alarm: { required: false, default: true },
  timeoutSeconds: { required: false, default: 60 },
});
export const APPLICATION_CHECK_MIN_MINUTES = 10;
export const APPLICATION_CHECK_MAX_TIMEOUT = 300;

/**
 * Lane names a project's `projectLanes` may never use, because the secret
 * each would make (TRACKER_TOKEN_<LANE>) is already spoken for: the built-in
 * tracker seats (scripts/lib/expectedSecrets.mjs TRACKER_SEATS, kept in step
 * by its test) and TRACKER_TOKEN_NAME, the variable the runner sets to say
 * which secret to read. Refused when the config loads, so one bad entry can
 * never reach the door and lock every lane out.
 */
export const RESERVED_LANE_NAMES = Object.freeze(['operator', 'loop-build', 'loop-review', 'loop-intake', 'relay', 'hand-run', 'name']);

/** The ports Tailscale Funnel can publish on. */
export const FUNNEL_PORTS = Object.freeze([443, 8443, 10000]);

export class ProjectConfigError extends Error {
  constructor(message) { super(message); this.name = 'ProjectConfigError'; }
}

/** Each field's old name and the name it has now (SP-130). */
export const OLD_NAMES = Object.freeze({
  productSlug: 'projectSlug',
  productName: 'projectName',
  productScripts: 'projectScripts',
});

const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * A copy of `raw` with every old field name (`OLD_NAMES`) moved to its new
 * one. The same value under both names is fine; two different values are
 * refused with a message naming both names, never one picked silently.
 * Used for the settings file and the setup's answers file alike.
 */
export function withProjectNames(raw, { file = CONFIG_FILE } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const out = { ...raw };
  for (const [oldName, newName] of Object.entries(OLD_NAMES)) {
    if (!Object.hasOwn(out, oldName)) continue;
    if (Object.hasOwn(out, newName) && !sameValue(out[newName], out[oldName])) {
      throw new ProjectConfigError(`${file}: "${newName}" is ${JSON.stringify(out[newName])} but its old name "${oldName}" is ${JSON.stringify(out[oldName])}; keep "${newName}" only`);
    }
    if (!Object.hasOwn(out, newName)) out[newName] = out[oldName];
    delete out[oldName];
  }
  return out;
}

/** Walk up from `startDir` to the nearest folder holding spirality.project.json. */
export function findConfigFile(startDir = process.cwd()) {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, CONFIG_FILE);
    if (existsSync(candidate)) return candidate;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function checkValue(key, value, spec, where) {
  const fail = (why) => { throw new ProjectConfigError(`${where}: "${key}" ${why}`); };
  switch (spec.kind) {
    case 'id':
      if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
      if (typeof value === 'string' && /^[0-9]+$/.test(value)) return value;
      return fail(`must be a numeric ClickUp id (digits only), got ${JSON.stringify(value)}`);
    // The manifest's format version: a whole number, and exactly the one
    // this Spirality reads. "1" as a string is refused too, so a manifest
    // written by hand says the number the document says.
    case 'version':
      if (value === MANIFEST_VERSION) return value;
      return fail(`is ${JSON.stringify(value)}, but this Spirality reads manifest version ${MANIFEST_VERSION} (the format is in ${MANIFEST_DOC})`);
    case 'port':
      if (typeof value === 'string' && /^[0-9]+$/.test(value)) value = Number(value);
      if (Number.isInteger(value) && value >= 1 && value <= 65535) return value;
      return fail(`must be a port number from 1 to 65535, got ${JSON.stringify(value)}`);
    case 'repo':
      if (typeof value === 'string' && /^[\w.-]+\/[\w.-]+$/.test(value)) return value;
      return fail(`must be a GitHub repository written owner/name, got ${JSON.stringify(value)}`);
    case 'string':
      if (typeof value === 'string' && value.trim()) return value;
      return fail(`must be a non-empty string, got ${JSON.stringify(value)}`);
    case 'slug':
      if (typeof value === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(value)) return value;
      return fail(`must be a short lower-case name (letters, digits and dashes), got ${JSON.stringify(value)}`);
    case 'pathMap':
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return fail(`must be an object of name -> path, got ${JSON.stringify(value)}`);
      }
      for (const [k, v] of Object.entries(value)) {
        if (typeof v !== 'string' || !v.trim()) {
          return fail(`entry "${k}" must be a non-empty path, got ${JSON.stringify(v)}`);
        }
      }
      return Object.freeze({ ...value });
    case 'prefix':
      if (typeof value === 'string' && /^[A-Z][A-Z0-9]*$/.test(value)) return value;
      return fail(`must be capital letters and digits, beginning with a letter, got ${JSON.stringify(value)}`);
    case 'url': {
      let u = null;
      try { u = typeof value === 'string' ? new URL(value) : null; } catch { u = null; }
      const schemes = spec.httpsOnly ? ['https:'] : ['http:', 'https:'];
      if (u && schemes.includes(u.protocol) && !u.username && !u.password && /^\/?$/.test(u.pathname) && !u.search && !u.hash) {
        // The parsed origin, never the raw string: "http://host:7420/?" and
        // " http://host:7420 " parse clean but would be stored as written.
        return u.origin;
      }
      return fail(`must be ${spec.httpsOnly ? 'an https' : 'an http or https'} address with no path, query or sign-in in it, got ${JSON.stringify(value)}`);
    }
    case 'funnelUrl': {
      let u = null;
      try { u = typeof value === 'string' ? new URL(value) : null; } catch { u = null; }
      const port = u && (u.port === '' ? 443 : Number(u.port));
      if (u && u.protocol === 'https:' && !u.username && !u.password && /^\/?$/.test(u.pathname) && !u.search && !u.hash && FUNNEL_PORTS.includes(port)) {
        return u.origin;
      }
      return fail(`must be an https address with no path, on a port Tailscale Funnel publishes (${FUNNEL_PORTS.join(', ')}), got ${JSON.stringify(value)}`);
    }
    case 'oneOf':
      if (typeof value === 'string' && spec.values.includes(value)) return value;
      return fail(`must be one of ${spec.values.map((v) => JSON.stringify(v)).join(', ')}, got ${JSON.stringify(value)}`);
    case 'strings':
      if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && v.trim())) {
        return fail(`must be a list of non-empty strings, got ${JSON.stringify(value)}`);
      }
      if (spec.nonEmpty && value.length === 0) return fail('must list at least one entry');
      return Object.freeze([...value]);
    // Lane names become secret names (TRACKER_TOKEN_<LANE>), so each is
    // lower-case words joined by single dashes: two different names can
    // never make the same secret, and none holds a character a shell or
    // Doppler would trip on. A name listed twice is refused, not merged.
    case 'lanes': {
      if (!Array.isArray(value)) return fail(`must be a list of lane names, got ${JSON.stringify(value)}`);
      const bad = value.find((v) => typeof v !== 'string' || !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(v));
      if (bad !== undefined) return fail(`entry ${JSON.stringify(bad)} is not a lane name (lower-case letters and digits, words joined by single dashes, e.g. "loop-handoff")`);
      const twice = value.find((v, i) => value.indexOf(v) !== i);
      if (twice !== undefined) return fail(`lists ${JSON.stringify(twice)} twice`);
      const taken = value.find((v) => RESERVED_LANE_NAMES.includes(v));
      if (taken !== undefined) {
        return fail(`entry ${JSON.stringify(taken)} is taken: its secret, TRACKER_TOKEN_${taken.toUpperCase().replaceAll('-', '_')}, is ${taken === 'name' ? 'the variable every runner sets to say which secret to read' : 'a built-in tracker seat\'s'}. A project's own lane needs a name of its own`);
      }
      return Object.freeze([...value]);
    }
    // A list of comment phrases, matched as a WHOLE comment after the comment
    // is normalized (mergeOnComment's `normalizeCommand`: lower-cased, spaces
    // collapsed, emphasis and trailing sentence punctuation dropped). The
    // matcher normalizes these entries too, so casing and punctuation here are
    // harmless. What is NOT harmless is a phrase with no letter or digit in it
    // at all: `"."` normalizes away to the empty string, which would equal
    // every empty comment and merge on silence. That one is refused, naming
    // the entry (review of 86bcgmnpy, round 3).
    case 'phrases': {
      if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && v.trim())) {
        return fail(`must be a list of non-empty strings, got ${JSON.stringify(value)}`);
      }
      if (spec.nonEmpty && value.length === 0) return fail('must list at least one entry');
      const empty = value.find((v) => !/[a-z0-9]/i.test(v));
      if (empty !== undefined) {
        return fail(`entry ${JSON.stringify(empty)} has no letter or digit, so it can never be a phrase anyone types`);
      }
      return Object.freeze([...value]);
    }
    // A command run without a shell: the program, then each argument, as
    // separate strings, so nothing in it is ever re-read by a shell.
    case 'command':
      if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === 'string' && v.trim())) {
        return fail(`must be a command written as a list of non-empty strings, the program first (e.g. ["node", "scripts/apply_migrations.mjs"]), got ${JSON.stringify(value)}`);
      }
      return Object.freeze([...value]);
    // A project's application checks (SP-264, docs/PROJECT_MANIFEST.md):
    // each `{ name, command, everyMinutes, alarm?, timeoutSeconds? }`. A bad
    // entry is refused naming the entry and the field, never skipped, so a
    // check that was meant to watch something is never silently off.
    case 'appChecks': {
      if (!Array.isArray(value)) return fail(`must be a list of checks, each { "name", "command", "everyMinutes" }, got ${JSON.stringify(value)}`);
      const seen = new Set();
      const out = value.map((entry, i) => {
        const label = `entry ${i + 1}${entry && typeof entry.name === 'string' && entry.name ? ` ("${entry.name}")` : ''}`;
        const bad = (field, why) => fail(`${label}: "${field}" ${why}`);
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return fail(`${label} must be an object { "name", "command", "everyMinutes" }, got ${JSON.stringify(entry)}`);
        for (const field of Object.keys(entry)) {
          if (!Object.hasOwn(APPLICATION_CHECK_FIELDS, field)) return fail(`${label}: unknown field "${field}" (the fields are: ${Object.keys(APPLICATION_CHECK_FIELDS).join(', ')})`);
        }
        for (const [field, f] of Object.entries(APPLICATION_CHECK_FIELDS)) {
          if (f.required && !Object.hasOwn(entry, field)) return fail(`${label}: missing field "${field}"`);
        }
        if (typeof entry.name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(entry.name)) return bad('name', `must be a short lower-case name (letters, digits and dashes), got ${JSON.stringify(entry.name)}`);
        if (seen.has(entry.name)) return bad('name', 'is listed twice; each check needs a name of its own');
        seen.add(entry.name);
        if (typeof entry.command !== 'string' || !entry.command.trim()) return bad('command', `must be the shell command to run, as one non-empty string, got ${JSON.stringify(entry.command)}`);
        if (!Number.isInteger(entry.everyMinutes) || entry.everyMinutes < APPLICATION_CHECK_MIN_MINUTES) {
          return bad('everyMinutes', `must be a whole number of minutes, ${APPLICATION_CHECK_MIN_MINUTES} or more (the relay ticks every ${APPLICATION_CHECK_MIN_MINUTES} minutes), got ${JSON.stringify(entry.everyMinutes)}`);
        }
        if (Object.hasOwn(entry, 'alarm') && typeof entry.alarm !== 'boolean') return bad('alarm', `must be true or false, got ${JSON.stringify(entry.alarm)}`);
        if (Object.hasOwn(entry, 'timeoutSeconds') && (!Number.isInteger(entry.timeoutSeconds) || entry.timeoutSeconds < 1 || entry.timeoutSeconds > APPLICATION_CHECK_MAX_TIMEOUT)) {
          return bad('timeoutSeconds', `must be a whole number of seconds from 1 to ${APPLICATION_CHECK_MAX_TIMEOUT}, got ${JSON.stringify(entry.timeoutSeconds)}`);
        }
        return Object.freeze({
          name: entry.name,
          command: entry.command,
          everyMinutes: entry.everyMinutes,
          alarm: Object.hasOwn(entry, 'alarm') ? entry.alarm : APPLICATION_CHECK_FIELDS.alarm.default,
          timeoutSeconds: Object.hasOwn(entry, 'timeoutSeconds') ? entry.timeoutSeconds : APPLICATION_CHECK_FIELDS.timeoutSeconds.default,
        });
      });
      return Object.freeze(out);
    }
    default:
      throw new Error(`projectConfig SCHEMA has an unknown kind for "${key}"`);
  }
}

/**
 * Check a parsed config object against SCHEMA and return a frozen copy with
 * environment overrides applied. `file` is only used to name the file in
 * error messages.
 */
export function validateProjectConfig(raw, { file = CONFIG_FILE, env = {} } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ProjectConfigError(`${file}: must hold one JSON object of settings`);
  }
  raw = withProjectNames(raw, { file });
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(SCHEMA, key)) {
      throw new ProjectConfigError(`${file}: unknown key "${key}" (the known keys are: ${Object.keys(SCHEMA).join(', ')})`);
    }
  }
  const out = {};
  for (const [key, spec] of Object.entries(SCHEMA)) {
    const override = spec.env ? env[spec.env] : undefined;
    if (override !== undefined && override !== '') {
      out[key] = checkValue(key, override, spec, `${spec.env} (overriding ${file})`);
      continue;
    }
    if (!Object.hasOwn(raw, key) && spec.optional) { out[key] = spec.default; continue; }
    // A `nullable` key written as null is the same as left out, so a checked
    // config (which holds it as null) checks again.
    if (spec.nullable && raw[key] === null) { out[key] = null; continue; }
    if (!Object.hasOwn(raw, key)) {
      const hint = spec.kind === 'version' ? ` (add "${key}": ${MANIFEST_VERSION}, the manifest version this Spirality reads; the format is in ${MANIFEST_DOC})` : '';
      throw new ProjectConfigError(`${file}: missing required key "${key}"${hint}`);
    }
    out[key] = checkValue(key, raw[key], spec, file);
  }
  if (out.tracker === 'api' && !out.trackerUrl) {
    throw new ProjectConfigError(`${file}: "trackerUrl" is required when "tracker" is "api" (the tracker's address, e.g. "http://mini.local:7420")`);
  }
  if (out.applicationChecks.length && !out.busProject) {
    throw new ProjectConfigError(`${file}: "applicationChecks" lists ${out.applicationChecks.length} check(s) but "busProject" names no bus, so what they find would have nowhere to post (docs/TRACKER_MVP.md, "The bus")`);
  }
  if (out.trackerApiUrl == null) out.trackerApiUrl = out.trackerUrl;
  return Object.freeze(out);
}

/**
 * Find, read and check the project config. Throws ProjectConfigError with a
 * message naming the file (and the key, when one is at fault).
 */
export function loadProjectConfig({ file, cwd = process.cwd(), env = process.env } = {}) {
  const path = file ? resolve(cwd, file) : findConfigFile(cwd);
  if (!path) throw new ProjectConfigError(`no ${CONFIG_FILE} found in ${resolve(cwd)} or any folder above it`);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new ProjectConfigError(`${path}: could not be read (${err.code || err.message})`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ProjectConfigError(`${path}: is not valid JSON (${err.message})`);
  }
  return validateProjectConfig(raw, { file: path, env });
}
