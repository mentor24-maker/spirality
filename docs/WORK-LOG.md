# Spirality work log

A plain-English record, newest first, one entry per merged pull request.
Each entry is written INSIDE the pull request it describes. Never edit this
file directly on `main`.

---

## 2026-10-11 — One file holds every product-specific id (#3)

The ClickUp door had Spirality's ids (its queue, its space, Dane's seat)
typed straight into the code. That is fine for one product and wrong for a
shared one: the same code has to work StarCaster's queue and WaveCenter's.
Now those values live in one small file, `spirality.project.json`, and the
code reads them from there. If a value is missing or mistyped, every command
stops straight away and names the setting at fault, instead of quietly
working the wrong queue. Each product will get its own copy of that file;
the code stays the same for all three.

## 2026-10-11 — Spirality is born: the seed loop, copied from WaveCenter (#1)

Dane decided that the development loop StarCaster and WaveCenter each run a
copy of becomes its own Alphire product, Spirality, in its own repository.
This first pull request gives the repository the seed loop WaveCenter has run
since 2026-10-11, pointed at Spirality's own ClickUp queue: the ClickUp door,
the loop runner and its installer, the three skills, the no-edits-on-main
hook, the secrets scan, and `npm run verify` as the one definition of done.
From here Spirality's own loops do the real work: moving StarCaster's loop
modules into a shared package that both products install.
