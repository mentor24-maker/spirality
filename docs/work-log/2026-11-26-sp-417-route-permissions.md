## 2026-11-26 — Check ticket permissions on the comment, queue order, attachment, tag and topic routes (#344)

The tracker has roles: admin, editor, contributor, reviewer and viewer. A
reviewer or viewer is meant to look, not change. Editing a ticket already
respected that, but several other ways of changing a project did not:
posting a comment, reordering the queue, adding, renaming or removing a
file, and making, renaming or deleting a tag or topic. A viewer could still
do all of those.

Now each of those asks the same question editing asks, through one shared
check, before anything is written. Someone who may not change tickets gets a
clear "cannot edit" answer naming them, their role and the project, and the
tracker is left exactly as it was. Loops and admins work as before, and
reading is open to everyone on the project, as before. The one change people
will notice: reviewers and viewers can no longer comment.

A new test tries all eleven routes as a reviewer and a viewer (refused,
nothing changed), as someone from another project (not found), and as a
contributor, editor, admin and loop (each works). The roles notes in
`docs/TRACKER_MVP.md` now say so.
