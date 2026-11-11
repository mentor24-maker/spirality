## 2026-11-10 — Make the setup wizard give a project its bus (#166)

StarCaster sends its alarms ("the heartbeat stopped", "a key ran out of
credit") to a place called the bus. On the tracker, the bus is a project of
its own. The setup wizard never asked about it, so StarCaster would have
moved to the tracker with nowhere for those alarms to land.

Now the wizard asks one yes-or-no question: does this project have a bus?
The answer is no unless you say yes. On yes, it writes the bus's name into
the project's settings file and makes the bus project on the tracker. Then
it checks that each of the project's loops can see it. Running the wizard
again finds the bus already there and leaves it alone. A test posts a real
alarm to a bus the step made and reads it back.

Projects whose setup had already started (WaveCenter, Normie and the
others) are not stopped by the new question. It is asked only when other
questions are being asked anyway, and their answer stays "no bus".
