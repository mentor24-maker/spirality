## 2026-11-13 — Update the Settings UI (#230)

The Settings page had grown into one long scroll: Stage Colours at the top,
then every project's pipeline controls one after another. It is now split
into two tabs, chosen from a menu under the heading: **Pipeline Controls**
(shown first) and **Styles** (where Stage Colours lives). The tab you pick
is remembered in the page address, so reloading or sharing the link opens
the same tab.

Each project's controls now sit in their own box with a dark blue header
that opens and closes, so you can look at one project without scrolling past
the others. A box you opened stays open when you save a setting in it, and
when the page quietly refreshes itself once a minute. Every button on the
page now has the same look: rounded corners, dark blue, bold white words.

Nothing about what the controls do, save or allow changed; it is the page's
look only.
