#!/usr/bin/env node
'use strict';

/**
 * Claude Code PreToolUse hook (Bash), supplied to a project's lane sessions
 * by Spirality's plugin folder (plugin/hooks/hooks.json, SP-272).
 *
 * The loop skills say `npm run clickup -- <command>`. In Spirality's own
 * checkout that is Spirality's door. A project's lane pass works in the
 * project's checkout, where `npm run clickup` is the project's old copy of
 * the door, or nothing at all. So when the runner says the pass works for
 * another project (SPIRALITY_PROJECT names a folder that is not this one),
 * this hook points every `npm run clickup` in the command at Spirality's
 * folder: `npm --prefix "<spirality>" run clickup`. The door then reads the
 * project's manifest because SPIRALITY_PROJECT is still set (SP-270).
 *
 * Anything else is left exactly as it was: no SPIRALITY_PROJECT, a
 * SPIRALITY_PROJECT that is Spirality itself, a command with no
 * `npm run clickup`, or input that cannot be read. The hook never blocks.
 */

const fs = require('fs');
const path = require('path');

const SPIRALITY = path.resolve(__dirname, '..', '..');

function realDir(dir) {
  try { return fs.realpathSync(dir); } catch { return path.resolve(dir); }
}

/** A shell-safe double-quoted path. */
function quoted(dir) {
  return '"' + String(dir).replace(/(["\\$`])/g, '\\$1') + '"';
}

/**
 * The command with every `npm run clickup` (and `npm run --silent clickup`,
 * `npm run -s clickup`) pointed at `spiralityDir`, or null when there is
 * nothing to change. A `npm --prefix ... run clickup` is already pointed
 * somewhere and is left alone.
 */
function pointDoorAtSpirality(command, spiralityDir) {
  if (typeof command !== 'string' || !command) return null;
  const re = /(^|[\s;&|(`])npm(\s+)run((?:\s+(?:--silent|-s))*)(\s+)clickup(?=\s|$|[;&|)`])/g;
  let changed = false;
  const out = command.replace(re, (_m, lead, sp1, flags, sp2) => {
    changed = true;
    return `${lead}npm${sp1}--prefix ${quoted(spiralityDir)} run${flags}${sp2}clickup`;
  });
  return changed ? out : null;
}

/** Whether the pass works for a project other than Spirality itself. */
function worksForAnotherProject(env, spiralityDir) {
  const project = env.SPIRALITY_PROJECT;
  if (!project) return false;
  return realDir(project) !== realDir(spiralityDir);
}

/** The hook's answer for one payload: the JSON to print, or null for none. */
function decide(payload, env, spiralityDir = SPIRALITY) {
  if (!payload || payload.tool_name !== 'Bash') return null;
  if (!worksForAnotherProject(env, spiralityDir)) return null;
  const input = payload.tool_input || {};
  const rewritten = pointDoorAtSpirality(input.command, spiralityDir);
  if (rewritten === null) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput: { ...input, command: rewritten },
    },
  };
}

function main(stdin) {
  let payload;
  try { payload = JSON.parse(stdin); } catch { process.exit(0); }
  const answer = decide(payload, process.env);
  if (answer) process.stdout.write(JSON.stringify(answer));
  process.exit(0);
}

if (require.main === module) {
  let stdin = '';
  process.stdin.on('data', (c) => { stdin += c; });
  process.stdin.on('end', () => main(stdin));
}

module.exports = { pointDoorAtSpirality, worksForAnotherProject, decide, SPIRALITY };
