## 2026-11-04 — Dane only hears about a call for his answer by email: also text him an iMessage from the Mini (#87)

When a ticket needs Dane's answer, the tracker already emailed him. Now it
also sends a text to the project's alert phone, through the Messages app on
the Mini, so he hears about it on his phone straight away. No text service
and no new keys: the Mini sends it as the Apple ID Messages is signed into.

The text follows the same rules as the email: one per hand-over, never two.
The two are kept apart, so if one fails the other still goes, and neither is
sent twice. Each has its own line to wait in, so while Messages is stuck
(for example on the Mini's first "allow?" box) the emails still go out on
time. A failed text is noted in the log and tried again a minute later, then
after longer waits, rather than on every change. Its link is the Mini's
shared address, so it opens on the phone. The phone number never appears in
the log or in this public repository.

The text is sent by a fixed little script that is handed the number and the
message as separate values, so a ticket name with odd characters in it can
never be read as instructions. That was checked on the Mini with a ticket
name built to break out, which came through as plain text.

`npm run tracker:test-text -- --project spirality` sends one test text, the
way the test email already proves the email. The first time, macOS on the
Mini asks whether Terminal, and later "node" (the tracker server), may
control Messages; the docs say exactly which box to click.
