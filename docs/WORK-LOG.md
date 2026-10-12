# Spirality work log

A plain-English record, newest first, one entry per merged pull request.
Each entry is written INSIDE the pull request it describes. Never edit this
file directly on `main`.

---

## 2026-10-11 — The loop's rules are written down once (#2)

Until now each product kept its own description of how a ticket moves from
idea to shipped: which statuses exist, who may move a ticket out of each, how
Dane's "merge" comment is recognised, how a loop asks him a question. Those
copies had already started to disagree, and StarCaster's even described a
two-account setup the code stopped using. `docs/LOOP_CONTRACT.md` is now the
one description, checked line by line against StarCaster's code, with the
real incident behind each rule. Each product will link to it instead of
restating it, so a lesson learned in one product reaches the others.

## 2026-10-11 — Spirality is born: the seed loop, copied from WaveCenter (#1)

Dane decided that the development loop StarCaster and WaveCenter each run a
copy of becomes its own Alphire product, Spirality, in its own repository.
This first pull request gives the repository the seed loop WaveCenter has run
since 2026-10-11, pointed at Spirality's own ClickUp queue: the ClickUp door,
the loop runner and its installer, the three skills, the no-edits-on-main
hook, the secrets scan, and `npm run verify` as the one definition of done.
From here Spirality's own loops do the real work: moving StarCaster's loop
modules into a shared package that both products install.
