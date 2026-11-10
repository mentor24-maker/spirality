# commands/

A **copy** of Dane's own slash commands for Claude Code sessions, one
`<name>/SKILL.md` per command. The originals live on the MacBook in
`~/.claude/skills/`; the tracker runs on the Mini and cannot read that folder,
so the Docs page's **Commands** section lists this copy (beside the loop skills
in `.claude/skills/`).

Do not edit a file here by hand: change the original, then refresh the copy
on the MacBook and open a pull request with the result:

```bash
npm run commands:copy
```

It copies only each command's `SKILL.md`, removes the copy of a command that
is gone, and refuses (writing nothing) when a file looks like it holds a key.
This repository is public: a command must hold nothing secret.
