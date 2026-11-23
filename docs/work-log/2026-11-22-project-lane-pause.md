## 2026-11-22 — Give each of a project's own lanes its own pause switch on the Settings page (#333)

Some projects run a lane of their own beside the standard four. WaveCenter's
hand-off lane is one: it passes member-ticked tasks to the agents. The
Settings page only had pause switches for the standard four, so that lane
could not be paused on its own (yesterday's fix, #332, let it follow the
"pause everything" switch so it at least runs again).

Now the tracker keeps a list of each project's own lanes. A new command,
`npm run clickup -- project-lanes`, sends it the names from the project's
settings file. The names are checked with the same rules that file uses,
then read back to confirm they were saved. Each lane on the list gets its
own **Paused** switch on that project's Settings page, next to the others.
Turning it on stops that one lane before its next pass, and the change log
records who did it. No other project gets that switch. The "pause
everything" switch still pauses the lane, and the lanes still treat a
tracker they cannot reach as paused.

After this merges, the WaveCenter lane names need to be sent once (step 5
in `docs/ONBOARDING_A_PROJECT.md`) for its switch to show up.
