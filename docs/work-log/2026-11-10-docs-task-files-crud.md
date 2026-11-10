## 2026-11-10 — Task files on the Docs page can only be looked at: let Dane add, rename and remove them there (#153)

The Docs page lists every file kept on a project's tasks, but until now you
could only look at that list. Now you can change it from there: **Add File**
puts a file on any task you pick, **Rename** changes a file's name (not what
is inside it), and **Remove** deletes one after asking you to confirm, naming
both the file and the task so you cannot remove the wrong one by accident.

This is the first time the tracker deletes a task's file, so each rename and
removal is written into that task's history with who did it, and the page
checks the change really happened before it tells you so. Someone who is not
on the task's project cannot rename or remove its files; the tracker answers
them exactly as if the task did not exist. A removed file can only be brought
back from the nightly backup.
