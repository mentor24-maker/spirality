## 2026-11-17 — A new project's setup stops at its lanes and ends off main: have npm run onboard name its release and put its checkout back on main (#317)

When Cassidy was set up, the setup said "Done" while Cassidy's folder on the
Mini was still sitting on the temporary setup branch, one GitHub had already
deleted. The relay won't update a folder in that state, so every pass would
have run old code until someone noticed and switched it back by hand.

The setup now has one more step at the very end. It switches the project's
folder back to `main`, brings it up to date with GitHub, and checks that it
really is there, with nothing unsaved, before it says "Done". If the folder
holds unsaved work, or sits on some branch the setup didn't put it on, it
stops and says why instead of touching anything. It also tidies away the old
setup branch, but only once it can prove that branch's work was merged.

This is the first of three fixes from Cassidy's setup; naming the project's
release and the watchdog noise are separate tickets.
