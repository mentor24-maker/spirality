## 2026-11-04 — Setting up a product sends Dane to the Edit page to type its GitHub repository: let the sign-ins command fill it in, from any settings file (#86)

Setting up a new product meant one Terminal command to make its project on
the tracker and its loops' sign-ins, then a trip to the project's Edit page
in the browser to type its GitHub repository by hand. And the command only
worked when run from a folder holding the product's settings file, which on
Normie's setup (SP-98) meant copying that file into `/tmp` first.

Now the same command fills in the repository from the settings file: a new
project gets it straight away, an existing one with the field empty has it
filled in, and one that already records a different repository is left
alone, with both shown, so a person decides which is right. Every write is
checked by reading it back. The command can also be pointed at a settings
file anywhere with `--config`, and the part that picks the product's Doppler
project reads the same file, so the sign-ins land in the right product's
key store. This is the first of the six tickets that make product setup one
guided step.
