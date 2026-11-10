// The Docs page's Commands list (SP-179): tracker/commands.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { listCommands, parseSkill, REPO_ROOT } from './commands.mjs';

const skill = (name, description, body = `# ${name}\n\n1. A step.\n`) => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;

/** A temporary checkout with both folders, and a folder outside it holding a SKILL.md that must never be read. */
function checkout() {
  const top = mkdtempSync(join(tmpdir(), 'commands-list-'));
  const root = join(top, 'repo');
  const outside = join(top, 'outside');
  const put = (folder, name, text) => {
    mkdirSync(join(root, folder, name), { recursive: true });
    writeFileSync(join(root, folder, name, 'SKILL.md'), text);
  };
  mkdirSync(join(outside, 'secret'), { recursive: true });
  writeFileSync(join(outside, 'secret', 'SKILL.md'), skill('secret', 'OUTSIDE-TEXT'));
  writeFileSync(join(outside, 'SKILL.md'), skill('stray', 'OUTSIDE-TEXT'));
  return { top, root, outside, put, cleanup: () => rmSync(top, { recursive: true, force: true }) };
}

test('parseSkill reads name and description (plain, quoted, or folded) and keeps the steps below the front matter', () => {
  assert.deepEqual(parseSkill(skill('plain', 'Say it plainly.')), { name: 'plain', description: 'Say it plainly.', steps: '# plain\n\n1. A step.\n' });
  assert.equal(parseSkill('---\nname: "q"\ndescription: \'quoted words\'\n---\nx').description, 'quoted words');
  assert.equal(parseSkill('---\nname: f\ndescription: >\n  folded over\n  two lines\n---\nx').description, 'folded over two lines');
  assert.equal(parseSkill('# no front matter'), null);
});

test('lists Your commands, then Loop skills, each by name, with description and steps; files without a name or description are left out', () => {
  const c = checkout();
  try {
    c.put('commands', 'why-stuck', skill('why-stuck', 'Find out why a ticket is stuck.'));
    c.put('commands', 'close-check', skill('close-check', 'Check before closing.'));
    c.put('commands', 'broken', '# no front matter\n');
    c.put('.claude/skills', 'loop-review', skill('loop-review', 'Review the next pull request.'));
    c.put('.claude/skills', 'close-check', skill('close-check', 'A loop skill with the same name.'));
    writeFileSync(join(c.root, 'commands', 'README.md'), 'not a command');
    const list = listCommands({ root: c.root });
    assert.deepEqual(list.map((x) => [x.name, x.source]), [['close-check', 'Your command'], ['why-stuck', 'Your command'], ['loop-review', 'Loop skill']]);
    assert.equal(list[1].description, 'Find out why a ticket is stuck.');
    assert.equal(list[1].steps, '# why-stuck\n\n1. A step.\n');
  } finally { c.cleanup(); }
});

test('a missing folder lists nothing from it', () => {
  const c = checkout();
  try {
    assert.deepEqual(listCommands({ root: c.root }), []);
    c.put('.claude/skills', 'loop-spec', skill('loop-spec', 'Spec it.'));
    assert.deepEqual(listCommands({ root: c.root }).map((x) => x.name), ['loop-spec']);
  } finally { c.cleanup(); }
});

test('never reads a file outside the two folders: links, odd names and deeper files are passed over unopened', () => {
  const c = checkout();
  try {
    c.put('commands', 'plain', skill('plain', 'Plain.'));
    // A folder that is a link to outside, a SKILL.md that is a link to outside, a nested SKILL.md, a dotted name.
    symlinkSync(join(c.outside, 'secret'), join(c.root, 'commands', 'linked'));
    mkdirSync(join(c.root, 'commands', 'file-link'));
    symlinkSync(join(c.outside, 'secret', 'SKILL.md'), join(c.root, 'commands', 'file-link', 'SKILL.md'));
    c.put('commands', 'deep/inner', skill('inner', 'Too deep.'));
    c.put('commands', '.hidden', skill('hidden', 'Dotted.'));
    mkdirSync(join(c.root, '.claude'), { recursive: true });
    symlinkSync(c.outside, join(c.root, '.claude', 'skills'));
    writeFileSync(join(c.root, 'SKILL.md'), skill('root', 'OUTSIDE-TEXT'));

    const touched = [];
    const disk = {
      readdir: (p) => { touched.push(['readdir', p]); return readdirSync(p); },
      lstat: (p) => { touched.push(['lstat', p]); return lstatSync(p); },
      read: (p) => { touched.push(['read', p]); return readFileSync(p, 'utf8'); },
    };
    const list = listCommands({ root: c.root, disk });
    assert.deepEqual(list.map((x) => x.name), ['plain']);
    assert.equal(JSON.stringify(list).includes('OUTSIDE-TEXT'), false);
    const inside = [join(c.root, 'commands'), join(c.root, '.claude', 'skills')];
    for (const [, p] of touched) {
      assert.ok(inside.some((dir) => p === dir || p.startsWith(dir + sep)), `touched ${p}`);
    }
    // Only one file was opened: commands/plain/SKILL.md.
    assert.deepEqual(touched.filter(([kind]) => kind === 'read').map(([, p]) => p), [join(c.root, 'commands', 'plain', 'SKILL.md')]);
  } finally { c.cleanup(); }
});

test('this checkout lists the four loop skills', () => {
  const names = listCommands({ root: REPO_ROOT }).filter((x) => x.source === 'Loop skill').map((x) => x.name);
  for (const name of ['loop-build', 'loop-intake', 'loop-review', 'loop-spec']) assert.ok(names.includes(name), name);
});
