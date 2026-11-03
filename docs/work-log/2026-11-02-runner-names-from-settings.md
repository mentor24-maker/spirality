## 2026-11-02 — A second product's loop runners would write into Spirality's logs and share its locks: name them from the settings file (#74)

The script that starts every unattended loop pass on the Mini had the word
"spirality" typed into the names of its log files, its locks (the markers
that stop two passes running at once) and the restart instruction it prints.
That was fine while Spirality was the only product, but Normie's loops would
have written into Spirality's logs and waited on Spirality's locks.

The script now takes those names from the product's settings file, the way
the installer already did. Spirality's settings give exactly the names it
used before, so its running loops see no change. A new test runs the real
script with a settings file for another product and checks every name it
uses, without touching any real loop.
