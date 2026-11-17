# The off-Mini copy

Every night at 03:15 the tracker backs up its database onto the Mini's own
disk (`tracker/backup.mjs`, `docs/TRACKER_MVP.md`, "Running it"). A dead disk
would take those backups with it, and with them every project's tickets. So
straight after that backup, the same job copies two things off the Mini, to a
private GitHub repository (SP-355; Dane chose a repository of its own,
answer B, 2026-11-16):

| What | Where in the repository | How |
|---|---|---|
| Tonight's tracker database | A release named `tracker-YYYY-MM-DD`, holding `tracker-YYYY-MM-DD.db.gz` | Gzipped and uploaded; the newest 14 releases are kept, as on the Mini |
| The Mini's launch agents (`~/Library/LaunchAgents/*.plist`) | `launch-agents/` on `main` | Committed and pushed when they change; git keeps every version |

The code is `tracker/offMiniCopy.mjs`.

## Where it goes

The repository is the project's own `githubRepo` with `-machine-backup` on the
end: for Spirality, `mentor24-maker/spirality-machine-backup`. Nothing is
typed into the code and no manifest field is needed. It is **private**: it
holds every project's tickets.

## What it never copies

- **No sign-in, key or identity file.** StarCaster's sign-ins and identity
  files stay where they are (Dane's non-goal on SP-355).
- **No launch agent that looks like it holds a secret.** A plist with a known
  token shape in it, or an environment variable named like a token, secret,
  password or key, is not copied, and the night's copy fails naming it.
- **No database but the project's own.** Only the database in the project
  config's `trackerDataDir` goes. A test's or a scratch copy is backed up
  where it is and never leaves the machine. `TRACKER_OFF_MINI=off` turns the
  copy off.

## Why the database is a release, not a commit

The database is tens of megabytes and grows every day. Committed every night
it would push the repository past GitHub's size limits within weeks, and git
cannot show what changed inside it anyway. A release holds one file of up to
2 GB, and removing an old one frees its space. The launch agents are small
text, so they are committed, which is what lets "what did the Mini's jobs look
like the week it broke" be answered with `git log`.

## Checking it

Every write is read back: the pushed commit against GitHub's `main`, the
uploaded file against the size GitHub reports. Older releases are removed
only after tonight's has read back. The job's log
(`~/loop-logs/spirality-tracker-backup.log`) has one line per night:

- `off-Mini copy OK to <repository>: ...` naming both halves, or
- `off-Mini copy FAILED: <the step>: <why>`, and the job exits 1. Tonight's
  backup on the Mini is already made and stays.

`./scripts/install_loop_runner.sh --status` shows the newest of those lines
as `off-Mini:` under `tracker-backup`.

The copy works in its own clone, `~/spirality-tracker/off-mini-clone`. It is
safe to delete: the next night clones it again from GitHub.

## Getting a database back

On any Mac signed in to GitHub with `gh auth login`:

```bash
gh release list --repo mentor24-maker/spirality-machine-backup
gh release download tracker-YYYY-MM-DD --repo mentor24-maker/spirality-machine-backup
gunzip tracker-YYYY-MM-DD.db.gz
```

Then follow "Restoring a backup" in `docs/TRACKER_MVP.md` with that file.

## Getting a launch agent back

```bash
gh repo clone mentor24-maker/spirality-machine-backup
cp spirality-machine-backup/launch-agents/<label>.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<label>.plist
```

The plists name this Mini's paths (its home folder, its Node, its
checkouts), so on a new machine with the same layout they work as they are;
otherwise `./scripts/install_loop_runner.sh` writes Spirality's afresh.
