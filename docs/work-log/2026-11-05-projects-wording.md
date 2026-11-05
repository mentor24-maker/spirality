## 2026-11-05 — Tickets and docs call Normie, PressPlay and the others 'products': say 'projects' everywhere the loop writes words (#105)

Dane asked whether "products" in the tickets meant projects like Normie and
PressPlay. It did, so the loop now says "project" everywhere it writes words:
the rules file, the docs, the skills each pass follows, the setup templates a
new project receives, code comments, and the messages commands print. The
onboarding guide is now `docs/ONBOARDING_A_PROJECT.md`, with every link fixed.

Nothing behaves differently. The names inside the settings file and the code
(and the `--product` option of the setup command) are left alone; renaming
those, with the old names still accepted, is the next ticket. Past ticket
titles quoted in the setup review stay exactly as they were filed.

Later the same day five other pull requests landed on `main` first (#98,
#100, #101, #102, #106) and touched the same setup files, so GitHub would not
merge this one. Their changes were merged in by hand (SP-135), keeping what
each one added and saying "project" in the lines both had edited. One of
their new tests expected the setup page to ask for a "Product name"; it now
expects "Project name", the wording this change gives the question.
