## 2026-11-13 — Add a custom date range to the Reporting page's Task Productivity table (#219)

The Reporting page's first table counted tasks started and finished only over fixed spans: the last 7 days, the last 30 days and all time. Dane asked to pick his own dates. The table now has a Start Date and an End Date column, each with a calendar picker in its heading, starting at 30 days ago and today. Pick any two days and the table shows how many tasks were started and finished between them, counting both whole days in Mountain time.

Changing a date updates just those numbers, without reloading the page, and keeps the project chosen. Picking a start after the end says so in a plain sentence instead of showing a wrong zero. Behind the page, the tracker's report address accepts the two dates and refuses a half-given or back-to-front range with a clear message. Tests check the edges: a task on the first or last day counts, one a day outside does not.
