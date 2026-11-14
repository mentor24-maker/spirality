## 2026-11-13 — Task title suggester (#227)

The tracker can now suggest titles for a task. Give it a description of the
task, and the title you typed if you typed one, and it asks Claude on the
Mini for five short titles to choose from. Each starts with a verb and says
plainly what the task does, the same naming rule the loops follow.

This is the first half of Dane's request. It adds the suggester itself (a
new skill, and the code that runs it) and the address the page will call.
The second half, SP-248, puts it on the Add Task box with the toggle between
writing your own title first or starting from the description.

Why it is built carefully: what someone types is sent to Claude only through
its input, never on the command line where other programs could see it.
Claude gets no tools for this job, so it can only write text. It has a
minute to answer. If it does not send back exactly five usable titles, the
page gets a clear "try again, or write your own" instead of a broken list.
It uses the Claude sign-in the loops already use, so no new key was needed.
