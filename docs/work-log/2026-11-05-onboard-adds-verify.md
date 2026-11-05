## 2026-11-05 — Every copied skill tells a product's passes to run npm run verify, which the product may not have: the setup adds one that runs its check and the loop tests (#99)

The loop's instructions, copied into every product by the setup wizard, tell
each pass to run `npm run verify` to check its work. PressPlay had no command
by that name (its check is `npm run build`), so its review lane sent its
first ticket back.

Now the setup gives a product that has no `verify` command one: its own
check, then the loop's copied tests. That is exactly what its CI check runs,
so a pass and CI check the same thing, and CI itself just runs
`npm run verify`. A product that already has its own `verify` keeps it
untouched. Because every product now has `verify`, the wizard no longer
rewrites that line in the copied instructions, and the product's guide says
plainly what `verify` runs.
