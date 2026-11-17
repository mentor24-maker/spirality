## 2026-11-17 — Refuse an ask card that hands over a SQL file without the run block (#313)

When a loop needs Dane to run a database change, the rule (DOCTRINE 6.5) is
that it hands him one clearly marked block per file, holding a link he can
click straight to the file on GitHub. Until now that rule was only words: on
StarCaster a pass listed the files as bold numbered paths instead, and nothing
stopped it.

Now the loop's own ticket command checks. When an `ask` card or a plain
`comment` names a `.sql` file without its block, the command refuses before
anything is posted or any status moves, says which file is missing its block,
and prints the block ready to paste, so fixing it is one copy and paste. A card
that mentions no SQL file, or only quotes one inside a code block, behaves
exactly as before. Because the check lives in Spirality's shared command, it
applies to every project's passes at once.
