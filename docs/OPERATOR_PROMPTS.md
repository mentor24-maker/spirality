# Operator prompts

Every prompt Dane, the operator, gives a hand-run thread, word for word and in
order, each followed by what it led to: tickets, pull requests, doc changes,
decisions. His prompts are where everything the loop builds starts, so this is
the one record of them. Earlier sections are history and are not rewritten;
only a broken link is corrected. Material he pasted in (a screenshot, a log)
is named in square brackets, not copied. **This repository is public**: a
secret or someone's private details in a prompt is written as
"[removed: secret]".

Tickets are in the tracker at `http://mac-mini.local:4180/t/<id>`; pull
requests are in this repository unless named otherwise. A thread run from
this repository can work on other projects' tickets (PP- is PressPlay, UB- is
Upwork Blaster); those projects' own docs hold what was decided for them, and
this log only points there.

**One file per thread, in [operator-prompts/](operator-prompts/).** Each
thread's prompts are a file of their own, so two threads in flight at once
never edit the same lines (SP-293, "Any two threads in flight at once clash in
docs/OPERATOR_PROMPTS.md: give each thread's prompts their own file"; SP-38
did the same for the work log). The Docs page on the tracker lists them under
Operator Prompts, newest first.

**Adding a thread:** write a new file,
`docs/operator-prompts/<YYYY-MM-DD>-<topic>.md`: the thread's first day
(Mountain time), then a short topic in lower case with dashes. It starts with
a `## <date>: <topic>` heading and lists the prompts as numbered quotes, each
followed by its `Led to:` line. A later prompt in the same thread goes in the
same file. Links to other docs start with `../`.

**Never add a thread to this file.** It is not edited for a new thread, and it
keeps no list of threads: a list every thread adds to would clash again.
