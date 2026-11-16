## 2026-11-15 — Show related tickets, topics, tags and links in each suggestion's info box (#259)

When the tracker suggests a project's next tasks, each one has an **i**
that opens a box about it. Until now that box only repeated the short
reason and description. Now it also gives a clear paragraph about the
task: what it is and why it matters. It lists the open tickets the task
is related to, the project's topics and tags it belongs to, and links to
read more. A file link opens that file on GitHub, and a ticket link opens
the ticket.

The suggestions are written by Claude, so the tracker does not take them
on trust. It keeps a related ticket only if it is one of the project's
open tickets. It keeps a topic or tag only if the project really has it.
It keeps a link only if it is a plain path to a file in the project or an
open ticket, never a web address. Anything else is quietly dropped rather
than shown, so a bad answer can never put a made-up ticket or a link to an
outside site on the page.
