## 2026-11-01 — Nobody can have a tracker account yet: teach the database to hold people's emails, passwords and sign-ins (#52)

The tracker's database can now hold real accounts for people, the first of
four steps away from "paste your tracker token". A person can have an email
and a password; the password is never kept as typed, only as a slow, salted
scramble that cannot quickly be turned back into the password. A signed-in
browser gets a session that lasts 30 days. Emailed links (a one-time setup
link for Dane's own account, an invite for someone new, a "forgot password"
link) work once and then stop, and run out after 7 days, or 1 hour for a
password reset. Using a reset link signs that person out everywhere.

The loops are not people: they cannot be given an email, a password or a
session, and keep their tokens exactly as before. Today's database picks up
the new pieces on start-up with every ticket, comment and sign-in left as it
was, and a test proves it. Nothing on the page changes yet; the sign-in
screen, the emails and the switch-over are the next three tickets.
