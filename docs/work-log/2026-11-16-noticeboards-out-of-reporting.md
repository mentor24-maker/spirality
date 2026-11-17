## 2026-11-16 — Leave noticeboard tickets out of the Reporting page (#295)

Each project now keeps its Team chat ticket in its own queue, parked in Live. Live is where finished work sits, so the Reporting page was counting the Team chat as a finished ticket, and every message posted to it as time spent on it. StarCaster's weekly report has the same problem, because it gets its numbers from `npm run clickup -- stage-counts`.

Both now skip noticeboards: the Team chat, plus any ticket tagged `noticeboard`, such as StarCaster's Pipeline pause switch. One file, `lib/loopNoticeboards.js`, decides what counts as a noticeboard, and the loops already use that same file, so there is only one list to keep up to date. On a copy of the real tracker, StarCaster's all-time finished count went from 727 to 725, and each bus project lost the one ticket it should never have counted. The Tasks list still shows the boards as before.
