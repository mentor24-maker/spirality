## 2026-11-01 — You cannot set a tracker password yet: add the emailed set-password link and your one-time setup email (#54)

The tracker can now hold a password for each person (#52), but nobody had a
way to set one. Now there is: a link in an email opens a page that needs no
sign-in, shows the email address the link is for, and asks for a new
password twice. Saving it says "Password set". The link works once. Open it
a second time, or after it expires, and the page says so in plain words and
changes nothing.

Dane's first link comes from a command a session runs on the Mini. It sends
the email through the same service as the "waiting on you" emails and
prints only "sent to <address>, good for 7 days", or the reason it did not
send. It refuses to give a password to a loop's account or to use an email
someone else already has. If the email service turns the message down, the
link is cancelled, so no usable link is left behind. Because the link goes
to Dane's existing account, every ticket and comment he already has stays
his.

Neither the link nor the password is ever written to the server's log or
the command's output; tests check both. Signing in with the password is the
next ticket. Until then the token box stays.
