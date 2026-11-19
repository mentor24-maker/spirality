#!/usr/bin/env node
/**
 * laneSettings.mjs — a project's own lane settings, for scripts/loop_runner.sh.
 *
 *   node scripts/lib/laneSettings.mjs pause-command   → the program, then each argument
 *   node scripts/lib/laneSettings.mjs env             → NAME=value, one per variable
 *   node scripts/lib/laneSettings.mjs heartbeat-command → the program, then each argument
 *
 * Each item is ended by a NUL byte, never a newline, so the runner rebuilds
 * the command exactly as the manifest wrote it with no shell re-reading it.
 * A field not set: nothing printed, exit 0, and the runner does nothing new.
 *
 * The values come from the manifest's `lanePauseCommand`, `laneEnv` and
 * `laneHeartbeatCommand` (SP-397) (docs/PROJECT_MANIFEST.md), read by lib/projectConfig.mjs from the project
 * SPIRALITY_PROJECT names, or the one found from the current folder up, the
 * way scripts/project_config.mjs reads them. A config that cannot be used
 * exits 1, naming why on stderr: the runner then treats the lane as paused
 * (for the heartbeat command, it logs one line and skips that beat).
 */

import { loadProjectConfig, namedProjectFolder, ProjectConfigError } from '../../lib/projectConfig.mjs';

const what = process.argv[2];
const WHATS = ['pause-command', 'env', 'heartbeat-command'];
if (!WHATS.includes(what)) {
  console.error(`usage: node scripts/lib/laneSettings.mjs ${WHATS.join('|')}`);
  process.exit(2);
}

let config;
try {
  config = loadProjectConfig({ project: namedProjectFolder() });
} catch (err) {
  if (!(err instanceof ProjectConfigError)) throw err;
  console.error(`laneSettings: the project config is not usable — ${err.message}`);
  process.exit(1);
}

const items = what === 'pause-command' ? (config.lanePauseCommand ?? [])
  : what === 'heartbeat-command' ? (config.laneHeartbeatCommand ?? [])
    : Object.entries(config.laneEnv ?? {}).map(([name, value]) => `${name}=${value}`);
process.stdout.write(items.map((i) => `${i}\0`).join(''));
