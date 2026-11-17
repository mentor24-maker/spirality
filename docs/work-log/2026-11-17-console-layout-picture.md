## 2026-11-17 — Update the Console view to match the attached layout (#308)

The Console, the map of the loop on the Tasks page, now matches the layout Dane drew. Requested is a tall area on the left. The main path runs left to right along the top: Queued, Building, In review. Under each of those sits the stop it leads to or comes back from: Needs your input, Rework and Ready to launch. Live is one strip along the bottom, where every route ends. A "Task Submitted" funnel over Requested opens the Add Task page, the place every request comes from.

Every way a ticket moves is now an arrow. A green arrow is a step forward and a red one is a step back. Three routes the drawing left out are added: a mid-review question, an answer that sends work back to Rework, and an answer that closes a ticket. The drawing's arrow from Requested straight to Queued became Requested to Needs your input, because every new request stops there once for Dane's "go". Each arrow's point lands where no tile can cover it, and a test now holds that.

Two small fixes came with the new shape. Tiles in Live's short strip are drawn smaller so they stay inside it. The In review tiles' slow drift toward Ready to launch still runs in the shorter area.
