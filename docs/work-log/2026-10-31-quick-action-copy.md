## 2026-10-31 — Dane has to retype commands a ticket asks him to run: make them click-to-copy in Quick Action (#45)

When a loop asked Dane to run something in Terminal, he had to retype or carefully select the command from the ticket page. Now each command in the card's ask appears at the top right of the ticket page with its own Copy button: one click, then paste. The button copies exactly what's shown, with no stray backticks, spaces or blank lines, and the page never runs anything itself.

The tracker page on the Mini is plain `http`, and browsers switch off their normal copy feature on plain pages. So the button falls back to an older way of copying that still works there. Both ways were tried in a real browser, and each put exactly the command on the clipboard.
