## 2026-11-16 — Add why-stuck and others in the Quick Claude Commands in Docs (#297)

The Docs page's Quick Claude Commands pod lists Dane's own slash commands from
this repository's copy in `commands/`, but that copy was empty, so none of his
showed. A MacBook session ran `npm run commands:copy` and brought in all eight
of his commands: `/close-check`, `/doc-it`, `/handover`, `/my-move`, `/plain`,
`/test-me`, `/ticket-it` and `/why-stuck`. Each file was read in full before
it was committed, because this repository is public. None holds a key, an
address or anything private.

One word had to change first. The wording check (Dane's "say projects, not
products" rule) caught `/doc-it` saying a prompt's "Led to:" line lists "its
products". There it meant what the prompt produced, so the original on the
MacBook now says "what it produced", and the copy was taken again. The
copy was never edited by hand.

The Mini's build lane could not do this ticket (SP-369), because the
originals live only on the MacBook. The copy does not keep up by itself: after
a command changes, run `npm run commands:copy` on the MacBook again and open a
pull request.
