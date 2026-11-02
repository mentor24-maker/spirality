## 2026-11-01 — Nobody can tell how much human work a finished task saved: have the build loop record a human-hours estimate on each pull request (#61)

Dane asked for a report of how many hours of human programmer work the
loops' output is worth. Nothing wrote that number down, so there was nothing
to add up. Now, when the build loop records a finished pull request on its
ticket, it also writes its estimate on the line underneath: how many hours an
experienced programmer new to this code would take to read the ticket, make
the change, write the tests and get it reviewed, with a one-line reason.

The estimate must be a sensible number (whole or half hours, more than 0, at
most 200); anything else is refused before a word is written, and the
estimate is read back off the ticket after posting, like every other write.
The line the merge and review steps already read is unchanged, and tests
prove they still read it. Tickets finished before today simply show as "not
estimated". The next slice (SP-79) adds the numbers up on the Reporting page.
