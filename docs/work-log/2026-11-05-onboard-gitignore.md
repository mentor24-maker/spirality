## 2026-11-05 — A new product's lanes never pick up merged work because its main checkout always looks changed: the setup copy adds .claude/worktrees/ to its .gitignore (#98)

The loop's lanes do their work in separate copies of a product, kept in a
folder called `.claude/worktrees/` inside the product's own folder. Git has
to be told to ignore that folder. If it isn't, the product's main folder
always looks as if it has unsaved changes. The lanes only pull in newly
merged work when that folder is clean, so they kept running old code
forever. PressPlay's first setup hit exactly this.

The setup wizard's one pull request now fixes the product's ignore list
(`.gitignore`) as well. It keeps every line the product already has, in
order, and adds the missing line, or makes the file if there is none. The
line to add lives in the setup's list of files, not in code, so later
additions are a one-line change. A product that already ignores the folder
is left exactly as it was.
