## 2026-10-29 — Each work-log entry gets its own file (#30)

Every pull request used to add its note to the top of one shared file,
`docs/WORK-LOG.md`. Two pull requests built at the same time therefore
always clashed there, even when their real work never touched: of the 20
clashes measured on this repository, the work log was in 19, and for 11
pull requests it was the only thing in the way. Each entry is now its own
small file in `docs/work-log/`, named by date and branch, so two entries
can never collide. The old file keeps all its history and is closed to new
entries. `ls -r docs/work-log` reads the log newest first.
