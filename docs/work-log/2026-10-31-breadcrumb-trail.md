## 2026-10-31 — Add a breadcrumb trail at the top of every page under the main menu (#43)

The tracker page now tells Dane where he is. Just under the black menu sits a
small grey line like `Spirality > Task SP-47 > Details`: the project, then
the ticket, then which view of it. Every step but the last is a link, so one
click climbs from a ticket back to its project's board or list, and one more
reaches the list of all projects. Pages that belong to no single project
(Waiting on you, Projects, New request) show just their own name.

Project and ticket names are typed by people, so the trail treats them as
plain text: a name with `<` or `&` in it shows exactly as typed and can never
turn into part of the page. A test checks that.
