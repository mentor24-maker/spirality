## 2026-11-11 — StarCaster's setup pull request fails StarCaster's own tests: check the setup branch before stopping the old loops (#187)

On 11/11 the setup wizard stopped StarCaster's old loops first, then found
the setup could not even be committed, and StarCaster had no loops until
Dane put them back. The wizard now does the risky check first. For a project
already on ClickUp, its first new step (`setup-check`) builds the setup
branch and runs that project's own full check, `npm run verify`, before it
stops anything. If the check fails, the wizard stops there and the old loops
keep running.

Three things had broken StarCaster's run. The setup folder had no packages
installed, so StarCaster's own commit check could not run; it now installs
them first. A file Spirality copies had a Mac's own folder path in a comment,
which StarCaster's rules refuse; it is gone, and a test keeps such paths out.
And about twenty of StarCaster's tests checked its old copy of the loop, which
the setup replaces. Those are now retired by one rule anyone can check: the
test fails on the setup branch, passes on StarCaster's main, and reads one of
the files the setup writes. The setup pull request lists every retired test.
On a copy of StarCaster's real setup folder, the rule picked out all eighteen
files the ticket named and two more, and StarCaster's whole check then passed.
