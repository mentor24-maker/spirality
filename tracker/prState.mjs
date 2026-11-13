/**
 * A pull request's live state on GitHub, for the tracker page (SP-226).
 *
 * The page's bell, its Waiting on You list and the ticket page's Merge
 * button went by the ticket's status alone, and the status lags GitHub: on
 * SP-207 Dane's "merge" had already landed PR #169 while the page still
 * asked him to merge it. The waiting verdict (lib/waitingOnOperator.js)
 * takes the PR's state as a fourth fact since SP-217; this module is how the
 * tracker server gets that fact.
 *
 * Two parts, so tests and the demo never call GitHub:
 *
 *   - ghPrState(): the real read, `gh pr view <n> --repo <owner/name>
 *     --json state`, the same call the door makes (scripts/clickup.mjs,
 *     livePrState). It answers `OPEN`, `MERGED`, `CLOSED`, or null when the
 *     read failed. A failed read is null, never a guess.
 *   - prStateCache(): keeps each answer for a minute, failures included, so
 *     the page's refresh never calls GitHub more than once a minute per pull
 *     request, and two reads of the same one at once share a single call.
 */
import { execFile } from 'node:child_process';

const STATES = ['OPEN', 'MERGED', 'CLOSED'];

/** How long one answer is kept: a minute (SP-226, criterion 6). */
export const PR_STATE_KEEP_MS = 60_000;

/** How long one `gh` call may take before it counts as a failed read. */
const GH_TIMEOUT_MS = 5_000;

/** A state as this module answers it: one of STATES, else null. */
export function normalState(value) {
  const s = String(value ?? '').trim().toUpperCase();
  return STATES.includes(s) ? s : null;
}

/**
 * The real read, through the `gh` command. `run` stands in for execFile in
 * tests. Resolves to OPEN / MERGED / CLOSED, or null on any failure (gh
 * missing or signed out, GitHub unreachable, a timeout, an answer that does
 * not parse). It never rejects.
 */
export function ghPrState({ run = execFile, timeoutMs = GH_TIMEOUT_MS } = {}) {
  return ({ repo, number }) => new Promise((resolve) => {
    if (!repo || !Number.isInteger(Number(number))) { resolve(null); return; }
    try {
      run('gh', ['pr', 'view', String(number), '--repo', String(repo), '--json', 'state'], { timeout: timeoutMs, encoding: 'utf8' }, (err, stdout) => {
        if (err) { resolve(null); return; }
        try { resolve(normalState(JSON.parse(String(stdout)).state)); } catch { resolve(null); }
      });
    } catch {
      resolve(null);
    }
  });
}

/**
 * Keep each pull request's answer for `keepMs`. `read({ repo, number })`
 * resolves to a state or null; a read that throws or rejects counts as null.
 * `stateOf({ repo, number })` resolves to OPEN / MERGED / CLOSED or null.
 */
export function prStateCache({ read, now = Date.now, keepMs = PR_STATE_KEEP_MS } = {}) {
  if (typeof read !== 'function') throw new TypeError('prStateCache needs a read function.');
  const kept = new Map();
  return {
    stateOf({ repo, number }) {
      const key = `${String(repo).toLowerCase()}#${Number(number)}`;
      const at = now();
      const hit = kept.get(key);
      if (hit && at - hit.at < keepMs) return hit.answer;
      const answer = Promise.resolve()
        .then(() => read({ repo, number: Number(number) }))
        .then(normalState, () => null);
      kept.set(key, { at, answer });
      return answer;
    },
  };
}
