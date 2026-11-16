## 2026-11-14 — Approving a website bug report takes four clicks into a hidden menu: add an Approve button on the ticket, drop the Reply box that does nothing, and show the report clearly (#243)

This is the first of two parts. When a visitor reports a bug from a live site, the tracker gets a ticket for it. The top of that ticket's page used to show the ticket's name, cut off mid-sentence, and then "(none attached)", so Dane had to open Details to find out what was actually reported.

Now the top of the page reads "Bug Report:", then what the visitor wrote, in bold, then where and who it came from: the page they were on (a link), the project, the kind of visitor, their browser, when they sent it (in Mountain time) and the report's id. Whatever the visitor typed is shown as plain text, so nothing they type can change the page. Every other ticket looks the same as before.

The second part (SP-287) adds Approve and Reject buttons and removes the Reply box, which does nothing on these tickets.
