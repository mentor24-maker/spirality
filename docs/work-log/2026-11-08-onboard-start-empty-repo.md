## 2026-11-08 — A new project with an empty GitHub repository stops the setup at its first look: give the setup a step that makes the first commit (#122)

When Dane made a brand-new, empty GitHub repository for Upwork Blaster and
ran the setup, it stopped straight away. An empty repository has no `main`
branch yet, so there was nothing to protect, copy or test, and someone had
to make a first commit by hand before the setup would go on.

The setup now handles this itself. Its first look says an empty repository
is something it will deal with, not a blocker. A new step, `start`, then
makes the smallest first commit the setup needs: a `package.json` whose
`npm run verify` runs one placeholder test, the Node version to use, a
`.gitignore`, a README with the project's name, and the lock file CI needs.
It pushes that to `main`, then asks GitHub whether it really landed. If it
did not, the step fails and the setup goes no further. A repository that
already has any commit is never touched, so a rerun never writes over real
work. The setup page lists the new step with the others.
