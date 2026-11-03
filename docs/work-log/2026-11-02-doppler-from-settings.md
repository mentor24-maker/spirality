## 2026-11-02 — A second product's ticket commands and doctor read Spirality's Doppler keys: take the Doppler project from the settings file (#73)

Every tool here that needs a secret key asks Doppler, the secret store, for
it. Until now each of those commands said "Spirality's keys" outright, so a
copy of the tools in Normie would have read Spirality's keys, and Normie's
key check (`npm run doctor`) would have looked in Spirality's store and
reported on the wrong product.

Now a small helper reads which Doppler project and config to use from the
product's own settings file, `spirality.project.json`, and every key-reading
command goes through it. The key check does the same, says which project it
looked in, and stops asking a product that does not run the tracker for the
three keys only the tracker's home needs (Dane's own sign-in and the
hand-over email). Nothing changes for Spirality itself: same project, same
keys, all present. This clears one of the steps that stand between Normie
and its own loops.
