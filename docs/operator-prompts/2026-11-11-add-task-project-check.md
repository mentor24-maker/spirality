## 2026-11-11: The Add Task box's project check keeps asking about WaveCenter

1. > I have been getting the check about whether I want a submitted task to be associated with Wavecenter or Spirality every time, even though I haven't submitted a task for Wavecenter in quite a while. Take a look at that feature and ensure it is functioning as intended.

   Led to: [SP-225](http://mac-mini.local:4180/t/SP-225), "The Add Task box keeps asking whether a Spirality task belongs to WaveCenter", built in the hand-run session as [#174](https://github.com/mentor24-maker/spirality/pull/174). Replaying his 149 typed requests, the check asked on 35 of them; with the fix, 5.

2. > This is great. It doesn't have to be perfect. Just a better hit rate is a win. /doc-it and also flag it for future improvements. I suspect we'll be able to improve on the hit rate with more data later.

   Led to: `docs/TRACKER_MVP.md`, "The Add Task Box's Project Check" (his bar, and how to measure the check by replay), added to #174. Parked [SP-227](http://mac-mini.local:4180/t/SP-227), "Improve the Add Task box's project check hit rate as the tickets grow" (`Live`, tagged `deferred`; set it back to `Queued` to revive it).
