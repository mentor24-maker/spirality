## 2026-11-05 — Make formatting consistent. Establish style conventions doc (#111)

The tracker page mixed two capital-letter styles: "Add Task" next to "Add
project" and "Post reply". Dane chose one, Title Case, and now every button,
heading, panel toggle, table column heading, icon tooltip and tab title uses
it ("Add Project", "Post Reply", "Waiting on You", "Last Change"). The status
names ("Needs your input" and the rest) stay exactly as they were, because
the loops read them word for word.

The rule now lives in a new file, `docs/DOCTRINE.md`, so later work follows
it without being asked. A new test reads the page's source, finds every
label the rule covers (about 150 of them) and fails the checks on any that
breaks it, so a future "Add thing" button can't get onto the page unnoticed.
The test caught two labels on its first run that the hand-made list had
missed.
