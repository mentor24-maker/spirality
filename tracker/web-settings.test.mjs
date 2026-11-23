/**
 * Tests for the Settings page. One file per page (SP-352),
 * so two tickets changing two pages no longer edit one test file; what they
 * share is tracker/webTestKit.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from './store.mjs';
import { DEMO_NEWEST_RELEASE, DEMO_OWN_PROJECT, demoNewestRelease, seedDemo, tickingClock } from './demoData.mjs';
import { pipelineControlsOf } from './pageData.mjs';
import { renderPipelineControls, renderReleaseGroup, controlValueText, mountainTime, wakeInEffectText, modelLastPassText, drainLine } from './web/render.mjs';
import { startServer } from './server.mjs';
import { pageScript } from './pageScripts.mjs';
import { WEB, fixture } from './webTestKit.mjs';

test('the Settings page is in the header after Reporting and Users, lists the stages the server gives, saves them all, reads them back, and shows a refusal', async () => {
  const html = readFileSync(WEB('index.html'), 'utf8');
  assert.match(html, /<a href="\/reporting" data-nav="reporting">Reporting<\/a>\s*<a href="\/users" data-nav="users">Users<\/a>\s*<a href="\/docs" data-nav="docs">Docs<\/a>\s*<a href="\/settings" data-nav="settings">Settings<\/a>/);
  const app = pageScript();
  const draw = app.slice(app.indexOf('async function drawSettings'), app.indexOf('/**\n * The Users page'));
  assert.match(draw, /const \{ stages \} = await api\('GET', '\/stage-colours'\);/, 'the stages come from the server, never typed out');
  assert.doesNotMatch(draw, /'Queued'|'Requested'|'Live'/);
  assert.match(draw, /type="color"/);
  assert.match(draw, /chosen\[tr\.dataset\.status\] = null;/, 'Clear sets no colour');
  assert.match(draw, /await api\('PUT', '\/stage-colours', \{ colours: chosen \}\);\s*\/\/ Read back before saying it worked\.\s*const back = await api\('GET', '\/stage-colours'\);/);
  assert.match(draw, /showMessage\(\{ kind: 'error', text: `Not saved: \$\{err\.message\}` \}\);/, 'a refused Save is said in the message strip (SP-323)');
  assert.match(draw, /escapeHtml\(s\.status\)/);
  assert.match(app, /markNav\(reporting \? 'reporting' : settings \? 'settings' :/);
  const f = await fixture();
  try {
    const page = await f.call('GET', '/settings', { token: null });
    assert.equal(page.status, 200);
    assert.equal(page.text, readFileSync(WEB('index.html'), 'utf8'));
    // Dane renamed it from Admin: the old address is not the page.
    assert.notEqual((await f.call('GET', '/admin', { token: null })).text, page.text);
    // The demo's loop is refused with a message the page can show.
    const loop = await f.call('PUT', '/stage-colours', { token: f.store.issueToken(f.loop.id), body: { colours: { Queued: '#2b9cf2' } } });
    assert.equal(loop.status, 403);
    assert.ok(loop.body.message);
    const saved = await f.call('PUT', '/stage-colours', { body: { colours: { Queued: '#2b9cf2' } } });
    assert.equal(saved.status, 200, saved.text);
  } finally { await f.cleanup(); }
});

test('the Settings page\'s Spirality Release group: the release, when and by whom, the one before, Move to Newest and Roll Back for the operator; Spirality\'s own and a project with none named say so (SP-275)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-web-release-'));
  const clock = tickingClock();
  const store = openStore(join(dir, 'tracker.db'), { now: clock });
  const seed = seedDemo(store, { operatorName: 'Dane', clock });
  // As the demo serves it: Alpha stands in for Spirality's own, the newest is a stand-in.
  const server = await startServer({ store, port: 0, ownProject: DEMO_OWN_PROJECT, newestRelease: demoNewestRelease });
  const url = `http://127.0.0.1:${server.address().port}`;
  const get = async (path) => (await fetch(`${url}${path}`, { headers: { authorization: `Bearer ${seed.token}` } })).json();
  try {
    const { projects } = await get('/pipeline-controls');
    const beta = projects.find((p) => p.project.slug === 'beta');
    const html = renderPipelineControls(beta);
    assert.match(html, /<h4>Spirality Release<\/h4>/);
    assert.ok(html.indexOf('Spirality Release') < html.indexOf('Change Log'), 'above the change log');
    assert.match(html, /Runs <strong>release-2<\/strong>, named [^<]+M[SD]T by Dane\./);
    assert.match(html, /Before that: <strong>release-1<\/strong>, named [^<]+ by Loop \(build\)\./);
    assert.match(html, new RegExp(`The newest release is <strong>${DEMO_NEWEST_RELEASE}</strong>\\.`));
    assert.match(html, /<button type="button" class="btn" data-release-action="newest">Move to Newest<\/button>/);
    assert.match(html, /<button type="button" class="btn" data-release-action="back">Roll Back to release-1<\/button>/);
    assert.match(html, /Named, but the lanes do not run from it yet \(SP-276\)\./);

    const alpha = projects.find((p) => p.project.slug === 'alpha');
    const own = renderPipelineControls(alpha);
    assert.match(own, /Always the newest release: Spirality&#39;s own lanes meet every change first\./);
    assert.doesNotMatch(own, /data-release-action/);

    // Another reader sees the release, never the buttons.
    assert.doesNotMatch(renderReleaseGroup({ ...beta.release, canChange: false }), /<button/);
    // None named yet: the line, and only Move to Newest.
    const none = renderReleaseGroup({ ...beta.release, current: null, previous: null, rollBackTo: null });
    assert.match(none, /No release named yet\./);
    assert.match(none, /Move to Newest/);
    assert.doesNotMatch(none, /Roll Back/);
    // Already on the newest: Move to Newest is greyed and says why; nowhere back says so.
    const upToDate = renderReleaseGroup({ ...beta.release, current: { ...beta.release.current, release: DEMO_NEWEST_RELEASE }, rollBackTo: null });
    assert.match(upToDate, /data-release-action="newest" disabled>Move to Newest/);
    assert.match(upToDate, /It runs the newest release\./);
    assert.match(upToDate, /No earlier release to roll back to\./);
    // The newest unreadable: said, and Move to Newest greyed.
    const blind = renderReleaseGroup({ ...beta.release, newest: null, newestProblem: 'git ls-remote failed: offline' });
    assert.match(blind, /The newest release could not be read: git ls-remote failed: offline/);
    assert.match(blind, /data-release-action="newest" disabled/);
    // A button's outcome shows beside the buttons.
    assert.match(renderReleaseGroup(beta.release, { ok: false, text: 'Not saved: no' }), /<span class="note error">Not saved: no<\/span>/);

    // Roll Back on the demo: release-2 back to release-1.
    const back = await fetch(`${url}/releases/beta/back`, { method: 'POST', headers: { authorization: `Bearer ${seed.token}`, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(back.status, 200);
    assert.equal((await get('/pipeline-controls/beta')).release.current.release, 'release-1');
  } finally {
    await new Promise((r) => server.close(r));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Pipeline Controls on the Settings page: each control with its value, "default" while it has it, the not-yet line naming its slice, and the change log in Mountain time (SP-224)', async () => {
  const f = await fixture();
  try {
    const { body } = await f.call('GET', '/pipeline-controls');
    const alpha = body.projects.find((p) => p.project.slug === 'alpha');
    assert.equal(alpha.canChange, true);
    assert.ok(alpha.controls.every((c) => c.isDefault), 'the demo leaves every control on its default');
    assert.deepEqual(alpha.changes.map((c) => [c.actorName, c.label, c.from, c.to]), [['Dane', 'work-in-progress cap', '3', '5'], ['Dane', 'work-in-progress cap', '5', '3']]);
    const html = renderPipelineControls(alpha);
    // A box that opens and closes (SP-289), its name the header, closed unless asked open.
    assert.match(html, /^<details class="pipeline-controls" data-project="alpha">\s*<summary>Alpha<\/summary>/);
    assert.match(renderPipelineControls(alpha, {}, true), /^<details class="pipeline-controls" data-project="alpha" open>/);
    for (const title of ['Wake Times', 'Pause and Resume', 'Work-in-Progress Cap', 'Model per Lane', 'Change Log']) assert.match(html, new RegExp(`<h4>${title}</h4>`));
    // Every group is wired now (SP-238 the cap, SP-239 the models): no not-yet line at all.
    assert.doesNotMatch(html, /Saved, but the lanes do not use this yet/);
    assert.doesNotMatch(html, /\(SP-23[89]\)/);
    assert.match(html, /Claude&#39;s default<span class="in-effect">Last pass ran on: not known on this machine yet\.<\/span>/);
    assert.equal(alpha.capInFlight.count, alpha.capInFlight.ids.length);
    assert.match(html, new RegExp(`<tr data-control="wip-cap"[\\s\\S]*?<span class="in-flight[^"]*">${alpha.capInFlight.count} in flight now`));
    // The lanes use the wake times (SP-236): no not-yet line, and each says what its lane last used.
    assert.doesNotMatch(html, /SP-236/);
    assert.match(html, /1,800 seconds \(Every 30 minutes\)<span class="in-effect">Last used: not known on this machine yet\.<\/span>/);
    // The pause switches are wired in (SP-237): no not-yet line, and no drain line while nothing is paused.
    assert.doesNotMatch(html, /\(SP-237\)/);
    assert.doesNotMatch(html, /Draining|Paused: nothing in flight/);
    assert.match(html, /<tr data-control="wake\.loop-build" data-kind="seconds">[\s\S]*?loop-build Wake Time<\/label> <span class="default">default<\/span>[\s\S]*?type="number" min="60" max="86400" step="1" value="1800"[\s\S]*?1,800 seconds \(Every 30 minutes\)[\s\S]*?<button type="button" class="btn btn-save btn-sm">Save<\/button>/);
    assert.match(html, /<option value="default" selected>Claude&#39;s default<\/option>/);
    assert.match(html, /<option value="off" selected>Off<\/option><option value="on">On<\/option>/);
    assert.match(html, /<td>Dane<\/td><td>work-in-progress cap<\/td><td>3<\/td><td>5<\/td>/);
    assert.match(html, /M[SD]T<\/td>/, 'the times are Mountain time');

    // Another reader sees the values, locked, and who may change them.
    const locked = renderPipelineControls({ ...alpha, canChange: false });
    assert.doesNotMatch(locked, /<button/);
    assert.match(locked, /type="number"[^>]*disabled/);
    assert.match(locked, /Only Dane, the project's operator, may change these\./);
    // A Save's outcome shows beside its control.
    assert.match(renderPipelineControls(alpha, { 'wip-cap': { ok: false, text: 'Not saved: too small' } }), /<span class="note error">Not saved: too small<\/span>/);
    assert.match(renderPipelineControls({ ...alpha, changes: [] }), /No changes yet\./);

    // The demo's loop may read them, never change them.
    const loopToken = f.store.issueToken(f.loop.id);
    assert.equal((await f.call('PUT', '/pipeline-controls/alpha', { token: loopToken, body: { setting: 'wake.loop-build', value: '900' } })).status, 403);
    const saved = await f.call('PUT', '/pipeline-controls/alpha', { body: { setting: 'wake.loop-build', value: '900' } });
    assert.equal(saved.status, 200, saved.text);
    assert.match(renderPipelineControls(saved.body), /<td>Dane<\/td><td>loop-build wake time<\/td><td>1800<\/td><td>900<\/td>/);
  } finally { await f.cleanup(); }
});

test('Quiet Days Before Moving: a number box from 0 to 30 with no not-yet line, left out for the tracker\'s home project; the page saves it as a number (SP-277)', async () => {
  const f = await fixture();
  try {
    const { body } = await f.call('GET', '/pipeline-controls');
    const alpha = body.projects.find((p) => p.project.slug === 'alpha');
    const html = renderPipelineControls({ ...alpha, own: false });
    assert.match(html, /<h4>Quiet Days Before Moving<\/h4>\s*<table class="controls"><tbody><tr data-control="release\.quiet-days" data-kind="days">[\s\S]*?type="number" min="0" max="30" step="1" value="0"[\s\S]*?0 \(moves only when named by hand\)/);
    const after = html.slice(html.indexOf('<h4>Quiet Days Before Moving</h4>'), html.indexOf('<h4>Change Log</h4>'));
    assert.doesNotMatch(after, /do not use this yet/, 'the relay uses it already');
    assert.ok(html.indexOf('<h4>Spirality Release</h4>') > 0 && html.indexOf('<h4>Spirality Release</h4>') < html.indexOf('<h4>Quiet Days Before Moving</h4>'), 'it sits under the release it moves');
    const own = renderPipelineControls({ ...alpha, own: true });
    assert.doesNotMatch(own, /Quiet Days Before Moving|release\.quiet-days/);
    assert.match(own, /<h4>Wake Times<\/h4>/, 'the home project keeps its other controls');
  } finally { await f.cleanup(); }
  const app = pageScript();
  assert.match(app, /const numeric = \['seconds', 'count', 'days'\]\.includes\(tr\.dataset\.kind\);/);
});

test('a project\'s own lane\'s switch shows under Pause and Resume, titled like the others, and its change log names who turned it on (SP-401)', async () => {
  const f = await fixture();
  try {
    const operator = f.store.getProject('alpha').operator;
    const loop = f.store.createActor({ kind: 'machine', name: 'Lane' });
    f.store.setProjectLanes({ project: 'alpha', lanes: ['loop-handoff'], actor: loop.id });
    f.store.setPipelineSetting({ project: 'alpha', setting: 'paused.loop-handoff', value: 'on', actor: operator });
    const html = renderPipelineControls(pipelineControlsOf(f.store, 'alpha', { reader: operator }));
    const pause = html.slice(html.indexOf('<h4>Pause and Resume</h4>'), html.indexOf('<h4>Work-in-Progress Cap</h4>'));
    assert.match(pause, /data-control="paused\.relay"[\s\S]*data-control="paused\.loop-handoff"/, 'after the built-in lanes');
    assert.match(pause, /<label for="[^"]+">loop-handoff Paused<\/label>/);
    const log = html.slice(html.indexOf('<h4>Change Log</h4>'));
    assert.match(log, /loop-handoff paused/);
    assert.match(log, new RegExp(f.store.getActor(operator).name));
    const others = renderPipelineControls(pipelineControlsOf(f.store, 'beta', { reader: operator }) ?? { controls: [], groups: [] });
    assert.doesNotMatch(others, /loop-handoff/);
  } finally { await f.cleanup(); }
});

test('each model on the Settings page says what its lane\'s last pass ran on, read from the lane\'s START line, and says plainly while the next pass has yet to pick up a change (SP-239)', async () => {
  const f = await fixture();
  try {
    const lanes = [{ job: 'loop-review', model: 'claude-opus-5-5' }, { job: 'loop-build', model: 'default' }, { job: 'loop-intake', model: null }, { job: 'relay', model: null }];
    const view = pipelineControlsOf(f.store, 'alpha', { lanes });
    const lastOf = (key) => view.controls.find((c) => c.key === key).lastModel;
    assert.deepEqual(['model.loop-review', 'model.loop-build', 'model.loop-intake'].map(lastOf), ['claude-opus-5-5', 'default', null]);
    assert.equal(lastOf('wip-cap'), undefined);
    const html = renderPipelineControls(view);
    assert.match(html, /data-control="model\.loop-build"[\s\S]*?<span class="in-effect">In effect: the last pass ran on Claude&#39;s default\.<\/span>/);
    assert.match(html, /data-control="model\.loop-review"[\s\S]*?<span class="in-effect waiting">Last pass ran on: Opus 5\.5\. The lane&#39;s next pass picks this up\.<\/span>/);
    assert.match(html, /data-control="model\.loop-intake"[\s\S]*?<span class="in-effect">Last pass ran on: not known on this machine yet\.<\/span>/);
    const models = view.models;
    assert.equal(modelLastPassText({ value: 'claude-opus-5-5', lastModel: 'claude-opus-5-5' }, models), 'In effect: the last pass ran on Opus 5.5.');
    assert.equal(modelLastPassText({ value: 'default', lastModel: 'claude-x-9' }, models), 'Last pass ran on: claude-x-9. The lane\'s next pass picks this up.');
  } finally { await f.cleanup(); }
});

test('each wake time on the Settings page says what its lane last used, and says plainly while the lane has not picked up the set value (SP-236)', async () => {
  const f = await fixture();
  try {
    const alpha = (await f.call('GET', '/pipeline-controls')).body.projects.find((p) => p.project.slug === 'alpha');
    const withUsed = (key, used) => ({ ...alpha, controls: alpha.controls.map((c) => (c.key === key ? { ...c, value: '600', isDefault: false, used, inEffect: used == null ? null : String(used) === '600' } : c)) });
    const waiting = renderPipelineControls(withUsed('wake.loop-build', 1800));
    assert.match(waiting, /600 seconds \(Every 10 minutes\)<span class="in-effect waiting">Last used: 1,800 seconds\. Waiting for the lane&#39;s next pass to pick this up\.<\/span>/);
    const taken = renderPipelineControls(withUsed('wake.loop-build', 600));
    assert.match(taken, /<span class="in-effect">In effect: the lane last used 600 seconds\.<\/span>/);
    assert.doesNotMatch(taken, /Waiting for the lane/);
    assert.equal(wakeInEffectText({ used: null, inEffect: null }), 'Last used: not known on this machine yet.');
    // Only the wake times and the models (SP-239) say it.
    assert.equal((taken.match(/class="in-effect/g) || []).length, 4 + 3);
    assert.equal((taken.match(/Last used:|In effect: the lane/g) || []).length, 4);
  } finally { await f.cleanup(); }
});

test('the Settings page draws Pipeline Controls from the server and says Saved only when the stored value read back is the one sent (SP-224)', () => {
  const app = pageScript();
  const draw = app.slice(app.indexOf('async function drawSettings'), app.indexOf('/**\n * The Users page'));
  assert.match(draw, /await api\('GET', '\/pipeline-controls'\)/);
  assert.match(draw, /\{ id: 'pipeline-controls', title: 'Pipeline Controls' \}/);
  assert.match(draw, /await api\('PUT', `\/pipeline-controls\/\$\{encodeURIComponent\(slug\)\}`, \{ setting: key, value: sent \}\);\s*\/\/ Read back before saying it worked/);
  assert.match(draw, /if \(stored !== sent \|\| answer\.saved\?\.to !== sent\) throw/);
  assert.match(draw, /text: `Not saved: \$\{err\.message\}`/);
});

test('controlValueText and mountainTime say a control and a time in words', () => {
  assert.equal(controlValueText({ kind: 'seconds', value: '900' }), '900 seconds (Every 15 minutes)');
  assert.equal(controlValueText({ kind: 'switch', value: 'on' }), 'On');
  assert.equal(controlValueText({ kind: 'model', value: 'x' }, [{ id: 'x', label: 'Model X' }]), 'Model X');
  assert.equal(controlValueText({ kind: 'days', value: '0' }), '0 (moves only when named by hand)');
  assert.equal(controlValueText({ kind: 'days', value: '1' }), '1 day');
  assert.equal(controlValueText({ kind: 'days', value: '7' }), '7 days');
  assert.equal(mountainTime('2026-11-12T13:48:00Z'), 'Nov 12, 2026, 6:48 AM MST');
  assert.equal(mountainTime('2026-07-01T18:00:00Z'), 'Jul 1, 2026, 12:00 PM MDT');
  assert.equal(mountainTime('nope'), '–');
});

test('npm run clickup -- settings prints every control as name=value, defaults included, and exits non-zero saying why when it cannot read them (SP-224)', async () => {
  const f = await fixture();
  try {
    f.store.setPipelineSetting({ project: 'alpha', setting: 'wake.loop-build', value: '900', actor: f.operator.id });
    const r = await f.door('alpha', 'settings');
    assert.equal(r.code, 0, r.err);
    const lines = r.out.trim().split('\n');
    assert.equal(lines.length, f.store.pipelineSettings('alpha').length);
    assert.ok(lines.every((l) => /^[a-z.-]+=[^\s]+$/.test(l)), r.out);
    for (const l of ['wake.loop-build=900', 'wake.relay=600', 'paused=off', 'wip-cap=5', 'model.loop-review=default', 'release.quiet-days=0']) assert.ok(lines.includes(l), l);
    assert.match(r.err, /14 pipeline control\(s\) for alpha, 1 changed from the default/);
    const missing = await f.door('nope', 'settings');
    assert.equal(missing.code, 1);
    assert.equal(missing.out, '');
    assert.match(missing.err, /read the pipeline controls FAILED — HTTP 404/);
  } finally { await f.cleanup(); }
});

test('npm run clickup -- pause-check: exit 0 running, 3 paused naming who and when, 3 on a failed read or a lane with no switch, 2 with no lane (SP-237)', async () => {
  const f = await fixture();
  try {
    const running = await f.door('alpha', 'pause-check', '--lane', 'loop-build');
    assert.equal(running.code, 0, running.err);
    assert.equal(running.out.trim(), 'running — neither the whole pipeline nor loop-build is paused');

    f.store.setPipelineSetting({ project: 'alpha', setting: 'paused.loop-build', value: 'on', actor: f.operator.id });
    const lane = await f.door('alpha', 'pause-check', '--lane', 'loop-build');
    assert.equal(lane.code, 3, lane.err);
    assert.match(lane.out.trim(), /^paused by Dane at [A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d\d [AP]M M[SD]T — not starting \/loop-build \(loop-build is paused/);
    const other = await f.door('alpha', 'pause-check', '--lane', 'loop-review');
    assert.equal(other.code, 0, 'the other lanes run as normal');

    f.store.setPipelineSetting({ project: 'alpha', setting: 'paused', value: 'on', actor: f.operator.id });
    for (const l of ['loop-intake', 'loop-review', 'relay']) {
      const r = await f.door('alpha', 'pause-check', '--lane', l);
      assert.equal(r.code, 3, l);
      assert.match(r.out, /the whole pipeline is paused/);
    }

    // Resume: the lane may start again.
    f.store.setPipelineSetting({ project: 'alpha', setting: 'paused', value: 'off', actor: f.operator.id });
    f.store.setPipelineSetting({ project: 'alpha', setting: 'paused.loop-build', value: 'off', actor: f.operator.id });
    assert.equal((await f.door('alpha', 'pause-check', '--lane', 'loop-build')).code, 0);

    const unreadable = await f.door('nope', 'pause-check', '--lane', 'loop-build');
    assert.equal(unreadable.code, 3, 'settings that cannot be read count as paused');
    assert.match(unreadable.out, /^could not read the pipeline settings, so \/loop-build is treated as PAUSED and not starting \(it fails safe[^)]*\)\. Reason: HTTP 404/);

    // A lane with no switch of its own fails safe, naming the missing setting; no lane at all is refused.
    const unknown = await f.door('alpha', 'pause-check', '--lane', 'loop-nonsense');
    assert.equal(unknown.code, 3);
    assert.match(unknown.out, /has no "paused\.loop-nonsense" setting/);
    const bad = await f.door('alpha', 'pause-check');
    assert.equal(bad.code, 2);
    assert.match(bad.err, /--lane names the lane asking/);
  } finally { await f.cleanup(); }
});

test('GET /pipeline-controls lists the tickets in flight, and the Settings page says Draining while a pause waits on them, then Paused: nothing in flight (SP-237)', async () => {
  const f = await fixture();
  try {
    const { body } = await f.call('GET', '/pipeline-controls/alpha');
    const building = f.store.listTickets('alpha').filter((t) => t.status === 'building').map((t) => t.id);
    assert.deepEqual(body.inFlight.filter((t) => t.kind === 'a build').map((t) => t.id), building);
    assert.ok(body.inFlight.every((t) => ['a build', 'a review'].includes(t.kind)));

    const view = (on, inFlight) => ({
      controls: ['paused', 'paused.loop-build', 'paused.loop-review', 'paused.loop-intake'].map((key) => ({ key, group: 'pause', value: on.includes(key) ? 'on' : 'off' })),
      inFlight,
    });
    const build = { id: 'AL-7', name: 'Build <it>', status: 'building', kind: 'a build' };
    const review = { id: 'AL-9', name: 'Check it', status: 'in review', kind: 'a review' };
    assert.equal(drainLine(view([], [build])), '', 'nothing paused, nothing said');
    const whole = drainLine(view(['paused'], [build, review]));
    assert.match(whole, /<div class="drain draining"><p>Draining: 2 ticket\(s\) still finishing\.<\/p>/);
    assert.match(whole, /<a href="\/t\/AL-7">AL-7<\/a> Build &lt;it&gt; <span class="quiet">\(a build\)<\/span>/);
    // One lane waits only on its own kind of pass; intake has none to wait on.
    assert.match(drainLine(view(['paused.loop-review'], [build, review])), /Draining: 1 ticket\(s\)[\s\S]*AL-9/);
    assert.equal(drainLine(view(['paused.loop-intake'], [build, review])), '<p class="drain paused">Paused: nothing in flight.</p>');
    assert.equal(drainLine(view(['paused'], [])), '<p class="drain paused">Paused: nothing in flight.</p>');

    // On the page, under the pause switches, once a switch is on.
    const saved = await f.call('PUT', '/pipeline-controls/alpha', { body: { setting: 'paused', value: 'on' } });
    assert.equal(saved.status, 200);
    const html = renderPipelineControls(saved.body);
    assert.match(html, /<h4>Pause and Resume<\/h4>[\s\S]*?<div class="drain-box">(<div class="drain draining">|<p class="drain paused">)[\s\S]*?<h4>Work-in-Progress Cap<\/h4>/);
    // The page reads the drain line again while it drains, redrawing only that line.
    const app = pageScript();
    assert.match(app, /if \(!box\.querySelector\('\.drain\.draining'\)\) return;/);
    assert.match(app, /if \(slot\) slot\.innerHTML = drainLine\(v\);/);
  } finally { await f.cleanup(); }
});

test('GET /pipeline marks the stages paused from the project\'s controls (SP-237)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-pipeline-paused-'));
  const store = openStore(join(dir, 'tracker.db'), { now: tickingClock() });
  const seed = seedDemo(store, { operatorName: 'Dane', clock: tickingClock() });
  const server = await startServer({ store, port: 0, pipeline: { logDir: dir, slug: 'alpha' } });
  try {
    store.setPipelineSetting({ project: 'alpha', setting: 'paused.relay', value: 'on', actor: seed.operator.id });
    const res = await fetch(`http://127.0.0.1:${server.address().port}/pipeline`, { headers: { authorization: `Bearer ${seed.token}` } });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(Object.fromEntries(body.stages.map((s) => [s.job, s.paused])), { relay: 'lane', 'loop-build': null, 'loop-review': null, 'loop-intake': null });
  } finally {
    await new Promise((r) => server.close(r));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Settings is two tabs, each project a box that stays open across a Save, its buttons the four kinds (SP-289, SP-321)', () => {
  const app = pageScript();
  const css = readFileSync(WEB('app.css'), 'utf8');
  // The menu: Pipeline Controls first (and the default), then Styles; the address names the tab.
  assert.match(app, /const SETTINGS_TABS = \[\s*\{ id: 'pipeline-controls', title: 'Pipeline Controls' \},\s*\{ id: 'styles', title: 'Styles' \},\s*\];/);
  assert.match(app, /return SETTINGS_TABS\.some\(\(t\) => t\.id === named\) \? named : SETTINGS_TABS\[0\]\.id;/);
  assert.match(app, /history\.replaceState\(null, '', `\$\{location\.pathname\}\$\{location\.search\}#\$\{a\.dataset\.tab\}`\);/);
  // Stage Colours sits in the Styles tab, the projects in Pipeline Controls.
  const settings = app.slice(app.indexOf('async function drawSettings'), app.indexOf('const SETTINGS_TABS'));
  const styles = settings.indexOf('<div class="settings-tab" data-tab="styles">');
  assert.ok(styles > settings.indexOf('<div class="settings-tab" data-tab="pipeline-controls">'));
  assert.ok(settings.indexOf('<h2>Stage Colours</h2>') > styles);
  assert.ok(settings.indexOf('<div class="pipeline-controls">') < styles);
  // A box open before a redraw (a Save, Move to Newest, Roll Back) is drawn open again; a whole-page refresh keeps it by project.
  assert.match(app, /const open = new Set\(\[\.\.\.box\.querySelectorAll\('details\.pipeline-controls\[open\]'\)\]\.map\(\(d\) => d\.dataset\.project\)\);/);
  assert.match(app, /renderPipelineControls\(v, notes\.get\(v\.project\.slug\) \?\? \{\}, open\.has\(v\.project\.slug\)\)/);
  assert.match(app, /d\.dataset\.project \? `project\|\$\{d\.dataset\.project\}`/);
  // The look: reverse-colour header, 1px border, container corners (SP-320 put the corners on tokens). Its buttons take the four kinds (SP-321): no look of their own.
  assert.match(css, /details\.pipeline-controls \{[^}]*border: 1px solid var\(--navy\); border-radius: var\(--radius-container\); overflow: hidden;/);
  assert.match(css, /details\.pipeline-controls > summary \{[^}]*background: var\(--navy\); color: var\(--btn-flat-ink\); font-weight: 700;/);
  assert.doesNotMatch(css, /div\.settings-tab button/);
  assert.match(settings, /<button type="submit" class="btn btn-save">Save<\/button>/, 'Stage Colours\' Save is a Save');
});
