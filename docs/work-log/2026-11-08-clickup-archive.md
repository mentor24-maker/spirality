## 2026-11-08 — Spirality still depends on ClickUp after the week: make its list a read-only archive (#126)

Spirality had spent its week running on the tracker with ClickUp kept alongside as a backup to compare against, and Dane said the week went well. This change lets ClickUp go for Spirality without throwing anything away.

Spirality's settings file no longer names its old ClickUp list, so nothing in Spirality reads or writes it: the list stays in ClickUp exactly as it was, as an archive. The health check (`npm run doctor`) stops asking for the ClickUp key, and the two tools that copy from ClickUp now say plainly that this project has no ClickUp list instead of failing in a confusing way.

Old pull requests and comments still mention ClickUp ticket ids. A new lookup, `npm run tracker:old-id -- <id>`, turns one into its tracker ticket and link (86bctjbc3 is SP-21), reading the tracker's records without changing them. The tracker plan document now explains all of this and writes down the archived list's ids, in case Spirality ever needs to switch back.
