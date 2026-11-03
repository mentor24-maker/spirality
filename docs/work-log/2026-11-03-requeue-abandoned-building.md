## 2026-11-03 — A ticket stays in Building forever when its build pass dies: put it back in the queue (#79)

When a build pass stopped partway, for example because it was killed or ran out of time, the ticket it had taken stayed marked "Building". No loop picks work up from "Building", and every later pass assumed someone was still working on it. That is how SP-92 sat untouched for a day until a person noticed.

Now every build pass starts by looking at the tickets in "Building". If no other build pass is running, the ticket has no pull request, and nothing has happened on it for 90 minutes, the pass puts it back in the queue. It leaves a note saying when it was last touched and which leftover work folder probably belongs to it. Nothing is deleted. If any of those facts can't be read, the ticket is left alone and the pass says it could not tell.
