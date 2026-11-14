## 2026-11-14 — Let Spirality's door act for another project's checkout (#236)

Every project used to need its own copy of the door into the tracker (`npm run clickup`), because the door only knew about the project whose folder it ran from. Now Spirality's own copy can act for any project. You name that project's folder in one setting, `SPIRALITY_PROJECT`. The door then reads that project's settings file and works on its tickets, and the Doppler wrapper reads that project's keys, so StarCaster's tracker key still comes from StarCaster's own store and is never printed. With nothing named, everything works exactly as before.

Why it matters: this is the second of five steps to keep the loop's code only in Spirality, so that a fix made once reaches every project. The next step lets the lanes set this name when they run for a project.

Second round, after review: the door read the named project's settings, but the smaller helpers it uses still read Spirality's own file. So a note the door posted on a StarCaster ticket was signed as Spirality's, and the words that mean "merge it", the operator's name and the clickable ticket links came from Spirality's file too. Those helpers now read the named project's file as well, and a test runs them from Spirality's folder against a made-up project with its own name and merge words to prove it.
