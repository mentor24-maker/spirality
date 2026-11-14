## 2026-11-14 — Let Spirality's door act for another project's checkout (#236)

Every project used to need its own copy of the door into the tracker (`npm run clickup`), because the door only knew about the project whose folder it ran from. Now Spirality's own copy can act for any project. You name that project's folder in one setting, `SPIRALITY_PROJECT`. The door then reads that project's settings file and works on its tickets, and the Doppler wrapper reads that project's keys, so StarCaster's tracker key still comes from StarCaster's own store and is never printed. With nothing named, everything works exactly as before.

Why it matters: this is the second of five steps to keep the loop's code only in Spirality, so that a fix made once reaches every project. The next step lets the lanes set this name when they run for a project.
