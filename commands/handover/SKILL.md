---
name: handover
description: Write a short, paste-ready handover note so a fresh conversation can carry on this thread's work without losing anything. It covers what the thread was for, what's done (verified), where it stopped, the exact next step, and every ticket, pull request, branch, worktree and file involved, all checked live. Use when the user runs /handover or says "hand this over", "I want to start a new thread", "this thread is getting long", "write me a pickup note", or when /close-check says to keep the thread open but the user wants a clean start.
---

# Handover note for a fresh thread

The user wants to close this conversation and carry on in a new one. The
new session will know only what this note tells it, so the note has to be
complete and accurate.

1. **Go through the whole thread**, from the first message, not just the
   last task. List the goal, the decisions made and who made them, the work
   done, and what is still open.

2. **Check the live state of everything named.** Read the tickets (status,
   latest comment), the pull requests (open, merged, checks green or red),
   the branches and worktrees (`git worktree list`, uncommitted changes),
   and any background job still running. Go by what you read, not by what
   the thread says happened. If something can't be checked, say so in the
   note.

3. **Save what would otherwise be lost.** A decision or fact that is
   written down nowhere but here goes into a ticket comment, the project
   docs (offer `/doc-it`) or memory before the note is written, and the note
   says where it went.

4. **Write the note** as a plain block the user can paste as a new thread's
   first message:
   - **Goal**: one or two sentences.
   - **Done**: each item, verified, with its ticket or pull request.
   - **Where it stopped**: the exact state, including half-done steps,
     uncommitted changes and the worktree path.
   - **Next step**: the one thing the new session should do first, as an
     instruction.
   - **References**: ticket ids with exact titles, pull request numbers,
     branch names, file paths, machine (MacBook or Mini).
   - **Watch out for**: traps found in this thread that the new session
     would otherwise walk into.

   Keep it short: a page at most. It contains no secret values.

5. **Answer.** Give the note in a code block so it copies cleanly, then one
   line on anything you saved in step 3. Offer to copy it to the clipboard
   with `pbcopy`; it's a note, not a command, so this is safe on either
   machine.
