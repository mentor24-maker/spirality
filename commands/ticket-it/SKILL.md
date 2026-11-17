---
name: ticket-it
description: Turn the idea, bug or request being discussed right now into one ticket in the right project's queue, with the operator's own words quoted verbatim, the context from this thread that a builder would need, and the status "Requested" so the intake loop writes the full spec. Read it back and give the link. A quick capture that doesn't stop the thread, unlike /loop-spec's full interview. Use when the user runs /ticket-it or says "ticket that", "make a ticket", "add that to the queue", "file this" or "we should do that later".
---

# Capture this as a ticket

The user has had an idea or found a problem mid-thread and wants it in the
queue without stopping to spec it. Intake will write the full spec later;
this command's job is to capture it faithfully and in the right place.

1. **Pin down what to ticket.** Usually it's the last thing discussed. If
   the user named it ("ticket the Docs lookup"), use that. If it's unclear
   which idea they mean, or it's really two pieces of work, ask in one line
   (or file two tickets, one each).

2. **Pick the right project.** Work for StarCaster goes in StarCaster's
   queue, WaveCenter's in WaveCenter's, and substrate work (the loop, the
   tracker, the shared package) in Spirality's. Never mix them. Each
   project's door is `npm run clickup` in its own repository
   (`~/WebApps/spirality`, `~/WebApps/starcaster`, `~/WebApps/wavecenter`);
   on the MacBook, Spirality's needs `TRACKER_API_URL=http://mac-mini.local:4180`
   and to run outside the sandbox.

3. **Check it isn't already there.** Search the queue
   (`npm run clickup -- queue`) for a ticket covering the same thing. If one
   exists, add this thread's context to it as a comment instead, and say so.

4. **Write the ticket.**
   - **Name**: what is wrong or missing and what to do, in plain words, in
     the queue's existing style (e.g. "Spirality's own documentation cannot
     be read in the tracker: show the docs folder on the Docs page").
   - **Body**: an "Asked" section with the user's words quoted exactly, in
     a code block; then "Context from the thread": why it came up, related
     tickets by id and exact title, files or pages involved, constraints
     already agreed. No secret values.
   - **Status**: `Requested`, so intake picks it up. Never `Queued`, and
     never one of Dane's two statuses.

   Create it with `npm run clickup -- task --name "..." --body-file -
   --status Requested --id-out <file>`, then read it back with
   `get --task <id>` and check the name and body landed as written.

5. **Answer** in one line: the ticket id and exact title as a link, and the
   project it went to. If you added to an existing ticket instead, say
   which.
