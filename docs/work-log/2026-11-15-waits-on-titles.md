## 2026-11-15 — Accept a ticket id followed by its title on a Waits on: line (#258)

A ticket can say "don't build me until that other ticket is done" with a `Waits on:` line. SP-276 wrote its line the friendly way, with the other ticket's name after its id: `SP-271 ("Run a project's lanes from Spirality's folder")`. The loop couldn't read the name part, so it played safe and held SP-276 back on every pass, forever, even after the work it waited on was finished.

Now the loop reads an id followed by a quoted title as just the id, and a comma inside the title no longer splits it in two. Anything it still can't be sure of (plain words, words in brackets with no quotes, a title that mentions another ticket) keeps holding the ticket back, because building a ticket too early is worse than building it late.

Review found a gap: a title in single quotes could run on past its real end and swallow a second ticket (`SP-1 'x'; bbb2 'y'` read as only SP-1). Now an apostrophe counts as part of a single-quoted title only between two letters, as in "Dane's", and any title with a number in it is refused too, because a bare ClickUp id like 86bctbw76 can't be told from a word. The loop contract now describes the title form, so the passes that write tickets know it.
