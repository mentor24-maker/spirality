'use strict';

/**
 * Running git in a test's own throwaway repository, and only there.
 *
 * WHY THIS EXISTS (2026-11-03, SP-104). Inside a git commit hook, git sets
 * variables such as GIT_DIR and GIT_INDEX_FILE that point at the repository
 * being committed. A test that runs `git` with the environment it inherited
 * then works on THAT repository, whatever `cwd` says. In Normie, whose
 * pre-commit hook runs `npm run verify`, one commit put mainMoved.test.js's
 * scratch commit on the real branch and wrote its `user.name=T` into the real
 * `.git/config`. Spirality has no commit hook, so its own verify never hit it.
 *
 * Two ways in, for two kinds of test:
 *
 *   git(cwd, ...args)       the test's own git calls: a cleaned environment
 *                           and a scratch identity given with `-c`, so nothing
 *                           is written to any config at all.
 *   forgetOuterRepository() for a test whose CODE UNDER TEST runs git with
 *                           the inherited environment (branchCatchUp,
 *                           mainMoved): it clears the variables from this test
 *                           process, which `node --test` runs one per file.
 *
 * `scratchGitEnv(env)` is the cleaned copy, for a child (a shell runner) that
 * is handed an environment of its own.
 */

const { spawnSync } = require('node:child_process');

/** Every variable git reads to find a repository other than the one at cwd. */
const REPOSITORY_VARIABLES = Object.freeze([
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_WORK_TREE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_PREFIX',
]);

/** The identity a scratch commit is made with, never written to a config file. */
const SCRATCH_IDENTITY = Object.freeze([
  '-c', 'user.name=Test',
  '-c', 'user.email=test@example.com',
  '-c', 'commit.gpgsign=false',
]);

/** A copy of `env` with every repository-pointing variable removed. */
function scratchGitEnv(env = process.env) {
  const out = { ...env };
  for (const name of REPOSITORY_VARIABLES) delete out[name];
  return out;
}

/** Remove the repository-pointing variables from `env` in place (this process by default). */
function forgetOuterRepository(env = process.env) {
  for (const name of REPOSITORY_VARIABLES) delete env[name];
}

/** Run git in `cwd` alone. Throws, naming the command and git's words, on a non-zero exit. */
function git(cwd, ...args) {
  const out = spawnSync('git', [...SCRATCH_IDENTITY, ...args], { cwd, encoding: 'utf8', env: scratchGitEnv() });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr || out.error || `exit ${out.status}`}`);
  return String(out.stdout).trim();
}

/** As `git`, but reports instead of throwing: `{ ok, stdout, stderr }`. */
function tryGit(cwd, ...args) {
  const out = spawnSync('git', [...SCRATCH_IDENTITY, ...args], { cwd, encoding: 'utf8', env: scratchGitEnv() });
  return { ok: out.status === 0, stdout: String(out.stdout || '').trim(), stderr: String(out.stderr || '').trim() };
}

module.exports = { REPOSITORY_VARIABLES, SCRATCH_IDENTITY, scratchGitEnv, forgetOuterRepository, git, tryGit };
