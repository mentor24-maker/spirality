## 2026-11-27 — Add a command that lists worktrees and branches left by abandoned passes (#348)

Every build and review pass works in its own copy of the project, a
"worktree", in `.claude/worktrees/`. Nothing ever cleaned them up, and by
today there were 514, with no easy way to tell which were still in use.

`npm run clickup -- stale-worktrees` now answers that. It lists every one
with its branch, whether it reached GitHub, whether it holds unsaved edits,
its pull request and its ticket, and marks each one:

- STALE: finished (its pull request merged or closed, or its ticket is done).
- UNPUSHED: never sent anywhere, which is what a pass that died leaves behind.
- ACTIVE: still in use.
- UNKNOWN: something could not be read.

The first run on the Mini found 507 finished, 6 never pushed and 1 active.
The command only looks: it removes nothing, so deciding what to clear up is
still a person's call, or a later ticket's.
