/**
 * Which project a new task's words fit best: the check the Tasks page's Add
 * Task box makes before it files, so a task typed while the page
 * shows the wrong project is caught with "Did you mean for that to be
 * associated with project X?".
 *
 * Pure: no store, no network, no AI. Plain word matching on what the
 * tracker already holds. The rule, in words:
 *
 *   1. The request's words are its title and description, lower-cased,
 *      split on anything that is not a letter or a digit, keeping only words
 *      of three letters or more that are not short common words ("the",
 *      "and", "with", ...). Each word counts once however often it appears.
 *   2. A word scores for a project by how many of that project's tickets
 *      (title and description) use it: the share of its tickets, counted as
 *      if the project had PRIOR_TICKETS more tickets that use none of the
 *      words, so a project with one or two tickets cannot win on a couple of
 *      shared words. A word in the project's own name (or slug) scores
 *      NAME_WORD instead: saying "Normie" is the strongest sign of Normie.
 *   3. A project's score is the sum over the request's words.
 *   4. Another project is named only when it beats the project being filed
 *      into by at least MARGIN, and every other project by MARGIN too; anything
 *      closer is a close call, and a close call names none.
 *   5. A request that names two or more projects by name (a task about
 *      Normie and PressPlay both, say) is a close call too: it is about
 *      several projects, so none is "the" right one.
 */

/** How much more another project must score than the one being filed into. */
export const MARGIN = 0.5;

/** What a word in a project's own name is worth: more than any ticket share (at most 1). */
export const NAME_WORD = 3;

/** Make-believe empty tickets added to every project, so a tiny project's shares stay small. */
export const PRIOR_TICKETS = 10;

/** The shortest word that counts. */
export const MIN_WORD = 3;

/** Short common words that say nothing about which project a task belongs to. */
export const COMMON_WORDS = Object.freeze(new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'onto', 'are', 'was', 'were', 'been',
  'being', 'have', 'has', 'had', 'not', 'but', 'its', 'his', 'her', 'our', 'your', 'their', 'they',
  'them', 'you', 'can', 'cannot', 'could', 'should', 'would', 'will', 'shall', 'may', 'might', 'must',
  'does', 'did', 'doing', 'done', 'all', 'any', 'each', 'every', 'one', 'two', 'out', 'off', 'over',
  'under', 'when', 'what', 'which', 'who', 'whom', 'why', 'how', 'where', 'there', 'here', 'then',
  'than', 'also', 'only', 'just', 'very', 'too', 'some', 'more', 'most', 'other', 'such', 'about',
  'after', 'before', 'again', 'once', 'like', 'make', 'makes', 'made', 'get', 'gets', 'got', 'let',
  'say', 'says', 'said', 'see', 'now', 'new', 'yes', 'nor', 'own', 'same', 'both', 'few', 'while',
  'because', 'until', 'upon', 'per', 'via', 'way', 'need', 'needs', 'want', 'wants', 'use', 'used',
  'uses', 'using', 'don', 'isn', 'doesn', 'won',
]));

/** The distinct words of `text` that count (rule 1), as a Set. */
export function wordsOf(text) {
  const words = new Set();
  for (const w of String(text ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (w.length >= MIN_WORD && !COMMON_WORDS.has(w)) words.add(w);
  }
  return words;
}

/**
 * Each project's score for the request's words (rules 2 and 3), highest
 * first; ties keep the order the projects were given. `named` says whether
 * the request uses a word of the project's own name.
 *
 * @param {{ name?: string, description?: string }} request
 * @param {Array<{ slug: string, name: string, tickets: Array<{ name?: string, description?: string }> }>} projects
 * @returns {Array<{ slug: string, name: string, score: number, named: boolean }>}
 */
export function scoreProjects(request, projects) {
  const words = wordsOf(`${request?.name ?? ''}\n${request?.description ?? ''}`);
  const scored = projects.map((p, order) => {
    const named = wordsOf(`${p.name ?? ''} ${p.slug ?? ''}`);
    const docs = (p.tickets ?? []).map((t) => wordsOf(`${t.name ?? ''}\n${t.description ?? ''}`));
    let score = 0;
    let isNamed = false;
    for (const w of words) {
      if (named.has(w)) { score += NAME_WORD; isNamed = true; continue; }
      let using = 0;
      for (const d of docs) if (d.has(w)) using += 1;
      score += using / (docs.length + PRIOR_TICKETS);
    }
    return { slug: p.slug, name: p.name, score, named: isNamed, order };
  });
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return scored.map(({ slug, name, score, named }) => ({ slug, name, score, named }));
}

/**
 * The project the request should go to instead of `current`, or null
 * (rules 4 and 5). Null when `current` is the best fit, when nothing clearly beats
 * it, or when `current` is not among `projects`.
 *
 * @returns {{ slug: string, name: string } | null}
 */
export function guessProject(request, current, projects) {
  const scored = scoreProjects(request, projects);
  const here = scored.find((p) => p.slug === current);
  if (!here) return null;
  const [best, runnerUp] = scored.filter((p) => p.slug !== current);
  if (!best) return null;
  if (scored.filter((p) => p.named).length >= 2) return null;
  if (best.score - here.score < MARGIN) return null;
  // Two other projects about as good as each other: no clear "project X" to name.
  if (runnerUp && best.score - runnerUp.score < MARGIN) return null;
  return { slug: best.slug, name: best.name };
}
