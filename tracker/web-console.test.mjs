/**
 * Tests for the Console. One file per page (SP-352),
 * so two tickets changing two pages no longer edit one test file; what they
 * share is tracker/webTestKit.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { contrast, renderConsole, renderDetours, renderFunnel, detourPathData, MAP_DETOURS, DETOURS_KEY, renderConsoleTile, consoleHeld, MAP_AREAS, MAP_UNITS, placeArea, driftOf, liveFade, slotShare, moreOpens, moreFeatures, tileSizeClass, TILE_MAX, TILE_MIN, TILE_COMPACT, TILE_TINY, LIVE_FADE_FLOOR, consoleNextChange, consoleAge, consoleWaiting, CONSOLE_UNKNOWN, consoleFeature, featureColourIndex, renderFeatureKey, consoleForProject, renderProjectPicker, FEATURE_PALETTE, capInFlightText, glidesOf, buildRunning, laneRunning, runningAreas, GLIDE_AREA, GLIDE_AREAS, DRIFT_FULL_MS, tileMoves, MOVE_MIN } from './web/render.mjs';
import { pageScript, renderScript } from './pageScripts.mjs';
import { WEB, drawnCss } from './webTestKit.mjs';

// ── The Console view (SP-233) ────────────────────────────────────────────────

const CONSOLE_NOW = Date.parse('2026-11-12T18:00:00.000Z');
const consoleTicket = (over = {}) => ({
  id: 'AL-7', project: 'alpha', name: 'Fix the thing', status: 'Queued', tags: [], priority: null, assignee: null,
  updatedAt: '2026-11-12T15:00:00.000Z', stageSince: '2026-11-12T15:00:00.000Z',
  waitingOnOperator: false, answerIn: false, pullRequest: null, hold: null,
  nextChange: { kind: 'lane', lane: 'Build', job: 'loop-build', running: false, due: '2026-11-12T18:12:00.000Z' },
  ...over,
});
const ALPHA = { slug: 'alpha', name: 'Alpha', prefix: 'AL', logo: 'https://alpha.example/logo.png' };
const BETA = { slug: 'beta', name: 'Beta', prefix: 'BE', logo: null };

test('a Console tile for a project with a logo: the logo, the number over it, stage, next change and time in stage, a link to the ticket', () => {
  const html = renderConsoleTile(consoleTicket(), ALPHA, CONSOLE_NOW);
  assert.match(html, /^<a class="tile" href="\/t\/AL-7" title="AL-7: Fix the thing"/);
  assert.match(html, /<img class="tile-logo" src="https:\/\/alpha\.example\/logo\.png" alt="" referrerpolicy="no-referrer">/);
  assert.doesNotMatch(html, /tile-prefix/);
  assert.match(html, /<span class="tile-number">AL-7<\/span>/);
  assert.match(html, /<span class="fact stage" data-stage="Queued">Queued<\/span>/);
  assert.match(html, /<span class="fact next" title="Build&#39;s next pass is due Nov 12, 2026, 11:12 AM MST">in 12 min<\/span>/);
  assert.match(html, /<span class="fact age" title="In Queued for 3h">3h<\/span>/);
});

test('a Console tile for a project with no logo shows its ticket prefix in large letters; a logo that is not a web address is not drawn', () => {
  const html = renderConsoleTile(consoleTicket({ id: 'BE-2', project: 'beta' }), BETA, CONSOLE_NOW);
  assert.match(html, /<span class="tile-prefix" aria-hidden="true">BE<\/span>/);
  assert.doesNotMatch(html, /<img/);
  const odd = renderConsoleTile(consoleTicket(), { ...ALPHA, logo: 'javascript:alert(1)' }, CONSOLE_NOW);
  assert.doesNotMatch(odd, /<img|javascript:/);
  assert.match(odd, /<span class="tile-prefix" aria-hidden="true">AL<\/span>/);
  // No project in the answer: the prefix is read off the ticket number.
  assert.match(renderConsoleTile(consoleTicket({ id: 'ZZ-1' }), null, CONSOLE_NOW), /<span class="tile-prefix" aria-hidden="true">ZZ<\/span>/);
});

test('a Console tile waiting on the operator is ringed, and its next change is "You"', () => {
  const his = renderConsoleTile(consoleTicket({ status: 'Needs your input', waitingOnOperator: true, nextChange: { kind: 'operator' } }), ALPHA, CONSOLE_NOW);
  assert.match(his, /^<a class="tile waiting"/);
  assert.match(his, /<span class="fact next" title="Your move: no lane acts on it until you do">You<\/span>/);
  assert.match(his, /waiting on you\.">/);
  assert.equal(consoleWaiting(consoleTicket({ answerIn: true })), true, 'an answer of his that is in');
  assert.equal(consoleWaiting(consoleTicket({ nextChange: { kind: 'operator' } })), true, 'one of his statuses');
  assert.equal(consoleWaiting(consoleTicket()), false);
  assert.match(renderConsoleTile(consoleTicket(), ALPHA, CONSOLE_NOW), /^<a class="tile" /);
});

test('a Console tile the build loop will not claim yet carries a "Waiting" mark titled with why; one next to build carries none, and a tile waiting on you keeps its ring (SP-377)', () => {
  const reasons = ['waits on al-3 (still open)', 'its Waits on: line names "x", which is not a ticket id or link'];
  const held = renderConsoleTile(consoleTicket({ hold: { reasons } }), ALPHA, CONSOLE_NOW);
  assert.match(held, /^<a class="tile held" /);
  assert.match(held, /<span class="tile-held" title="waits on al-3 \(still open\); its Waits on: line names &quot;x&quot;, which is not a ticket id or link">Waiting<\/span>/);
  assert.match(held, /aria-label="[^"]*; held: waits on al-3 \(still open\); [^"]*\.">/);
  assert.doesNotMatch(held, /class="tile[^"]*\bwaiting\b/, 'held is not "waiting on you"');
  const next = renderConsoleTile(consoleTicket(), ALPHA, CONSOLE_NOW);
  assert.doesNotMatch(next, /tile-held|held/);
  assert.equal(consoleHeld(consoleTicket()), '');
  assert.equal(consoleHeld(consoleTicket({ hold: { reasons: [] } })), '');
  const his = renderConsoleTile(consoleTicket({ status: 'Needs your input', waitingOnOperator: true, nextChange: { kind: 'operator' } }), ALPHA, CONSOLE_NOW);
  assert.match(his, /^<a class="tile waiting"/);
  assert.doesNotMatch(his, /tile-held/);
  const css = readFileSync(WEB('app.css'), 'utf8');
  assert.match(css, /\.tile\.waiting \{ box-shadow: 0 0 0 3px var\(--status-warn\); \}/, 'the ring on a tile waiting on you is unchanged');
  assert.match(css, /\.tile-held \{[^}]*position: absolute;/);
  assert.match(css, /\.tile-tiny \.tile-held \{ display: none; \}/);
});

test('a Console tile whose next change is unknown shows a dash; Building and a running lane show "Now"', () => {
  for (const nextChange of [null, undefined, { kind: 'lane', due: null }, { kind: 'lane', due: 'not a time' }, { kind: 'odd' }]) {
    assert.deepEqual(consoleNextChange(nextChange, CONSOLE_NOW), { text: CONSOLE_UNKNOWN, title: 'When the next pass picks it up is not known' });
  }
  assert.match(renderConsoleTile(consoleTicket({ nextChange: null }), ALPHA, CONSOLE_NOW), /<span class="fact next" title="When the next pass picks it up is not known">—<\/span>/);
  assert.equal(consoleNextChange({ kind: 'running', lane: 'Build', job: 'loop-build' }, CONSOLE_NOW).text, 'Now');
  assert.equal(consoleNextChange({ kind: 'lane', lane: 'Review', running: true, due: null }, CONSOLE_NOW).text, 'Now');
  assert.equal(consoleNextChange({ kind: 'lane', lane: 'Review', running: false, due: '2026-11-12T17:59:00.000Z' }, CONSOLE_NOW).text, 'Now', 'a pass already due');
  assert.equal(consoleNextChange({ kind: 'lane', lane: 'Review', running: false, due: '2026-11-12T20:10:00.000Z' }, CONSOLE_NOW).text, 'in 2 h');
});

test('a Console next change counts whole hours down the way it counts minutes, never rounding up', () => {
  const at = (minutes) => consoleNextChange({ kind: 'lane', lane: 'Review', running: false, due: new Date(CONSOLE_NOW + minutes * 60_000).toISOString() }, CONSOLE_NOW).text;
  assert.equal(at(59), 'in 59 min');
  assert.equal(at(60), 'in 1 h');
  assert.equal(at(89), 'in 1 h', 'not "in 1 h" at 89 and "in 2 h" at 90');
  assert.equal(at(90), 'in 1 h');
  assert.equal(at(119), 'in 1 h');
  assert.equal(at(120), 'in 2 h');
});

test('time in stage reads short: minutes, hours under two days, then days; an unreadable time is a dash', () => {
  assert.equal(consoleAge('2026-11-12T17:59:30.000Z', CONSOLE_NOW), '0m');
  assert.equal(consoleAge('2026-11-12T17:15:00.000Z', CONSOLE_NOW), '45m');
  assert.equal(consoleAge('2026-11-11T18:00:00.000Z', CONSOLE_NOW), '24h');
  assert.equal(consoleAge('2026-11-09T18:00:00.000Z', CONSOLE_NOW), '3d');
  assert.equal(consoleAge(null, CONSOLE_NOW), CONSOLE_UNKNOWN);
});

test('a Console tile escapes every piece of ticket and project text', () => {
  const html = renderConsoleTile(consoleTicket({ id: 'AL-<b>', name: '<script>alert(1)</script> "x"', status: '<i>Queued</i>' }), { ...ALPHA, prefix: '<u>', logo: 'https://a.example/x.png?"><script>' }, CONSOLE_NOW);
  assert.doesNotMatch(html, /<script>|<b>|<i>|<u>|"><script/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &quot;x&quot;/);
  assert.match(html, /href="\/t\/AL-%3Cb%3E"/);
});

test('the Console map: an area per stage in the loop\'s order, each with its name, count and place; no ticket dropped, an unknown status listed under the map (SP-333)', () => {
  const answer = {
    projects: [ALPHA, BETA],
    tickets: [
      consoleTicket({ id: 'AL-1', status: 'Queued' }),
      consoleTicket({ id: 'BE-1', project: 'beta', status: 'Needs your input', nextChange: { kind: 'operator' } }),
      consoleTicket({ id: 'AL-2', status: 'Odd' }),
    ],
  };
  const html = renderConsole(answer, CONSOLE_NOW);
  const order = [...html.matchAll(/<section class="map-area" data-stage="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['Requested', 'Needs your input', 'Queued', 'Building', 'In review', 'Rework', 'Ready to launch', 'Live']);
  assert.ok(!order.includes('Go'), '"Go" is the operator\'s answer, not a stage');
  assert.match(html, /<div class="console"><a class="map-funnel" href="\/new"[^>]*>[\s\S]*?<\/a><div class="console-map" role="group" aria-label="The loop">/);
  assert.match(html, /data-area="Requested" data-x="0" data-y="0" data-w="0\.2" data-h="0\.8"><h2><span class="stage-name">Requested<\/span><span class="count quiet">0<\/span><\/h2><div class="tiles"><\/div>/);
  const area = (s) => html.slice(html.indexOf(`<section class="map-area" data-stage="${s}"`), html.indexOf('</section>', html.indexOf(`<section class="map-area" data-stage="${s}"`)));
  assert.match(area('Queued'), /<a class="tile" data-x="[\d.]+" data-y="[\d.]+" data-size="[\d.]+" href="\/t\/AL-1"/);
  assert.match(area('Needs your input'), /<a class="tile waiting" data-x=[^>]*href="\/t\/BE-1"/);
  assert.match(html, /<section class="console-other"><h2>Other Statuses<\/h2><div class="tiles"><a class="tile" href="\/t\/AL-2"/);
  assert.doesNotMatch(html, /style="/, 'places are data, never a style attribute');
  assert.match(renderConsole(null, CONSOLE_NOW), /^<div class="console"><a class="map-funnel" href="\/new"[\s\S]*?<\/a><div class="console-map"[^>]*>(<section class="map-area"[\s\S]*?<\/section>){8}<svg class="map-detours"[\s\S]*?<\/svg><\/div><p class="map-detours-key quiet">[^<]+<\/p><\/div>$/);
});

test('the Console map\'s areas tile the map with no overlap, in the layout the operator drew (SP-333, SP-374)', () => {
  const inside = (a) => a.x >= 0 && a.y >= 0 && a.x + a.w <= MAP_UNITS.width && a.y + a.h <= MAP_UNITS.height;
  const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  assert.ok(MAP_AREAS.every(inside));
  for (const a of MAP_AREAS) for (const b of MAP_AREAS) if (a !== b) assert.ok(!overlap(a, b), `${a.status} overlaps ${b.status}`);
  assert.equal(MAP_AREAS.reduce((n, a) => n + a.w * a.h, 0), MAP_UNITS.width * MAP_UNITS.height, 'every part of the map belongs to a stage');
  const at = Object.fromEntries(MAP_AREAS.map((a) => [a.status, a]));
  // SP-374, the operator's picture: Requested tall on the left, spanning both rows.
  assert.deepEqual([at.Requested.x, at.Requested.y], [0, 0]);
  assert.equal(at.Requested.h, at.Queued.h + at['Needs your input'].h);
  // The top row, left to right: Queued, Building, In review, meeting edge to edge.
  const top = ['Queued', 'Building', 'In review'];
  const bottom = ['Needs your input', 'Rework', 'Ready to launch'];
  assert.equal(at.Queued.x, at.Requested.x + at.Requested.w);
  for (const s of top) assert.equal(at[s].y, 0, `${s} is on the top row`);
  for (let i = 1; i < top.length; i++) assert.equal(at[top[i]].x, at[top[i - 1]].x + at[top[i - 1]].w, `${top[i]} right of ${top[i - 1]}`);
  // Each stop off the path under the stage above it, the same width.
  bottom.forEach((s, i) => {
    assert.equal(at[s].x, at[top[i]].x, `${s} under ${top[i]}`);
    assert.equal(at[s].w, at[top[i]].w);
    assert.equal(at[s].y, at[top[i]].y + at[top[i]].h);
  });
  // Live: one strip across the whole width, under both rows, about a third the height of a row.
  assert.deepEqual([at.Live.x, at.Live.w, at.Live.y], [0, MAP_UNITS.width, at.Requested.h]);
  assert.ok(at.Live.h <= at.Queued.h / 2, 'Live is a short strip');
  // Exits follow the layout.
  assert.deepEqual(Object.fromEntries(MAP_AREAS.map((a) => [a.status, a.exit])), {
    Requested: 'right', 'Needs your input': 'up', Queued: 'right', Building: 'right', 'In review': 'down', Rework: 'up', 'Ready to launch': 'down', Live: 'right',
  });
  // The shares the page draws by meet exactly too: rounding must not push one area onto its neighbour.
  const drawn = [...renderConsole(null, CONSOLE_NOW).matchAll(/data-area="([^"]+)" data-x="([\d.]+)" data-y="([\d.]+)" data-w="([\d.]+)" data-h="([\d.]+)"/g)]
    .map(([, status, x, y, w, h]) => ({ status, x: +x, y: +y, w: +w, h: +h }));
  assert.equal(drawn.length, MAP_AREAS.length);
  const eps = 1e-9;
  for (const a of drawn) for (const b of drawn) if (a !== b) assert.ok(!(a.x + eps < b.x + b.w && b.x + eps < a.x + a.w && a.y + eps < b.y + b.h && b.y + eps < a.y + a.h), `${a.status} drawn over ${b.status}`);
  assert.deepEqual(MAP_AREAS.map((a) => a.status).sort(), ['Building', 'In review', 'Live', 'Needs your input', 'Queued', 'Ready to launch', 'Requested', 'Rework']);
});

test('the routes are drawn as arrows for every way the code moves a ticket between stages, green forward and red back, and none from Requested straight to Queued (SP-334, SP-374)', () => {
  const routes = MAP_DETOURS.map((d) => `${d.kind}: ${d.from} -> ${d.to}`).sort();
  assert.deepEqual(routes, [
    'back: Building -> Needs your input',
    'back: In review -> Needs your input',
    'back: In review -> Rework',
    'forward: Building -> In review',
    'forward: In review -> Ready to launch',
    'forward: Needs your input -> Live',
    'forward: Needs your input -> Queued',
    'forward: Needs your input -> Rework',
    'forward: Queued -> Building',
    'forward: Ready to launch -> Live',
    'forward: Requested -> Needs your input',
    'forward: Rework -> Building',
  ]);
  assert.ok(!MAP_DETOURS.some((d) => d.from === 'Requested' && d.to === 'Queued'), 'every new request stops in Needs your input for "go" first');
  const at = Object.fromEntries(MAP_AREAS.map((a) => [a.status, a]));
  const inArea = ([x, y], a) => x > a.x && x < a.x + a.w && y > a.y && y < a.y + a.h;
  // Two areas share a border when they meet edge to edge along some length.
  const span = (a0, a1, b0, b1) => Math.min(a1, b1) - Math.max(a0, b0);
  const touch = (a, b) => ((a.x + a.w === b.x || b.x + b.w === a.x) && span(a.y, a.y + a.h, b.y, b.y + b.h) > 0)
    || ((a.y + a.h === b.y || b.y + b.h === a.y) && span(a.x, a.x + a.w, b.x, b.x + b.w) > 0);
  const rowLine = at.Queued.y + at.Queued.h;
  for (const d of MAP_DETOURS) {
    assert.ok(inArea(d.path[0], at[d.from]), `${d.from} -> ${d.to} starts in ${d.from}`);
    assert.ok(inArea(d.path[d.path.length - 1], at[d.to]), `${d.from} -> ${d.to} ends in ${d.to}`);
    assert.ok(d.why && d.why.length > 10, `${d.from} -> ${d.to} says when a ticket takes it`);
    if (touch(at[d.from], at[d.to])) continue;
    // Areas that do not share a border (In review meets Rework only at a corner): the arrow bends along the borders
    // between areas to get there, each bend on the line between the rows or between two columns.
    const columns = new Set(MAP_AREAS.filter((x) => x.y === 0).map((x) => x.x).filter((x) => x > 0));
    assert.ok(d.path.length > 2, `${d.from} -> ${d.to} bends to get there`);
    assert.ok(d.path.slice(1, -1).every(([x, y]) => y === rowLine || columns.has(x)), `${d.from} -> ${d.to} bends only on the borders between areas`);
  }
  // Short arrows, so each covers little of either area.
  for (const d of MAP_DETOURS) if (d.path.length === 2) assert.ok(Math.hypot(d.path[1][0] - d.path[0][0], d.path[1][1] - d.path[0][1]) <= 15, `${d.from} -> ${d.to} is short`);
});

test('the detours SVG: in map units over the map, one titled group per route, the head pointing along the last stretch, and a line under the map (SP-334)', () => {
  const svg = renderDetours();
  assert.match(svg, /^<svg class="map-detours" viewBox="0 0 160 100" role="img" aria-label="Routes: Requested to Needs your input; [^"]+">/);
  const groups = [...svg.matchAll(/<g class="detour detour-(forward|back)" data-from="([^"]+)" data-to="([^"]+)"><title>([^<]+)<\/title><path class="detour-line" d="([^"]+)"\/><path class="detour-head" d="([^"]+)"\/><\/g>/g)];
  assert.equal(groups.length, MAP_DETOURS.length);
  assert.match(groups[0][4], /^Requested → Needs your input: /);
  assert.doesNotMatch(svg, /style="/);
  // A rightward arrow from (33, 58) to (43, 58): the line stops at the head's base, the head points right.
  const { line, head } = detourPathData([[33, 58], [43, 58]]);
  assert.equal(line, 'M33 58 L40.4 58');
  assert.equal(head, 'M43 58 L40.4 59.8 L40.4 56.2 Z');
  const up = detourPathData([[70, 37.5], [70, 28]]);
  assert.match(up.head, /^M70 28 L/);
  const html = renderConsole(null, CONSOLE_NOW);
  assert.ok(html.indexOf('<svg class="map-detours"') > html.lastIndexOf('<section class="map-area"'), 'drawn after the areas, so over their backgrounds');
  assert.ok(html.includes(`<p class="map-detours-key quiet">${DETOURS_KEY}</p>`));
  const css = readFileSync(WEB('app.css'), 'utf8');
  assert.match(css, /\.map-detours \{ position: absolute; inset: 0;[^}]*z-index: 1;[^}]*pointer-events: none; \}/);
  assert.match(css, /\.console-map \.tile \{[^}]*z-index: 2; \}/, 'tiles sit over the arrows');
  assert.match(css, /\.console-map \.tile\.more\[open\] \{ z-index: 3; \}/, 'an open More list rises over the other tiles');
  assert.match(css, /\.map-detours \.detour \{ --detour: var\(--map-arrow-forward\);/, 'forward is green');
  assert.match(css, /\.map-detours \.detour-back \{ --detour: var\(--map-arrow-back\); \}/, 'back is red');
  assert.match(css, /--map-arrow-forward: #16a34a;/);
  assert.match(css, /--map-arrow-back: #dc2626;/);
  assert.match(css, /@media \(max-width: 700px\) \{[\s\S]*?\.map-detours, \.map-detours-key \{ display: none; \}/, 'a stacked phone view has no map for arrows to cross');
});

test('in Queued the next to build sits nearest the exit toward Building, the rest in build order; the same answer always draws the same places (SP-333)', () => {
  const queued = MAP_AREAS.find((a) => a.status === 'Queued');
  const tickets = ['AL-1', 'AL-2', 'AL-3', 'AL-4'].map((id) => consoleTicket({ id }));
  const placed = placeArea(queued, tickets, CONSOLE_NOW);
  const first = placed.tiles[0];
  assert.equal(first.ticket.id, 'AL-1');
  assert.equal(first.col, placed.grid.cols - 1, 'the right-hand column, toward Building');
  assert.equal(first.row, 0);
  assert.deepEqual(placed.tiles.map((t) => t.ticket.id), ['AL-1', 'AL-2', 'AL-3', 'AL-4']);
  for (let i = 1; i < placed.tiles.length; i++) assert.ok(placed.tiles[i].col <= placed.tiles[i - 1].col, 'each later one no nearer the exit');
  assert.equal(renderConsole({ projects: [ALPHA], tickets }, CONSOLE_NOW), renderConsole({ projects: [ALPHA], tickets }, CONSOLE_NOW));
  const slots = new Set(placed.tiles.map((t) => `${t.col},${t.row}`));
  assert.equal(slots.size, tickets.length, 'no two tiles in one place');
});

test('in Building and In review a tile drifts toward the exit the longer it sits; a stuck one is pressed against it (SP-333)', () => {
  const building = MAP_AREAS.find((a) => a.status === 'Building');
  const review = MAP_AREAS.find((a) => a.status === 'In review');
  const ago = (h) => new Date(CONSOLE_NOW - h * 3_600_000).toISOString();
  assert.equal(driftOf(consoleTicket({ status: 'Building', stageSince: ago(0) }), CONSOLE_NOW), 0);
  assert.equal(driftOf(consoleTicket({ status: 'Building', stageSince: ago(1.5) }), CONSOLE_NOW), 0.5);
  assert.equal(driftOf(consoleTicket({ status: 'Building', stageSince: ago(30) }), CONSOLE_NOW), 1, 'never past the exit');
  assert.equal(driftOf(consoleTicket({ status: 'In review', stageSince: ago(3) }), CONSOLE_NOW), 0.5);
  assert.equal(driftOf(consoleTicket({ status: 'Queued', stageSince: ago(3) }), CONSOLE_NOW), 0, 'only the two drift areas drift');
  const fresh = consoleTicket({ id: 'AL-1', status: 'Building', stageSince: ago(0) });
  const stuck = consoleTicket({ id: 'AL-2', status: 'Building', stageSince: ago(5) });
  const b = placeArea(building, [fresh, stuck], CONSOLE_NOW);
  const col = (id) => b.tiles.find((t) => t.ticket.id === id).col;
  assert.equal(col('AL-2'), b.grid.cols - 1, 'stuck: against the exit toward In review');
  assert.equal(col('AL-1'), 0, 'just in: at the entrance');
  // In review leaves downward, toward Ready to launch.
  const r = placeArea(review, [consoleTicket({ id: 'AL-3', status: 'In review', stageSince: ago(9) })], CONSOLE_NOW);
  assert.equal(r.tiles[0].row, r.grid.rows - 1);
  // A full line pushes the next one to the nearest line with room, never onto another tile.
  const many = Array.from({ length: 6 }, (_, i) => consoleTicket({ id: `AL-${10 + i}`, status: 'Building', stageSince: ago(9) }));
  const crowd = placeArea(building, many, CONSOLE_NOW);
  assert.equal(new Set(crowd.tiles.map((t) => `${t.col},${t.row}`)).size, crowd.tiles.length);
});

test('a filling area shrinks its tiles, and past what it holds shows "+N More" with the rest; fifty tickets never spill out of the area (SP-333)', () => {
  const queued = MAP_AREAS.find((a) => a.status === 'Queued');
  const one = placeArea(queued, [consoleTicket()], CONSOLE_NOW);
  assert.equal(one.grid.size, TILE_MAX);
  const many = Array.from({ length: 50 }, (_, i) => consoleTicket({ id: `AL-${i + 1}` }));
  const full = placeArea(queued, many, CONSOLE_NOW);
  assert.equal(full.grid.size, TILE_MIN);
  assert.ok(full.more, 'a "+N more" tile');
  assert.equal(full.tiles.length + full.more.hidden.length, 50, 'every ticket is shown or in the more list');
  assert.equal(full.tiles.length + 1, full.grid.cols * full.grid.rows);
  assert.equal(full.more.hidden[0].id, `AL-${full.tiles.length + 1}`, 'the last in build order go in it');
  for (const slot of [...full.tiles, full.more]) {
    const { x, y, size } = slotShare(queued, full.grid, slot);
    assert.ok(x >= 0 && x + size <= 1, 'inside the area across');
    assert.ok(y >= 0 && y + size * queued.w / queued.h <= 1.0001, 'inside the area down');
  }
  const html = renderConsole({ projects: [ALPHA], tickets: many.map((t) => ({ ...t, status: 'Queued' })) }, CONSOLE_NOW);
  const n = full.more.hidden.length;
  assert.match(html, new RegExp(`<details class="tile more opens-right opens-down tile-tiny" data-stage="Queued"[^>]*><summary aria-label="${n} more in Queued">\\+${n} More</summary><ul class="more-list"><li><a href="/t/AL-${full.tiles.length + 1}">`));
  assert.match(html, /<a class="tile tile-tiny" data-x=/);
  assert.equal(tileSizeClass(TILE_MAX), '');
  assert.equal(tileSizeClass(TILE_COMPACT - 0.5), 'tile-compact');
  assert.equal(tileSizeClass(TILE_TINY - 0.5), 'tile-tiny');
});

test('a "+N More" list opens toward the middle of the map, so Requested\'s, at the far left, and Live\'s, at the bottom, stay on screen (SP-333)', () => {
  const many = (status) => Array.from({ length: 60 }, (_, i) => consoleTicket({ id: `AL-${i + 1}`, status, stageSince: new Date(CONSOLE_NOW - 3_600_000).toISOString() }));
  const opens = {};
  for (const area of MAP_AREAS) {
    const placed = placeArea(area, many(area.status), CONSOLE_NOW);
    assert.ok(placed.more, `${area.status} overflows at 60`);
    opens[area.status] = moreOpens(area, placed.grid, placed.more);
    // The tile's left edge, as a share of the map: an anchored-left list starts there, an anchored-right one ends at its right edge.
    const { x, size } = slotShare(area, placed.grid, placed.more);
    const left = (area.x + x * area.w) / MAP_UNITS.width;
    const right = left + size * area.w / MAP_UNITS.width;
    // At the map's narrowest (60rem) the 22rem list must fit on the side it opens toward.
    if (opens[area.status].includes('opens-right')) assert.ok((1 - left) * 60 >= 22, `${area.status} opens right with room`);
    else assert.ok(right * 60 >= 22, `${area.status} opens left with room`);
    // And the list, up to 15rem tall, fits above or below it on the map (60rem wide, so 37.5rem tall).
    const tall = 60 * MAP_UNITS.height / MAP_UNITS.width;
    const topAt = (area.y + slotShare(area, placed.grid, placed.more).y * area.h) / MAP_UNITS.height;
    const bottomAt = topAt + placed.grid.size / MAP_UNITS.height;
    if (opens[area.status].includes('opens-up')) assert.ok(topAt * tall >= 15, `${area.status} opens up with room`);
    else assert.ok((1 - bottomAt) * tall >= 15, `${area.status} opens down with room`);
  }
  assert.equal(opens.Requested, 'opens-right opens-up', 'far left, low: rightward and up');
  assert.match(opens.Live, /opens-right opens-up/);
  // Ready to launch's More tile is its top row (its exit is down), just above the middle: its list opens down, over Live.
  assert.match(opens['Ready to launch'], /opens-down/);
  assert.match(opens.Queued, /opens-down/);
  const html = renderConsole({ projects: [ALPHA], tickets: many('Requested') }, CONSOLE_NOW);
  assert.match(html, /<details class="tile more opens-right opens-up tile-tiny" data-stage="Requested"/);
  const css = readFileSync(WEB('app.css'), 'utf8');
  assert.match(css, /\.tile\.more\.opens-right \.more-list \{ left: 0; \}/);
  assert.match(css, /\.tile\.more\.opens-up \.more-list \{ bottom: 100%;/);
  assert.doesNotMatch(/\.tile\.more \.more-list \{[^}]*\}/.exec(css)[0], /right: 0|top: 100%/, 'the base list is anchored by its direction only');
});

test('a Live tile shows no next change, and says none aloud: it is finished (SP-333)', () => {
  const live = renderConsoleTile(consoleTicket({ status: 'Live', nextChange: null }), ALPHA, CONSOLE_NOW);
  assert.doesNotMatch(live, /class="fact next"/);
  assert.doesNotMatch(live, /next change/);
  assert.match(live, /class="fact age"/);
  assert.match(renderConsoleTile(consoleTicket({ status: 'Queued' }), ALPHA, CONSOLE_NOW), /class="fact next"/, 'in flight: still shown');
});

test('Live shows the launches the server sends, newest on the right where they arrive, each fading with age (SP-333)', () => {
  const ago = (h) => new Date(CONSOLE_NOW - h * 3_600_000).toISOString();
  const tickets = [
    consoleTicket({ id: 'AL-1', status: 'Live', stageSince: ago(20), nextChange: null }),
    consoleTicket({ id: 'AL-2', status: 'Live', stageSince: ago(1), nextChange: null }),
    consoleTicket({ id: 'AL-3', status: 'Live', stageSince: ago(30), nextChange: null }),
  ];
  const html = renderConsole({ projects: [ALPHA], tickets }, CONSOLE_NOW);
  // The server (consoleOf, on its own clock) leaves out launches over a day old; the page does not filter again on the browser's clock.
  assert.match(html, /\/t\/AL-3"/, 'sent by the server: drawn, at the fade floor');
  assert.doesNotMatch(/export function renderConsole\([\s\S]*?\n\}/.exec(renderScript())[0], /LIVE_SHOWN_MS/);
  const live = html.slice(html.indexOf('data-stage="Live" data-area'));
  assert.ok(live.indexOf('/t/AL-2"') < live.indexOf('/t/AL-1"'), 'newest first, on the right under Ready to launch, where launches arrive');
  assert.match(live, /data-fade="0\.97" href="\/t\/AL-2"/);
  assert.match(live, /data-fade="0\.42" href="\/t\/AL-1"/);
  assert.equal(liveFade(consoleTicket({ stageSince: ago(0) }), CONSOLE_NOW), 1);
  assert.equal(liveFade(consoleTicket({ stageSince: ago(24) }), CONSOLE_NOW), LIVE_FADE_FLOOR);
  assert.match(live, /data-fade="0\.3" href="\/t\/AL-3"/);
  assert.match(live, /<span class="count quiet">3<\/span>/);
});

test('the Console page: /in-flight and the stage colours drawn, a Console link beside Board and List, remembered for "Tasks", redrawn every beat', () => {
  const app = pageScript();
  const draw = /async function drawConsole\(\) \{([\s\S]*?)\n\}/.exec(app)[1];
  assert.match(draw, /api\('GET', '\/in-flight'\)/);
  assert.match(draw, /api\('GET', '\/stage-colours'\)/);
  assert.match(draw, /localStorage\.setItem\(VIEW_KEY, 'console'\)/);
  assert.match(draw, /renderConsole\(shown, Date\.now\(\), \{ running: runningAreas\(lastPipeline\(\)\) \}\)\}`;[\s\S]*?placeOnMap\(\);\s*showLanesRunning\(\);/);
  assert.match(draw, /shown\.tickets\.some\(\(t\) => t\.status !== 'Live'\) \? '' : '<p class="quiet">Nothing is in flight\.<\/p>'/, 'the last day\'s launches are not work in flight');
  // Each place becomes a CSS value set from the page's code, never a style attribute.
  const place = /function placeOnMap\(\) \{([\s\S]*?)\n\}/.exec(app)[1];
  assert.match(place, /el\.style\.setProperty\(prop, el\.dataset\[key\]\)/);
  assert.match(draw, /<div class="tasks-head title-row"><h1>Tasks<\/h1>\$\{slug \? viewSwitch\(slug, 'console'\) : ''\}<\/div>/, 'the tabs at the right of the title row, as on Board and List (SP-326)');
  // The view switch names all three in Title Case, the current one marked.
  const sw = /function viewSwitch\(slug, current\) \{([\s\S]*?)\n\}/.exec(app)[1];
  assert.match(sw, /\['board', 'Board', [^\]]+\], \['list', 'List', [^\]]+\], \['console', 'Console', '\/console'\]/);
  assert.match(sw, /<nav class="tabs" aria-label="View">/, 'a tab bar (UI_DOCTRINE 5, SP-322), not a segmented control');
  assert.match(sw, /v === current \? ' aria-current="page"' : ''/);
  assert.match(/async function drawProject\(([^)]*)\) \{([\s\S]*?)\n\}/.exec(app)[2], /\$\{viewSwitch\(board\.project, view\)\}/);
  // "Tasks" in the header reopens the Console when it was chosen last.
  assert.match(app, /await drawTasks\(savedTasksView\(\)\);/);
  assert.match(/async function drawTasks\(view, opts = \{\}\) \{([\s\S]*?)\n\}/.exec(app)[1], /if \(view === 'console'\) \{\s*history\.replaceState\(null, '', '\/console'\);\s*return drawConsole\(\);/);
  // The minute's beat draws it again whether or not the answer changed, so "in 12 min" counts down.
  assert.match(app, /lastDrawn = \{ address: here\(\), reads, ticking: true \}/);
  assert.match(app, /const changed = drawn\.ticking \|\|/);
  // That beat does not read every answer first only to throw it away: one read of /in-flight a minute, not two.
  const refresh = /async function refreshPage\(\) \{[\s\S]*?\n\}/.exec(app)[0];
  assert.match(refresh, /const now = drawn\.ticking \? \[\] : await Promise\.all\(/);
});

test('the Console map\'s look: areas at 20% of their colour, a set stage colour taking over, the map one shape that scales, a narrow screen stacked (SP-333)', () => {
  const css = readFileSync(WEB('app.css'), 'utf8');
  assert.match(css, /\.console-map \{[^}]*aspect-ratio: 160 \/ 100;/);
  assert.match(css, /\.map-area \{[^}]*background: color-mix\(in srgb, var\(--area\) 20%, var\(--bg-surface\)\);/);
  assert.match(css, /\.map-area\.coloured \{ --area: var\(--stage-border\); \}/);
  for (const a of MAP_AREAS.filter((x) => x.status !== 'Requested')) assert.match(css, new RegExp(`\\.map-area\\[data-area="${a.status}"\\] \\{ --area: var\\(--map-[a-z-]+\\); \\}`));
  assert.match(css, /\.console-map \.tile \{[^}]*left: calc\(var\(--at-x\) \* 100%\);[^}]*width: calc\(var\(--at-size\) \* 100%\);[^}]*aspect-ratio: 1;/);
  assert.match(css, /@media \(max-width: 700px\) \{[\s\S]*?\.map-area \{ position: static;/);
  // The dim of a Features pick comes after Live's fade, so a picked feature still dims a Live tile.
  // A Live tile's fade (.console-map .tile[data-fade]) is three selectors deep, so the map's dim is too, and comes after it: a pick dims a Live tile.
  assert.match(css, /\n\.console-map \.tile\.dimmed \{ opacity: 0\.25; \}/);
  assert.ok(css.indexOf('.console-map .tile[data-fade]') < css.indexOf('.console-map .tile.dimmed'));
});

test('the Console\'s minute redraw keeps how far across he has scrolled', () => {
  const app = pageScript();
  assert.match(app, /const SIDEWAYS = '\.console';/);
  const place = /function keepPlace\(\) \{[\s\S]*?\n\}/.exec(app)[0];
  // Read before the redraw, put back on the new columns before the page is shown.
  assert.match(place, /const across = \[\.\.\.main\.querySelectorAll\(SIDEWAYS\)\]\.map\(\(el\) => el\.scrollLeft\);/);
  assert.match(place, /restore\(\) \{[\s\S]*\[\.\.\.main\.querySelectorAll\(SIDEWAYS\)\]\.forEach\(\(el, i\) => \{ if \(i < across\.length\) el\.scrollLeft = across\[i\]; \}\);[\s\S]*window\.scrollTo\(0, y\);/);
  // The Console's map is the area that scrolls sideways on a window narrower than it.
  assert.match(renderConsole({ tickets: [], projects: [] }), /^<div class="console">/);
  assert.match(readFileSync(WEB('app.css'), 'utf8'), /\.console \{[^}]*overflow-x: auto/);
});

test('beside the work-in-progress cap: the count in flight now, marked full at the cap, nothing when unknown (SP-238)', () => {
  const cap = { key: 'wip-cap', value: '3' };
  assert.equal(capInFlightText(cap, { count: 2, ids: ['SP-1', 'SP-2'] }), '<span class="in-flight">2 in flight now.</span>');
  assert.equal(capInFlightText(cap, { count: 3, ids: ['SP-1', 'SP-2', 'SP-3'] }),
    '<span class="in-flight full">3 in flight now: full, loop-build is not claiming new tickets.</span>');
  assert.equal(capInFlightText(cap, undefined), '');
  assert.equal(capInFlightText(cap, { count: null }), '');
});

// ── The Console's feature colours (SP-234) ──────────────────────────────────

test('a ticket\'s feature is its first tag, passing over request-form; no tag, or only request-form, is no feature', () => {
  assert.equal(consoleFeature(consoleTicket({ tags: ['tracker', 'tracker-5'] })), 'tracker');
  assert.equal(consoleFeature(consoleTicket({ tags: ['request-form', 'console'] })), 'console');
  assert.equal(consoleFeature(consoleTicket({ tags: ['request-form'] })), null);
  assert.equal(consoleFeature(consoleTicket({ tags: [] })), null);
  assert.equal(consoleFeature(consoleTicket({ tags: null })), null);
  assert.equal(consoleFeature(consoleTicket({ tags: ['', '  '] })), null);
});

test('a feature\'s colour is a pure function of its tag: the same on every call, always a palette colour, and different tags usually differ', () => {
  for (const tag of ['tracker', 'console', 'onboarding', 'ünïcode', '']) {
    const i = featureColourIndex(tag);
    assert.ok(Number.isInteger(i) && i >= 0 && i < FEATURE_PALETTE.length, tag);
    assert.equal(featureColourIndex(tag), i, `${tag} keeps its colour`);
  }
  // Fixed values, so a change to the rule (which would recolour every feature) is a decision, not an accident.
  assert.deepEqual(['tracker', 'console', 'onboarding'].map(featureColourIndex), [5, 8, 6]);
  const many = Array.from({ length: 200 }, (_, i) => featureColourIndex(`feature-${i}`));
  assert.equal(new Set(many).size, FEATURE_PALETTE.length, 'the rule uses every colour');
});

test('two tiles with the same feature share a colour class; a tile with no feature keeps the plain tile', () => {
  const a = renderConsoleTile(consoleTicket({ id: 'AL-1', tags: ['tracker'] }), ALPHA, CONSOLE_NOW);
  const b = renderConsoleTile(consoleTicket({ id: 'BE-1', project: 'beta', tags: ['tracker', 'other'] }), BETA, CONSOLE_NOW);
  const n = featureColourIndex('tracker');
  for (const html of [a, b]) {
    assert.match(html, new RegExp(`^<a class="tile feature feature-${n}" data-feature="tracker" `));
    assert.match(html, /aria-label="[^"]*; feature tracker\."/);
  }
  assert.match(renderConsoleTile(consoleTicket({ tags: ['request-form'] }), ALPHA, CONSOLE_NOW), /^<a class="tile" href=/);
  assert.match(renderConsoleTile(consoleTicket({ tags: ['x'], waitingOnOperator: true }), ALPHA, CONSOLE_NOW), /^<a class="tile feature feature-\d+ waiting" data-feature="x" /);
  assert.match(renderConsoleTile(consoleTicket({ tags: ['<b>"'] }), ALPHA, CONSOLE_NOW), /data-feature="&lt;b&gt;&quot;"/);
});

test('every feature colour has its rule in app.css, in palette order, and the tile\'s text reads on it', () => {
  const css = drawnCss();
  const rules = [...css.matchAll(/^\.feature-(\d+) \{ --feature: (#[0-9a-f]{6}); \}$/gm)].map((m) => [Number(m[1]), m[2]]);
  assert.deepEqual(rules, FEATURE_PALETTE.map((c, i) => [i, c]));
  assert.match(css, /\.tile\.feature \{ background: var\(--feature\); \}/);
  assert.match(css, /\.tile\.dimmed \{ opacity: [0-9.]+; \}/);
  const ink = /--ink-primary: (#[0-9a-f]{6})/.exec(css)[1];
  for (const colour of FEATURE_PALETTE) assert.ok(contrast(ink, colour) >= 4.5, `${ink} reads on ${colour}`);
  // The facts strip stays white, so the stage colours and the quiet age read as before.
  assert.match(css, /\.tile\.feature \.tile-facts \{ background: #fff(?:fff)?; \}/);
});

test('the Features key lists each feature on screen with its count, most first, and nothing when there is none', () => {
  const tickets = [
    consoleTicket({ id: 'AL-1', tags: ['console'] }),
    consoleTicket({ id: 'AL-2', tags: ['tracker'] }),
    consoleTicket({ id: 'AL-3', tags: ['tracker'] }),
    consoleTicket({ id: 'AL-4', tags: ['request-form'] }),
    consoleTicket({ id: 'AL-5', tags: ['alpha'] }),
  ];
  const key = renderFeatureKey(tickets);
  assert.match(key, /^<div class="feature-key" role="group" aria-label="Features"><span class="key-title">Features<\/span>/);
  const listed = [...key.matchAll(/data-feature="([^"]+)" aria-pressed="false"[^>]*><span class="swatch" aria-hidden="true"><\/span>[^<]+<span class="count">(\d+)<\/span>/g)].map((m) => [m[1], Number(m[2])]);
  assert.deepEqual(listed, [['tracker', 2], ['alpha', 1], ['console', 1]]);
  assert.match(key, new RegExp(`class="feature-pick feature-${featureColourIndex('tracker')}" data-feature="tracker"`));
  assert.match(renderFeatureKey(tickets, 'tracker'), /data-feature="tracker" aria-pressed="true"/);
  assert.equal(renderFeatureKey([consoleTicket({ tags: ['request-form'] })]), '');
  assert.equal(renderFeatureKey(null), '');
  assert.match(renderFeatureKey([consoleTicket({ tags: ['<i>'] })]), /data-feature="&lt;i&gt;"[^>]*>.*&lt;i&gt;<span class="count">1/);
  // The key is no longer drawn over the map (SP-383): the page puts it in the row under the title.
  const map = renderConsole({ tickets, projects: [ALPHA] }, CONSOLE_NOW);
  assert.match(map, /^<div class="console">/);
  assert.doesNotMatch(map, /feature-key|feature-pick/);
});

// ── The Console's row under the title (SP-383) ───────────────────────────────

/** The template drawConsole puts in the page, from its first line to its last. */
const consoleDraw = () => /async function drawConsole\(\) \{([\s\S]*?)\n\}/.exec(pageScript())[1];

test('the Console has a row under its title: Project picker, Pipeline Stages pod, then the Features key, in that order (SP-383)', () => {
  const draw = consoleDraw();
  assert.match(draw, /\$\{slug \? viewSwitch\(slug, 'console'\) : ''\}<\/div>\s*<div class="toolbar tasks-bar">\$\{renderFilterBar\(\{\s*project: renderProjectPicker\(answer\.projects, pickedProject, \{ all: true \}\),\s*pod: '<button type="button" class="pipeline-pod" aria-haspopup="dialog" title="Open Pipeline Status"><\/button>',\s*after: renderFeatureKey\(shown\.tickets\),\s*\}\)\}<\/div>/);
  // The pod is filled and opens Pipeline Status as on Board and List.
  assert.match(draw, /<dialog class="pipeline-status" aria-labelledby="pipeline-status-title">[\s\S]*<div class="pipeline-details"><\/div>/);
  assert.match(draw, /wirePipeline\(\);\s*refreshPipeline\(\);/);
  const css = readFileSync(WEB('app.css'), 'utf8');
  assert.match(css, /\.tasks-bar \.feature-key \{ margin: 0; \}/);
});

test('the Console\'s row has no Topic picker, no Search box and no Kind / Started By / How It Ended filters (SP-383)', () => {
  const draw = consoleDraw();
  for (const absent of ['renderTopicPicker', 'searchForm', 'renderClassFilters', 'topic-picker', 'class-filters', 'form class="search"']) {
    assert.ok(!draw.includes(absent), `the Console draws no ${absent}`);
  }
  assert.equal((draw.match(/<select|renderProjectPicker/g) || []).length, 1, 'one picker: the Project picker');
});

test('the Project picker starts on All Projects; choosing a project leaves only its tickets on the map, its counts and its Features key (SP-383)', () => {
  const picker = renderProjectPicker([ALPHA, BETA], '', { all: true });
  assert.match(picker, /^<label class="project-picker">Project: <select name="project"><option value="" selected>All Projects<\/option><option value="alpha">Alpha<\/option><option value="beta">Beta<\/option><\/select><\/label>$/);
  assert.match(renderProjectPicker([ALPHA, BETA], 'beta', { all: true }), /<option value="">All Projects<\/option><option value="alpha">Alpha<\/option><option value="beta" selected>Beta/);
  // Board and List's picker is unchanged: no All Projects.
  assert.doesNotMatch(renderProjectPicker([ALPHA, BETA], 'alpha'), /All Projects|value=""/);
  const answer = {
    projects: [ALPHA, BETA],
    tickets: [
      consoleTicket({ id: 'AL-1', tags: ['console'] }),
      consoleTicket({ id: 'AL-2', status: 'Building', tags: ['console'] }),
      consoleTicket({ id: 'BE-1', project: 'beta', tags: ['mail'] }),
      consoleTicket({ id: 'BE-2', project: 'beta', status: 'Odd status', tags: ['mail'] }),
    ],
  };
  const all = consoleForProject(answer, '');
  assert.deepEqual(all.tickets.map((t) => t.id), ['AL-1', 'AL-2', 'BE-1', 'BE-2']);
  assert.deepEqual(consoleForProject(answer, 'gone').tickets.map((t) => t.id), ['AL-1', 'AL-2', 'BE-1', 'BE-2'], 'a project not in the answer is All Projects');
  const beta = consoleForProject(answer, 'beta');
  assert.deepEqual(beta.tickets.map((t) => t.id), ['BE-1', 'BE-2']);
  assert.deepEqual(beta.projects, [ALPHA, BETA], 'every project stays in the picker');
  const map = renderConsole(beta, CONSOLE_NOW);
  assert.doesNotMatch(map, /AL-1|AL-2/);
  assert.match(map, /href="\/t\/BE-1"/);
  assert.match(map, /<section class="console-other"><h2>Other Statuses<\/h2>[\s\S]*BE-2/);
  assert.match(map, /data-area="Queued"[^>]*><h2><span class="stage-name">Queued<\/span><span class="count quiet">1<\/span>/);
  assert.match(map, /data-area="Building"[^>]*><h2><span class="stage-name">Building<\/span><span class="count quiet">0<\/span>/);
  const key = renderFeatureKey(beta.tickets);
  assert.match(key, /data-feature="mail"/);
  assert.match(key, /<span class="count">2<\/span>/);
  assert.doesNotMatch(key, /data-feature="console"/);
  // The page filters before it draws, and draws the map, the empty line and the key from that.
  const draw = consoleDraw();
  assert.match(draw, /const shown = consoleForProject\(answer, pickedProject\);/);
  assert.ok(draw.indexOf('consoleForProject(answer, pickedProject)') < draw.indexOf('main.innerHTML'));
});

test('the picked project survives the minute redraw, is the Console\'s own, and a pick whose feature is gone is let go (SP-383)', () => {
  const app = pageScript();
  const draw = consoleDraw();
  // Kept in the page, not saved where Board and List read their project.
  assert.match(app, /\nlet pickedProject = '';/);
  assert.match(draw, /pickedProject = e\.target\.value;\s*route\(\);/);
  assert.doesNotMatch(draw, /PROJECT_KEY|localStorage\.setItem\(PROJECT/);
  assert.match(draw, /if \(!answer\.projects\.some\(\(p\) => p\.slug === pickedProject\)\) pickedProject = '';/);
  // After a project change the Features key is drawn afresh; a pick it no longer lists is released.
  assert.match(draw, /showFeaturePick\(\);\s*putTrail/);
  const show = /function showFeaturePick\(\) \{([\s\S]*?)\n\}/.exec(app)[1];
  assert.match(show, /if \(!picks\.some\(\(b\) => b\.dataset\.feature === pickedFeature\)\) pickedFeature = null;/);
  assert.match(show, /main\.querySelectorAll\('\.feature-pick'\)/);
});

test('a "+N More" tile names the features of the tickets it holds, so a pick dims it only when none of them match (SP-333)', () => {
  assert.equal(moreFeatures([consoleTicket({ tags: ['Board'] }), consoleTicket({ tags: [] }), consoleTicket({ tags: ['Board'] }), consoleTicket({ tags: ['Mail'] })]), 'Board\nMail');
  assert.equal(moreFeatures([consoleTicket({ tags: [] })]), '', 'no feature: an empty list, which every pick dims');
  assert.equal(moreFeatures(null), '');
  const many = Array.from({ length: 60 }, (_, i) => consoleTicket({ id: `AL-${i + 1}`, status: 'Queued', tags: i === 59 ? ['Mail'] : ['Board'] }));
  const html = renderConsole({ projects: [ALPHA], tickets: many }, CONSOLE_NOW);
  assert.match(html, /<details class="tile more[^"]*" data-stage="Queued" data-features="Board\nMail" data-x=/);
});

test('a click on a feature in the key dims every other tile, a second click shows them all, and the minute redraw keeps the pick', () => {
  const app = pageScript();
  const draw = /async function drawConsole\(\) \{([\s\S]*?)\n\}/.exec(app)[1];
  assert.match(draw, /pickedFeature = pickedFeature === b\.dataset\.feature \? null : b\.dataset\.feature;/);
  assert.match(draw, /showFeaturePick\(\);\s*putTrail/, 'the pick is put back after every draw');
  const show = /function showFeaturePick\(\) \{([\s\S]*?)\n\}/.exec(app)[1];
  assert.match(show, /tile\.classList\.toggle\('dimmed', pickedFeature !== null && !has\)/);
  // A "+N More" tile dims only when none of the tickets it holds is the picked feature.
  assert.match(show, /const has = tile\.dataset\.features !== undefined\s*\? tile\.dataset\.features\.split\('\\n'\)\.includes\(pickedFeature\)\s*: tile\.dataset\.feature === pickedFeature;/);
  assert.match(show, /b\.setAttribute\('aria-pressed', String\(b\.dataset\.feature === pickedFeature\)\)/);
  assert.match(show, /if \(!picks\.some\(\(b\) => b\.dataset\.feature === pickedFeature\)\) pickedFeature = null;/);
});

// ── Build running: the Building area pulses and its tiles glide (SP-365) ─────

test('the glide: a tile starts where its time in Building puts it and reaches the exit at three hours; one past three hours does not move (SP-365)', () => {
  const building = MAP_AREAS.find((a) => a.status === GLIDE_AREA);
  const ago = (h) => new Date(CONSOLE_NOW - h * 3_600_000).toISOString();
  const glideFor = (hours) => {
    const placed = placeArea(building, [consoleTicket({ status: 'Building', stageSince: ago(hours) })], CONSOLE_NOW);
    const entrance = slotShare(building, placed.grid, { col: 0, row: 0 }).x;
    // The exit line: where the tile's right edge meets the far side of the area's room (1.5 units of padding, AREA_PAD).
    const exit = Math.round(((building.w - 1.5 - placed.grid.size) / building.w) * 10_000) / 10_000;
    assert.ok(exit >= slotShare(building, placed.grid, { col: placed.grid.cols - 1, row: 0 }).x, 'never short of the last slot');
    return { glide: glidesOf(building, placed, CONSOLE_NOW)[0], entrance, exit };
  };
  const fresh = glideFor(0);
  assert.ok(fresh.exit > fresh.entrance, 'Building is wide enough to cross');
  assert.deepEqual(fresh.glide, { ticket: fresh.glide.ticket, from: fresh.entrance, to: fresh.exit, ms: DRIFT_FULL_MS.Building });
  const half = glideFor(1.5);
  assert.ok(Math.abs(half.glide.from - (half.entrance + half.exit) / 2) < 0.001, 'an hour and a half in: halfway across');
  assert.equal(half.glide.to, half.exit);
  assert.equal(half.glide.ms, DRIFT_FULL_MS.Building / 2, 'and at the exit at the three-hour mark');
  const stuck = glideFor(5);
  assert.deepEqual([stuck.glide.from, stuck.glide.to, stuck.glide.ms], [stuck.exit, stuck.exit, 0], 'past three hours: at the exit, still');
  // A minute on, the answer is where the glide had brought the tile: the redraw carries on, no jump back.
  const placedNow = placeArea(building, [consoleTicket({ status: 'Building', stageSince: ago(1) })], CONSOLE_NOW);
  const now = glidesOf(building, placedNow, CONSOLE_NOW)[0];
  const later = glidesOf(building, placeArea(building, [consoleTicket({ status: 'Building', stageSince: ago(1) })], CONSOLE_NOW + 60_000), CONSOLE_NOW + 60_000)[0];
  const moved = now.from + (now.to - now.from) * (60_000 / now.ms);
  assert.ok(Math.abs(later.from - moved) < 0.0002, `a minute on: ${later.from} where the glide put it, ${moved}`);
  assert.equal(later.ms, now.ms - 60_000);
  // An area leaving any way but right or down has none.
  const rework = MAP_AREAS.find((a) => a.status === 'Rework');
  assert.equal(rework.exit, 'up');
  assert.deepEqual(glidesOf(rework, placeArea(rework, [consoleTicket({ status: 'Rework' })], CONSOLE_NOW), CONSOLE_NOW), []);
});

test('gliding tiles never end up on top of each other, and none runs into one stopped at the exit (SP-365)', () => {
  const building = MAP_AREAS.find((a) => a.status === GLIDE_AREA);
  const ago = (h) => new Date(CONSOLE_NOW - h * 3_600_000).toISOString();
  for (const hours of [[0, 0.1], [1.2, 1.8], [5, 2.9, 0.4], [9, 9, 9, 9, 9, 9], [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 0.2, 0.7, 2.2]]) {
    const tickets = hours.map((h, i) => consoleTicket({ id: `AL-${20 + i}`, status: 'Building', stageSince: ago(h) }));
    const placed = placeArea(building, tickets, CONSOLE_NOW);
    const glides = glidesOf(building, placed, CONSOLE_NOW);
    const size = slotShare(building, placed.grid, { col: 0, row: 0 }).size;
    const byRow = new Map();
    placed.tiles.forEach((t, i) => byRow.set(t.row, [...(byRow.get(t.row) ?? []), glides[i]]));
    for (const row of byRow.values()) {
      for (const g of row) assert.ok(g.from <= g.to && g.ms >= 0, 'only ever toward the exit');
      const at = (g, ms) => g.from + (g.to - g.from) * Math.min(1, g.ms ? ms / g.ms : 1);
      for (const ms of [0, 1_800_000, 5_400_000, DRIFT_FULL_MS.Building]) {
        const xs = row.map((g) => at(g, ms)).sort((a, b) => a - b);
        for (let i = 1; i < xs.length; i++) assert.ok(xs[i] - xs[i - 1] >= size - 0.0002, `${hours}: two tiles overlap ${ms / 60_000} min on`);
      }
    }
  }
});

test('the Building area carries "running" only while GET /pipeline says Build is running; an unreadable answer is not running (SP-365)', () => {
  const stages = (running) => ({ stages: [{ name: 'Intake', running: true }, { name: 'Build', running }, { name: 'Review', running: true }] });
  assert.equal(buildRunning(stages(true)), true);
  assert.equal(buildRunning(stages(false)), false, 'another lane running is not Build running');
  assert.equal(buildRunning(null), false, 'a failed read');
  assert.equal(buildRunning({}), false);
  const tickets = [consoleTicket({ status: 'Building', stageSince: '2026-11-12T17:00:00.000Z' })];
  const on = renderConsole({ projects: [ALPHA], tickets }, CONSOLE_NOW, { running: runningAreas(stages(true)) });
  const off = renderConsole({ projects: [ALPHA], tickets }, CONSOLE_NOW);
  assert.match(on, /<section class="map-area running" data-stage="Building"/);
  assert.match(on, /<section class="map-area running" data-stage="In review"/, 'Review is running in this answer too');
  assert.equal((on.match(/map-area running/g) ?? []).length, 2, 'only the two glide areas');
  assert.doesNotMatch(off, /map-area running/);
  assert.match(off, /data-glide="right" data-glide-from="[\d.]+" data-glide-to="[\d.]+" data-glide-ms="\d+"/);
  assert.doesNotMatch(on, /style=/, 'no style attribute: the page sets the glide after drawing');
  // The page follows every /pipeline read, and sets the glide as CSS values, as placeOnMap places tiles.
  const app = pageScript();
  assert.match(app, /document\.dispatchEvent\(new Event\(PIPELINE_READ\)\)/);
  assert.match(app, /document\.addEventListener\(PIPELINE_READ, showLanesRunning\)/);
  assert.match(app, /area\.classList\.toggle\('running', running\.includes\(status\)\)/);
  assert.match(app, /glideFrom: '--glide-from', glideTo: '--glide-to'/);
  // The pulse, the glide, and neither under reduced motion or on a phone's stacked areas.
  const css = readFileSync(WEB('app.css'), 'utf8');
  assert.match(css, /\.map-area\.running\[data-area="Building"\] \{ animation: area-pulse /);
  assert.match(css, /@keyframes area-pulse \{ from \{ background: color-mix\(in srgb, var\(--area\) 20%, var\(--bg-surface\)\); \} to \{ background: color-mix\(in srgb, var\(--area\) 30%, var\(--bg-surface\)\); \} \}/);
  assert.match(css, /\.map-area\.running \.tile\[data-glide-ms\] \{ animation: tile-glide var\(--glide-ms\) linear forwards; \}/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.map-area\.running\[data-area="Building"\], \.map-area\.running \.tile\[data-glide-ms\] \{ animation: none; \}/);
});

// ── Review running: the In review area's tiles glide down (SP-366) ─────────

test('the glide down: an In review tile starts where its time in review puts it and reaches the bottom at six hours; one past six hours does not move (SP-366)', () => {
  const review = MAP_AREAS.find((a) => a.status === 'In review');
  assert.equal(review.exit, 'down');
  const ago = (h) => new Date(CONSOLE_NOW - h * 3_600_000).toISOString();
  const glideFor = (hours) => {
    const placed = placeArea(review, [consoleTicket({ status: 'In review', stageSince: ago(hours) })], CONSOLE_NOW);
    const top = slotShare(review, placed.grid, { col: 0, row: 0 }).y;
    // The bottom: where the tile meets the foot of the area's room (SP-374: In review is one row of full-size tiles tall).
    const bottom = Math.round(((review.h - 1.5 - placed.grid.size) / review.h) * 10_000) / 10_000;
    assert.ok(bottom >= slotShare(review, placed.grid, { col: 0, row: placed.grid.rows - 1 }).y, 'never short of the last slot');
    return { glide: glidesOf(review, placed, CONSOLE_NOW)[0], top, bottom };
  };
  const fresh = glideFor(0);
  assert.ok(fresh.bottom > fresh.top, 'In review is tall enough to cross');
  assert.deepEqual(fresh.glide, { ticket: fresh.glide.ticket, from: fresh.top, to: fresh.bottom, ms: DRIFT_FULL_MS['In review'] });
  const half = glideFor(3);
  assert.ok(Math.abs(half.glide.from - (half.top + half.bottom) / 2) < 0.001, 'three hours in: halfway down');
  assert.equal(half.glide.to, half.bottom);
  assert.equal(half.glide.ms, DRIFT_FULL_MS['In review'] / 2, 'and at the bottom at the six-hour mark');
  const stuck = glideFor(8);
  assert.deepEqual([stuck.glide.from, stuck.glide.to, stuck.glide.ms], [stuck.bottom, stuck.bottom, 0], 'past six hours: at the bottom, still');
  // A minute on, the redraw carries on from where the glide had brought it.
  const at = (now) => glidesOf(review, placeArea(review, [consoleTicket({ status: 'In review', stageSince: ago(2) })], now), now)[0];
  const now = at(CONSOLE_NOW);
  const later = at(CONSOLE_NOW + 60_000);
  const moved = now.from + (now.to - now.from) * (60_000 / now.ms);
  assert.ok(Math.abs(later.from - moved) < 0.0002, `a minute on: ${later.from} where the glide put it, ${moved}`);
  assert.equal(later.ms, now.ms - 60_000);
});

test('In review tiles gliding down never end up on top of each other (SP-366)', () => {
  const review = MAP_AREAS.find((a) => a.status === 'In review');
  const ago = (h) => new Date(CONSOLE_NOW - h * 3_600_000).toISOString();
  for (const hours of [[0, 0.1], [2.4, 3.6], [9, 5.8, 0.4], [9, 9, 9, 9, 9, 9], [0, 1, 2, 3, 4, 5, 6, 7, 0.5, 1.5, 4.5, 0.2, 2.2, 3.3]]) {
    const tickets = hours.map((h, i) => consoleTicket({ id: `AL-${40 + i}`, status: 'In review', stageSince: ago(h) }));
    const placed = placeArea(review, tickets, CONSOLE_NOW);
    const glides = glidesOf(review, placed, CONSOLE_NOW);
    // Shares of the area's height: a tile's height is its width's share scaled by the area's shape.
    const tall = slotShare(review, placed.grid, { col: 0, row: 0 }).size * review.w / review.h;
    const byCol = new Map();
    placed.tiles.forEach((t, i) => byCol.set(t.col, [...(byCol.get(t.col) ?? []), glides[i]]));
    for (const col of byCol.values()) {
      for (const g of col) assert.ok(g.from <= g.to && g.ms >= 0, 'only ever down');
      const at = (g, ms) => g.from + (g.to - g.from) * Math.min(1, g.ms ? ms / g.ms : 1);
      for (const ms of [0, 3_600_000, 10_800_000, DRIFT_FULL_MS['In review']]) {
        const ys = col.map((g) => at(g, ms)).sort((a, b) => a - b);
        for (let i = 1; i < ys.length; i++) assert.ok(ys[i] - ys[i - 1] >= tall - 0.0003, `${hours}: two tiles overlap ${ms / 60_000} min on`);
      }
    }
  }
});

test('the In review area carries "running" only while GET /pipeline says Review is running, and glides down without the pulse (SP-366)', () => {
  assert.deepEqual(GLIDE_AREAS, { Building: 'Build', 'In review': 'Review' });
  const stages = (build, review) => ({ stages: [{ name: 'Build', running: build }, { name: 'Review', running: review }] });
  assert.equal(laneRunning(stages(false, true), 'Review'), true);
  assert.deepEqual(runningAreas(stages(false, true)), ['In review']);
  assert.deepEqual(runningAreas(stages(true, true)), ['Building', 'In review']);
  assert.deepEqual(runningAreas(stages(true, false)), ['Building']);
  assert.deepEqual(runningAreas(null), [], 'an unreadable answer: nothing runs');
  const tickets = [
    consoleTicket({ id: 'AL-1', status: 'Building', stageSince: '2026-11-12T17:00:00.000Z' }),
    consoleTicket({ id: 'AL-2', status: 'In review', stageSince: '2026-11-12T16:00:00.000Z' }),
  ];
  const html = (pipeline) => renderConsole({ projects: [ALPHA], tickets }, CONSOLE_NOW, { running: runningAreas(pipeline) });
  const reviewOnly = html(stages(false, true));
  assert.match(reviewOnly, /<section class="map-area running" data-stage="In review"/, 'In review runs, and never pulses');
  assert.match(reviewOnly, /<section class="map-area" data-stage="Building"/, 'Building still while Build sleeps');
  assert.match(reviewOnly, /data-glide="down" data-glide-from="[\d.]+" data-glide-to="[\d.]+" data-glide-ms="\d+" href="\/t\/AL-2"/);
  const both = html(stages(true, true));
  assert.match(both, /<section class="map-area running" data-stage="Building"/);
  assert.match(both, /<section class="map-area running" data-stage="In review"/);
  const neither = html(null);
  assert.doesNotMatch(neither, /map-area running/);
  // Only Building pulses: no pulse rule names In review.
  assert.doesNotMatch(readFileSync(WEB('app.css'), 'utf8'), /data-area="In review"\][^{]*\{ animation/);
  assert.doesNotMatch(both, /style=/, 'no style attribute');
  // In review's tiles glide on top, under the same reduced-motion and phone rules as Building's.
  const css = readFileSync(WEB('app.css'), 'utf8');
  assert.match(css, /\.map-area\.running \.tile\[data-glide="down"\] \{ animation-name: tile-glide-down; \}/);
  assert.match(css, /@keyframes tile-glide-down \{ from \{ top: calc\(var\(--glide-from\) \* 100%\); \} to \{ top: calc\(var\(--glide-to\) \* 100%\); \} \}/);
  assert.ok(css.indexOf('tile-glide-down;') < css.indexOf('@media (prefers-reduced-motion: reduce)'), 'reduced motion comes later, so it wins');
  // The page toggles every glide area on each /pipeline read.
  const app = pageScript();
  assert.match(app, /for \(const status of Object\.keys\(GLIDE_AREAS\)\)/);
});

// ── Tiles slide when their status changes (SP-335) ───────────────────────────

test('tileMoves: a tile in both draws that changed place moved, by how far; one that stayed is still', () => {
  const before = [{ id: 'a', x: 10, y: 20 }, { id: 'b', x: 50, y: 50 }];
  const after = [{ id: 'a', x: 210, y: 5 }, { id: 'b', x: 50, y: 50 }];
  assert.deepEqual(tileMoves(before, after), { moved: [{ id: 'a', dx: 200, dy: -15 }], still: ['b'], added: [], gone: [] });
});

test('tileMoves: a ticket new to the board is added; one gone from it is gone, with its old place', () => {
  const before = [{ id: 'a', x: 1, y: 2 }, { id: 'old', x: 30, y: 40 }];
  const after = [{ id: 'a', x: 1, y: 2 }, { id: 'new', x: 70, y: 80 }];
  assert.deepEqual(tileMoves(before, after), { moved: [], still: ['a'], added: ['new'], gone: [{ id: 'old', x: 30, y: 40 }] });
});

test('tileMoves: a shift inside its area (the queue moved up) slides too; a wobble under MOVE_MIN does not', () => {
  const before = [{ id: 'a', x: 0, y: 40 }, { id: 'b', x: 0, y: 80 }];
  const after = [{ id: 'a', x: 0, y: 40 + MOVE_MIN / 2 }, { id: 'b', x: 0, y: 40 + 40 / 2 }];
  assert.deepEqual(tileMoves(before, after).moved, [{ id: 'b', dx: 0, dy: -20 }]);
  assert.deepEqual(tileMoves(before, after).still, ['a']);
});

test('tileMoves: an empty board before fades every tile in; an empty board after fades every tile out', () => {
  const tiles = [{ id: 'a', x: 1, y: 2 }, { id: 'b', x: 3, y: 4 }];
  assert.deepEqual(tileMoves([], tiles), { moved: [], still: [], added: ['a', 'b'], gone: [] });
  assert.deepEqual(tileMoves(tiles, []), { moved: [], still: [], added: [], gone: tiles });
  assert.deepEqual(tileMoves([], []), { moved: [], still: [], added: [], gone: [] });
});

test('tileMoves: the first draw (no map before) moves and fades nothing', () => {
  const tiles = [{ id: 'a', x: 1, y: 2 }];
  assert.deepEqual(tileMoves(null, tiles), { moved: [], still: ['a'], added: [], gone: [] });
  assert.deepEqual(tileMoves(undefined, []), { moved: [], still: [], added: [], gone: [] });
});

test('tileMoves: an id listed twice counts once, at its first place', () => {
  const before = [{ id: 'a', x: 0, y: 0 }];
  const after = [{ id: 'a', x: 0, y: 0 }, { id: 'a', x: 99, y: 99 }];
  assert.deepEqual(tileMoves(before, after), { moved: [], still: ['a'], added: [], gone: [] });
});

test('the Console reads every tile\'s place before it redraws and slides them after, never on a first draw or with reduced motion', () => {
  const app = pageScript();
  const draw = /async function drawConsole\(\) \{([\s\S]*?)\n\}/.exec(app)[1];
  assert.ok(draw.includes('const before = mapTiles()'));
  assert.ok(draw.indexOf('const before = mapTiles()') < draw.indexOf('main.innerHTML'), 'the places are read before the map is replaced');
  assert.ok(draw.indexOf('slideTiles(before)') > draw.indexOf('placeOnMap()'), 'the slide runs once the new tiles are placed');
  const slide = /function slideTiles\(before\) \{([\s\S]*?)\n\}/.exec(app)[1];
  assert.match(slide, /if \(!before \|\| !after \|\| stillPlease\(\)\) return;/);
  assert.match(app, /matchMedia\?\.\('\(prefers-reduced-motion: reduce\)'\)/);
});

test('the slide, fade in and fade out are short, and reduced motion turns each of them off', () => {
  const css = readFileSync(WEB('app.css'), 'utf8');
  assert.match(css, /\.console-map \.tile\.tile-moving \{[^}]*transition: transform 450ms/);
  assert.match(css, /\.console-map \.tile\.tile-arriving \{[^}]*animation: tile-arrive 450ms/);
  assert.match(css, /\.console-map > \.tile\.tile-leaving \{[^}]*animation: tile-leave 450ms/);
  assert.match(pageScript(), /const SLIDE_MS = 450;/);
  const reduced = css.slice(css.indexOf('/* SP-335'), css.indexOf('/* SP-334'));
  const media = reduced.slice(reduced.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(media, /\.tile-moving \{ transition: none; \}/);
  assert.match(media, /\.tile-arriving[^{]*\{ animation: none; \}/);
  assert.match(media, /\.tile-leaving \{ display: none; \}/);
});

// ── The layout the operator drew (SP-374) ────────────────────────────────────

test('a "Task Submitted" funnel sits over Requested, as wide as it, outside the map\'s areas, and opens the Add Task page (SP-374)', () => {
  const funnel = renderFunnel();
  assert.match(funnel, /^<a class="map-funnel" href="\/new" title="[^"]+">/);
  assert.match(funnel, /<span class="map-funnel-label">Task Submitted<\/span><\/a>$/);
  assert.match(funnel, /<svg class="map-funnel-shape" [^>]*aria-hidden="true">/);
  const html = renderConsole(null, CONSOLE_NOW);
  assert.ok(html.indexOf('class="map-funnel"') < html.indexOf('class="console-map"'), 'above the map, not one of its areas');
  assert.doesNotMatch(funnel, /style="/);
  // As wide as Requested: its share of the map, never under the map's 60rem floor.
  const requested = MAP_AREAS.find((a) => a.status === 'Requested');
  const pct = (100 * requested.w) / MAP_UNITS.width;
  assert.equal(requested.x, 0, 'Requested is the left-hand area the funnel sits over');
  const css = readFileSync(WEB('app.css'), 'utf8');
  assert.match(css, new RegExp(`\\.map-funnel \\{[^}]*width: max\\(${pct}%, ${(60 * pct) / 100}rem\\);`));
  assert.match(css, /\.map-funnel-shape polygon \{ fill: var\(--map-funnel-bg\); stroke: var\(--map-funnel-line\);/);
});

test('no tile is drawn taller than its area\'s room, so Live\'s short strip keeps its tiles inside it (SP-374)', () => {
  for (const area of MAP_AREAS) {
    for (const n of [1, 3, 12, 60]) {
      const placed = placeArea(area, Array.from({ length: n }, (_, i) => consoleTicket({ id: `AL-${i + 1}`, status: area.status })), CONSOLE_NOW);
      for (const slot of [...placed.tiles, ...(placed.more ? [placed.more] : [])]) {
        const { x, y, size } = slotShare(area, placed.grid, slot);
        const tall = (size * area.w) / area.h;
        assert.ok(y + tall <= 1 + 1e-9, `${area.status} with ${n}: a tile hangs out of the bottom`);
        assert.ok(x + size <= 1 + 1e-9, `${area.status} with ${n}: a tile hangs out of the side`);
      }
    }
  }
  const live = MAP_AREAS.find((a) => a.status === 'Live');
  assert.ok(placeArea(live, [consoleTicket({ status: 'Live' })], CONSOLE_NOW).grid.size < TILE_MAX, 'Live\'s tiles are smaller than the largest');
});

test('every arrow\'s point lands where no tile can sit, in a header band or an area\'s padding, so no tile ever hides where a route leads (SP-374)', () => {
  const at = Object.fromEntries(MAP_AREAS.map((a) => [a.status, a]));
  // An area's room for tiles: inside its padding (1.5 units) and under its name (6 units), as areaGrid lays them.
  const inRoom = ([x, y], a) => x > a.x + 1.5 && x < a.x + a.w - 1.5 && y > a.y + 6 && y < a.y + a.h - 1.5;
  for (const d of MAP_DETOURS) {
    const tip = d.path[d.path.length - 1];
    assert.ok(!inRoom(tip, at[d.to]), `${d.from} -> ${d.to} points into ${d.to}'s tiles at ${tip}`);
  }
});
