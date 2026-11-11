## 2026-11-10 — SP-207: the relay tells the bus about merges

StarCaster's relay posts to its bus every time it merges a pull request or
refuses one, so whoever watches the bus sees each production deploy. Spirality's
relay wrote only on the ticket, so once StarCaster moved over, its bus would
have gone quiet about merges.

- **When a project names a bus (`busProject`), the relay now posts one line**
  for each merge, each refusal and each conflict hand-off, using StarCaster's
  wording with its name taken out. It posts only when the note on the ticket is
  written for the first time, so a pass that has nothing new to say posts nothing.
- **A post that fails says so.** It shows in the relay's UNCHECKED list and the
  pass exits 1. The merge itself is never undone or retried because of it.
- **A project with no bus is unchanged**: Spirality, WaveCenter and every
  project without `busProject` write nothing new.

Not carried over: StarCaster's daily nag about a stalled conflict hand-off,
because Spirality's relay keeps no clock for stalls.
