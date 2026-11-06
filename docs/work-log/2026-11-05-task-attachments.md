## 2026-11-05 — Allow attachments to Add Task form (#113)

Dane can now attach files when he files a request from the Add Task box on
the Tasks page: a screenshot, a PDF, a note. Before this, the box took only
words, and the tracker had nowhere to keep a file.

The files are kept inside the tracker's own database, the same single file
that holds every ticket. That matters because the nightly backup already
copies that file, so the attachments are safe with nothing new to look
after. Each file can be up to 10 MB; a bigger one is turned away with a
plain sentence and nothing is saved.

When he clicks File Request, the ticket is filed first and then each file
goes up on its own. The note afterwards says which files went up, and names
any that did not and why, so one bad file never loses the request. The
ticket's page lists the files under the description, with their sizes; each
name downloads the file, and a picture also shows a small preview.

For safety, a downloaded file is always saved rather than opened in the
tracker's page, so a file that happens to be a web page can never run as if
it were the tracker itself.

The loops cannot read these files yet; that is the next ticket, SP-142.
