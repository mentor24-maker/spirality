## 2026-11-01 — The Reporting page cannot show how well work flows yet: add time to finish, sent-back rate and time waiting on Dane (#60)

The Reporting page used to say only how many tasks were finished and started. Now it also says how smoothly the work moves, for the last week, the last month and all time:

- **Time to finish**: how long a task typically takes, and the longest one took, from joining the queue to going live. Tasks that never sat in the queue (old imports, for example) are left out, and the page says how many.
- **Sent back**: how many finished tasks the review step returned for more work at least once, as a count and a percentage.
- **Waiting on you**: how much time finished tasks spent waiting for Dane's answer or merge word, and how many are waiting on him right now.

Every figure comes from the tracker's own record of each status change, so nothing new has to be written down for it. The demo tracker now gives its finished tasks a full history, so every report shows a real number when you click through it.
