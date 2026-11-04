## 2026-11-04 — Alerts for every project go to one address set in Doppler: add an alert email and phone to each project's settings (#85)

Until now, every "this is waiting on you" email from the tracker went to one
address, set once in Doppler, whichever project the ticket belonged to. Each
project now has its own Alert email and Alert phone boxes on its Edit project
page. When a project has an alert email, its hand-over emails go there.
When it doesn't, they go to the Doppler address as before, so nothing changes
until someone fills a box in.

The boxes reject anything that clearly isn't an email or an international
phone number, and say which box was wrong. Only a person signed in can see
what's in them. The loops and the Projects table never do, and the log says
only *which* address an email went to, never the address itself. The phone
number is stored ready for the next ticket, which will send iMessage texts
to it. Nothing texts it yet.
