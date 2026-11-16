## 2026-11-16 — Read older ClickUp-imported bug reports correctly in the bug report view (#267)

The website bug reports that came across from ClickUp in their older shape
(SC-111 and SC-446 to SC-479) now read properly at the top of their ticket
page. Before, almost every one of them claimed "Screenshots are attached"
when none were: their divider line was written as `* * *` with spaces, and
the page did not recognise that as a divider, so it mistook it for a
screenshot. The page now treats a row of spaced stars, dashes or underscores
as the divider it is. The one report that records a page address, SC-111,
showed it as raw `[address](address)` text; it is now a clickable link, with
anything odd in the text made harmless before it reaches the page. On a copy
of the real tracker, the false screenshot lines went from 38 to none. The
demo tracker has a third held bug report in the older shape to try it on.
