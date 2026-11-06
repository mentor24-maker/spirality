## 2026-11-05 — The setup look says it will clone a product that is not on the Mini, but no step does: clone it in npm run onboard (#97)

The setup wizard's first look told Dane that a product not yet on the Mini
would be cloned by the setup, but no step did it, so the setup stopped a few
steps later with "does not exist" and PressPlay had to be cloned by hand.

Now `npm run onboard` has a clone step right after that look. If the
product's folder is missing, it downloads the product's `main` into it, the
same way (https or ssh) Spirality's own copy was downloaded, and then checks
that what landed is the right repository, on `main`, with nothing changed. If
the folder is already there, the step leaves it alone. If anything is off, it
says FAILED and stops, so the next product needs no hand step here.
