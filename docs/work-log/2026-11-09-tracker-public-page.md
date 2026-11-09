## 2026-11-09 — Updates to the app-home at /spirality.alphire.agency (#133)

The tracker has a public address on the internet, so StarCaster's server
(which runs outside the home network) can talk to it. Until now that
address only answered the tracker's behind-the-scenes calls: opening it in
a browser gave a short error, never the page.

Dane decided his team should get the very same tracker page from anywhere,
limited by each person's role and projects, rather than a second smaller
copy built elsewhere. So the public address now serves the page too. The
extra protections it already had stay: the sign-in cookie only travels
over https, browsers are told to always use https there, and wrong
passwords or reset emails from the internet are limited separately from
the home network. Signed out, all anyone sees is the sign-in screen.

This is the first step; the next one points spirality.alphire.agency at it.
