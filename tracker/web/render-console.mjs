/**
 * The Console page (page-console.mjs): the map of stage areas, its tiles,
 * the detours and the feature key.
 *
 * Split out of render.mjs (SP-364), which re-exports it, so every importer
 * still names render.mjs. Its rule holds here too: every character of
 * ticket text is escaped before it is drawn.
 */
import { escapeHtml, mountainTime, share } from './render-common.mjs';

/** What a Console tile shows when a fact is not known. */
export const CONSOLE_UNKNOWN = '—';

/**
 * A ticket's next change as a tile's short fact and its hover text, from
 * the answer's `nextChange`: `You` when it is the operator's move, `Now`
 * while Building (or while the lane that acts on it runs), `in 12 min` /
 * `in 2 h` until the lane's next pass (its clock time in Mountain time on
 * hover), `Now` for a pass already due, and CONSOLE_UNKNOWN when no time is
 * known. `now` is a time in milliseconds, given so a test can fix the clock.
 */
export function consoleNextChange(nextChange, now = Date.now()) {
  const lane = typeof nextChange?.lane === 'string' ? nextChange.lane : 'The lane';
  if (nextChange?.kind === 'operator') return { text: 'You', title: 'Your move: no lane acts on it until you do' };
  if (nextChange?.kind === 'running') return { text: 'Now', title: `${lane} is working on it now` };
  if (nextChange?.kind !== 'lane') return { text: CONSOLE_UNKNOWN, title: 'When the next pass picks it up is not known' };
  if (nextChange.running) return { text: 'Now', title: `${lane} is running now` };
  const due = Date.parse(nextChange.due);
  if (Number.isNaN(due)) return { text: CONSOLE_UNKNOWN, title: 'When the next pass picks it up is not known' };
  const away = due - now;
  const at = `${lane}'s next pass is due ${mountainTime(nextChange.due)}`;
  if (away <= 0) return { text: 'Now', title: at };
  const minutes = Math.ceil(away / 60_000);
  // Whole hours count down the same way minutes do: 89 minutes is still "in 1 h", never rounded up to 2.
  return { text: minutes < 60 ? `in ${minutes} min` : `in ${Math.floor(minutes / 60)} h`, title: at };
}

/**
 * How long a ticket has sat in its stage, short: `5m`, `3h`, `2d` (under a
 * minute is `0m`), or CONSOLE_UNKNOWN for a time that cannot be read.
 */
export function consoleAge(since, now = Date.now()) {
  const at = Date.parse(since);
  if (Number.isNaN(at)) return CONSOLE_UNKNOWN;
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/**
 * True when a tile is ringed as waiting on the operator: the loop's own
 * verdict (`waitingOnOperator`), one of his two statuses (`nextChange` of
 * kind `operator`), or an answer of his that is in (`answerIn`).
 */
export function consoleWaiting(t) {
  return t?.waitingOnOperator === true || t?.answerIn === true || t?.nextChange?.kind === 'operator';
}

/**
 * The tag a ticket from the tracker page carries (SP-221): it says where the
 * request came from, not what feature it is part of.
 */
export const REQUEST_FORM_TAG = 'request-form';

/**
 * The Console's feature colours (SP-234): light backgrounds, so the ticket
 * number (the page's ink) reads on every one of them. app.css has one
 * `.tile.feature-<n>` rule per colour, in this order; a test holds the two
 * together and checks each colour's contrast.
 */
export const FEATURE_PALETTE = Object.freeze([
  '#ffd6d6', '#ffe2c2', '#fff3b0', '#d9f2c4', '#c8f0e4',
  '#cfe8ff', '#dcd6ff', '#f5d0f0', '#e6dccb', '#d5dde6',
]);

/**
 * A ticket's feature: its first tag (the loops tag each ticket with its
 * epic's name), passing over `request-form`, which says only where the
 * request came from. Null for a ticket with no such tag, which keeps the
 * plain tile.
 */
export function consoleFeature(t) {
  const tags = Array.isArray(t?.tags) ? t.tags : [];
  const tag = tags.find((x) => typeof x === 'string' && x.trim() && x.trim() !== REQUEST_FORM_TAG);
  return tag ? tag.trim() : null;
}

/**
 * Which FEATURE_PALETTE colour a feature gets: a pure function of the tag
 * (an FNV-1a hash of its characters), so the same tag has the same colour on
 * every load and every machine. Two tags can share a colour, more often once
 * there are more features than colours.
 */
export function featureColourIndex(tag) {
  let hash = 0x811c9dc5;
  for (const ch of String(tag)) {
    hash ^= ch.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % FEATURE_PALETTE.length;
}

/**
 * The Console's Features key as HTML (SP-234): each feature on screen, with
 * its colour swatch and how many tickets in flight carry it, most tickets
 * first (ties by name). Each is a button; the page dims every other tile
 * while one is picked (`picked`, the feature's tag, shown pressed). Nothing
 * when no ticket on screen has a feature.
 */
export function renderFeatureKey(tickets, picked = null) {
  const counts = new Map();
  for (const t of Array.isArray(tickets) ? tickets : []) {
    const feature = consoleFeature(t);
    if (feature) counts.set(feature, (counts.get(feature) ?? 0) + 1);
  }
  if (!counts.size) return '';
  const order = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const pick = ([feature, n]) => {
    const on = feature === picked;
    const say = `${feature}: ${n} ticket${n === 1 ? '' : 's'}`;
    return `<button type="button" class="feature-pick feature-${featureColourIndex(feature)}" data-feature="${escapeHtml(feature)}" aria-pressed="${on}" title="${escapeHtml(on ? `Show every ticket again` : `Show only ${feature}`)}" aria-label="${escapeHtml(say)}">`
      + `<span class="swatch" aria-hidden="true"></span>${escapeHtml(feature)}<span class="count">${n}</span></button>`;
  };
  return `<div class="feature-key" role="group" aria-label="Features"><span class="key-title">Features</span>${order.map(pick).join('')}</div>`;
}

/**
 * One Console tile as HTML: a link to the ticket, its full name on hover;
 * the project's logo as its picture (only an http(s) address is drawn), or
 * the project's ticket prefix in large letters when it has none; the ticket
 * number over it; and along the bottom the stage, the next change
 * (consoleNextChange) and the time in stage (consoleAge); a Live tile has no next change. A ticket waiting
 * on the operator carries `waiting` (the ring). A ticket with a feature
 * (consoleFeature) carries `feature feature-<n>` (its colour, from app.css)
 * and `data-feature`, which the Features key's pick dims by. The stage fact carries
 * `data-stage`, so the page puts the Settings page's stage colour on it
 * after drawing (no inline style). Every piece of ticket and project text
 * is escaped. On the map (SP-333), `size` is its size class (tileSizeClass)
 * and `attrs` its place (placeAttrs), both written by the map itself.
 */
/**
 * Why a Queued ticket is held from the build loop (SP-377): the reasons in
 * its answer's `hold` (pageData.mjs holdOf), joined by "; ", or '' when
 * nothing holds it. Its own word, never "waiting on you" (consoleWaiting).
 */
export function consoleHeld(t) {
  const reasons = Array.isArray(t?.hold?.reasons) ? t.hold.reasons.map(String).filter(Boolean) : [];
  return reasons.join('; ');
}

export function renderConsoleTile(t, project = null, now = Date.now(), { attrs = '', size = '' } = {}) {
  const id = String(t?.id ?? '');
  const prefix = project?.prefix ?? id.replace(/-.*$/, '');
  const logo = typeof project?.logo === 'string' && /^https?:\/\//i.test(project.logo) ? project.logo : null;
  const picture = logo
    ? `<img class="tile-logo" src="${escapeHtml(logo)}" alt="" referrerpolicy="no-referrer">`
    : `<span class="tile-prefix" aria-hidden="true">${escapeHtml(prefix)}</span>`;
  const next = consoleNextChange(t?.nextChange, now);
  const age = consoleAge(t?.stageSince, now);
  const waiting = consoleWaiting(t);
  const feature = consoleFeature(t);
  const held = consoleHeld(t);
  const status = String(t?.status ?? '');
  const label = `${id}: ${t?.name ?? ''}`;
  // A launched ticket has no next change (SP-333's Live area): finished work says only how long ago.
  const done = status === 'Live';
  const spoken = `${label}. ${status}${done ? '' : `; next change ${next.text}`}; in this stage ${age}${feature ? `; feature ${feature}` : ''}${held ? `; held: ${held}` : ''}${waiting ? '; waiting on you' : ''}.`;
  const classes = `tile${size ? ` ${size}` : ''}${feature ? ` feature feature-${featureColourIndex(feature)}` : ''}${waiting ? ' waiting' : ''}${held ? ' held' : ''}`;
  const marked = feature ? ` data-feature="${escapeHtml(feature)}"` : '';
  return `<a class="${classes}"${marked}${attrs} href="/t/${encodeURIComponent(id)}" title="${escapeHtml(label)}" aria-label="${escapeHtml(spoken)}">`
    + `<span class="tile-picture">${picture}</span>`
    + `<span class="tile-number">${escapeHtml(id)}</span>`
    + (held ? `<span class="tile-held" title="${escapeHtml(held)}">Waiting</span>` : '')
    + '<span class="tile-facts">'
    + `<span class="fact stage" data-stage="${escapeHtml(status)}">${escapeHtml(status)}</span>`
    + (done ? '' : `<span class="fact next" title="${escapeHtml(next.title)}">${escapeHtml(next.text)}</span>`)
    + `<span class="fact age" title="${escapeHtml(`In ${status} for ${age}`)}">${escapeHtml(age)}</span>`
    + '</span></a>';
}

/**
 * The Console's map (SP-333, laid out as the operator drew it in SP-374): the
 * loop drawn as areas of the screen, one per stage, each tile placed by its
 * status. Requested is one tall area on the left; the main path runs left to
 * right along the top row, Queued → Building → In review; each stop off it
 * sits under the stage it comes back to or leads on to (Needs your input under
 * Queued, Rework under Building, Ready to launch under In review); and Live is
 * one strip along the whole bottom, where every route ends. Areas are in map
 * units, MAP_UNITS wide and high; the page draws every place as a share of the
 * map, so the layout scales to the window. `exit` is the side of an area its
 * tickets leave by, toward the next stage (Live, where nothing leaves, keeps
 * its newest launch on the right, under Ready to launch, where they arrive).
 */
export const MAP_UNITS = Object.freeze({ width: 160, height: 100 });
export const MAP_AREAS = Object.freeze([
  { status: 'Requested', x: 0, y: 0, w: 32, h: 80, exit: 'right', place: 'order' },
  { status: 'Needs your input', x: 32, y: 40, w: 52, h: 40, exit: 'up', place: 'order' },
  { status: 'Queued', x: 32, y: 0, w: 52, h: 40, exit: 'right', place: 'order' },
  { status: 'Building', x: 84, y: 0, w: 38, h: 40, exit: 'right', place: 'drift' },
  { status: 'In review', x: 122, y: 0, w: 38, h: 40, exit: 'down', place: 'drift' },
  { status: 'Rework', x: 84, y: 40, w: 38, h: 40, exit: 'up', place: 'order' },
  { status: 'Ready to launch', x: 122, y: 40, w: 38, h: 40, exit: 'down', place: 'order' },
  { status: 'Live', x: 0, y: 80, w: 160, h: 20, exit: 'right', place: 'newest' },
].map((a) => Object.freeze(a)));

/** Space round an area's tiles and above them for its name, in map units. */
const AREA_PAD = 1.5;
const AREA_HEAD = 6;
/** The largest and smallest tile, in map units: tiles shrink as an area fills. */
export const TILE_MAX = 16;
export const TILE_MIN = 6;
/** Below this size a tile drops its facts strip; below TILE_TINY, its picture too. */
export const TILE_COMPACT = 14;
export const TILE_TINY = 9;
/**
 * How long a ticket sits in Building or In review before it is pressed
 * against its area's exit (SP-333 "drift"): a build pass takes about an hour,
 * a review about the same, so three hours in Building and six in review is
 * stuck.
 */
export const DRIFT_FULL_MS = Object.freeze({ Building: 3 * 3_600_000, 'In review': 6 * 3_600_000 });
/** Live shows the last day's launches, fading with age down to LIVE_FADE_FLOOR. */
export const LIVE_SHOWN_MS = 24 * 3_600_000;
export const LIVE_FADE_FLOOR = 0.3;

/** Round to 0.01 of a unit, so the same data always writes the same number. */
const tidy = (n) => Math.round(n * 100) / 100;
/**
 * The tile size an area of `n` tiles draws at, and its grid: the largest
 * size from TILE_MAX down to TILE_MIN (half-unit steps) whose grid holds all
 * `n`; at TILE_MIN, the most it holds. Never a tile taller or wider than the
 * area's room for tiles (Live's strip is shorter than TILE_MAX), so no tile
 * hangs out of its area. `{ size, gap, cols, rows }`.
 */
export function areaGrid(area, n) {
  const w = area.w - 2 * AREA_PAD;
  const h = area.h - AREA_PAD - AREA_HEAD;
  const biggest = Math.max(TILE_MIN, Math.floor(Math.min(TILE_MAX, w, h) * 2) / 2);
  let fit = null;
  for (let size = biggest; size >= TILE_MIN; size -= 0.5) {
    const gap = Math.max(0.8, size * 0.08);
    const cols = Math.max(1, Math.floor((w + gap) / (size + gap)));
    const rows = Math.max(1, Math.floor((h + gap) / (size + gap)));
    fit = { size, gap: tidy(gap), cols, rows };
    if (cols * rows >= n) break;
  }
  return fit;
}

/**
 * An area's slots, nearest its exit first: for an exit on the right, the
 * right-hand column top to bottom, then the one left of it; down, the bottom
 * row first; left, the left-hand column first; up, the top row first (reading
 * order). Each `{ col, row }`.
 */
export function slotsByExit(grid, exit) {
  const slots = [];
  for (let row = 0; row < grid.rows; row++) for (let col = 0; col < grid.cols; col++) slots.push({ col, row });
  const by = {
    right: (a, b) => b.col - a.col || a.row - b.row,
    left: (a, b) => a.col - b.col || a.row - b.row,
    down: (a, b) => b.row - a.row || a.col - b.col,
    up: (a, b) => a.row - b.row || a.col - b.col,
  }[exit] ?? ((a, b) => a.row - b.row || a.col - b.col);
  return slots.sort(by);
}

/** How far a ticket has drifted toward its area's exit, 0 (just in) to 1 (stuck). */
export function driftOf(t, now = Date.now()) {
  const full = DRIFT_FULL_MS[t?.status];
  const at = Date.parse(t?.stageSince);
  if (!full || Number.isNaN(at)) return 0;
  return Math.min(1, Math.max(0, (now - at) / full));
}

/** How solid a Live tile is drawn: 1 just launched, down to LIVE_FADE_FLOOR a day on. */
export function liveFade(t, now = Date.now()) {
  const at = Date.parse(t?.stageSince);
  if (Number.isNaN(at)) return LIVE_FADE_FLOOR;
  const age = Math.min(1, Math.max(0, (now - at) / LIVE_SHOWN_MS));
  return tidy(1 - age * (1 - LIVE_FADE_FLOOR));
}

/**
 * Where each of an area's tickets sits: `{ status, tiles: [{ ticket, col,
 * row }], more: null | { col, row, hidden: [tickets] }, grid }`, the same
 * answer for the same data, so the minute's redraw moves nothing that did
 * not change.
 *  - `order` (Requested, Queued, Needs your input, Rework, Ready to launch):
 *    the answer's order (in Queued, the order they will be built), the first
 *    nearest the exit.
 *  - `newest` (Live): the newest launch nearest the exit, back toward Requested.
 *  - `drift` (Building, In review): each ticket's line across the area is
 *    its drift (driftOf), from the entrance to the exit, so one that has sat
 *    longest is pressed against the exit; the oldest are placed first, and a
 *    ticket whose line is full takes the nearest line with room.
 * More tickets than the grid holds at TILE_MIN: the slot furthest from the
 * exit is a "+N more" tile holding the rest (the last in order; in a drift
 * area, the newest in).
 */
export function placeArea(area, tickets, now = Date.now()) {
  const list = Array.isArray(tickets) ? tickets.slice() : [];
  if (area.place === 'newest') list.sort((a, b) => (Date.parse(b.stageSince) || 0) - (Date.parse(a.stageSince) || 0));
  if (area.place === 'drift') {
    const index = new Map(list.map((t, i) => [t, i]));
    list.sort((a, b) => driftOf(b, now) - driftOf(a, now) || index.get(a) - index.get(b));
  }
  const grid = areaGrid(area, list.length);
  const ranked = slotsByExit(grid, area.exit);
  const room = ranked.length;
  let more = null;
  let shown = list;
  if (list.length > room) {
    const slot = ranked[room - 1];
    shown = list.slice(0, room - 1);
    more = { col: slot.col, row: slot.row, hidden: list.slice(room - 1) };
  }
  if (area.place !== 'drift') return { status: area.status, grid, tiles: shown.map((ticket, i) => ({ ticket, ...ranked[i] })), more };

  // Lines run across the exit: columns for an exit right or left, rows for one up or down.
  const across = area.exit === 'right' || area.exit === 'left';
  const lines = across ? grid.cols : grid.rows;
  const depth = across ? grid.rows : grid.cols;
  const toward = (d) => (area.exit === 'right' || area.exit === 'down' ? d : lines - 1 - d);
  const taken = new Set(more ? [`${more.col},${more.row}`] : []);
  const tiles = [];
  for (const ticket of shown) {
    const want = Math.round(driftOf(ticket, now) * (lines - 1));
    let put = null;
    for (let step = 0; step < 2 * lines && !put; step++) {
      const d = want + (step % 2 ? -Math.ceil(step / 2) : Math.ceil(step / 2));
      if (d < 0 || d >= lines) continue;
      for (let k = 0; k < depth && !put; k++) {
        const slot = across ? { col: toward(d), row: k } : { col: k, row: toward(d) };
        if (!taken.has(`${slot.col},${slot.row}`)) put = slot;
      }
    }
    taken.add(`${put.col},${put.row}`);
    tiles.push({ ticket, ...put });
  }
  return { status: area.status, grid, tiles, more };
}

/**
 * Whether a lane is running a pass now, from GET /pipeline's answer: its
 * stage named `stage` (`Build`, `Review`) says `running: true`. An answer
 * not read, or one without that stage, is not running.
 */
export function laneRunning(pipeline, stage) {
  return Array.isArray(pipeline?.stages) && pipeline.stages.some((s) => s?.name === stage && s.running === true);
}

/** Whether the build lane is running a pass now (SP-365). */
export const buildRunning = (pipeline) => laneRunning(pipeline, 'Build');

/**
 * The event app.mjs's refreshPipeline sends on the document after every GET
 * /pipeline read, failed ones too, which the Console follows (SP-365). Here,
 * not in app.mjs, because page-console.mjs listens as it loads, before
 * app.mjs (which imports it) has run.
 */
export const PIPELINE_READ = 'pipeline-read';

/**
 * The areas whose tiles glide while their lane runs a pass, each with the
 * Pipeline Status stage that moves it on: Building while Build runs (SP-365),
 * In review while Review runs (SP-366).
 */
export const GLIDE_AREAS = Object.freeze({ Building: 'Build', 'In review': 'Review' });

/** The area that also pulses while its lane runs (SP-365); In review only glides. */
export const GLIDE_AREA = 'Building';

/** The glide areas whose lane is running now, by GET /pipeline's answer: `['Building', ...]`. */
export function runningAreas(pipeline) {
  return Object.entries(GLIDE_AREAS).filter(([, stage]) => laneRunning(pipeline, stage)).map(([status]) => status);
}

/**
 * How each tile in a drift area glides toward its exit while its lane runs:
 * Building's right toward In review (SP-365), In review's down toward Ready
 * to launch (SP-366). `[{ ticket, from, to, ms }]`, `from` and `to` its
 * leading edge along the way out as a share of the area (its left edge as
 * data-x is, for an exit right; its top as data-y is, for an exit down),
 * `ms` how long the move takes. A tile starts where its time in the area
 * puts it on a straight line from the entrance line (just in) to the exit
 * line (DRIFT_FULL_MS in; the exit line is where the tile meets the far
 * side of the area's room), and moves at (distance left) / (time left), so it
 * reaches the exit at three hours in Building, six in review. That is the
 * same speed for every tile, so tiles in one lane keep their gaps; the same
 * answer for a later clock is where the glide had brought them, so the
 * minute's redraw carries on with no jump back. Never on top of another: in
 * each lane (a row for an exit right, a column for an exit down; placeArea
 * keeps them apart) tiles are kept a whole slot apart, and the nth from the
 * exit stops n slots short of it, so none runs into one that has stopped. A
 * "+N More" tile in the lane stays put at the entrance. A tile past the full
 * time sits at the exit with `ms` 0. An area leaving any other way has none.
 */
export function glidesOf(area, placed, now = Date.now()) {
  const grid = placed?.grid;
  const way = {
    right: { along: 'col', lane: 'row', lead: AREA_PAD, count: grid?.cols, span: area?.w },
    down: { along: 'row', lane: 'col', lead: AREA_HEAD, count: grid?.rows, span: area?.h },
  }[area?.exit];
  if (!grid || !way) return [];
  const pitch = grid.size + grid.gap;
  const first = way.lead;
  // The way out ends where a tile touches the far side of the area's room, not at its last slot: In review's
  // row (SP-374) holds a single row of full-size tiles, and a glide that ended at the last slot would not move.
  const last = Math.max(way.lead + (way.count - 1) * pitch, way.span - AREA_PAD - grid.size);
  const full = DRIFT_FULL_MS[area.status];
  const speed = full ? (last - first) / full : 0;
  const lanes = new Map();
  for (const tile of placed.tiles) {
    const lane = tile[way.lane];
    if (!lanes.has(lane)) lanes.set(lane, []);
    lanes.get(lane).push({ tile, at: first + driftOf(tile.ticket, now) * (last - first) });
  }
  const glides = new Map();
  for (const [lane, list] of lanes) {
    list.sort((a, b) => a.at - b.at || a.tile[way.along] - b.tile[way.along]);
    // From the exit back: each a slot behind the one ahead, never past the exit.
    let ahead = last + pitch;
    for (let i = list.length - 1; i >= 0; i--) ahead = list[i].at = Math.min(list[i].at, ahead - pitch);
    // From the entrance on: each a slot past the one behind (or the +N More tile), never before the entrance.
    let behind = placed.more && placed.more[way.lane] === lane ? first : first - pitch;
    for (const item of list) behind = item.at = Math.max(item.at, behind + pitch);
    list.forEach((item, i) => {
      const to = last - (list.length - 1 - i) * pitch;
      const from = Math.min(item.at, to);
      glides.set(item.tile, { from, to, ms: speed > 0 ? Math.round((to - from) / speed) : 0 });
    });
  }
  return placed.tiles.map((tile) => {
    const g = glides.get(tile);
    return { ticket: tile.ticket, from: share(g.from / way.span), to: share(g.to / way.span), ms: g.ms };
  });
}

/** A slot's place inside its area, as shares of the area: `{ x, y, size }`, size a share of the area's width. */
export function slotShare(area, grid, { col, row }) {
  const x = area.x + AREA_PAD + col * (grid.size + grid.gap);
  const y = area.y + AREA_HEAD + row * (grid.size + grid.gap);
  return { x: share((x - area.x) / area.w), y: share((y - area.y) / area.h), size: share(grid.size / area.w) };
}

/**
 * Which way a "+N More" tile's list opens, so it stays on the map (SP-333):
 * a tile in the left half of the map opens its list to the right
 * (`opens-right`, anchored on the tile's left edge), one in the right half
 * to the left; a tile whose middle is in the bottom half opens upward
 * (`opens-up`), one in the top half downward. Returned as the classes to add.
 */
export function moreOpens(area, grid, { col, row }) {
  const left = area.x + AREA_PAD + col * (grid.size + grid.gap);
  const middle = area.y + AREA_HEAD + row * (grid.size + grid.gap) + grid.size / 2;
  const across = left / MAP_UNITS.width < 0.5 ? 'opens-right' : 'opens-left';
  const down = middle / MAP_UNITS.height > 0.5 ? 'opens-up' : 'opens-down';
  return `${across} ${down}`;
}

/** A tile's size class: `tile-compact` (no facts strip) or `tile-tiny` (the number alone), or ''. */
export function tileSizeClass(size) {
  if (size < TILE_TINY) return 'tile-tiny';
  return size < TILE_COMPACT ? 'tile-compact' : '';
}

/**
 * Where a tile sits, as data the page turns into its place after drawing
 * (no `style=""`: the page's rules forbid it): `data-x`, `data-y` and
 * `data-size`, shares of its area, and `data-fade` on a Live tile.
 */
function placeAttrs(area, grid, slot, fade = null, glide = null) {
  const { x, y, size } = slotShare(area, grid, slot);
  const moves = glide ? ` data-glide="${area.exit}" data-glide-from="${glide.from}" data-glide-to="${glide.to}" data-glide-ms="${glide.ms}"` : '';
  return ` data-x="${x}" data-y="${y}" data-size="${size}"${fade === null ? '' : ` data-fade="${fade}"`}${moves}`;
}

/**
 * The features of the tickets a "+N More" tile holds, one per line, each
 * once: its `data-features`, so a pick in the Features key dims the More
 * tile only when none of its hidden tickets is the picked feature.
 */
export function moreFeatures(hidden) {
  return [...new Set((Array.isArray(hidden) ? hidden : []).map(consoleFeature).filter(Boolean))].join('\n');
}

/**
 * The routes (SP-334, every one drawn since SP-374): each way a ticket moves
 * from one stage to another, drawn as an arrow over the map, in map units.
 * `kind` is `forward` (green: a step on toward Live) or `back` (red: work
 * stops for a question, or goes back to be built again). Each route is the
 * code's, not a picture's:
 *  - Requested → Needs your input: loop-intake writes the spec and asks for
 *    the operator's go; every new ticket takes this route once. There is no
 *    route from Requested straight to Queued.
 *  - Queued → Building: loop-build claims it. Building → In review: its pull
 *    request is open. In review → Ready to launch: review passes it. Ready to
 *    launch → Live: his merge word.
 *  - Building / In review → Needs your input: `ask` mid-build or mid-review.
 *  - Needs your input → Queued, Rework or Live: the relay's hand-back of his
 *    answer (lib/busRelayPlan.js handbackDestination): no pull request yet,
 *    Queued ("go" is one such answer); an open one, Rework; a close word or a
 *    merged one, Live.
 *  - In review → Rework: loop-review's send-back.
 *  - Rework → Building: loop-build claims Rework before fresh work
 *    (lib/loopStatuses.js CLAIMABLE_BY_BUILD).
 * A dead pass's ticket handed back from Building (pass-reconcile) is a
 * repair, not a route work is meant to take, so it is not drawn. `path` is
 * the arrow's points, tail first. Each is short and crosses the border its
 * two areas share where tiles never sit: a header's band under its name, the
 * padding along an area's foot, or the bottom of an area that fills from the
 * top, and clear of each area's name and count. In review's two red arrows
 * leave from one corner: one runs down the border and turns into Rework under
 * its count, the other runs along the border between the rows (its areas do
 * not touch) and joins Building → Needs your input for its last stretch.
 */
export const MAP_DETOURS = Object.freeze([
  { from: 'Requested', to: 'Needs your input', kind: 'forward', why: 'A new request: its spec waits for your go', path: [[25, 76], [32.8, 76]] },
  { from: 'Queued', to: 'Building', kind: 'forward', why: 'The build loop takes the next queued ticket', path: [[77.8, 5], [84.8, 5]] },
  { from: 'Building', to: 'In review', kind: 'forward', why: 'Built: its pull request is open for review', path: [[115.8, 5], [122.8, 5]] },
  { from: 'In review', to: 'Ready to launch', kind: 'forward', why: 'Review passes it: it waits for your merge', path: [[143, 38.6], [143, 45.6]] },
  { from: 'Ready to launch', to: 'Live', kind: 'forward', why: 'Your merge word: Live', path: [[143, 78.6], [143, 85.6]] },
  { from: 'Needs your input', to: 'Queued', kind: 'forward', why: 'Your go, or an answer before anything is built: back to Queued', path: [[60, 45.6], [60, 38.6]] },
  { from: 'Needs your input', to: 'Rework', kind: 'forward', why: 'Your answer on a ticket with an open pull request: back to Rework', path: [[77, 76], [84.8, 76]] },
  { from: 'Needs your input', to: 'Live', kind: 'forward', why: 'Your close word, or its pull request already merged: Live', path: [[58, 78.6], [58, 85.6]] },
  { from: 'Rework', to: 'Building', kind: 'forward', why: 'The build loop takes Rework before fresh work', path: [[108, 45.6], [108, 38.6]] },
  { from: 'Building', to: 'Needs your input', kind: 'back', why: 'A question for you mid-build', path: [[90, 37], [86, 40], [72, 44]] },
  { from: 'In review', to: 'Needs your input', kind: 'back', why: 'A question for you mid-review', path: [[125, 36], [122, 40], [86, 40], [72, 44]] },
  { from: 'In review', to: 'Rework', kind: 'back', why: 'Review sends it back', path: [[125, 36], [122, 40], [122, 44.6], [114, 44.6]] },
].map((d) => Object.freeze({ ...d, path: Object.freeze(d.path.map((p) => Object.freeze(p))) })));

/** An arrowhead's length and half its width, in map units. */
const HEAD_LONG = 2.6;
const HEAD_HALF = 1.8;

/** An arrow's line and its head as SVG path data, the head pointing along the last stretch. */
export function detourPathData(path) {
  const pts = path.map(([x, y]) => [tidy(x), tidy(y)]);
  const [tx, ty] = pts[pts.length - 1];
  const [px, py] = pts[pts.length - 2];
  const len = Math.hypot(tx - px, ty - py) || 1;
  const ux = (tx - px) / len;
  const uy = (ty - py) / len;
  const bx = tx - ux * HEAD_LONG;
  const by = ty - uy * HEAD_LONG;
  // The line stops at the head's base, so its end does not poke through the point.
  const line = [...pts.slice(0, -1), [bx, by]].map(([x, y], i) => `${i ? 'L' : 'M'}${tidy(x)} ${tidy(y)}`).join(' ');
  const head = `M${tx} ${ty} L${tidy(bx - uy * HEAD_HALF)} ${tidy(by + ux * HEAD_HALF)} L${tidy(bx + uy * HEAD_HALF)} ${tidy(by - ux * HEAD_HALF)} Z`;
  return { line, head };
}

/**
 * The routes as one SVG laid over the map (SP-334), in the map's own units
 * (viewBox MAP_UNITS), so each arrow stays on the border it crosses as the
 * map scales. Each arrow is a `detour detour-<kind>` group (`forward` green,
 * `back` red) naming its route (`data-from`, `data-to`) with a hover title
 * saying when a ticket takes it.
 */
export function renderDetours() {
  const arrows = MAP_DETOURS.map((d) => {
    const { line, head } = detourPathData(d.path);
    return `<g class="detour detour-${d.kind}" data-from="${escapeHtml(d.from)}" data-to="${escapeHtml(d.to)}">`
      + `<title>${escapeHtml(`${d.from} → ${d.to}: ${d.why}`)}</title>`
      + `<path class="detour-line" d="${line}"/><path class="detour-head" d="${head}"/></g>`;
  });
  const said = MAP_DETOURS.map((d) => `${d.from} to ${d.to}`).join('; ');
  return `<svg class="map-detours" viewBox="0 0 ${MAP_UNITS.width} ${MAP_UNITS.height}" role="img" aria-label="${escapeHtml(`Routes: ${said}`)}">${arrows.join('')}</svg>`;
}

/** The line under the map saying what the arrows are. */
export const DETOURS_KEY = 'Green arrows move a ticket forward; red arrows send it back, to wait on your answer or to be built again. Hover an arrow to see when a ticket takes it.';

/**
 * Where every request comes from (SP-374): a funnel over Requested, as wide as
 * it (app.css), linking to the Add Task page. It sits above the map, outside
 * its areas, so every part of the map is still a stage.
 */
export function renderFunnel() {
  return '<a class="map-funnel" href="/new" title="Add a task: every request starts here, in Requested">'
    + '<svg class="map-funnel-shape" viewBox="0 0 32 10" preserveAspectRatio="none" aria-hidden="true"><polygon points="0.5,0.5 31.5,0.5 24,9.5 8,9.5"/></svg>'
    + '<span class="map-funnel-label">Task Submitted</span></a>';
}

/**
 * The /in-flight answer as the Console shows it for one project (its
 * Project picker): only that project's tickets, every project still listed
 * for the picker. `slug` empty, or naming no project in the answer, is "All
 * Projects": the answer as it came. The map, its counts, the funnel and the
 * Features key are all drawn from what this returns, so they agree.
 */
export function consoleForProject(answer, slug) {
  const projects = Array.isArray(answer?.projects) ? answer.projects : [];
  const tickets = Array.isArray(answer?.tickets) ? answer.tickets : [];
  if (!slug || !projects.some((p) => p.slug === slug)) return { ...answer, projects, tickets };
  return { ...answer, projects, tickets: tickets.filter((t) => t.project === slug) };
}

/**
 * The Console as HTML (SP-333, replacing SP-233's stage columns): the map,
 * MAP_AREAS each a
 * `map-area` with its name, its count and its tiles placed by placeArea. The
 * map's areas come in the loop's own order, so a narrow screen, which stacks
 * them, reads the same path. The "Task Submitted" funnel (renderFunnel) sits
 * over Requested, above the map. Live shows the launches /in-flight sends (the last day's, on the server's clock), each
 * fading with age. The routes' arrows (renderDetours, SP-334) lie over the
 * areas, with a line under the map saying what green and red mean. A ticket whose
 * status is not on the map is listed under it ("Other Statuses"), so no
 * ticket is ever left off. `running` lists the glide areas whose lane is
 * running a pass (runningAreas): each carries `running`, and its tiles glide
 * toward its exit by their data-glide, data-glide-from, data-glide-to and
 * data-glide-ms (glidesOf); app.css also pulses Building's background while
 * it runs (SP-365), never In review's (SP-366). The page keeps the class in step
 * with GET /pipeline between redraws.
 */
export function renderConsole(answer, now = Date.now(), { running = [] } = {}) {
  const tickets = Array.isArray(answer?.tickets) ? answer.tickets : [];
  const projects = new Map((Array.isArray(answer?.projects) ? answer.projects : []).map((p) => [p.slug, p]));
  const onMap = new Set(MAP_AREAS.map((a) => a.status));
  // Which Live tickets are recent enough to show is the server's answer (consoleOf, on its clock); the page only fades them.
  const shown = tickets;
  const tile = (t, opts) => renderConsoleTile(t, projects.get(t.project), now, opts);
  const areaHtml = (area) => {
    const here = shown.filter((t) => t.status === area.status);
    const placed = placeArea(area, here, now);
    const sizeClass = tileSizeClass(placed.grid.size);
    const glides = Object.hasOwn(GLIDE_AREAS, area.status) ? glidesOf(area, placed, now) : [];
    const tiles = placed.tiles.map(({ ticket, col, row }, i) => {
      const fade = area.status === 'Live' ? liveFade(ticket, now) : null;
      return tile(ticket, { attrs: placeAttrs(area, placed.grid, { col, row }, fade, glides[i] ?? null), size: sizeClass });
    });
    if (placed.more) {
      const n = placed.more.hidden.length;
      tiles.push(`<details class="tile more ${moreOpens(area, placed.grid, placed.more)}${sizeClass ? ` ${sizeClass}` : ''}" data-stage="${escapeHtml(area.status)}" data-features="${escapeHtml(moreFeatures(placed.more.hidden))}"${placeAttrs(area, placed.grid, placed.more)}>`
        + `<summary aria-label="${escapeHtml(`${n} more in ${area.status}`)}">+${n} More</summary>`
        + `<ul class="more-list">${placed.more.hidden.map((t) => `<li><a href="/t/${encodeURIComponent(String(t.id ?? ''))}">${escapeHtml(String(t.id ?? ''))}</a> ${escapeHtml(t.name ?? '')}</li>`).join('')}</ul></details>`);
    }
    const runs = running.includes(area.status) ? ' running' : '';
    return `<section class="map-area${runs}" data-stage="${escapeHtml(area.status)}" data-area="${escapeHtml(area.status)}"`
      + ` data-x="${share(area.x / MAP_UNITS.width)}" data-y="${share(area.y / MAP_UNITS.height)}" data-w="${share(area.w / MAP_UNITS.width)}" data-h="${share(area.h / MAP_UNITS.height)}">`
      + `<h2><span class="stage-name">${escapeHtml(area.status)}</span><span class="count quiet">${here.length}</span></h2>`
      + `<div class="tiles">${tiles.join('')}</div></section>`;
  };
  const others = shown.filter((t) => !onMap.has(t.status));
  const other = others.length
    ? `<section class="console-other"><h2>Other Statuses</h2><div class="tiles">${others.map((t) => tile(t)).join('')}</div></section>`
    : '';
  return `<div class="console">${renderFunnel()}<div class="console-map" role="group" aria-label="The loop">${MAP_AREAS.map(areaHtml).join('')}${renderDetours()}</div>`
    + `<p class="map-detours-key quiet">${escapeHtml(DETOURS_KEY)}</p>${other}</div>`;
}

// ── Suggest Next Tasks (SP-251) ──────────────────────────────────────────────

// ── Tiles that moved between two redraws (SP-335) ─────────────────────────────
/**
 * How far a tile must have shifted, in the units its places are given in (the
 * page gives pixels from the map's corner), before it slides: less is a
 * rounding wobble, drawn in place.
 */
export const MOVE_MIN = 1;

/**
 * What changed on the Console's map between two redraws (SP-335), from two
 * lists of `{ id, x, y }`, each tile's place by ticket id: `moved` the tiles in
 * both whose place changed (each with `dx`, `dy`, how far it went), `still`
 * the ids in both that stayed put, `added` the ids new to the board, `gone`
 * the tiles that left it (with their old place, where they fade out). A
 * `before` of null is the page's first draw: every tile is `still`, so nothing
 * moves or fades on arrival. An id listed twice counts once, its first place.
 */
export function tileMoves(before, after, min = MOVE_MIN) {
  const byId = (list) => {
    const out = new Map();
    for (const t of Array.isArray(list) ? list : []) {
      if (t && t.id != null && !out.has(String(t.id))) out.set(String(t.id), t);
    }
    return out;
  };
  const now = byId(after);
  if (before == null) return { moved: [], still: [...now.keys()], added: [], gone: [] };
  const was = byId(before);
  const moved = [];
  const still = [];
  const added = [];
  for (const [id, t] of now) {
    const old = was.get(id);
    if (!old) { added.push(id); continue; }
    const dx = Number(t.x) - Number(old.x);
    const dy = Number(t.y) - Number(old.y);
    if (Math.abs(dx) >= min || Math.abs(dy) >= min) moved.push({ id, dx, dy });
    else still.push(id);
  }
  const gone = [...was].filter(([id]) => !now.has(id)).map(([id, t]) => ({ id, x: t.x, y: t.y }));
  return { moved, still, added, gone };
}
