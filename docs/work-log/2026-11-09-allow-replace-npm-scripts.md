## 2026-11-09 — StarCaster's setup will stop at the copy step: let --allow-replace replace a project's own clickup and doctor commands (#148)

A project that ran its own older copy of the loop already has two shortcut
commands, `clickup` and `doctor`, under the same names the new loop uses. The
setup wizard stopped on them and suggested a switch, `--allow-replace`, that
could not actually help, so WaveCenter had to clear them by hand.

Now that switch works: with it, the setup swaps in the loop's two commands and
its pull request says what each one used to be, so nothing is lost silently.
Without it, the setup stops as before, and its advice is now true. The
project's own `verify` command, which is how it checks its work, is never
swapped. StarCaster's move (SP-25) can now get through this step unaided.
