# Spirality — rules for every agent session

Read this file first, then [docs/LOOP_ENGINEERING.md](docs/LOOP_ENGINEERING.md).

**This repository is public.** Never commit a key, password, token or `.env`
file. Keys live in Doppler (project `spirality`).

## What we are building

Alphire Spirality is the AI development system: the one loop that builds
StarCaster, WaveCenter and Spirality itself. Today StarCaster and WaveCenter
each run their own copy of the same loop (StarCaster's is ~50,000 lines
grown over three months of incidents; WaveCenter's is a 1,700-line seed copy),
and lessons learned in one do not reach the other. Spirality ends that:

1. **One contract.** The ClickUp statuses, who owns each, the comment markers,
   the operator card, the merge phrases and what "waiting on Dane" means,
   written once, in `docs/LOOP_CONTRACT.md`, and linked from every product.
2. **One package.** The pure decision modules (statuses, trail, machine stamp,
   operator card, waiting verdict, merge-on-comment, conflict work, pacing),
   then the ClickUp door, the runners and the watchdogs, then the skills and
   hooks, each parameterised by a **project config** object: workspace, space,
   Loop Queue list, operator id, machine user id, GitHub repo, Doppler project,
   launchd label prefix, log folder, merge phrases, governance paths.
3. **Products pin a version.** StarCaster and WaveCenter depend on a tagged
   release; an upgrade is a pull request with CI. A substrate change can never
   reach both products at once unchecked.

The full analysis and the five-phase plan are on the WaveCenter ticket that
created this repository (86bcgm97x) and in `docs/PLAN.md`.

Spirality is the first consumer of itself: this repository runs the seed loop
copied from WaveCenter on 2026-10-11, and its own loops do the extraction.

## How to work with Dane

The same as WaveCenter, because they were learned the hard way:

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

Every piece of work on this repository is a ticket in the **Loop Queue** list
of the **Spirality** space in ClickUp (list id `901418065068`, space
`90146476540`). StarCaster's queue is `901418546619` and WaveCenter's is
`901422159126`; work for a product goes in that product's queue, substrate
work goes here, never mixed.

- Every ClickUp touch goes through `npm run clickup -- <command>` (Doppler
  supplies the token). Never the claude.ai connector.
- A pull request's title is the ticket's name, byte for byte, and its body
  carries the ticket link. `npm run verify` is the definition of done; CI runs
  it on every pull request.
- Two statuses are Dane's: `Needs your input` and `Ready to launch`. Only
  `ask` may set them, and no loop takes a ticket back out of them.

## Engineering rules

1. **`main` never deploys unchecked.** Branches, pull requests, a green
   `verify` check, Dane's word.
2. **Nothing project-specific is hard-coded in substrate code.** Every id,
   name, path and phrase that differs between products comes from the project
   config. A literal list id in a module is a bug.
3. **Move, don't rewrite.** StarCaster's modules come across with their tests;
   behaviour changes are separate tickets.
4. **Secret keys never reach the repository or a log.**
5. **Every write to ClickUp is read back.**
6. **A step that fails says so.** Never a success line over a failed write.
7. **One topic, one folder.** A separate git worktree per thread.
8. **Standard tooling only.** Plain Node, bash and launchd; no host-specific
   features, so the loop runs on any Mac and could run elsewhere.
