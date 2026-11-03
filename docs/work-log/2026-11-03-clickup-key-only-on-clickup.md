## 2026-11-03 — A product on the tracker fails doctor for a ClickUp key it never uses: ask for CLICKUP_API_TOKEN only from products on ClickUp (#81)

`npm run doctor` checks that every key a product needs is in its Doppler
project. It asked every product for the ClickUp key, even Normie, which has
only ever used the tracker on the Mini. So Normie's doctor failed for a key it
would never use, and the ticket copying the ticket tools into Normie could not
finish.

Doctor now asks for the ClickUp key only when the product's settings file
says it still talks to ClickUp: its tracker is ClickUp, or it names a real
ClickUp list. Spirality still names its old list (kept to compare against),
so it is still asked; Normie's ClickUp ids are all "0", so it is not. The
onboarding checklist says the same, and new tests cover both kinds of product.
