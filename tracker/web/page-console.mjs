/**
 * The Console (/console): every ticket in flight, drawn as a map of stage areas, with its feature pick.
 *
 * Part of Dane's page: app.mjs is the entry the page loads, holds what
 * every page shares (signing in, the API call, the header, routing and the
 * message strip) and imports this file. Moved out of app.mjs unchanged
 * (Spirality SP-352), so a ticket that changes one page no longer edits the
 * same file as a ticket that changes another.
 */
import { stageLooks, renderConsole } from './render.mjs';
import { main, api, SignedOut, VIEW_KEY, savedProject, setTitle, viewSwitch, putTrail } from './app.mjs';

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
  const put = { x: '--at-x', y: '--at-y', w: '--at-w', h: '--at-h', size: '--at-size', fade: '--at-fade' };
  for (const el of main.querySelectorAll('.console-map [data-x]')) {
    for (const [key, prop] of Object.entries(put)) if (el.dataset[key] !== undefined) el.style.setProperty(prop, el.dataset[key]);
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
  main.innerHTML = `
    <div class="tasks-head title-row"><h1>Tasks</h1>${slug ? viewSwitch(slug, 'console') : ''}</div>
    ${answer.tickets.some((t) => t.status !== 'Live') ? '' : '<p class="quiet">Nothing is in flight.</p>'}
    ${renderConsole(answer)}`;
  placeOnMap();
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
  showFeaturePick();
  putTrail([{ label: 'Tasks' }, { label: 'Console' }]);
}
