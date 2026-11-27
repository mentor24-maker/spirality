'use strict';

/**
 * Where a Stop hook's per-session state lives.
 *
 * NOT `<toplevel>/.git/` -- that is only a DIRECTORY in the main checkout. In
 * a linked worktree `.git` is a one-line FILE pointing at the real git dir, so
 * writing a state file under it fails with ENOTDIR. Both hooks wrap that write
 * in a try/catch, so the failure is silent, and the effect is that the
 * three-refusal stand-down never engages. Every thread in this repo runs in a
 * worktree, so that is the case that matters: the safety valve is inoperative
 * exactly where the work happens, and a hook that can wedge a conversation
 * shut is worse than the miss it prevents.
 *
 * `--absolute-git-dir` answers correctly from both -- the main checkout's
 * `.git`, or `<main>/.git/worktrees/<name>` from inside a linked worktree.
 * Per-worktree is the right grain anyway: sessions are per-folder.
 *
 * WHY THIS IS ITS OWN FILE
 * The same bug was fixed once already, in check_operator_handoff.cjs (PR #499),
 * and the sibling SQL hook was left with the broken path -- which is how a
 * fixed bug stayed live in the other half of the pair. Copying the resolver a
 * second time would set up the same drift again, so both hooks now read this
 * one function. Returns '' when git cannot be reached at all; the CALLER
 * decides what to do with that, because the two hooks answer it differently.
 */

const { execFileSync } = require('child_process');

function gitStateDir(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

module.exports = { gitStateDir };
