## 2026-11-02 — The tracker's GitHub repository field can disagree with a product's settings file and nobody notices: check one against the other (#75)

Each project in the tracker has a box for its GitHub repository, but the loops
never read that box: they open pull requests wherever the product's settings
file says. So the two could say different things and nobody would know until
something went to the wrong place.

The loops' health check, `npm run doctor`, now reads the box and compares it
with the settings file. If they match, it says so. If the box is empty, it
says that too, and gives the address of the page where you fill it in, but it
does not count as a failure. If they disagree, it names both and fails, so it
gets noticed. It only looks; it never changes the box.

Today all three projects have the box empty, so Spirality's doctor run ends
with a reminder to fill it in on the project's Edit page.
