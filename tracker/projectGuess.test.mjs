import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guessProject, scoreProjects, wordsOf, MARGIN, NAME_WORD, PRIOR_TICKETS, COMMON_WORDS } from './projectGuess.mjs';

const t = (name, description = '') => ({ name, description });

/** Two projects with tickets of their own, one with none. */
const PROJECTS = [
  {
    slug: 'tracker', name: 'Tracker', tickets: [
      t('Tasks page search box finds nothing', 'The search box on the Tasks page.'),
      t('Reporting page shows the wrong hours'),
      t('Add Task box loses its text on sign-out'),
      t('Tasks page board columns are too narrow'),
    ],
  },
  {
    slug: 'game', name: 'Starfield', tickets: [
      t('Spaceship engine sound cuts out', 'The engine sound stops after the warp.'),
      t('Spaceship warp drive crashes on level three'),
      t('Asteroid field spawns inside the spaceship'),
      t('Warp drive trail looks flat'),
    ],
  },
  { slug: 'empty', name: 'Garden', tickets: [] },
];

test('the rule\'s numbers are written down as named constants', () => {
  assert.equal(typeof MARGIN, 'number');
  assert.ok(MARGIN > 0);
  assert.ok(NAME_WORD > 1, 'a name word is worth more than any ticket share, which is at most 1');
  assert.ok(PRIOR_TICKETS > 0);
});

test('a request\'s words: lower-cased, split on non-letters, short and common words left out, each counted once', () => {
  assert.deepEqual([...wordsOf('The Spaceship, the SPACESHIP and a warp-drive to go!')], ['spaceship', 'warp', 'drive']);
  assert.ok(COMMON_WORDS.has('the') && COMMON_WORDS.has('and'));
  assert.deepEqual([...wordsOf("Normie's CI")], ['normie'], 'a possessive keeps the name; two-letter words are left out');
  assert.deepEqual([...wordsOf(null)], []);
});

test('a request whose words match another project\'s tickets gets that project', () => {
  const asked = t('Spaceship warp drive stutters', 'The engine sound too.');
  assert.deepEqual(guessProject(asked, 'tracker', PROJECTS), { slug: 'game', name: 'Starfield' });
  assert.deepEqual(guessProject(t('Search box on the Tasks page'), 'game', PROJECTS), { slug: 'tracker', name: 'Tracker' });
});

test('a request that names another project gets that project, even an empty one', () => {
  assert.deepEqual(guessProject(t('Garden sprinkler timer'), 'tracker', PROJECTS), { slug: 'empty', name: 'Garden' });
  assert.deepEqual(guessProject(t('Starfield credits roll'), 'tracker', PROJECTS), { slug: 'game', name: 'Starfield' });
});

test('the current project winning gets none', () => {
  assert.equal(guessProject(t('Tasks page search box is slow'), 'tracker', PROJECTS), null);
  assert.equal(guessProject(t('Spaceship warp drive stutters'), 'game', PROJECTS), null);
  // Its own name outweighs the other project's words.
  assert.equal(guessProject(t('Tracker: show the spaceship warp drive tickets'), 'tracker', PROJECTS), null);
});

test('a close call gets none', () => {
  // One word each way: neither clearly wins.
  assert.equal(guessProject(t('Board for the spaceship'), 'tracker', PROJECTS), null);
  // Words no project uses.
  assert.equal(guessProject(t('Quarterly invoice reminder'), 'tracker', PROJECTS), null);
  // Nothing typed that counts.
  assert.equal(guessProject(t('', ''), 'tracker', PROJECTS), null);
  // A request naming two projects is about both: no single project X to name.
  assert.equal(guessProject(t('Starfield and Garden share a login'), 'tracker', PROJECTS), null);
  // Two other projects about as good as each other.
  const twins = [
    { slug: 'a', name: 'Alpha', tickets: [] },
    { slug: 'b', name: 'Beta', tickets: [t('Spaceship warp drive')] },
    { slug: 'c', name: 'Gamma', tickets: [t('Spaceship warp drive')] },
  ];
  assert.equal(guessProject(t('Spaceship warp drive'), 'a', twins), null);
});

test('an empty project gets none from ticket words alone, and is never the guess from words it does not hold', () => {
  const words = t('Spaceship warp drive stutters');
  const scores = scoreProjects(words, PROJECTS);
  assert.equal(scores.find((p) => p.slug === 'empty').score, 0);
  assert.deepEqual(guessProject(words, 'empty', PROJECTS), { slug: 'game', name: 'Starfield' });
  assert.equal(guessProject(t('Quarterly invoice reminder'), 'empty', PROJECTS), null);
});

test('a project with only a ticket or two cannot win on a couple of shared words', () => {
  const projects = [
    { slug: 'big', name: 'Big', tickets: [t('Login page'), t('Login form'), t('Settings page'), t('Sign-in email'), t('Dark mode')] },
    { slug: 'tiny', name: 'Tiny', tickets: [t('Login page colour and settings')] },
  ];
  assert.equal(guessProject(t('Login settings page'), 'big', projects), null);
});

test('a project the request is filed into that is not in the list gets none', () => {
  assert.equal(guessProject(t('Spaceship warp drive'), 'nowhere', PROJECTS), null);
});

test('scores come highest first and say which projects the request names', () => {
  const scores = scoreProjects(t('Garden spaceship warp'), PROJECTS);
  assert.deepEqual(scores.map((p) => p.slug), ['empty', 'game', 'tracker']);
  assert.deepEqual(scores.map((p) => p.named), [true, false, false]);
  assert.equal(scores[0].score, NAME_WORD);
});
