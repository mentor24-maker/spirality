## 2026-11-14 — Add a Topics column to the Tasks list, changed from a dropdown (#234)

Topics (the key parts of a project, made on the Topics page) can now be put
on tickets. The Tasks page's List view has a new Topics column, after Tags.
Each ticket's topics show as small chips with a × to take one off, and an
Add Topic dropdown lists the project's other topics. Picking one saves at
once, the same way the priority, assignee and tag controls already do.

One ticket can carry several topics and one topic can sit on several
tickets. A topic from another project is turned away, and a change never
overwrites a loop's move: if the ticket changed while the page was open,
nothing is saved and the page says so. Outside sites that read the task list
see two new fields and nothing taken away.
