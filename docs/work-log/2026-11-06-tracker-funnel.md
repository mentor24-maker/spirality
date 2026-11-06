## 2026-11-06 — StarCaster's server cannot reach the tracker on the Mini: put the tracker's API on the internet over https (#120)

StarCaster's Spirality page will run on StarCaster's server, which lives on
the internet, not in the house, so it could not reach the tracker on the
Mini. This gives the tracker one public https address through Tailscale
Funnel, the same service StarCaster already uses on the Mini, on its own
port (8443) so StarCaster's routes are untouched.

At that address the tracker shows only its data doors, never its page, and
the sign-in cookie is marked "https only". On the home network nothing
changes. A new script puts the route on, checks it and takes it off; it
refuses to publish a tracker still running older code, and checks after
every change that StarCaster's routes are exactly as they were. The route
goes on after this merges and the tracker has restarted onto the new code.
