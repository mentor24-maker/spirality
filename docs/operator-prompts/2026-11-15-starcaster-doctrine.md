## 2026-11-15: StarCaster's doctrine and styles come to Spirality

1. > I don't believe Spirality adopted all the style-related documentation from the Starcaster doctrine. Did Spirality adopt any of Starcaster's doctrine/vault?

   Led to: no. Spirality's `docs/DOCTRINE.md` held only its own Title Case rule (SP-138); StarCaster's 3,451-line doctrine, its UI doctrine and style guide, and the private vault were not in it, and [PLAN.md](../PLAN.md) had kept StarCaster's doctrine out on purpose. The loop's code cited StarCaster section numbers (`DOCTRINE 3.11`, `§2.5`, `§6.6`) 67 times, all pointing at nothing.

2. > Let's review the history: I started building Starcaster by another name, and at a certain point realized I needed harnessing and I wanted to creating 'looping pipelines'. That whol apparatus was built to support Starcaster development. At a certain point, I determined that the development pipeline was really a separate project, so I spun out Spirality.
   >
   > So there is much within the Starcaster doctrine that directly applies to Spirality, as you observed. There is others that are specific to Starcaster, like the Builder you mentioned. As for the styles, I think it makes sense to maintain style continuity between these two Alphire products, so I think we should adopt all the style conventions established for Starcaster in Spirality.
   >
   > Otherwise, I leave it to you to sort out the parts of Starcaster's doctrine that should be migrated to Spirality. Purge any deprecated parts of Starcaster's doctrine. Incorporate all of the new Spirality doctrine.

   Led to: [SP-318](http://mac-mini.local:4180/t/SP-318), "Move the loop's doctrine and StarCaster's style conventions into Spirality" (PR #256). Every StarCaster doctrine section was sorted; 53 moved into [DOCTRINE.md](../DOCTRINE.md) under their StarCaster numbers, with an "In Spirality now" line wherever Spirality differs today; §6.21 (ClickUp's audit trail) was retired. The look and words of the tracker page became [UI_DOCTRINE.md](../UI_DOCTRINE.md): the Title Case rule plus StarCaster's admin-screen conventions with their values. Filed SP-320 to SP-325 (Requested) to bring the tracker page into line, part by part. StarCaster's half is [SC-811](http://mac-mini.local:4180/t/SC-811), "Point StarCaster's doctrine at Spirality for the loop's rules and remove the retired parts" ([StarCaster PR #1018](https://github.com/mentor24-maker/starcaster/pull/1018)): 16 loop sections there became pointers here, and StarCaster's retired parts were removed.

3. > [Answers to three questions put to him: which buttons win, how field labels are written, and the shape of a page title.] "StarCaster's four kinds (Recommended)"; "Title Case (Recommended)"; "StarCaster's row, keep the trail (Recommended)"

   Led to: [UI_DOCTRINE.md](../UI_DOCTRINE.md) sections 1, 3 and 4. StarCaster's four button kinds replace the ticket page's all-green buttons (SP-76) and Settings' dark-blue ones (SP-289); field labels are Title Case in both projects, with StarCaster's labels filed as [SC-812](http://mac-mini.local:4180/t/SC-812), "Write every StarCaster form field label in Title Case"; each page gets StarCaster's title row, and the tracker keeps its trail in place of the "Section:" prefix.
