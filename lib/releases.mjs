/**
 * releases.mjs — what a Spirality release is (SP-265, move 5 of
 * docs/INTEGRATION.md), as pure functions the tracker's store, the door and
 * `npm run release` all read, so the three never disagree on a name.
 *
 * A release is a commit of Spirality's `main`, named by a git tag
 * `release-<n>`, `n` counting up from 1. Each project runs the release named
 * for it in the tracker; Spirality's own lanes always run `main`.
 */

/** `release-<n>`: n a whole number from 1, with no leading zero. */
export const RELEASE_PATTERN = /^release-([1-9]\d*)$/;

/** What Spirality's own project shows in place of a release. */
export const OWN_PROJECT_RELEASE = 'main (always the newest)';

/** The number in a release name, or null when the name is not one. */
export function releaseNumber(name) {
  const m = RELEASE_PATTERN.exec(String(name ?? ''));
  return m ? Number(m[1]) : null;
}

/** True when `name` is a release name. */
export function isReleaseName(name) {
  return releaseNumber(name) != null;
}

/** The release name for a number. */
export function releaseName(n) {
  if (!Number.isInteger(n) || n < 1) throw new Error(`a release number is a whole number from 1; ${JSON.stringify(n)} is not.`);
  return `release-${n}`;
}

/**
 * The release tags in `git ls-remote --tags` output, as
 * `[{ name, number, commit }]`, newest (highest number) first. An annotated
 * tag's peeled line (`^{}`) names the commit it points at and wins over the
 * tag object's own id. Any other tag is left out.
 */
export function parseReleaseTags(lsRemoteOutput) {
  const byName = new Map();
  for (const line of String(lsRemoteOutput ?? '').split('\n')) {
    const m = /^([0-9a-f]{7,64})\s+refs\/tags\/(.+?)(\^\{\})?$/.exec(line.trim());
    if (!m) continue;
    const [, commit, name, peeled] = m;
    const number = releaseNumber(name);
    if (number == null) continue;
    if (peeled || !byName.has(name)) byName.set(name, { name, number, commit });
  }
  return [...byName.values()].sort((a, b) => b.number - a.number);
}

/**
 * What `release cut` should do, given the release tags (parseReleaseTags)
 * and the commit `origin/main` is at: `{ cut: true, name }` for the next
 * number, or `{ cut: false, why }` when main has not moved since the last.
 */
export function nextRelease(tags, mainCommit) {
  const newest = tags[0] ?? null;
  if (newest && newest.commit === mainCommit) {
    return { cut: false, why: `main has not moved since ${newest.name} (both are ${mainCommit.slice(0, 12)}); there is nothing new to release.` };
  }
  return { cut: true, name: releaseName((newest?.number ?? 0) + 1), after: newest?.name ?? null };
}

/**
 * The release a roll-back names, from a project's record (newest first,
 * `[{ release }]`): walking back from the release it runs now, the first one
 * numbered lower than it. Null when there is none. Going by number keeps a
 * second roll-back going further back, never bouncing to the release just
 * rolled away from.
 */
export function rollBackTarget(history) {
  const [current, ...older] = history;
  if (!current) return null;
  const now = releaseNumber(current.release);
  const found = older.find((h) => {
    const n = releaseNumber(h.release);
    return n != null && now != null && n < now;
  });
  return found ? found.release : null;
}

/** Where the release tags live: `origin` of the Spirality checkout, or another remote a test names. */
export const RELEASE_REMOTE_ENV = 'SPIRALITY_RELEASE_REMOTE';

/** The remote to read and push release tags at. */
export function releaseRemote(env = process.env) {
  return String(env[RELEASE_REMOTE_ENV] ?? '').trim() || 'origin';
}

/**
 * Ask the remote for its release tags (`git ls-remote --tags`), never the
 * local copy, which can be behind or hold a tag nobody pushed. Answers
 * `{ tags }` (parseReleaseTags) or `{ problem }` naming why it could not.
 * `git` runs one git command and answers spawnSync's `{ status, stdout,
 * stderr }`.
 */
export function readReleaseTags({ git, remote }) {
  const out = git(['ls-remote', '--tags', remote, 'refs/tags/release-*']);
  if (out.status !== 0) {
    return { problem: `git ls-remote --tags ${remote} failed: ${String(out.stderr || out.error?.message || '').trim().slice(0, 300) || `exit ${out.status}`}` };
  }
  return { tags: parseReleaseTags(out.stdout) };
}
