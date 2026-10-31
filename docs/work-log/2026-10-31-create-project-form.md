## 2026-10-31 — Dane cannot add a project from the tracker page: add a Create Project form, for people only (#41)

Until now, adding a project to the tracker meant someone running a command
on the Mini. Now the Projects page has a **New project** button that opens a
short form: the project's name, its slug (its part of the web address), its
ticket prefix (the "SP" in SP-12), its web address, a logo and an owner
picked from the people in the tracker. Saving files it and opens its page;
if something is wrong (say the prefix is already used) the page says why and
keeps what was typed.

Only a person can do this. The loops sign in too, and the button never shows
for them; if one tried anyway, the tracker refuses and writes nothing.

The tracker's database needed three new spaces on each project (web address,
logo, owner). The live database gets them automatically the next time the
tracker starts, empty, with every existing project and ticket left exactly
as it was; a test proves that on a copy of the old layout.
