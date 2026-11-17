---
name: test-me
description: Give Dane exact, followable test steps for a change that has been built or merged: where to go (a link, or a command and which machine to run it on), what to do, step by step, what he should see when it works, and what would mean it's broken. It checks first where the change actually runs (StarCaster's preview links have no database and can't sign in, so those tests go on the Mini). Use when the user runs /test-me, or asks "how do I test this?", "what should I try?", "show me it working" or "is it ready for me to look at?".
---

# Test steps for Dane

"Done" means verified, and Dane is the last check before a merge. He needs
steps he can follow without asking a question.

1. **Work out what to test.** The change from this thread, or the ticket or
   pull request the user names. Read the ticket's acceptance criteria and
   test steps, and the pull request's diff, so the steps cover what actually
   changed.

2. **Work out where it can be seen, and check it's there now.**
   - Merged and deployed: the live page. Check it's actually deployed.
   - A pull request: its preview link, if the preview can show it. StarCaster
     previews have no database, so anything needing a sign-in is tested on
     the Mini instead.
   - The tracker or a loop: on the Mini. Check the running copy has the
     change (the right branch or commit), and restart it if needed and you
     can. Say which machine every command runs on; for the Mini, tell him to
     check the prompt says `daneofearth@mac-mini` before pressing Return.

   Run the steps yourself first wherever you can (open the page, run the
   command), so you're giving him steps you know work.

3. **Write the steps.**
   - **Where**: one link, or one exact command with its machine.
   - **Do**: numbered steps, one action each, naming buttons and fields
     exactly as the page shows them.
   - **You should see**: what the page or output looks like when it works,
     with the exact words he'll see where possible.
   - **It's broken if**: the one or two signs that it isn't working, and
     what to send back if so.

   Plain language; no step depends on knowing the code.

4. **Answer** with the steps, then the one thing he does after: e.g. reply
   "merge" on the pull request if it works, or describe what he saw if not.
