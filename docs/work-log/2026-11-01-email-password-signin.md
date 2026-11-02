## 2026-11-01 — You still sign in by pasting a token: sign in with email and password, with a forgot-password email (#56)

The tracker page used to ask for a long secret code, a "token", to be pasted into a box, and kept it in the browser where any script on the page could read it. Now you sign in the ordinary way, with your email and the password you set from your setup email, and the page keeps you signed in for 30 days. It remembers you with a cookie, a small note the browser keeps and sends back automatically, which the page's own code cannot read. Signing out ends that sign-in at the tracker itself, not just in the browser.

If you forget your password, "Forgot password?" emails you a link that works for one hour. The page says the same thing whether or not the email has an account, so nobody can use it to find out who has one. A wrong password and an unknown email also get the same answer. After five wrong tries in fifteen minutes, that email is paused for fifteen minutes, which slows down anyone guessing.

The loops are not affected: they still sign in with their own tokens, exactly as before, and a loop's token can never be turned into a person's sign-in. Another website cannot make changes as you, and no password or sign-in code is ever written to the tracker's log.
