## 2026-11-14 — Supply the loop skills and hooks to each lane session from Spirality (#246)

When Spirality runs a lane for another project, each pass now gets the loop
skills (the written instructions a lane follows, like "build the next
ticket") and the safety hooks (small checks that run before every edit, such
as "never edit the live branch") from Spirality's own folder. Until now each
project needed its own copy in its `.claude/` folder, and a fix to one copy
never reached the others.

Spirality hands them over with a standard Claude Code option that loads a
folder of skills and hooks for one session. The skills are not copied: the
folder points at the one set Spirality already uses. A second small hook
makes the skills' "talk to the ticket system" lines reach Spirality's door
from inside a project that has no door of its own, so no skill had to be
rewritten.

One thing turned up along the way: if a project still carries its own copy
of a skill under the same name, Claude Code picks the project's copy. So a
project's lane asks for Spirality's copy by its full name. Spirality's own
lanes start exactly as they did. A one-command dry run,
`scripts/dry_project_pass.sh`, shows a project with an empty `.claude/`
folder finding the skill and being refused an edit on its main branch.
