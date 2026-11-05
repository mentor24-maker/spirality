## 2026-11-05 — The setup wizard can only be driven from its Terminal: let it run without questions and leave a state file a page can read (#103)

Setting up a new product with `npm run onboard` meant sitting at its Terminal:
it asked questions, waited for "done" after the sign-ins paste, and waited up
to an hour for the merge. Dane wants to run the whole setup from the browser,
copying only the odd command line to the Mini.

This is the first of three pieces for that. The wizard now has a
`--no-prompt` mode that never waits for typing: at each point where it needs
Dane (answers to fill in, the sign-ins block to paste, the setup to merge) it
stops with a short message, and running it again after he has done his part
carries on from there. As it goes, it writes down in a small file where it
stands and exactly what to copy next. The tracker's setup page (the next two
tickets) reads that file to show each step and a Copy button. The file holds
commands and links only, never a password or key. The Terminal way still
works exactly as before.
