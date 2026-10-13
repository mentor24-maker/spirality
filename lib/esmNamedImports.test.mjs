// Every name a lib/ module exports to require() must also be a named ESM
// import, except the getters, which are deliberately read through the module
// object (a named import is copied once at load and would freeze them).
//
// Node finds a CommonJS module's named exports by scanning its
// `module.exports = { … }` list, and stops at the first entry that is not a
// plain name. A getter placed early in the list once hid 56 names across three
// modules: `import { isMachineComment } from '…/machineComment.js'` was a
// SyntaxError while require() worked, so only ESM callers ever saw it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const modules = readdirSync(here)
  .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
  .sort();

test('the lib/ module list is not empty', () => {
  assert.ok(modules.includes('machineComment.js'), modules.join(', '));
});

for (const file of modules) {
  test(`${file}: every non-getter export is a named ESM import`, async () => {
    const cjs = require(path.join(here, file));
    const plain = Object.keys(cjs).filter(
      (k) => !Object.getOwnPropertyDescriptor(cjs, k).get,
    );
    const ns = await import(path.join(here, file));
    const hidden = plain.filter((k) => !(k in ns));
    assert.deepEqual(hidden, [], `${file} hides these from import { … }`);
  });
}
