## 2026-11-09 — A ticket's new files are buried in a comment: show them in a Files Made box on its page (#145)

When a ticket's pull request creates new files, the relay's merge note now
lists them, each one linked on GitHub (that was the first half of this
request). But that note is just one comment among many, folded away under
Details, so the files were still hard to find.

Now a ticket's page shows those files in a light-blue **Files Made** box near
the top, under the Quick Action section. Each file name is a link that opens
the file in a new tab. A ticket that made no files shows no box. If a ticket
was built in parts, the box shows the newest list. The page only links to web
addresses, and it shows every file name as plain text, so a strange file name
can't change the page.
