## 2026-11-05 — The setup wizard's paste step is easy to answer done before anything ran: ask Run these now? and run them on Dane's yes (#102)

When the setup wizard reached the sign-ins (the step that writes a new
product's keys into Doppler), it printed a block of commands and asked Dane
to type "done" once he had run them somewhere. In PressPlay's first setup,
"done" was typed twice before anything had run, and the wizard stopped both
times.

Since Dane runs the wizard himself, in his own Terminal, it can run those
commands for him. It now shows them and asks "Run these now? [y/N]". On his
y it runs them right there, with their output on screen, and stops with the
failing command's exit code if one breaks. On anything else it runs nothing,
leaves the commands printed, and stops so a rerun can pick up. What it shows
and what it runs come from the same list, so they cannot differ.
