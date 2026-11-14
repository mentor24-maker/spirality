## 2026-11-13 — Suggest the next tasks for a project from its plans, docs, tickets and code (#228)

The tracker can now come up with a project's next few tasks when someone
asks it to. This is the engine behind Dane's "Autosuggest next tasks"
request; the list on the Tasks page comes in the next slice.

When asked, the tracker makes a fresh, temporary copy of the project and
runs Claude in it. Claude can read files there but can't change anything.
It reads the project's rules, plans, documents and code, plus the tickets
already open, and answers with three to seven suggested tasks, most useful
first, each with a reason. The temporary copy is deleted afterwards, always.
One run goes at a time per project. A run that takes more than 10 minutes is
stopped. An answer that isn't a proper list is refused with a plain reason
instead of being half used. The open tickets are handed to Claude privately,
never written on its command line where other programs could see them. The
last list is saved, so it survives a page reload or a tracker restart. Asking
for suggestions never creates or changes a ticket.
