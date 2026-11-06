## 2026-11-06 — The loops cannot see a request's attached files: list them in get and save them with an attachments command (#115)

Dane can now attach files (a screenshot, a note) to a request on the Tasks
page, but until now the loops never saw them. The command every loop uses to
read a ticket only showed its text, so a picture Dane attached could never
shape the spec or the build.

Now that command lists each file on the ticket by name and size, and a new
command saves the files to a folder so a session can open them. It checks
each saved file is the right size, never writes over a file already in the
folder, and says plainly which file failed when one does. The instructions
for the intake, spec and build loops now say to save and read the files
before writing anything.

One safety detail: the tracker running on the Mini is older than the
attachments feature, so it cannot list files yet. Instead of breaking every
loop's ticket read, the read now says "COULD NOT BE READ, the files are
unknown" and carries on, and the loops are told never to treat that as "no
files". Once the Mini's tracker restarts on the merged code, the files show
up.
