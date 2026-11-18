## 2026-11-17 — The Mini's Claude sign-in ends between 11/22 and 11/25 and every loop stops with it: give the lanes a long-lived sign-in (#316)

Every lane on the Mini signed in to Claude the way a person does, with a
browser sign-in kept in the Mini's keychain. That sign-in ends on a fixed date
(this time between 11/22 and 11/25), and when it ends every loop in every
project stops.

Now each lane pass first looks in Doppler, the secret store, for a long-lived
sign-in made for unattended jobs (`claude setup-token`, good for about a year),
and hands it to that pass alone. It is never written to a log or shown in the
list of running programs. If it is not there yet, the pass carries on with the
Mini's own sign-in, exactly as before, and the log says so in one line. One
token serves every project, because every project's lanes run from
Spirality's folder.

A new script, `scripts/claude_token_to_doppler.sh`, is the one step left for
the account holder: make the token in the browser, run the script, paste it.
The script never shows the token, checks it arrived whole, and says plainly
if it did not. `npm run doctor` now reports whether the token is there, and
the "could not sign in" line in the logs names the right fix for whichever
sign-in failed.
