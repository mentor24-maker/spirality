## 2026-11-16 — Add bar charts to Task Productivity section Reporting page (#304)

The Reporting page's Task Productivity table said how many tasks were started
and finished between two dates, but only as one total. Now a small bar chart
sits beside it, with two bars for each day in that range: tasks started and
tasks finished. That shows the shape of the work at a glance: a quiet week, a
busy day, a run of finishing.

The server now counts each day separately as well as the total, and the days
always add up to the total. The chart follows the date pickers: change a date
and it redraws, pick an impossible range and it goes away, leaving the note
the table already showed. A range with nothing in it says so instead of
showing an empty box. On a narrow window the chart moves below the table.
