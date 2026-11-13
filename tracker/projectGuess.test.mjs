import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guessProject, scoreProjects, wordsOf, MARGIN, NAME_WORD, PRIOR_TICKETS, HOME_SHARE, COMMON_WORDS } from './projectGuess.mjs';

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

/**
 * SP-225: two projects that share everyday words, one using them far more.
 * "Loop" is the tracker, whose tickets sometimes say "task"; "Scores" is a
 * project about scoring tasks, whose every ticket says "task" and "page".
 * Sixty tickets each, so a word in one ticket of Loop's is under HOME_SHARE.
 */
const many = (n, make) => Array.from({ length: n }, (_, i) => make(i));
const SHARED = [
  {
    slug: 'loop', name: 'Loop', tickets: [
      ...many(20, (i) => t(`Tasks page column ${i}`, 'The task list on the Tasks page.')),
      ...many(39, (i) => t(`Relay lane ${i} stops`, 'The relay merges after the lane wakes.')),
      t('Logo on the header'),
    ],
  },
  {
    slug: 'scores', name: 'Scores', tickets: [
      ...many(55, (i) => t(`Task points rule ${i}`, 'Each task page shows its points and its factor ratings.')),
      ...many(5, (i) => t(`Supabase table ${i}`, 'The Supabase table that holds a task\'s factor ratings.')),
    ],
  },
];

test('the rule 3 number is written down too', () => {
  assert.ok(HOME_SHARE > 0 && HOME_SHARE < 1 / (1 + PRIOR_TICKETS), 'a word in one ticket of a small project is at home');
});

test('everyday words the project already uses never name another project, however much more the other uses them', () => {
  // Without rule 3 "task", "tasks", "page" and "list" add up to Scores.
  const asked = t('Tasks page task list', 'On the Tasks page, show each task in the list with its page link.');
  assert.ok(scoreProjects(asked, SHARED)[0].slug === 'scores', 'every word counted, Scores leads');
  assert.equal(guessProject(asked, 'loop', SHARED), null);
  // Its words are not at home in Scores, so they still say Loop when filed there.
  assert.equal(guessProject(t('Relay lane stops'), 'scores', SHARED)?.slug, 'loop');
});

test('words strange to the project being filed into still name the project that uses them', () => {
  assert.deepEqual(guessProject(t('Supabase factor ratings table', 'Points for each task.'), 'loop', SHARED), { slug: 'scores', name: 'Scores' });
});

test('a word in one ticket of the project being filed into is at home in a small project, not in a big one', () => {
  // "logo": one Loop ticket of sixty, 1/70, is under HOME_SHARE: not at home, so it is kept and scores for Loop.
  const scored = scoreProjects(t('Logo'), SHARED, 'loop');
  assert.ok(scored.find((p) => p.slug === 'loop').score > 0);
  // In the four-ticket Tracker project one ticket is 1/14: at home, so it scores nothing for anyone.
  const small = scoreProjects(t('Narrow Spaceship'), PROJECTS, 'tracker');
  assert.equal(small.find((p) => p.slug === 'tracker').score, 0);
  assert.ok(small.find((p) => p.slug === 'game').score > 0, '"spaceship" is strange to Tracker and still counts for Starfield');
});

test('a project\'s name is never at home: a Loop ticket that says "Scores" does not stop "Scores" naming it', () => {
  const projects = [{ ...SHARED[0], tickets: [...SHARED[0].tickets, ...many(10, (i) => t(`Copy the loop to Scores ${i}`))] }, SHARED[1]];
  assert.deepEqual(guessProject(t('Scores credits roll'), 'loop', projects), { slug: 'scores', name: 'Scores' });
});
