## 2026-11-05 — Dane cannot set up a product from the browser: add Set up a product to the Projects page, with every step and click-to-copy commands (#106)

Setting up PressPlay meant working through a code editor and a Terminal. Dane asked to run the whole thing from a browser, copying only the commands he pastes into the Mini.

The tracker's Projects page now has a **Set up a product** button. It opens a form with the setup's questions, each with its usual answer already filled in. Saving opens that product's own setup page. The page shows every step of the setup and whether it is done, and below the steps, one box says what to do next: the command to start, the block that makes its sign-ins (his to paste, because it handles real secret values), the link to merge its setup, or what failed. Every command has a **Copy** button. The page checks the setup again every few seconds while it runs, so Dane can watch it move along. The page itself never runs anything on the Mini.
