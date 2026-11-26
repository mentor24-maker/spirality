## 2026-11-25: SP-404, All Projects taken off Board and List

This thread was opened from the StarCaster repository; its first prompt was a
diagnosis, and the fix is Spirality's.

1. > The spirality site has begun acting strangely. None of the links work, and eventually it pops up the Page unresponsive message. This is the only site in my browser doing this. Can you see what is going on?

   Led to: a diagnosis on a copy of the real tracker store, run on the MacBook with mail off. The server was healthy; the page was not. All Projects on Board and List (SP-402, PR #334) is remembered once picked, so "Tasks" drew all 1,596 tickets (about 175,000 page elements) and redrew them on the minute's beat; each redraw froze Chrome for over a second. Suggested test: switch the Project picker back to one project.

2. > That was it. Good job. Let's remove the All Projects option. It's not worth the effort. And remove it wherever else it might cause a similar problem.

   Led to: [SP-404](http://mac-mini.local:4180/t/SP-404), "Remove All Projects from the Tasks Board and List: it draws every ticket and freezes the page", filed and built by this hand-run session. Board and List lost All Projects and everything that served only it (`GET /all-projects/board` among them). The Console's and Reporting's All Projects were measured and kept: they draw work in flight and counts, not every ticket ([work log](../work-log/2026-11-25-remove-all-projects-board-list.md)).
