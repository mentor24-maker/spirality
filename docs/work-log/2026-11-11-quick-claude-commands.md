## 2026-11-11 — Format the Quick Commands in Docs (#183)

The Docs page's list of slash commands used to be a long section in the
middle of the page. Each command came with a dense paragraph written for
Claude, not for a person. Now it is a light blue "Quick Claude Commands" box
down the left third of the page. Each command shows its name and a few
words, and clicking one opens a small window. That window explains the
command in plain language and links to its full steps. On a phone the box
sits above everything else.

The few words and the plain explanation come from two new lines at the top
of each skill file. The line Claude Code uses to decide when to run a skill
is left exactly as it was, so the loops behave the same. A command that
doesn't have the new lines yet still shows sensibly: the start of its
existing description.
