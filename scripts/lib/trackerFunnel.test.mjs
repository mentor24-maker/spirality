// scripts/install_tracker_funnel.sh (SP-152) against a stand-in `tailscale`
// that keeps its routes in a JSON file, a stand-in `launchctl`, and real
// tracker servers on a free port: one on today's code, one standing in for
// a tracker still running code from before the public address existed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../../tracker/store.mjs';
import { startServer } from '../../tracker/server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', 'install_tracker_funnel.sh');
const OWN_CONFIG = JSON.parse(readFileSync(join(HERE, '..', '..', 'spirality.project.json'), 'utf8'));
// .invalid never resolves, so the outside check can never reach the internet from a test.
const PUBLIC = 'https://mini.invalid:8443';

/** StarCaster's routes on 443, as the Mini had them on 2026-11-06. */
const STARCASTER = {
  TCP: { 443: { HTTPS: true } },
  Web: { 'mini.invalid:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8080' }, '/live': { Proxy: 'http://127.0.0.1:8091' } } } },
  AllowFunnel: { 'mini.invalid:443': true },
};

// The stand-in tailscale: `--socket S serve status --json`, `--socket S funnel --bg --yes --https=P TARGET`
// and `--socket S funnel --yes --https=P off`, against $FAKE_TS_STATE. Every call is logged to $FAKE_TS_LOG.
const FAKE_TS = `#!/usr/bin/env node
const { readFileSync, writeFileSync, appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_TS_LOG, args.join(' ') + '\\n');
if (args[0] !== '--socket' || !args[1]) { console.error('no --socket'); process.exit(1); }
const rest = args.slice(2);
const state = JSON.parse(readFileSync(process.env.FAKE_TS_STATE, 'utf8'));
const save = () => writeFileSync(process.env.FAKE_TS_STATE, JSON.stringify(state));
if (rest.join(' ') === 'serve status --json') { process.stdout.write(Object.keys(state).length ? JSON.stringify(state) : ''); process.exit(0); }
if (rest[0] === 'funnel') {
  if (process.env.FAKE_TS_FAIL) { console.error('funnel failed'); process.exit(1); }
  const port = (rest.find((a) => a.startsWith('--https=')) ?? '').slice(8);
  const key = 'mini.invalid:' + port;
  if (rest.at(-1) === 'off') {
    delete state.TCP[port]; delete state.Web[key]; delete state.AllowFunnel[key]; save(); process.exit(0);
  }
  if (!rest.includes('--bg')) { console.error('foreground'); process.exit(1); }
  state.TCP ??= {}; state.Web ??= {}; state.AllowFunnel ??= {};
  state.TCP[port] = { HTTPS: true };
  state.Web[key] = { Handlers: { '/': { Proxy: rest.at(-1) } } };
  state.AllowFunnel[key] = true;
  if (process.env.FAKE_TS_CLOBBER) delete state.Web['mini.invalid:443'].Handlers['/live'];
  save(); process.exit(0);
}
console.error('unknown call: ' + rest.join(' ')); process.exit(1);
`;

function scratch(port, { loaded = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-funnel-'));
  const config = { ...OWN_CONFIG, trackerPort: port, trackerPublicUrl: PUBLIC, tailscaleLabel: 'com.example.tailscaled', tailscaleSocket: join(dir, 'ts.sock') };
  writeFileSync(join(dir, 'spirality.project.json'), JSON.stringify(config));
  writeFileSync(join(dir, 'tailscale'), FAKE_TS);
  chmodSync(join(dir, 'tailscale'), 0o755);
  writeFileSync(join(dir, 'launchctl'), `#!/bin/bash\n${loaded ? 'printf "123\\t0\\tcom.example.tailscaled\\n"' : 'true'}\n`);
  chmodSync(join(dir, 'launchctl'), 0o755);
  writeFileSync(join(dir, 'state.json'), JSON.stringify(STARCASTER));
  writeFileSync(join(dir, 'calls.log'), '');
  return dir;
}

// Asynchronous on purpose: the trackers answer from this same process, so a
// blocking spawn would leave the script's curl with nobody to answer it.
function run(dir, args = [], extra = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [SCRIPT, ...args], {
      cwd: dir,
      env: { ...process.env, FUNNEL_OUTSIDE_TRIES: '2', FUNNEL_OUTSIDE_PAUSE: '0', TAILSCALE_BIN: join(dir, 'tailscale'), LAUNCHCTL_BIN: join(dir, 'launchctl'), FAKE_TS_STATE: join(dir, 'state.json'), FAKE_TS_LOG: join(dir, 'calls.log'), ...extra },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, out, err, state: JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')), calls: readFileSync(join(dir, 'calls.log'), 'utf8') }));
  });
}

async function tracker() {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-funnel-db-'));
  const store = openStore(join(dir, 'tracker.db'));
  const server = await startServer({ store, port: 0, publicUrl: PUBLIC });
  return { port: server.address().port, close: () => new Promise((r) => server.close(() => { store.close?.(); r(); })) };
}

/** A tracker on code from before SP-152: answers /me 401 with no Strict-Transport-Security. */
async function oldTracker() {
  const server = createServer((req, res) => { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"unauthorized"}'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

test('putting the route on: port 8443 leads to the tracker, StarCaster\'s 443 routes are untouched, and it is read back', async () => {
  const t = await tracker();
  try {
    const dir = scratch(t.port);
    const r = await run(dir);
    assert.deepEqual(r.state.Web['mini.invalid:8443'], { Handlers: { '/': { Proxy: `http://127.0.0.1:${t.port}` } } });
    assert.equal(r.state.AllowFunnel['mini.invalid:8443'], true);
    assert.deepEqual(r.state.Web['mini.invalid:443'], STARCASTER.Web['mini.invalid:443'], 'StarCaster\'s routes are as they were');
    assert.match(r.calls, /--socket \S+ts\.sock funnel --bg --yes --https=8443 http:\/\/127\.0\.0\.1:\d+/, 'through the socket, in the background');
    assert.match(r.out, /Read back: port 8443 leads to the tracker, and every other route is as it was/);
    assert.match(r.out, /funnel: +on/);
    assert.match(r.out, new RegExp(`tracker: +http://127.0.0.1:${t.port}/me answers 401`));
    // The outside address cannot be reached from a test (.invalid), and the run says so rather than passing.
    assert.match(r.out, /outside: +https:\/\/mini\.invalid:8443\/me answers 000/);
    assert.match(r.out, /Waiting for https:\/\/mini\.invalid:8443\/me to answer \(a new Funnel port's certificate can take a minute\)/);
    assert.match(r.err, /The route is on, but https:\/\/mini\.invalid:8443\/me has not answered 401 yet/);
    assert.equal(r.status, 1);

    // Run again: nothing is rewritten.
    const again = await run(dir);
    assert.match(again.out, /The route was already on/);
    assert.equal(again.calls.match(/funnel --bg/g).length, 1);

    // --status says it is on; --off takes it off and leaves 443 alone.
    assert.match((await run(dir, ["--status"])).out, /funnel: +on/);
    const off = await run(dir, ['--off']);
    assert.equal(off.status, 0, off.err);
    assert.match(off.out, /Taken off and read back/);
    assert.equal(off.state.Web['mini.invalid:8443'], undefined);
    assert.deepEqual(off.state.Web['mini.invalid:443'], STARCASTER.Web['mini.invalid:443']);
    const status = await run(dir, ['--status']);
    assert.equal(status.status, 1);
    assert.match(status.out, /funnel: +OFF/);
    assert.equal((await run(dir, ["--off"])).status, 0, 'off when already off is fine');
  } finally { await t.close(); }
});

test('a tracker still on older code is never published: refused, exit 3, nothing written', async () => {
  const t = await oldTracker();
  try {
    const r = await run(scratch(t.port));
    assert.equal(r.status, 3);
    assert.match(r.err, /running code from before SP-152/);
    assert.doesNotMatch(r.calls, /funnel/);
    assert.deepEqual(r.state, STARCASTER);
  } finally { await t.close(); }
});

test('a port someone else already uses is refused, and so is taking off a route that is not ours', async () => {
  const t = await tracker();
  try {
    const dir = scratch(t.port);
    const theirs = { ...STARCASTER, Web: { ...STARCASTER.Web, 'mini.invalid:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } } } };
    writeFileSync(join(dir, 'state.json'), JSON.stringify(theirs));
    const r = await run(dir);
    assert.equal(r.status, 3);
    assert.match(r.err, /Refusing: other: port 8443 carries/);
    assert.deepEqual(r.state, theirs);
    const off = await run(dir, ['--off']);
    assert.equal(off.status, 3);
    assert.deepEqual(off.state, theirs);
  } finally { await t.close(); }
});

test('a failed write, a change to another route, or tailscaled not loaded each says so and fails', async () => {
  const t = await tracker();
  try {
    const failed = await run(scratch(t.port), [], { FAKE_TS_FAIL: '1' });
    assert.equal(failed.status, 1);
    assert.match(failed.err, /FAILED: tailscale funnel did not take the route/);
    assert.doesNotMatch(failed.out, /Read back/);

    const clobbered = await run(scratch(t.port), [], { FAKE_TS_CLOBBER: '1' });
    assert.equal(clobbered.status, 1);
    assert.match(clobbered.err, /FAILED: another route changed/);

    const down = await run(scratch(t.port, { loaded: false }));
    assert.equal(down.status, 1);
    assert.match(down.err, /tailscaled: NOT loaded under com\.example\.tailscaled/);
    assert.doesNotMatch(down.calls, /funnel/);

    // A job whose label only starts the same is not Tailscale's job.
    const lookalike = scratch(t.port, { loaded: false });
    writeFileSync(join(lookalike, 'launchctl'), '#!/bin/bash\nprintf "123\\t0\\tcom.example.tailscaled.helper\\n"\n');
    const near = await run(lookalike);
    assert.equal(near.status, 1);
    assert.match(near.err, /tailscaled: NOT loaded under com\.example\.tailscaled/);
    assert.doesNotMatch(near.calls, /funnel/);
  } finally { await t.close(); }
});

test('bad usage exits 2', () => {
  const r = spawnSync('bash', [SCRIPT, '--bogus'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage:/);
});
