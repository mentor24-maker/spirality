## 2026-11-17 — Make connectors and text in the Spirality Loop Queue infographic open info popups (#320)

The Loop Queue picture at the top of the Docs page already let you click a
status box to read about that status. The arrows between the boxes could not
be clicked, and they are where most of the rules live: who moves a ticket,
when, and what has to be true first. Now every arrow, and the two notes under
the Rework and Queued boxes, opens a short pop-up. It names the two statuses
the arrow joins and explains in 50 to 100 plain words what happens along it.

The clickable areas are drawn over the picture, so they grow and shrink with
it on any screen. Each arrow has a wide invisible band along its line, so a
thin arrow is easy to hit, and its label can be clicked too. A test checks
that no band reaches a status box, so clicking a box still opens its section
of the Loop Queue Anatomy page. The pop-ups work from the keyboard as well:
Tab reaches each arrow, Enter opens it, and Escape closes it.
