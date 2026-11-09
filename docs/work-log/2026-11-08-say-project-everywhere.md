## 2026-11-08 — The Projects page button still says Set Up a Product: say project everywhere and make verify catch the word coming back (#124)

The button on the Projects page said the wrong word again. Normie, PressPlay
and Spirality are projects, and an earlier change (SP-128) had already made
the loop say so. Later pull requests brought the old word back in 164 places:
the button, the setup page, the setup command and their tests. All of them
say "project" now. The button reads **Set Up a Project**.

Nothing that already works breaks. A setup command saved with the old option
name still runs, and a setup page opened with the old address still loads.

This time the fix stays fixed. `npm run verify`, the check every pull request
has to pass, now includes a wording check. If the old word appears as a whole
word anywhere outside this work log, the check fails and names the file and
line. Words that only contain it, like "production", still pass.
