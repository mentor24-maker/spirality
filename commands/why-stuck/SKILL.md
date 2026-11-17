---
name: why-stuck
description: Find out why a ticket hasn't moved and say in one line what is blocking it and whose move it is (Dane's, a loop's, or nobody's because something broke). It reads the live ticket trail and comments, the pull request and its checks, the loop logs and launchd lanes on the Mini, and the waiting check, then explains the cause in plain language with the evidence and the fix. Use when the user runs /why-stuck, or asks "why hasn't SP-12 moved?", "what's happening with this ticket?", "is the loop stuck?" or "why is this still Building?".
---

# Why is this ticket stuck?

The user sees a ticket sitting still and wants to know what's holding it and
who has to act.

1. **Identify the ticket.** The one named, or the one this thread is about.
   If it's unclear, ask which. Use the door of the ticket's own project
   (`npm run clickup` in `~/WebApps/spirality`, `~/WebApps/starcaster` or
   `~/WebApps/wavecenter`; on the MacBook, Spirality's needs
   `TRACKER_API_URL=http://mac-mini.local:4180` and to run outside the
   sandbox).

2. **Read the evidence live.**
   - The ticket: `get --task <id>` (status, assignee, rounds, pull request,
     MAIN MOVED note) and `comments --task <id>` (the trail, newest last).
   - Is it his? `waiting --task <id>` (exit 3 means it's waiting on Dane).
   - The pull request: open or merged, checks green or red, conflicts,
     review comments (`gh pr view`, `gh pr checks`).
   - The loops, on the Mini over ssh: is the lane for this status running
     (`launchctl list | grep <launchd prefix>`), and what did its latest
     passes say about this ticket (the log folder from the project config,
     e.g. `~/loop-logs`)? Look for errors, time-outs, a billing or sign-in
     failure, or a pass that skipped it and why.

3. **Name the cause.** Match what you found to one of these, or say plainly
   that it's something else:
   - **Waiting on Dane**: a question card or merge he hasn't answered.
   - **Waiting its turn**: the loop is running and other tickets come first.
   - **Blocked by another ticket**: a slice waiting on an earlier one.
   - **Pull request trouble**: red checks, a conflict with `main`, or
     review send-backs piling up.
   - **A loop is down or failing**: the lane isn't running, or each pass
     errors (account, billing, sign-in, the Mini asleep).
   - **Left behind**: claimed and abandoned (in `Building` with no recent
     pass).

4. **Answer.** One line first: what's blocking it and whose move it is.
   Then the evidence, a few lines quoting the comment, log line or check
   that shows it, with times in Mountain time. Then the fix: what you can do
   now (and offer to), or the exact action that's his. Don't change the
   ticket's status yourself unless the user says to.
