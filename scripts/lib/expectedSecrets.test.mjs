import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EXPECTED_SECRETS, CONFIGS, doctorReport, formatReport } from './expectedSecrets.mjs';

const all = (config) => new Set(EXPECTED_SECRETS.filter((s) => s.configs.includes(config)).map((s) => s.name));
const two = [
  { name: 'CLICKUP_API_TOKEN', configs: ['dev'] },
  { name: 'OTHER_KEY', configs: ['dev', 'prd'] },
];

test('every expected name is in at least one known config, and names are unique', () => {
  const names = EXPECTED_SECRETS.map((s) => s.name);
  assert.equal(new Set(names).size, names.length);
  for (const s of EXPECTED_SECRETS) {
    assert.ok(s.configs.length > 0, s.name);
    for (const c of s.configs) assert.ok(CONFIGS.includes(c), `${s.name}: ${c}`);
  }
});

test('all present: ok', () => {
  const report = doctorReport({ dev: all('dev') });
  assert.equal(report.ok, true);
  assert.deepEqual(report.rows.find((r) => r.name === 'CLICKUP_API_TOKEN').cells, { dev: 'present' });
});

test('a name not needed in a config is not a failure; one missing name fails the whole report', () => {
  const okReport = doctorReport({ dev: new Set(['CLICKUP_API_TOKEN', 'OTHER_KEY']), prd: new Set(['OTHER_KEY']) }, two, ['dev', 'prd']);
  assert.equal(okReport.ok, true);
  assert.deepEqual(okReport.rows.find((r) => r.name === 'CLICKUP_API_TOKEN').cells, { dev: 'present', prd: 'not needed' });
  const bad = doctorReport({ dev: new Set(['CLICKUP_API_TOKEN', 'OTHER_KEY']), prd: new Set() }, two, ['dev', 'prd']);
  assert.equal(bad.ok, false);
  assert.equal(bad.rows.find((r) => r.name === 'OTHER_KEY').cells.prd, 'MISSING');
});

test('a config that could not be read is a failure, never a pass', () => {
  const report = doctorReport({ dev: null });
  assert.equal(report.ok, false);
  assert.equal(report.rows[0].cells.dev, 'unreadable');
});

test('the table has a header and one line per expected name', () => {
  const text = formatReport(doctorReport({ dev: all('dev') }));
  const lines = text.split('\n');
  assert.equal(lines.length, EXPECTED_SECRETS.length + 1);
  assert.match(lines[0], /^NAME\s+dev$/);
  assert.match(text, /CLICKUP_API_TOKEN\s+present/);
});

test('every tracker token a runner names is on the list, so doctor reports it', () => {
  const names = new Set(EXPECTED_SECRETS.map((s) => s.name));
  const installer = readFileSync(new URL('../install_loop_runner.sh', import.meta.url), 'utf8');
  const skills = installer.match(/^SKILLS=\(([^)]*)\)/m)[1].trim().split(/\s+/);
  assert.ok(skills.length > 0);
  // loop_runner.sh: TRACKER_TOKEN_ + the skill name, upper case, dashes to underscores.
  const runner = readFileSync(new URL('../loop_runner.sh', import.meta.url), 'utf8');
  assert.match(runner, /export TRACKER_TOKEN_NAME="TRACKER_TOKEN_\$\(printf '%s' "\$SKILL" \| tr 'a-z-' 'A-Z_'\)"/);
  for (const skill of skills) assert.ok(names.has(`TRACKER_TOKEN_${skill.toUpperCase().replaceAll('-', '_')}`), skill);
  const relay = readFileSync(new URL('../run_relay.sh', import.meta.url), 'utf8');
  assert.ok(names.has(relay.match(/^export TRACKER_TOKEN_NAME=(\S+)$/m)[1]));
  assert.ok(names.has('TRACKER_TOKEN_OPERATOR'));
});
