## 2026-11-16 — Add attachment field to Change This Ticket form (#303)

A ticket's page can now take files after the ticket is filed. Before this,
the only way to put a screenshot or a PDF on a ticket was to attach it to a
brand new request in the Add Task box, which is why Dane had to refile a
Console layout request just to get its picture on it.

The Change This Ticket panel has a new Files row with a picker and an Upload
button. Each file goes up on its own, so one that fails does not stop the
rest; a file over 10 MB is never sent. When it finishes, the page redraws so
the new files show under Attachments, and the message line at the top says
which files went up and names each one that did not, with the reason. A
failure is never reported as a success.
