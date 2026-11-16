## 2026-11-15 — Put each tracker page's title and buttons on one row, and make view switches tabs (#263)

Every page of the tracker now starts the way StarCaster's screens do: one
title, a little smaller and bolder than before, with the page's own controls
(the project picker, the search box, the Pipeline pod, "Set Up a Project")
on the same line at its right, instead of on a line of their own underneath.
The trail ("Alpha > Board") stays above it. Headings further down come in
three sizes, all smaller than the title.

The Board / List / Console switch was a black box of three buttons; it is now
a row of tabs under the title, with the one you are on in blue and
underlined. The Settings page's two tabs use exactly the same look, so every
switch between views reads the same way on every page.

This matters because Dane chose one look for every Alphire project (SP-318):
someone moving between StarCaster and the tracker should not have to learn
two layouts. A new check fails `npm run verify` if a page puts its toolbar
back on a row of its own, uses a fourth heading size, or brings back the old
black switch, and the style rules (`docs/UI_DOCTRINE.md`, section 12) now
record these two parts as done.
