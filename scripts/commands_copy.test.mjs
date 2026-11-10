// `npm run commands:copy` (SP-179). Every run here uses a temporary folder
// as the home folder and another as the repository, never the real
// ~/.claude or this checkout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { copyCommands, parseArgs } from './commands_copy.mjs';

const SCRIPT = fileURLToPath(new URL('./commands_copy.mjs', import.meta.url));
const skill = (name, description, body = `# ${name}\n\nThe steps.\n`) => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;
// Built here, so this file itself never looks like it holds a key.
const KEY_SHAPED = ['pk', '_', '1234567', '_', 'A'.repeat(24)].join('');

function folders() {
  const top = mkdtempSync(join(tmpdir(), 'commands-copy-'));
  const home = join(top, 'home');
  const repo = join(top, 'repo');
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
  mkdirSync(repo);
  const put = (name, text) => {
    mkdirSync(join(home, '.claude', 'skills', name), { recursive: true });
    writeFileSync(join(home, '.claude', 'skills', name, 'SKILL.md'), text);
  };
  const run = () => {
    const out = [];
    const err = [];
    const code = copyCommands({ home, repo, out: (l) => out.push(l), err: (l) => err.push(l) });
    return { code, out, err };
  };
  return { top, home, repo, put, run, cleanup: () => rmSync(top, { recursive: true, force: true }) };
}

test('copies each command\'s SKILL.md into commands/<name>/, says copied, and a second run says unchanged', () => {
  const f = folders();
  try {
    f.put('close-check', skill('close-check', 'Check a thread is finished before closing it.'));
    f.put('plain', skill('plain', 'Say it again in plain English.'));
    const first = f.run();
    assert.equal(first.code, 0, first.err.join('\n'));
    assert.deepEqual(first.out, ['copied close-check', 'copied plain']);
    assert.equal(readFileSync(join(f.repo, 'commands', 'close-check', 'SKILL.md'), 'utf8'), skill('close-check', 'Check a thread is finished before closing it.'));
    assert.ok(existsSync(join(f.repo, 'commands', 'plain', 'SKILL.md')));
    const second = f.run();
    assert.equal(second.code, 0);
    assert.deepEqual(second.out, ['unchanged close-check', 'unchanged plain']);
    // An edited original is copied again.
    f.put('plain', skill('plain', 'Say it again, plainer.'));
    assert.deepEqual(f.run().out, ['unchanged close-check', 'copied plain']);
  } finally { f.cleanup(); }
});

test('copies only SKILL.md, skips a folder without one (such as synced/), and removes a copy whose original is gone', () => {
  const f = folders();
  try {
    f.put('plain', skill('plain', 'Say it again in plain English.'));
    writeFileSync(join(f.home, '.claude', 'skills', 'plain', 'notes.txt'), 'not copied');
    mkdirSync(join(f.home, '.claude', 'skills', 'synced'));
    writeFileSync(join(f.home, '.claude', 'skills', 'synced', 'other.md'), 'not a skill');
    mkdirSync(join(f.repo, 'commands', 'old-one'), { recursive: true });
    writeFileSync(join(f.repo, 'commands', 'old-one', 'SKILL.md'), skill('old-one', 'Gone now.'));
    writeFileSync(join(f.repo, 'commands', 'README.md'), 'kept');
    const r = f.run();
    assert.equal(r.code, 0, r.err.join('\n'));
    assert.deepEqual(r.out, ['copied plain', 'removed old-one']);
    assert.deepEqual(readdirSync(join(f.repo, 'commands')).sort(), ['README.md', 'plain']);
    assert.deepEqual(readdirSync(join(f.repo, 'commands', 'plain')), ['SKILL.md']);
  } finally { f.cleanup(); }
});

test('a SKILL.md holding something shaped like a key: exit 1, and nothing is written', () => {
  const f = folders();
  try {
    f.put('plain', skill('plain', 'Say it again in plain English.'));
    f.put('leaky', skill('leaky', 'Has a key in it.', `Use ${KEY_SHAPED} here.\n`));
    const r = f.run();
    assert.equal(r.code, 1);
    assert.deepEqual(r.out, []);
    assert.match(r.err.join('\n'), /leaky\/SKILL\.md line \d+: looks like a ClickUp pk_ token/);
    assert.match(r.err.join('\n'), /nothing was written/);
    assert.equal(existsSync(join(f.repo, 'commands')), false, 'not even the clean command was copied');
  } finally { f.cleanup(); }
});

test('a name that is not plain letters, digits and dashes: exit 1, nothing written', () => {
  const f = folders();
  try {
    f.put('plain', skill('plain', 'Fine.'));
    f.put('odd name', skill('odd name', 'Has a space.'));
    const r = f.run();
    assert.equal(r.code, 1);
    assert.match(r.err.join('\n'), /"odd name" is not plain letters, digits and dashes/);
    assert.equal(existsSync(join(f.repo, 'commands')), false);
  } finally { f.cleanup(); }
});

test('no commands found, or no skills folder: exit 1 and the copy is left as it is (a run on the wrong machine never empties it)', () => {
  const f = folders();
  try {
    mkdirSync(join(f.repo, 'commands', 'plain'), { recursive: true });
    writeFileSync(join(f.repo, 'commands', 'plain', 'SKILL.md'), skill('plain', 'Kept.'));
    mkdirSync(join(f.home, '.claude', 'skills', 'synced'));
    const empty = f.run();
    assert.equal(empty.code, 1);
    assert.match(empty.err.join('\n'), /found no commands/);
    assert.ok(existsSync(join(f.repo, 'commands', 'plain', 'SKILL.md')));
    rmSync(join(f.home, '.claude'), { recursive: true });
    const none = f.run();
    assert.equal(none.code, 1);
    assert.match(none.err.join('\n'), /is not a folder/);
    assert.ok(existsSync(join(f.repo, 'commands', 'plain', 'SKILL.md')));
  } finally { f.cleanup(); }
});

test('a SKILL.md without name: and description: lines is skipped, said so, and not copied', () => {
  const f = folders();
  try {
    f.put('plain', skill('plain', 'Fine.'));
    f.put('half', '# No front matter\n');
    const r = f.run();
    assert.equal(r.code, 0);
    assert.deepEqual(r.out, ['skipped half: its SKILL.md has no name: and description: lines', 'copied plain']);
    assert.equal(existsSync(join(f.repo, 'commands', 'half')), false);
  } finally { f.cleanup(); }
});

test('run as a command: --home and --repo pick the folders; an unknown argument exits 2', () => {
  const f = folders();
  try {
    f.put('plain', skill('plain', 'Fine.'));
    const r = spawnSync(process.execPath, [SCRIPT, '--home', f.home, '--repo', f.repo], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'copied plain');
    assert.deepEqual(parseArgs(['--home', '/a', '--repo', '/b']), { home: '/a', repo: '/b' });
    const bad = spawnSync(process.execPath, [SCRIPT, '--force'], { encoding: 'utf8' });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /unknown argument "--force"/);
  } finally { f.cleanup(); }
});
