## 2026-11-12 — A project's spirality.project.json has no written format: publish its fields with a version, and refuse a manifest that does not match (#201)

Every project Spirality builds keeps one settings file, `spirality.project.json`,
that says who the project is: its GitHub repository, its keys' home in Doppler,
the words Dane uses to say "merge", and so on. Until now the list of what that
file may hold lived only in a comment inside the code, and the file did not
say which edition of the list it was written to.

Now the list is a document a project's owner can read,
`docs/PROJECT_MANIFEST.md`: every setting, what it is for, whether it must be
there, what it means when left out, and an example. Every settings file now
starts with `"manifestVersion": 1`. If it is missing, or says a different
number, Spirality stops before doing anything and says exactly which line is
wrong and what it should say. A test fails if the document and the code ever
list different settings, so the two cannot drift apart again.

Spirality's own file has the new line, and the setup wizard writes it into
every new project's file. StarCaster, WaveCenter, Normie and PressPlay each
need the one line added too, as a small ticket in their own queues; their own
loops keep running meanwhile, because they still use their own copy of the
reader.

This is the first of the moves in `docs/INTEGRATION.md` that end with all loop
code living in Spirality and each project supplying only its settings file,
its checks and its rules.
