## 2026-11-12 — The setup wizard drops a project's own hooks and live tests: merge .claude/settings.json and retire only tests of rewritten files (#192)

When the setup wizard gave StarCaster the loop (its setup pull request
#1003), StarCaster's own review sent it back for two reasons, and both were
the wizard's fault.

First, the wizard copied Spirality's `.claude/settings.json` straight over
StarCaster's. That file lists the small safety checks ("hooks") that run
whenever a Claude session edits a file or runs a command, and the commands
a session may run without asking. StarCaster had seven hooks. The copy kept
only one, and lost its two allowed commands. Now the wizard merges the two
files: everything StarCaster had stays, Spirality's one hook is added if it
is not there already, and nothing appears twice. The wizard then reads the
written file back and stops if anything is missing. Run against
StarCaster's real file, the merge keeps all seven hooks and both commands.

Second, the wizard deleted whole test files whenever a failing test in them
read one of the loop files it rewrites. Some of those files also test code
StarCaster still uses every day (`npm run ship`, `npm run pipeline`), and
deleting them would have thrown that safety net away. Now a test file is
deleted only when it tests nothing the project still runs. A file that also
tests live code is kept. The wizard names it and the tests in it that fail,
then stops before it changes anything else, so those tests can be fixed by
hand on the setup branch, and the pull request lists every one. Checked
against the 20 files the wizard deleted from StarCaster, 4 would still be
deleted and 16 would be kept for a hand fix.
