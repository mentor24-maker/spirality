---
name: doc-it
description: Fold everything worth keeping from this conversation into the project's canonical docs (decisions, rules, conventions, corrections, ids and commands, and lessons from what went wrong), each written into the one doc that owns that topic, replacing outdated text rather than appending to it; record every one of the operator's prompts from the thread, verbatim, in the operator prompt log, each mapped to what it produced; and ship it all the way the repository requires. Use when the user runs /doc-it, or says "document this", "write this down", "put this in the docs", "make this doctrine" or "make sure the next session knows this".
---

# Write this conversation into the doctrine

The user wants nothing learned in this thread to live only in this thread.
Every lasting fact goes into the project's canonical docs, in the right place,
so the next session (or the next person) reads it there.

1. **Gather from the whole conversation, not just the last few turns.** Look
   for:
   - **Decisions** the user made, in their own words where the wording matters.
   - **Rules and conventions**: how something must always or never be done.
   - **Corrections**: anything the user had to tell an agent twice, or a
     doc turned out to say wrongly.
   - **Facts a later session would otherwise have to rediscover**: ids, paths,
     commands, names, which machine something runs on.
   - **Lessons from what went wrong**: the incident, in one or two sentences,
     and the rule it produced.

   Leave out what only mattered for this thread, what the code or git history
   already records, and anything secret. Most repositories are public; a key,
   password or token never goes into a doc.

2. **Find each item's one home.** Read the repository's `CLAUDE.md` and the
   docs it points to (for Spirality: `docs/LOOP_CONTRACT.md`,
   `docs/LOOP_ENGINEERING.md`, `docs/DOCTRINE.md`, `docs/PLAN.md`,
   `docs/TRACKER_MVP.md`, and the rest of `docs/`). Put each item in the doc
   that owns its topic. One fact lives in one place; other docs link to it
   rather than repeat it. If no doc fits, propose a new section or a new doc
   instead of squeezing it in somewhere it doesn't belong.
   - Something about **how agents should work with this user** across
     projects goes in memory, not the repository.
   - Something that belongs to **another project** goes in that project's
     docs. Never mix projects.

3. **Read the target section before writing.** If it already says it, skip
   the item. If it says something different, **replace** the old text so the
   doc reads as one current rule; don't add an "Update:" paragraph underneath.
   If the conversation conflicts with the doc and the user didn't clearly
   choose to override it, **ask** which is right; don't pick one quietly.

4. **Write it the way the doc is written.** Match its voice, headings and
   level of detail, and follow its own rules (for Spirality: plain language,
   and Title Case for page labels as `docs/DOCTRINE.md` sets out). Name the
   source of a decision the way the doctrine does: who decided, the ticket id
   and exact title, and the date, e.g. "Dane chose this on SP-138, '…'
   (2026-11-05)". Dates are absolute; times are Mountain time.

5. **Log every one of the operator's prompts.** The operator is the person
   who runs the loop (Dane, on Spirality). Their prompts are the seed of
   everything the loop builds, so each one is recorded in a single listing,
   `docs/OPERATOR_PROMPTS.md` in the repository the thread worked in. If the
   file doesn't exist, create it with a short opening paragraph saying what
   it is, and link it from `CLAUDE.md`.
   - **Every prompt, in order, word for word.** Include short ones ("go",
     "yes") and slash commands (`/doc-it`). Don't tidy the wording. Material
     the operator pasted in (a log, an email, a long document) is not their
     prompt: name it in square brackets, e.g. "[pasted: build log from
     SP-140]".
   - **Map each prompt to what it produced**: tickets (id and exact title),
     pull requests (number and title), doc sections changed, memories saved,
     decisions made. Link each one. A prompt that only answered a question
     maps to the decision it settled. Write "Nothing yet" if it produced
     nothing, so a gap is visible.
   - **Shape**: one section per thread, newest at the bottom, headed with the
     date and a few words naming what the thread was about. Under it, a
     numbered list: the prompt as a quote, then a "Led to:" line with what it
     produced.
   - **This log is the one place that adds instead of replacing.** Earlier
     threads' entries are history and stay as they are; only correct a link
     that has gone wrong.
   - **The repository is public.** If a prompt contains a secret, a password
     or someone's private details, write "[removed: secret]" in its place and
     say so in the report.

6. **Ship it the way the repository requires.** Never commit to `main`
   directly. Work in a new git worktree on its own branch, run the
   repository's check (`npm run verify` in Spirality), and open a pull
   request. Where the repository says every change needs a ticket (Spirality
   does), file or use one and follow its rules for the pull request title and
   body. Memory edits are saved directly.

7. **Report.** One line first: what was documented and where the pull
   request is, or "Nothing new to document" if that's the truth (the prompt
   log still gets this thread's entry either way). Then a short list: each
   item, the doc and section it went into, and anything skipped with the
   reason. Say how many prompts were logged, and point out any that show
   "Nothing yet". End with any question from step 3 that needs the user's
   decision.
