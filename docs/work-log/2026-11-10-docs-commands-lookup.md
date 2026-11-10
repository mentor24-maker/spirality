## 2026-11-10 — Dane's slash commands cannot be looked up in the tracker: add a commands look-up to the Docs page (#155)

Dane has a handful of his own slash commands for Claude Code sessions
(/close-check, /plain, /why-stuck and the rest), plus the four loop skills
this repository runs. Until now, when he forgot which one did what, the only
place to look was the files themselves on his MacBook.

The tracker's Docs page now has a **Commands** section listing every command,
each marked as his own or as a loop skill, with what it does. A search box
narrows the list as he types, by name or by what he wants to do; clicking one
opens its full steps, formatted to read like a page rather than raw text.

His own commands live only on the MacBook, and the tracker runs on the Mini,
so the page reads a copy kept in this repository's `commands/` folder. A new
`npm run commands:copy`, run on the MacBook, refreshes that copy, and the
result comes in like any other change, through a pull request. Because this
repository is public, the copy step refuses outright if any command looks
like it holds a key, and it will not empty the copy if it is run on a machine
that has no commands. The page itself only ever reads those command files,
nothing else on the disk, and a test checks that.

Until that first copy is made, the section lists the four loop skills and
says his own commands have not been copied yet.
