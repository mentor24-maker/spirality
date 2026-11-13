#!/usr/bin/env node
/**
 * release.mjs — cut a Spirality release (SP-265, move 5 of
 * docs/INTEGRATION.md):
 *
 *   npm run release -- cut
 *
 * A release is a commit of Spirality's `main`, named by a git tag
 * `release-<n>` (lib/releases.mjs). `cut` reads the newest `main` and the
 * release tags from the remote itself (never the local copy, which can be
 * behind), tags `main` as the next number, pushes the tag, and reads it back
 * from the remote. It refuses, writing nothing, when `main` has not moved
 * since the last release. No branch is changed: the tag is pushed straight
 * from the commit, so nothing is left behind in this checkout either.
 *
 * Which release each project runs is the tracker's record, not a tag:
 * `npm run clickup -- release list | name | back`.
 *
 * The remote is `origin` of this checkout (Spirality's own), or the one
 * SPIRALITY_RELEASE_REMOTE names (a test's scratch repository).
 *
 * Exit 0 cut and read back / 2 refused (nothing new, or a bad command),
 * nothing written / 1 a step failed, saying which.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { nextRelease, readReleaseTags, releaseRemote } from '../lib/releases.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** One git command in `cwd`; answers spawnSync's result. */
function gitIn(cwd) {
  return (args) => spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 120_000 });
}

/** git's own words for a failed command, short. */
function gitWords(out) {
  return String(out.stderr || out.error?.message || '').trim().slice(0, 300) || `exit ${out.status}`;
}

/**
 * Cut the next release. Answers `{ code, lines, problem? }`; it prints
 * nothing itself, so a test reads every word.
 */
export function cut({ git, remote }) {
  const head = git(['ls-remote', remote, 'refs/heads/main']);
  if (head.status !== 0) return { code: 1, problem: `could not read main from ${remote}: ${gitWords(head)}` };
  const main = /^([0-9a-f]{40,64})\s+refs\/heads\/main$/m.exec(String(head.stdout))?.[1];
  if (!main) return { code: 1, problem: `${remote} has no main branch to release.` };

  const read = readReleaseTags({ git, remote });
  if (read.problem) return { code: 1, problem: read.problem };
  const plan = nextRelease(read.tags, main);
  if (!plan.cut) return { code: 2, problem: `nothing cut: ${plan.why}` };

  // The commit must be here to push a tag at it.
  const fetched = git(['fetch', '--quiet', remote, 'main']);
  if (fetched.status !== 0) return { code: 1, problem: `could not fetch main from ${remote}: ${gitWords(fetched)}` };
  const have = git(['cat-file', '-e', `${main}^{commit}`]);
  if (have.status !== 0) return { code: 1, problem: `main moved on ${remote} while this ran (its commit ${main.slice(0, 12)} did not arrive); run it again.` };

  const pushed = git(['push', '--quiet', remote, `${main}:refs/tags/${plan.name}`]);
  if (pushed.status !== 0) return { code: 1, problem: `${plan.name} was not pushed to ${remote}: ${gitWords(pushed)}` };

  const back = readReleaseTags({ git, remote });
  if (back.problem) return { code: 1, problem: `${plan.name} was pushed but could not be read back: ${back.problem}` };
  const landed = back.tags.find((t) => t.name === plan.name);
  if (!landed || landed.commit !== main) {
    return { code: 1, problem: `${plan.name} read back from ${remote} as ${landed ? landed.commit.slice(0, 12) : 'missing'}, not ${main.slice(0, 12)}; treat it as not cut.` };
  }
  return {
    code: 0,
    lines: [`cut ${plan.name} at ${main.slice(0, 12)} (the newest main${plan.after ? `, after ${plan.after}` : ', the first release'}), pushed to ${remote} and read back.`],
  };
}

const USAGE = `npm run release -- cut      tag the newest main on the remote as the next release-<n>, push it and read it back
                            (refused, writing nothing, when main has not moved since the last release)`;

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd !== 'cut' || rest.length) {
    console.error(USAGE);
    process.exit(2);
  }
  const out = cut({ git: gitIn(REPO_ROOT), remote: releaseRemote() });
  for (const l of out.lines ?? []) console.log(l);
  if (out.problem) console.error(out.code === 2 ? out.problem : `release cut FAILED — ${out.problem}`);
  process.exit(out.code);
}
