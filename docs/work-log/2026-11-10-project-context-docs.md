## 2026-11-10 — A project has nowhere to keep its context documents: let the Docs page upload, list, download and remove them (#152)

Until now, the tracker could keep a file only on a single task. A project's
own reference material (a brief, notes, a document that belongs to the
project as a whole) had nowhere to go. The Docs page now has a **Context
Documents** section for the project picked in the header. You can upload a
file (one at a time, up to 10 MB), see it listed with its size, who added it
and when, download it, and remove it after a "are you sure?" question that
names the file.

The files live inside the tracker's own database, like a task's files, so
the nightly backup already copies them and nothing else had to change. Only
people on the project can see or touch them. Every upload and removal is
checked after it happens, and the page says plainly when one did not work.
A project that still holds documents can't be deleted until they are
removed, so nobody's files disappear by accident.
