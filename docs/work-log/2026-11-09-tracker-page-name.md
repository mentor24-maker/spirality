## 2026-11-09 — spirality.alphire.agency shows StarCaster's small Tasks page: point it at the tracker's own page (#135)

The web address spirality.alphire.agency still opens a small StarCaster
page, not the tracker. The tracker can already be reached from the
internet, but only at a long Tailscale address whose security certificate
covers that address alone, so our own name cannot just point at it.

This change adds a tiny "forwarding" website. It has no content of its own:
it takes each request made to our name and passes it to the tracker
unchanged. The file is generated from the project settings, so it can never
point at an address someone typed by hand, and the checks fail if it ever
goes out of step with them. Sign-ins carry over because the tracker's
sign-in cookie is tied to whichever name the browser opened.

There is also a new setting for the page's public name. Once it is set,
invite and password-reset emails link to the friendly name. It stays off
until the name has actually moved, so no email points somewhere that does
not work yet.

Moving the name from StarCaster's site to the new one touches a live site,
so it is not done here. The exact steps, and how to undo them, are written in
docs/TRACKER_MVP.md for a session to carry out with Dane's go-ahead.
