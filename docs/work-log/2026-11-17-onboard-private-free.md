## 2026-11-17 — Setup stops on a private repository on GitHub Free: let npm run onboard finish when GitHub will not protect main (#314)

GitHub will not "lock" the main branch of a private repository on its free
plan. Locking main means GitHub itself refuses a change that has not passed
the checks. Cassidy, Dane's new personal-agents project, is private on the
free plan, so its setup would have done every step and then stopped at the
last one.

Now the setup treats this as a known limit and says so in plain words. The
first look at the project shows a "noted" line saying main will not be
locked. That line appears before anything is set up, even on an empty
repository. The setup then finishes, and its last step records that main is
**not** locked; it never claims otherwise. This is still safe: the loop's own
merge step merges a pull request only when its checks are green, so GitHub's
lock is a second guard, not the only one. What goes unchecked is a direct
push to main, which no loop makes.

If the repository is made public later, or the account moves to GitHub Pro
(about $4 a month), running the setup again locks main as it always has. Any
other kind of failure still stops the setup. The onboarding guide now
explains all of this, plus the next limit such a project meets: 2,000
GitHub Actions minutes a month.
