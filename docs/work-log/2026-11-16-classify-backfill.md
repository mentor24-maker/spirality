## 2026-11-16 — Give every existing Spirality ticket a kind, who started it and how it ended (#285)

Every ticket can now say what kind of work it is (a feature, a fix, keeping-things-running work, or documentation), who asked for it (Dane or an agent session), and how it ended (done, dropped, a duplicate or a test). But the 360 tickets filed before those fields existed had nothing in them, so any report would only start counting from today.

This read every one of them and filled the three fields in. The answers live in one table, `docs/ticket-class/spirality.tsv`, with a line per ticket and the rules used written at the top, so a wrong call is one line to change. A small script applies the table, writes only what differs and checks each write stuck.

What it showed: 228 features, 53 fixes, 61 keeping-things-running tickets (59 of them merge-conflict fix-ups) and 18 documentation tickets. Dane started 271; agent sessions started 89. Three tickets were dropped and two were duplicates, which until now every report counted as finished.
