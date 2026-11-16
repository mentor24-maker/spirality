## 2026-11-16 — Rename and delete tags on the Topics page (#275)

The Tags half of the Topics page could list tags and add new ones, but a
tag with a typo or one nobody wanted any more was stuck: the only way to
change it was to edit every task that carried it, one at a time.

Now each tag has Edit and Delete. Renaming a tag changes it on every task
that carries it in one go; deleting one asks first, says how many tasks it
will come off, and then takes it off all of them. Each task that changes
records it in its own history. Renaming a tag to a name that is already in
use is refused, so two tags are never merged by accident, and a tag of the
same name in another project is never touched.

While building it, a small hole turned up: a tag named just `.` or `..`
would have sent its delete to the project's own address instead. Such names
are now refused.
