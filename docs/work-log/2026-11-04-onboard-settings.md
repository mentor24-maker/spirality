## 2026-11-04 — A new product's settings file is written by hand: generate it from the setup answers (#92)

Every product the loops work on has a small settings file, `spirality.project.json`, that tells the loops which GitHub repository, which tracker project, which secret store and which log folder are its own. Normie's was typed out by hand, line by line. That is slow, and one typo sends a loop to the wrong place.

Now one command writes it from the answers file the setup already collects: `npm run onboard:settings -- write`. It also fills in the values nobody should have to type. It finds Dane's tracker account by his name, finds the product's build-loop sign-in if it exists yet, and copies the tracker's addresses and the log folder from Spirality's own settings. Then it reads the file back with the same checker every loop uses. If something did not stick, it says FAILED and names the field. A second command, `fill-machine-user`, adds the build-loop sign-in's number later, once the sign-ins step has made it.

Run for Normie, it produced Normie's real file, except for the order of one entry in the list of protected files. The test names that difference. The first real run also caught a mistake before it shipped: the Mini's private address had slipped into the file in place of the address Dane's browser uses. Spirality's settings are now read only from the file itself, never from the address the secret store gives the loops.

This is the third of the six setup-wizard pieces.
