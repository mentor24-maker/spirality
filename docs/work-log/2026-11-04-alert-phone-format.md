## 2026-11-04 — Alert phone takes a US number however it is typed (SP-115)

Dane typed his number into the project's Alert phone box as eleven digits
starting with 1, and the tracker refused it for having no `+`. The box now
takes a 10-digit US number in any usual shape (brackets, dashes, dots,
spaces), or the same with its leading 1, and saves it as `+1` and the ten
digits. A number from another country still needs its `+` and country code.
The function is `normalizePhone` in `tracker/store.mjs`; its tests use a
made-up 555 number, never a real one, because this repository is public.
