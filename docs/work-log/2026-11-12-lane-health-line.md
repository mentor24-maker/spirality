## 2026-11-12 — A lane can fail for hours with nothing on the page: show a health line when a lane keeps failing (#190)

On 11/11 the Mini lost its internet connection and the relay (the job that merges pull requests when Dane says "merge") failed every ten minutes for twelve and a half hours. The page said nothing about it. The only record was a log file on the Mini, so Dane kept seeing "Your move: Merge" on a ticket he had already answered.

Now every page of the tracker watches the same logs the Pipeline Status box already reads. Once a lane has failed three passes in a row, the top bar shows one plain yellow line, such as "Relay can't reach the internet since 9:00 PM", and the line clears as soon as a pass goes through. The page is served from the Mini itself, so it can still read those logs when the Mini is offline. It only ever shows one of two fixed phrases and never copies text out of a log, so nothing private can leak onto the page.
