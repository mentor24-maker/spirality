## 2026-11-01 — You cannot invite anyone to the tracker: add a People page that sends invite emails (#58)

The last of the four account steps. Anyone signed in to the tracker can now
open **People** in the header, see who has an account and who has been
invited, and invite someone new by typing their email. The new person gets
an email saying who invited them, with a link that works once for 7 days;
it asks for their name and a password, and then they can sign in like
anyone else. Nobody can join without being invited.

The page refuses, with its reason and without sending anything, an email
that already has an account, a second invite to the same email, and the
loops (only people can invite). An open invite can be cancelled, and its
link stops working at once. If the email does not go out, no invite is
left behind and the page says so, so nobody is listed as invited who never
got the email. One thing to know: until a domain is set up in Resend, the
email service only delivers to Dane's own address, so invites to anyone
else will say the email did not go out.
