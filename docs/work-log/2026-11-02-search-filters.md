## 2026-11-02 — Dane cannot narrow his search results: add Status, Priority, Created by and Assigned to filters to the search (#66)

The search page could find tickets by a word, but a common word brings back
dozens of them, with no way to cut the list down. There are now four pickers
above the results: Status, Priority, Created by and Assigned to. Each starts
at "Any". Choosing one shrinks the list at once, still best matches first and
still with the word in bold. So a search can be cut down to, say, "only Queued
tickets nobody is assigned to".

The tracker's server does the narrowing, not the page, and it also supplies
the choices in each picker (the stages in the loop's order, the priorities,
and the people and loops by name). If something new is added to any of those,
it shows up in the pickers without changing the page. The chosen filters are
written into the page's address, so a reload or a shared link shows the same
list. A filter value that doesn't exist, such as a made-up status, gets a
plain message saying so, rather than an empty list that would look like "no
results".
