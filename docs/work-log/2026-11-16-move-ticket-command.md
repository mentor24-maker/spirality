## 2026-11-16 — Add a command that moves a ticket into another project (#299)

Until now the tracker could only copy a ticket into another project, and a
copy starts fresh: one "Copied from" note and none of the conversation. The
buses' Team chat tickets hold hundreds of comments, and alarm texts already
on Dane's phone link to their old addresses, so a copy would have lost the
history and broken those links.

Now a ticket can be moved for real. `npm run clickup -- move --task <id>
--to <project>` gives it the other project's next number and takes
everything with it: comments with their authors and times, its history,
files, tags and who has read what. Its old address keeps opening it, so no
link anywhere breaks. The move happens all at once or not at all, and the
command reads the ticket back afterwards: if the comments don't all arrive,
it says the move failed. Only someone who can change tickets in both
projects may move one. No real ticket has been moved yet; that is the next
ticket's job.
