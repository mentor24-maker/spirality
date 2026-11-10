## 2026-11-09 — Lanes install with GitHub signed out: check gh before installing the relay (#140)

The relay is the part of the loop that merges a pull request when Dane writes
`merge`. It does that with GitHub's command-line tool, `gh`, which has to be
signed in to Dane's GitHub account. If it was signed out, nothing noticed until
the first merge Dane asked for failed.

Now the installer asks `gh` whether it is signed in before it sets anything up.
If not, it stops, installs nothing, and says that signing in is a browser login
for Dane to do (`gh auth login`). The installer's status report also gains a
`gh:` line naming the signed-in account, so a glance shows whether merges will
work. The check is in its own small file with tests that use a pretend `gh`,
and new projects get that file along with the installer.
