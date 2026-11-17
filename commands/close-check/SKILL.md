---
name: close-check
description: Decide whether this conversation can be closed. Review everything handled in it, check the live state of each item, and say plainly whether anything still depends on this thread. Use when the user asks "can I close this thread?", "do we need to keep this open?", or runs /close-check.
---

# Can this thread be closed?

The user wants to know whether this conversation still matters, or whether
everything it handled is finished or tracked somewhere else.

1. **List what this thread handled**: every request, decision and piece of
   work from the start of the conversation, not just the most recent one.

2. **Check each item's current state; don't go by memory.** Read the
   tickets, pull requests, branches or files involved. A ticket said to be
   "queued" earlier may be Live now, and a pull request may have merged.
   If an item can't be checked, say so rather than guessing.

3. **Sort each item into exactly one group:**
   - **Done:** finished and verified.
   - **Tracked elsewhere:** recorded somewhere that will carry it forward
     without this thread (a ticket, a pull request, a saved memory, another
     thread the user named). Say where.
   - **Depends on this thread:** context, a half-finished step or a promise
     that exists only here. Spell out exactly what would be lost.

4. **Save before you answer.** If an item depends on this thread only because
   a decision or fact isn't written down, offer to save it (memory, a ticket
   comment, or a handover note) so the thread can close.

5. **Answer first, in one line:** "You can close this thread" or "Keep this
   thread open, because …". Then the groups, briefly, with exact ticket ids
   and names. If a handover note would help a fresh thread, give it as a few
   lines the user can paste.
