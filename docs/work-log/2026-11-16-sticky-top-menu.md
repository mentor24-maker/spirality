## 2026-11-16 — Stop top menu from scrolling (#274)

The dark banner at the top of every tracker page, with the menu, the bell and
the sign-in name, used to scroll away as soon as a long page moved. Now it
stays pinned to the top of the window and the page slides up underneath it, so
the menu is always one click away, however far down the Tasks list you are.

Pinning a banner has one catch: when the page jumps to something (the link
that opens a ticket at its comments, or the jump to the comment box), the
thing it jumps to could land hidden under the banner. The page now leaves a
gap the banner's height at the top for every such jump, so it lands just
below. A new check in `npm run verify` makes sure a later change cannot quietly
unpin the banner or drop that gap.
