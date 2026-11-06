## 2026-11-05 — Check for correct project on submit task (#109)

Dane almost filed a task into the wrong project: the Tasks page was showing
one project while he was thinking about another, and the Add Task box files
into whatever the page shows.

Now, when he presses the button, the page first asks the tracker whether his
words fit another project better. The tracker compares the words with every
project's existing tickets (plain word matching, no AI and no cost), and a
project's own name counts most: typing "Normie" is a strong sign the task is
Normie's. If another project clearly fits better, a small box asks "Did you
mean for that to be associated with project X?" with **File in X** and
**Keep in** the project shown. Closing the box files nothing and keeps what he
typed. If the check cannot run, the task is filed as before and the note says
so, so the check never gets in the way.

It was tuned on a copy of the real tickets: on Spirality's own board it asks
only when a title names another project outright, and from the wrong board it
catches most Spirality tasks.
