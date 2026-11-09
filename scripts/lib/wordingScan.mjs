/**
 * The loop's own words say "project" for Normie, PressPlay, Spirality and
 * the others (SP-128, SP-156). This finds the other word, as a whole word,
 * in a file's text, so `npm run check:wording` can fail a pull request that
 * brings it back.
 *
 * The word is built from two halves here so this file does not trip its own
 * check. A whole-word search passes "production" and identifiers such as
 * `productSlug`, which only ever match as part of a longer word.
 */

const WORD = ['pro', 'duct'].join('');

/** The word and its plural, as whole words, any case. */
const PATTERN = new RegExp(`\\b${WORD}s?\\b`, 'gi');

/**
 * The deliberate old names, each blanked out of a line before it is
 * searched. Keep this short: every entry is an old name a running setup or a
 * saved command still uses, never a way round the rule.
 */
export const ALLOWED = Object.freeze([
  // The setup command's old option name: a command saved before SP-156
  // (`npm run onboard -- --<old> <slug>`) still runs (scripts/onboard/onboard.mjs, look.mjs).
  { text: `--${WORD}`, why: 'the setup command\'s old option name, still accepted' },
  // The look command reads its options by name with parseArgs, so the old
  // option is also an option key and a field of what it read.
  { text: `${WORD}: { type: 'string' }`, why: 'the look command\'s old option, declared for parseArgs' },
  { text: `args.${WORD}`, why: 'the look command\'s old option, read' },
  // The setup page's old address parameter, `/setup/fields?<old>=<slug>`,
  // still answered (tracker/server.mjs), so an open page keeps working.
  { text: `?${WORD}=`, why: 'the setup page\'s old address parameter, still answered' },
  { text: `searchParams.get('${WORD}')`, why: 'the setup page\'s old address parameter, read' },
]);

/** True for files that are history, which keep the words they were written in. */
export function isExempt(path) {
  return path.startsWith('docs/work-log/') || path === 'docs/WORK-LOG.md';
}

/**
 * Every use of the word in `text` (the contents of `path`) outside the
 * allow-list: `[{ line, word, text }]`, `line` 1-based, `text` the line
 * trimmed. Empty for an exempt file or a binary one (`text` null).
 */
export function findWording(path, text) {
  if (text == null || isExempt(path)) return [];
  const hits = [];
  text.split('\n').forEach((raw, i) => {
    let line = raw;
    for (const { text: allowed } of ALLOWED) line = line.split(allowed).join(' '.repeat(allowed.length));
    for (const m of line.matchAll(PATTERN)) hits.push({ line: i + 1, word: m[0], text: raw.trim() });
  });
  return hits;
}
