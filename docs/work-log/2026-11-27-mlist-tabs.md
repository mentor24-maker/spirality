## 2026-11-27 — Turn the mlist page's list switch into tabs (#347)

On the phone page, the switch between Waiting on You and Tasks used to be two
big buttons, and the list you were looking at was drawn as the blue "do this"
button. That made it look like something to press rather than the page you
were on. It is now a pair of tabs, the same as the Tasks and Settings pages:
a line underneath, the list you are on in blue with a blue underline. Each tab
still fills half the row and stays a finger's height (44 points), so it is as
easy to tap as before. Back and Open Full Page on a ticket stay buttons,
because those do something. The test now pins the tab markup so it cannot
drift back to buttons.
