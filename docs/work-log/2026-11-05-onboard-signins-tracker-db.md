## 2026-11-05 — The setup wizard stops at the sign-ins step even when every sign-in is made: give its check the tracker's database (#101)

When Dane set up PressPlay, the setup wizard stopped at the sign-ins step even
though his pasted commands had already made every sign-in. The wizard checks
its work by asking the tracker whether the sign-ins exist, but it asked
without saying where the tracker's database is. Only Spirality keeps that
location in its own settings; every other product has to be told, which the
pasted commands did and the wizard's check did not. So for any new product the
check could never pass, and Dane had to type the setting in front of the
command by hand to get past it.

The check is now given the same database location the pasted commands use.
The wizard's tests had used a stand-in for this check that never cared about
the setting, which is why they missed it; the stand-in now refuses without it,
just as the real one does, so all the wizard's tests cover this from now on.
