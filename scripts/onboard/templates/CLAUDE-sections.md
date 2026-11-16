## How to work with Dane

{{projectName}} is built by the loop [Spirality](https://github.com/{{spiralityRepo}})
defines and runs (Spirality's
[`docs/LOOP_ENGINEERING.md`](https://github.com/{{spiralityRepo}}/blob/main/docs/LOOP_ENGINEERING.md)),
and these rules are Spirality's, learned the hard way:

- **Plain language, always.** Explain a technical term the first time it
  matters.
- **Coach in the moment, kindly.** When Dane is about to do something risky,
  say so in one sentence and offer the safer step.
- **Agent sessions run the commands, not Dane.** Hand something to him only
  for a **real secret value**, a **billing screen**, a **browser login**, or
  a **decision that is genuinely his**, and say which.
- **An agent session is never a "person".**
- **Housekeeping is silent.**
- **Show, don't just tell.** Paste what matters; test steps are a link or an
  exact command plus what he should see.
- **Times in Mountain time**, never UTC.
- **Name tickets by their exact title.**
- **"Done" means verified.**

## Where the work is tracked

Every piece of work on this repository is a ticket in the **{{projectName}}** project
of **the tracker**, the ticket system that runs on the Mini
(`{{trackerUrl}}`, ids like `{{trackerPrefix}}-12`). Work for another project
goes in that project's queue, and a change to the loop itself (the ticket
door, the lanes, the skills and hooks, all of which live only in Spirality)
is Spirality work, filed in Spirality's project; never mixed.

- Every ticket touch goes through Spirality's door, `npm run clickup --
  <command>`. In a lane's pass a hook points that command at Spirality's
  folder; by hand, run it from Spirality's folder with
  `SPIRALITY_PROJECT={{checkoutDir}}` in front. It talks to whichever tracker
  `spirality.project.json` names, and Doppler (project `{{dopplerProject}}`)
  supplies the token. Off the Mini, put `TRACKER_API_URL={{trackerUrl}}` in
  front of it too. Never the claude.ai connector. A session started by hand
  signs in as `hand-run`, never as Dane.
- A pull request's title is the ticket's name, byte for byte, and its body
  carries the ticket link (`pr-opened` prints the exact line it accepts).
  `npm run verify` is the definition of done. {{verifyMeaning}} on every
  pull request.
- Two statuses are Dane's: `Needs your input` and `Ready to launch`. Only
  `ask` may set them, and no loop takes a ticket back out of them.

## Loop rules

1. **`main` never changes unchecked.** Branches, pull requests, a green
   `verify` check, Dane's word. In a lane's pass a hook of Spirality's
   refuses edits on `main`.
2. **Secret keys never reach the repository or a log.** {{visibilityLine}}
3. **Every write to the tracker is read back.**
4. **A step that fails says so.** Never a success line over a failed write.
5. **One topic, one folder.** A separate git worktree per thread.

The loop's code (the ticket door, the lanes, the skills and the hooks) lives
only in Spirality, which runs {{projectName}}'s lanes from its own folder. A
change to it is made there, never here.
