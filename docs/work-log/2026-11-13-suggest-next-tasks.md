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

After review sent it back because the title suggester (#227) had landed in
the same spots, main was merged in with both features kept. The two now
share one setting for which Claude to run on the Mini (`TRACKER_CLAUDE`),
rather than each having its own, so pointing the tracker at a different
Claude changes both at once.

Review sent it back a second time with a real hole: "read-only" was not the
same as "only reads the copy". Asked to, Claude could read any file on the
Mini, and since the open tickets and the copied files are text anyone on the
project can write, one of them could have told Claude to fetch a private file
and put it in a suggestion everyone sees. Claude now runs in restricted mode,
which keeps it inside the copy, including refusing a shortcut (symlink) in
the copy that points outside it. A new check, `npm run
check:suggest-confinement`, runs the real Claude against a secret file just
outside the copy and fails if the secret appears; it passed, and it does
report a leak when restricted mode is taken away. Three smaller fixes came
with it: a title that starts with a number ("2 factor sign-in") keeps it, a
tracker restart now stops a run going instead of leaving it behind (and the
next run clears any folder one left), and Claude's output is capped in size.
