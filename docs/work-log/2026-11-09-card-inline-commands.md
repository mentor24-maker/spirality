## 2026-11-09 — Highlight  key information such as command lines (#144)

When a loop asks Dane to do something, the top of the ticket page showed it
as one block of text. On SP-23 the command he had to run, `npm run onboard
-- --product wavecenter`, was buried in the middle of a sentence with no way
to copy it, and the choices he had to pick from ran into each other.

Now a command mentioned in the middle of a sentence also gets its own box on
the right with a Copy button, the same box commands written on their own
line already had. Only things that really are commands get one: the text has
to start with a word like `npm`, `git` or `gh` (one list, kept in one
place), so a file name or a quoted phrase does not. The red "what is needed"
text is laid out in steps: "Options:" starts a new paragraph, and each
option and the "Your move" line start on their own line, even when the loop
wrote them all on one line.

Only how the page draws a ticket changed; nothing a loop writes, and nothing
stored in the tracker, is different.
