## 2026-11-11 — Make the setup's clean-copy check run in a folder named for the project

Before it sets anything up, the setup wizard copies the project's `main`
into a scratch folder and runs the project's check there, to prove the check
passes. That copy always went into a folder called `repo`. StarCaster has a
test that checks its own folder is called `starcaster`, so the wizard said
StarCaster's check failed when it passes everywhere else, and stopped
StarCaster's move to the tracker (SP-25) before it started. The copy now
goes into a folder named for the repository (`starcaster`), the way
`git clone` and GitHub's own test machines name it. Nothing else changed.
