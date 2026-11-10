## 2026-11-10 — Spirality's own documentation cannot be read in the tracker: show the docs folder on the Docs page (#151)

Spirality's written rules and plans (the loop contract, the plan, the tracker
guide, the work log and the rest, all in the `docs/` folder) could only be
read on GitHub or in an editor. The tracker's Docs page now lists every one
of them by title, above the task files, and clicking one shows it as a proper
page with headings, lists and code, with a Back to Docs link.

The part that mattered most is what the tracker will *not* read: it opens
only Markdown files inside `docs/`. An address that tries to climb out of the
folder (with `..`), names a file elsewhere on the Mac, or follows a shortcut
out of the folder gets "no such file", and the tests watch every file read to
prove nothing outside was even opened.

The docs are written with a line break every 75 characters or so, which the
ticket page's drawing keeps; on a long document that read badly, so the Docs
page joins those lines back into paragraphs first. Tickets look the same as
before.
