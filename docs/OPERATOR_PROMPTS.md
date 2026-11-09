# Operator prompts

Every prompt Dane (the operator, the person who runs the loop) types into a
hand-run agent session, word for word and in order, with what each one led
to. His prompts are where everything the loop builds starts, so this is the
record of where each ticket, pull request and decision came from.

How entries are added (the `/doc-it` routine does this):

- One section per thread, newest at the bottom, headed with the date and a few
  words naming what the thread was about.
- Each prompt is quoted exactly, including short ones ("go") and slash
  commands. Material he pasted in is named in square brackets, not copied.
- Under each prompt, a **Led to:** line: tickets (id and exact title), pull
  requests, doc changes, memories and decisions, linked. "Nothing yet" when
  it produced nothing, so a gap is visible.
- This file is only ever added to. Earlier entries are history and are not
  rewritten; only a link that has gone wrong is corrected.
- **This repository is public.** A secret or someone's private details in a
  prompt is written as "[removed: secret]".

Tickets are on the tracker on the Mini (`http://mac-mini.local:4180`). A
thread run from this repository can work on other projects' tickets (PP- is
PressPlay, UB- is Upwork Blaster). Those projects' own docs hold what was
decided for them, and this log only points there.

---

## 2026-11-09: PressPlay overview, Upwork Blaster plan, PressPlay full copy

1. > Provide a link to the Overview.md file from http://mac-mini.local:4180/t/PP-2

   **Led to:** the link to PressPlay's overview, from [PP-2](http://mac-mini.local:4180/t/PP-2), "Write an overview of the application in it's current state" (pull request [#5](https://github.com/mentor24-maker/pressplay/pull/5), merged): https://github.com/mentor24-maker/pressplay/blob/main/docs/OVERVIEW.md. Nothing else.

2. > Find the doc referenced in http://mac-mini.local:4180/t/UB-2

   **Led to:** two links from [UB-2](http://mac-mini.local:4180/t/UB-2), "Produce development plan for Upwork Blaster based on hand-off doc.": the plan it produced (pull request [#2](https://github.com/mentor24-maker/upwork-blaster/pull/2), merged), https://github.com/mentor24-maker/upwork-blaster/blob/main/docs/DEVELOPMENT_PLAN.md, and the hand-off doc, which is an attachment on the ticket and is kept out of the public repository. Nothing else.

3. > On the PressPlay project, are we getting the entire story through the feed, or just headlines?

   **Led to:** the answer: only the headline, a snippet of at most 280 characters, the source, the time and the link, by PressPlay's copyright rule at the time. That answer led to prompt 4.

4. > OK, we are definitely going to need the full copy of all the stories. We don't need to publish any of them, but we need the information. We also do want to get a neutral compilation of all the facts of any given story based on all available sources. We are building this tool for the news outlets who have the stories, so I don't think there will be any issue getting and using the full copy. Please create a ticket to beef up the system based on these premises.

   **Led to:** Dane's decision to store full copy privately and never publish it, now PressPlay's copyright rule (PressPlay `docs/OVERVIEW.md`, "The copyright rule"). Filed as [PP-3](http://mac-mini.local:4180/t/PP-3), "Store the full copy of each story privately and build a neutral fact sheet per story from all sources". The loops split it into three slices:
   - slice 1, PP-3 itself: pull request [#6](https://github.com/mentor24-maker/pressplay/pull/6), merged, with every outlet switched off;
   - [PP-4](http://mac-mini.local:4180/t/PP-4), "Group stories from different outlets that are about the same news event, so each event can get one fact sheet";
   - [PP-5](http://mac-mini.local:4180/t/PP-5), "Write a neutral fact sheet for each news event from all its sources, using Claude, capped at $50 a month".

5. > /close-check

   **Led to:** the finding that the PP-3 review's list of fixes needed before any outlet is switched on was in no queue and in no doc. Prompt 6 wrote it down.

6. > /doc-it

   **Led to:** [PP-6](http://mac-mini.local:4180/t/PP-6), "The overview says a run that is cut off keeps its full copy, but it does not: correct it and list the fixes needed before an outlet is switched on" (pull request [#7](https://github.com/mentor24-maker/pressplay/pull/7) in PressPlay), and [SP-182](http://mac-mini.local:4180/t/SP-182), "Dane's prompts are not recorded anywhere: start docs/OPERATOR_PROMPTS.md and link it from CLAUDE.md", which started this file.
