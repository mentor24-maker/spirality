## 2026-11-18 — Report the lanes' long-lived Claude sign-in in npm run onboard:look over ssh (#324)

The setup look (`npm run onboard:look`) checks, among other things, that
Claude is signed in on the Mini. Run from another computer over ssh, it said
"BLOCKED" even when the loops were signed in and working: the Mini keeps that
sign-in in its keychain, a locked store an ssh session cannot open, so Claude
answered "not signed in".

The loops are moving to a long-lived sign-in made for unattended jobs, kept
in Doppler (the secret store) as `CLAUDE_CODE_OAUTH_TOKEN`. The look already
runs with Doppler's secrets, so now, when that sign-in is there, it reports
"ready, signed in by the lanes' long-lived token" without touching the
keychain, and never prints the secret itself. When it isn't there and the
answer is "not signed in" over ssh, the look says the keychain may be why and
names the long-lived sign-in as the fix, instead of a bare "BLOCKED".
