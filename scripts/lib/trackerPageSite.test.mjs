import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackerPageSite, checkTrackerPageSite, SITE_FILE } from './trackerPageSite.mjs';
import { loadProjectConfig } from '../../lib/projectConfig.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('the forwarding site sends the front page and every path to trackerPublicUrl, and nothing else is in it (SP-164, SP-198)', () => {
  const site = JSON.parse(trackerPageSite({ trackerPublicUrl: 'https://mini.example.ts.net:8443' }));
  assert.deepEqual(site, { rewrites: [
    { source: '/', destination: 'https://mini.example.ts.net:8443/' },
    { source: '/:path*', destination: 'https://mini.example.ts.net:8443/:path*' },
  ] });
});

test('the destination is whatever the config says, never a written-in address (SP-164)', () => {
  for (const url of ['https://a.example.ts.net', 'https://b.example.ts.net:10000']) {
    const [front, rest] = JSON.parse(trackerPageSite({ trackerPublicUrl: url })).rewrites;
    assert.equal(front.destination, `${url}/`);
    assert.equal(rest.destination, `${url}/:path*`);
  }
  assert.throws(() => trackerPageSite({ trackerPublicUrl: null }), /trackerPublicUrl/);
});

test('the check passes only when the file on disk is what the config makes (SP-164)', () => {
  const config = { trackerPublicUrl: 'https://mini.example.ts.net:8443' };
  assert.equal(checkTrackerPageSite(config, trackerPageSite(config)).ok, true);
  assert.equal(checkTrackerPageSite(config, null).ok, false);
  assert.equal(checkTrackerPageSite(config, trackerPageSite({ trackerPublicUrl: 'https://other.example.ts.net' })).ok, false);
  assert.equal(checkTrackerPageSite({ trackerPublicUrl: null }, null).ok, true);
  assert.equal(checkTrackerPageSite({ trackerPublicUrl: null }, '{}').ok, false);
});

test('this repository\'s committed site matches its own project config (SP-164)', () => {
  const config = loadProjectConfig({ cwd: root, env: {} });
  let onDisk = null;
  try { onDisk = readFileSync(join(root, SITE_FILE), 'utf8'); } catch { onDisk = null; }
  const { ok, why } = checkTrackerPageSite(config, onDisk);
  assert.ok(ok, why);
});
