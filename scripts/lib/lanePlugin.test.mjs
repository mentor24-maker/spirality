/**
 * Spirality's plugin folder (plugin/, SP-272): the loop skills and the safety
 * hooks a project's lane session is handed with `claude --plugin-dir`, so a
 * project needs no copy of them in its own .claude/ folder.
 *
 * Checked here without starting Claude: the folder's shape, that its skills
 * ARE .claude/skills (one copy, not two), that its hooks are the ones
 * .claude/settings.json runs for Spirality's own sessions, and that those
 * hooks, run from Spirality's folder against a project with no .claude/
 * folder, refuse an edit on main and point `npm run clickup` at Spirality's
 * door. scripts/dry_project_pass.sh is the same check through a real session.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import scratchGit from '../../lib/scratchGit.js';

const require = createRequire(import.meta.url);
const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const PLUGIN = join(REPO, 'plugin');
const door = require('../hooks/door_from_spirality.cjs');

const hooksOf = (file) => JSON.parse(readFileSync(file, 'utf8')).hooks.PreToolUse;
/** What a hook command runs once its root variable is filled in. */
const scriptOf = (command, root) => command.match(/^node "(.*)"$/)[1]
  .replace('${CLAUDE_PLUGIN_ROOT}', root).replace('$CLAUDE_PROJECT_DIR', root);

test('the plugin folder names itself, and its skills are .claude/skills through a link, not a second copy', () => {
  const manifest = JSON.parse(readFileSync(join(PLUGIN, '.claude-plugin/plugin.json'), 'utf8'));
  assert.match(manifest.name, /^[a-z0-9-]+$/, 'loop_runner.sh refuses any other plugin name');
  assert.ok(lstatSync(join(PLUGIN, 'skills')).isSymbolicLink(), 'plugin/skills is a copy, so the two would drift');
  assert.equal(realpathSync(join(PLUGIN, 'skills')), realpathSync(join(REPO, '.claude/skills')));
});

test('every lane the installer runs has its skill in the plugin folder', () => {
  const installer = readFileSync(join(REPO, 'scripts/install_loop_runner.sh'), 'utf8');
  const lanes = installer.match(/^SKILLS=\(([^)]*)\)$/m)[1].trim().split(/\s+/);
  for (const lane of lanes) assert.ok(existsSync(join(PLUGIN, 'skills', lane, 'SKILL.md')), `${lane} has no skill in plugin/skills`);
});

test('the plugin runs the same no-edits-on-main hook as .claude/settings.json, from Spirality\'s folder', () => {
  const own = hooksOf(join(REPO, '.claude/settings.json')).find((h) => h.matcher === 'Edit|Write|NotebookEdit');
  const plugin = hooksOf(join(PLUGIN, 'hooks/hooks.json')).find((h) => h.matcher === 'Edit|Write|NotebookEdit');
  assert.ok(own && plugin, 'one of the two has no Edit|Write|NotebookEdit hook');
  assert.equal(realpathSync(scriptOf(plugin.hooks[0].command, PLUGIN)), realpathSync(scriptOf(own.hooks[0].command, REPO)));
  // ${CLAUDE_PLUGIN_ROOT}, never $CLAUDE_PROJECT_DIR: that is the project's checkout.
  assert.doesNotMatch(plugin.hooks[0].command, /CLAUDE_PROJECT_DIR/);
});

test('the plugin points Bash at the door hook, and every hook script it names exists', () => {
  const all = hooksOf(join(PLUGIN, 'hooks/hooks.json'));
  const bash = all.find((h) => h.matcher === 'Bash');
  assert.ok(bash, 'no Bash hook in plugin/hooks/hooks.json');
  assert.equal(realpathSync(scriptOf(bash.hooks[0].command, PLUGIN)), realpathSync(join(REPO, 'scripts/hooks/door_from_spirality.cjs')));
  for (const h of all) for (const { command } of h.hooks) assert.ok(existsSync(scriptOf(command, PLUGIN)), command);
});

/** A project checkout on main with no .claude/ folder at all. */
function bareProject() {
  const dir = mkdtempSync(join(tmpdir(), 'bare-project-'));
  scratchGit.git(dir, 'init', '-q', '-b', 'main');
  scratchGit.git(dir, 'commit', '-q', '--allow-empty', '-m', 'scratch');
  assert.ok(!existsSync(join(dir, '.claude')));
  return dir;
}

function runHook(script, payload, env) {
  const clean = { ...process.env };
  delete clean.ALLOW_MAIN_EDITS;
  delete clean.SPIRALITY_PROJECT;
  return spawnSync('node', [script], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...clean, ...scratchGit.scratchGitEnv(), ...env } });
}

test('run from the plugin against a project with no .claude/ folder, the hook refuses an edit on main and allows one on a branch', () => {
  const project = bareProject();
  try {
    const plugin = hooksOf(join(PLUGIN, 'hooks/hooks.json')).find((h) => h.matcher === 'Edit|Write|NotebookEdit');
    const script = scriptOf(plugin.hooks[0].command, PLUGIN);
    const edit = { tool_name: 'Write', tool_input: { file_path: join(project, 'probe.txt'), content: 'hi' } };
    const onMain = runHook(script, edit, { CLAUDE_PROJECT_DIR: project, CLAUDE_PLUGIN_ROOT: PLUGIN });
    assert.equal(onMain.status, 2, onMain.stderr);
    assert.match(onMain.stderr, /BLOCKED: you are on the "main" branch/);
    scratchGit.git(project, 'checkout', '-q', '-b', 'topic');
    const onBranch = runHook(script, edit, { CLAUDE_PROJECT_DIR: project, CLAUDE_PLUGIN_ROOT: PLUGIN });
    assert.equal(onBranch.status, 0, onBranch.stderr);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('the door hook points every npm run clickup at Spirality\'s folder, and nothing else', () => {
  const at = '/Spirality Home';
  const cases = [
    ['npm run clickup -- get --task SP-1', 'npm --prefix "/Spirality Home" run clickup -- get --task SP-1'],
    ['npm run --silent clickup -- queue --claimable', 'npm --prefix "/Spirality Home" run --silent clickup -- queue --claimable'],
    ['cd /x && npm run -s clickup -- wip-check; echo $?', 'cd /x && npm --prefix "/Spirality Home" run -s clickup -- wip-check; echo $?'],
    ['echo "Why: x" | npm run clickup -- pr-opened --task SP-2 --body-file -', 'echo "Why: x" | npm --prefix "/Spirality Home" run clickup -- pr-opened --task SP-2 --body-file -'],
    ['npm run clickup -- a && npm run clickup -- b', 'npm --prefix "/Spirality Home" run clickup -- a && npm --prefix "/Spirality Home" run clickup -- b'],
  ];
  for (const [given, want] of cases) assert.equal(door.pointDoorAtSpirality(given, at), want, given);
  for (const untouched of ['npm run verify', 'npm run clickupish', 'npm --prefix /p run clickup -- get', 'git log', '', 'xnpm run clickup']) {
    assert.equal(door.pointDoorAtSpirality(untouched, at), null, untouched);
  }
  assert.equal(door.pointDoorAtSpirality('npm run clickup', 'a"b$c'), 'npm --prefix "a\\"b\\$c" run clickup');
});

test('the door hook changes a Bash command only on a pass for another project', () => {
  const project = bareProject();
  try {
    const payload = { tool_name: 'Bash', tool_input: { command: 'npm run clickup -- whoami', description: 'd' } };
    // Spirality's own sessions: no project named, or Spirality itself named.
    assert.equal(door.decide(payload, {}, REPO), null);
    assert.equal(door.decide(payload, { SPIRALITY_PROJECT: REPO }, REPO), null);
    // Not Bash, or no door call in it.
    assert.equal(door.decide({ ...payload, tool_name: 'Read' }, { SPIRALITY_PROJECT: project }, REPO), null);
    assert.equal(door.decide({ tool_name: 'Bash', tool_input: { command: 'npm run verify' } }, { SPIRALITY_PROJECT: project }, REPO), null);
    const answer = door.decide(payload, { SPIRALITY_PROJECT: project }, REPO);
    assert.equal(answer.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(answer.hookSpecificOutput.updatedInput.command, `npm --prefix "${REPO}" run clickup -- whoami`);
    assert.equal(answer.hookSpecificOutput.updatedInput.description, 'd', 'the rest of the input is kept');
    assert.equal(answer.hookSpecificOutput.permissionDecision, undefined, 'the hook never grants a permission');

    // The script itself, the way Claude Code runs it: JSON on stdout, exit 0.
    const script = join(REPO, 'scripts/hooks/door_from_spirality.cjs');
    const run = runHook(script, payload, { SPIRALITY_PROJECT: project });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).hookSpecificOutput.updatedInput.command, `npm --prefix "${realpathSync(REPO)}" run clickup -- whoami`);
    const own = runHook(script, payload, {});
    assert.equal(own.status, 0);
    assert.equal(own.stdout, '', 'Spirality\'s own session got an answer');
    const junk = spawnSync('node', [script], { input: 'not json', encoding: 'utf8' });
    assert.equal(junk.status, 0, 'unreadable input blocked the command');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('plugin/ holds only what Claude Code reads from a plugin folder', () => {
  assert.deepEqual(readdirSync(PLUGIN).sort(), ['.claude-plugin', 'hooks', 'skills']);
});
