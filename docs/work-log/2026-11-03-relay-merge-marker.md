## 2026-11-03 — The relay's "already handled" note never saves after a merge: send it, and say why when it fails (#80)

After every merge, the relay tries to leave a short "already handled" note
under Dane's merge comment. That note is what stops it from trying the same
merge twice. It had been failing every time, 14 times in Spirality's log, with
a bare "HTTP 0" that said nothing about why.

The reason turned out to be timing. Merging on GitHub makes the relay sit
still for about six seconds. The tracker hangs up on a quiet connection after
five. The relay then sent the note down the line the tracker had already hung
up, so it was lost. Other requests got lucky: the system quietly retries a
lost read, but never a lost write, in case the write lands twice.

Now the relay opens a fresh connection for every request. On the Mini that
costs about a millisecond. When a request does fail, the message says why
(for example "ECONNRESET", meaning the other side hung up), not just "HTTP 0".
A new test reproduces the hang-up with a slow fake merge: without the fix it
fails with the exact line from the Mini's log, and with the fix it passes.
