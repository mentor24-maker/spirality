## 2026-11-10: spirality.alphire.agency opens the tracker

1. > I thought one of the tickets we handled set up the web-based access to Spirality to show the actually task list instead of the stripped down one that only shows the Board, with no toggle for the List view. What is the status of that change?

   Led to: the finding that [SP-164](http://mac-mini.local:4180/t/SP-164), "spirality.alphire.agency shows StarCaster's small Tasks page: point it at the tracker's own page" ([#135](https://github.com/mentor24-maker/spirality/pull/135)), was Live but its hand-run move had never been done, so the name still opened StarCaster's page.

2. > yes

   Led to: the Funnel route checked from the Mini, then [SP-198](http://mac-mini.local:4180/t/SP-198), "The tracker page's forwarding site answers 404 at its front page: forward / to the tracker too" ([#160](https://github.com/mentor24-maker/spirality/pull/160)), after the project deploy below showed Vercel's 404 at `/`.

3. > [pasted: his Terminal output from `vercel link` and `vercel deploy --prod` in sites/tracker-page, creating the Vercel project spirality-tracker-page]

   Led to: the `spirality-tracker-page` project (https://spirality-tracker-page.vercel.app); the token file the CLI left in the folder checked as not served, and deleted.

4. > I see SP-200 was sent back to Rework. Let's change it's priority to Urgent so it skips ahead as much as possible.

   Led to: [SP-200](http://mac-mini.local:4180/t/SP-200), "StarCaster's bus-relay, pulse and weekly report read ClickUp: list what each needs on the tracker and file the work", set to Urgent, first in the claim order.

5. > redeployed

   Led to: the forwarding site checked: `/` shows the tracker's page, `/me` answers 401.

6. > move it

   Led to: `spirality.alphire.agency` moved from StarCaster's Vercel project to `spirality-tracker-page` and checked live; [SP-209](http://mac-mini.local:4180/t/SP-209), "Invite and reset emails still link to the Mini's address: point them at spirality.alphire.agency" ([#164](https://github.com/mentor24-maker/spirality/pull/164)).

7. > Confirmed.
   > /close-check

   Led to: the tracker restart owed after #164 merges written on SP-209 (comment 3772); the SP-198 worktree removed.

8. > /doc-it

   Led to: [SP-210](http://mac-mini.local:4180/t/SP-210), "A ticket goes Live while its hand-run steps are still undone: file them as their own ticket, and write this thread's prompts down" (this section, the rule under "Where the ticket goes after the merge" in docs/LOOP_CONTRACT.md, and the ssh note in docs/TRACKER_MVP.md), and the memory "Vercel from the MacBook".
