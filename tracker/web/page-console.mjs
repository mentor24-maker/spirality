/**
 * The Console (/console): every ticket in flight, drawn as a map of stage areas, with its feature pick.
 *
 * Part of Dane's page: app.mjs is the entry the page loads, holds what
 * every page shares (signing in, the API call, the header, routing and the
 * message strip) and imports this file. Moved out of app.mjs unchanged
 * (Spirality SP-352), so a ticket that changes one page no longer edits the
 * same file as a ticket that changes another.
 */
import { stageLooks, renderConsole, runningAreas, tileMoves, GLIDE_AREAS, GLIDE_AREA, PIPELINE_READ } from './render.mjs';
import { main, api, SignedOut, VIEW_KEY, savedProject, setTitle, viewSwitch, putTrail, lastPipeline } from './app.mjs';

/**
 * The Console view (SP-233): every ticket in flight on every project he can
 * see, as icon tiles on a map of the loop, each placed by its status
 * (renderConsole, SP-333), from GET /in-flight. The stages' colours come
 * from GET /stage-colours; an unreadable answer there draws each area in its
 * own default colour. Choosing it is remembered, so "Tasks" in the header
 * reopens it. A view only: nothing here changes a ticket. The beat draws it
 * again every minute (route marks it `ticking`), so "in 12 min" counts down.
 */
/**
 * The feature picked in the Console's Features key (SP-234), or null: kept
 * here so the minute's redraw keeps it. A reload clears it.
 */
let pickedFeature = null;

/**
 * Show the Console's pick: every tile of another feature (or of none) dims,
 * and the picked feature's button reads pressed. A picked feature no longer
 * on screen is let go, so no tile stays dimmed with nothing pressed.
 */
function showFeaturePick() {
  const picks = [...main.querySelectorAll('.feature-pick')];
  if (!picks.some((b) => b.dataset.feature === pickedFeature)) pickedFeature = null;
  for (const b of picks) b.setAttribute('aria-pressed', String(b.dataset.feature === pickedFeature));
  for (const tile of main.querySelectorAll('.console .tile')) {
    // A "+N More" tile carries its hidden tickets' features (render.mjs moreFeatures), one per line.
    const has = tile.dataset.features !== undefined
      ? tile.dataset.features.split('\n').includes(pickedFeature)
      : tile.dataset.feature === pickedFeature;
    tile.classList.toggle('dimmed', pickedFeature !== null && !has);
  }
}

/**
 * Put each area and tile of the Console's map where renderConsole placed it
 * (SP-333): its data-x, data-y, data-w / data-size and data-fade become CSS
 * values (--at-x and the rest), because the page's rules forbid a style attribute in the HTML itself.
 */
function placeOnMap() {
  const put = { x: '--at-x', y: '--at-y', w: '--at-w', h: '--at-h', size: '--at-size', fade: '--at-fade', glideFrom: '--glide-from', glideTo: '--glide-to' };
  for (const el of main.querySelectorAll('.console-map [data-x]')) {
    for (const [key, prop] of Object.entries(put)) if (el.dataset[key] !== undefined) el.style.setProperty(prop, el.dataset[key]);
    if (el.dataset.glideMs !== undefined) el.style.setProperty('--glide-ms', `${el.dataset.glideMs}ms`);
  }
}

/** One pulse of the Building area, lighter to darker and back, in app.css's area-pulse (two 4s halves). */
const PULSE_MS = 8000;

/**
 * Keep each glide area's `running` class in step with the last GET
 * /pipeline read: Building with Build (SP-365), In review with Review
 * (SP-366). On, its tiles glide toward its exit (and Building's background
 * pulses, app.css); off, or the answer unreadable, it is still. The pulse is
 * set to the clock's place in its cycle, so the minute's redraw does not restart it.
 */
function showLanesRunning() {
  const running = runningAreas(lastPipeline());
  for (const status of Object.keys(GLIDE_AREAS)) {
    const area = main.querySelector(`.console-map .map-area[data-area="${status}"]`);
    if (!area) continue;
    if (status === GLIDE_AREA) area.style.setProperty('--pulse-delay', `-${Date.now() % PULSE_MS}ms`);
    area.classList.toggle('running', running.includes(status));
  }
}
document.addEventListener(PIPELINE_READ, showLanesRunning);

/** How long a tile takes to slide, fade in or fade out (SP-335): app.css's tile-moving, tile-arriving and tile-leaving. */
const SLIDE_MS = 450;

/** A map tile's id across redraws: its ticket's address, or its area for a "+N More" tile. */
const tileKey = (el) => (el.classList.contains('more') ? `more|${el.dataset.stage}` : el.getAttribute('href'));

/**
 * Every tile on the Console's map with its place in pixels from the map's
 * corner, or null when the page is not showing the map (its first draw).
 * Measured from the map, not the window, so a scroll the redraw loses and
 * keepPlace puts back moves no tile.
 */
function mapTiles() {
  const map = main.querySelector('.console-map');
  if (!map) return null;
  const box = map.getBoundingClientRect();
  return {
    box,
    tiles: [...map.querySelectorAll('.tile')].map((el) => {
      const r = el.getBoundingClientRect();
      return { id: tileKey(el), x: r.left - box.left, y: r.top - box.top, w: r.width, el };
    }),
  };
}

/** True when the browser asks for reduced motion: then every redraw places tiles at once. */
const stillPlease = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

/**
 * Show the work move (SP-335): each tile whose place changed since `before`
 * (mapTiles, read just before the redraw) is drawn in its new place, offset
 * back to its old one, then let go so app.css's transition carries it home;
 * a ticket new to the board fades in; one gone from it fades out where it
 * was, as its old tile laid over the map. Nothing moves on the page's first
 * draw or when reduced motion is asked for.
 */
function slideTiles(before) {
  const after = mapTiles();
  if (!before || !after || stillPlease()) return;
  const { moved, added, gone } = tileMoves(before.tiles, after.tiles);
  const now = new Map(after.tiles.map((t) => [t.id, t.el]));
  const was = new Map(before.tiles.map((t) => [t.id, t]));
  for (const id of added) now.get(id)?.classList.add('tile-arriving');
  const map = main.querySelector('.console-map');
  const { width, height } = after.box;
  for (const { id } of gone) {
    const { el, x, y, w } = was.get(id);
    if (!width || !height) break;
    el.classList.remove('tile-moving', 'tile-arriving');
    el.classList.add('tile-leaving');
    el.style.removeProperty('transform');
    el.style.setProperty('--at-x', String(x / width));
    el.style.setProperty('--at-y', String(y / height));
    el.style.setProperty('--at-size', String(w / width));
    el.setAttribute('aria-hidden', 'true');
    el.inert = true;
    map.append(el);
    setTimeout(() => el.remove(), SLIDE_MS + 100);
  }
  if (!moved.length) return;
  const moving = moved.map(({ id, dx, dy }) => {
    const el = now.get(id);
    el.style.setProperty('transform', `translate(${-dx}px, ${-dy}px)`);
    return el;
  });
  // Lay the offset out before letting it go, so the transition starts from the old place.
  map.getBoundingClientRect();
  for (const el of moving) {
    el.classList.add('tile-moving');
    el.style.removeProperty('transform');
    setTimeout(() => el.classList.remove('tile-moving'), SLIDE_MS + 100);
  }
}

export async function drawConsole() {
  const [answer, colours] = await Promise.all([
    api('GET', '/in-flight'),
    api('GET', '/stage-colours').catch((err) => { if (err instanceof SignedOut) throw err; return null; }),
  ]);
  try { localStorage.setItem(VIEW_KEY, 'console'); } catch { /* the page still works; it is only not remembered */ }
  const looks = stageLooks(colours);
  const project = savedProject();
  const slug = answer.projects.some((p) => p.slug === project) ? project : answer.projects[0]?.slug;
  setTitle('Console · Tracker');
  // Where each tile was, read the moment before the map is drawn again (SP-335).
  const before = mapTiles();
  main.innerHTML = `
    <div class="tasks-head title-row"><h1>Tasks</h1>${slug ? viewSwitch(slug, 'console') : ''}</div>
    ${answer.tickets.some((t) => t.status !== 'Live') ? '' : '<p class="quiet">Nothing is in flight.</p>'}
    ${renderConsole(answer, Date.now(), { running: runningAreas(lastPipeline()) })}`;
  placeOnMap();
  showLanesRunning();
  for (const el of main.querySelectorAll('[data-stage]')) {
    const look = looks[el.dataset.stage];
    if (!look) continue;
    el.classList.add('coloured');
    el.style.setProperty('--stage-border', look.border);
    el.style.setProperty('--stage-tint', look.tint);
    el.style.setProperty('--stage-text', look.text);
  }
  // A click on a feature in the key dims every other tile; a second click on it shows them all again.
  for (const b of main.querySelectorAll('.feature-pick')) {
    b.addEventListener('click', () => {
      pickedFeature = pickedFeature === b.dataset.feature ? null : b.dataset.feature;
      showFeaturePick();
    });
  }
  slideTiles(before);
  showFeaturePick();
  putTrail([{ label: 'Tasks' }, { label: 'Console' }]);
}
