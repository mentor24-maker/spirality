## 2026-11-16 — Add tags on the Topics page before any task uses them (#271)

A tag used to exist only as a word written on a task, so there was no way to
make one ahead of time: it appeared the first time some task carried it. Now
each project keeps its own list of tags. On the Topics page, the Tags half has
an **Add Tag** form that folds open like Add Topic (a name and an optional
description). A new tag shows in the Tags table straight away with 0 tasks,
and it is offered in the Add Tag dropdown on every row of the Tasks page's
List view, so it can be put on tasks later.

A name that already exists, in any mix of capitals, is refused and nothing is
saved, so the list never ends up with both "design" and "Design". The page
only says a tag was created once it has read the list back and found it
there. Renaming and deleting tags come in the next slice; tasks still carry
their tags as plain words.
