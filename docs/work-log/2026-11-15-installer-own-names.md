## 2026-11-15 — Make the installer read Spirality's own lane names from Spirality's folder (#257)

The installer sets up the background jobs on the Mini. Run without naming a project, it is meant to set up Spirality's own jobs. But it read the job names from whichever folder you happened to be standing in. Started inside StarCaster's folder, it would have picked up StarCaster's names and quietly replaced StarCaster's real jobs with ones running Spirality's loop.

Now, with no project named, it always reads Spirality's own settings, wherever it is started. Naming a project with `--project` works exactly as before. A new test starts the installer from another project's folder and checks two things: it shows only Spirality's own jobs, and it still refuses a project that tries to use Spirality's names.
