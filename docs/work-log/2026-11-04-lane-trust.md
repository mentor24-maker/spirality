## 2026-11-04 — A new product's lanes ignore its allowed commands until somebody opens Claude in its folder: mark the folder trusted when the lanes are installed (#93)

The first time a person opens Claude in a folder, Claude asks whether to
trust it. The lanes on the Mini run Claude with nobody watching, so nobody
answers that question, and until it is answered Claude ignores the folder's
own list of allowed commands. Normie's lanes ran like that on their first
two passes, and it only stopped when somebody happened to open Claude in
Normie's folder by hand.

Now the installer answers it: before it starts any lane, it marks the
product's folder as trusted in Claude's settings, and its status report
says whether the folder is trusted. Claude rewrites that settings file all
the time, so the change is made carefully. It only writes when needed, only
that one setting, keeps a copy of the file as it was, and backs off rather
than overwrite something Claude has just written.
