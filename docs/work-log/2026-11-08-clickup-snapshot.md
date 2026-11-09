## 2026-11-08 — Attachments and history in ClickUp are lost when a project leaves it: save a full copy on the Mini before each switch (#127)

When a project moves from ClickUp to the tracker, the importer copies its
tickets and conversations, and nothing else. Screenshots and other files,
how long each ticket sat in each status, custom fields and ClickUp's own
records would all be gone the day ClickUp is let go.

There is now one command, `npm run tracker:snapshot`, that saves a complete
copy of a project's ClickUp list (and any other list named with `--list`)
in a folder on the Mini, packed into one archive beside the tracker's
nightly backups, where the backup's clean-up never deletes it. It only
reads ClickUp. If anything fails to read or download, it stops, says what
failed, and leaves no half-made copy that looks finished. At the end it
checks its counts against ClickUp's and says plainly if they differ. It
checks every file it writes to make sure the ClickUp key is not in it.

It is now the first half of step 4 in "Switching a project over"
(`docs/TRACKER_MVP.md`). Tried on Spirality's own list: 31 tickets, 222
comments and 35 replies read, counts matching. ClickUp's plan does not
include time in status, and the snapshot says so once in its record.

After review sent it back: Spirality's config now names no ClickUp list
(its list became a read-only archive), so the command saves only the lists
named with `--list` and says plainly when none is given. A failure while
packing the archive no longer leaves a finished-looking folder behind, a
comment ClickUp gives no reply count for is no longer reported as a
mismatch, the ClickUp key never travels over plain (unencrypted) web
addresses, pictures pasted into comments are collected too, and a list id
typed without `--list` is refused rather than ignored.
