## 2026-11-08 — Dane's merge is refused after CI was fixed: the relay still counts an old failed check run that a newer passing run replaced (#123)

When an automatic check on a pull request fails and is then run again and passes, GitHub keeps a record of both runs. The relay (the job that carries out Dane's "merge") looked at every record, so the old failure kept the pull request marked broken for good. That is why Dane's "merge" on the Upwork Blaster pull request was refused twice even though GitHub itself showed it green.

Now the relay looks only at the most recent run of each check. If it ever cannot tell which run is the most recent (a run with no start time, or two that started at the same moment), it plays safe and treats the check as failed, because wrongly calling a check green could put unchecked code live.
