/**
 * releaseFollow.mjs — moving a project to the newest Spirality release by
 * itself after a quiet period (SP-277, move 5 of docs/INTEGRATION.md).
 *
 * Each project has a pipeline control, `release.quiet-days` (0 to 30, default
 * 0). At 0 nothing moves by itself: a project moves only when a person names
 * a release for it, as before. Above 0, the relay pass of Spirality's own
 * project moves it to the newest release once that release has run quietly
 * on Spirality's own lanes for that many days:
 *
 *   - "since" is when the release's commit reached Spirality's `main` (its
 *     committer time), which is when Spirality's own lanes, which always run
 *     `main`, began running it. A release tag carries no time of its own.
 *   - "quietly" is no `ALARM:` post on Spirality's own bus since then. When
 *     Spirality has no bus, or it cannot be read, nobody can tell, so nothing
 *     moves, and the pass says so.
 *   - A project with no release named yet is left alone: the first release
 *     is named by hand.
 *   - A release the project was rolled back from is never chosen by itself;
 *     it waits for a person to name it.
 *
 * The decision is pure (quietMovePlan); followReleases runs it for every
 * project through the reads and writes it is handed, so a test drives it
 * with fakes and the relay with the tracker, git and the bus.
 */
import { releaseNumber } from './releases.mjs';

/** The pipeline control that turns this on (tracker/pipelineControls.mjs). */
export const QUIET_DAYS_KEY = 'release.quiet-days';

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Every release a project was rolled back from, from its record (newest
 * first, `[{ release }]`): one that some later entry replaced with a lower
 * number, by Roll Back or by naming an older one by hand.
 */
export function rolledBackFrom(history) {
  const out = new Set();
  const seen = [];
  for (const entry of [...(history ?? [])].reverse()) {
    const n = releaseNumber(entry?.release);
    if (n == null) continue;
    for (const s of seen) if (s.n > n) out.add(s.release);
    seen.push({ release: entry.release, n });
  }
  return out;
}

/** "3 days", "1 day", "0.5 days". */
function days(n) {
  const r = Math.round(n * 10) / 10;
  return `${r} day${r === 1 ? '' : 's'}`;
}

/**
 * What to do for one project. Answers `{ act, why, from?, to? }`:
 *
 *   off      quiet days is 0: only a person moves it
 *   stay     nothing to move to (no release cut, none named yet, already on
 *            the newest, or the newest is one it was rolled back from)
 *   wait     the newest has not yet run quietly for the days set
 *   held     an alarm on Spirality's bus since the newest reached main
 *   unknown  the release's time or Spirality's bus could not be read
 *   move     name `to` for it now
 *
 * `newest` is the newest release tag (`{ name, number }`) or null;
 * `releasedAt` its commit's time in ms (null: could not tell); `alarms` the
 * times (ms) of `ALARM:` posts on Spirality's bus, or null when the bus
 * could not be read (`alarmsWhy` says why).
 */
export function quietMovePlan({ quietDays, history, newest, releasedAt, alarms, alarmsWhy = null, now }) {
  const want = Number(quietDays) || 0;
  if (want <= 0) return { act: 'off', why: 'quiet days is 0: it moves only when a release is named for it by hand' };
  if (!newest) return { act: 'stay', why: 'no release has been cut yet' };
  const current = history?.[0]?.release ?? null;
  if (!current) return { act: 'stay', why: 'no release is named for it yet; the first one is named by hand' };
  const from = releaseNumber(current);
  if (from != null && newest.number <= from) return { act: 'stay', why: `it already runs ${current}, the newest` };
  if (rolledBackFrom(history).has(newest.name)) {
    return { act: 'stay', why: `it was rolled back from ${newest.name}, so that release waits for a person to name it` };
  }
  if (releasedAt == null || !Number.isFinite(releasedAt)) {
    return { act: 'unknown', why: `could not tell when ${newest.name} reached Spirality's main, so its quiet days cannot be counted` };
  }
  const ran = (now - releasedAt) / DAY_MS;
  if (ran < want) return { act: 'wait', why: `${newest.name} has run on Spirality's own lanes for ${days(Math.max(ran, 0))} of the ${days(want)} set` };
  if (alarms == null) return { act: 'unknown', why: `could not tell whether Spirality's own lanes were quiet: ${alarmsWhy ?? 'its bus could not be read'}` };
  const loud = alarms.filter((at) => at >= releasedAt).sort((a, b) => a - b);
  if (loud.length) {
    return { act: 'held', why: `${loud.length} ALARM post(s) on Spirality's bus since ${newest.name} reached main, so it has not been quiet`, firstAlarm: loud[0] };
  }
  return { act: 'move', why: `${newest.name} has run quietly on Spirality's own lanes for ${days(ran)} (${days(want)} set)`, from: current, to: newest.name };
}

/** The one plain line a project's bus hears when it moves. */
export function moveLine({ slug, projectName, from, to, quietDays }) {
  return `Spirality release: ${projectName} moved from ${from} to ${to} by itself, after ${to} ran at least ${days(Number(quietDays))} on Spirality's own lanes with no alarm. To go back: npm run clickup -- release back --project ${slug}`;
}

/**
 * Run the plan for every project but Spirality's own. Answers `{ lines,
 * problems, moved }`: `lines` say what happened to each project with quiet
 * days above 0; `problems` are the steps that failed (the relay's
 * UNCHECKED list); `moved` the slugs moved (or that would be, on a dry run).
 *
 *   projects   `[{ slug, name, own, history, quietDays }]`
 *   newest     the newest release tag `{ name, number, commit }`, or null
 *   io.releasedAt(commit)        ms, or `{ problem }`
 *   io.alarms()                  `{ times }` (ms of each ALARM post) or `{ problem }`
 *   io.nameRelease(slug, to)     `{ ok, release }` read back, or `{ problem }`
 *   io.busOf(slug)               the project's bus slug, or null when it has none
 *   io.postBus(bus, text)        `{ ok }` read back, or `{ problem }`
 */
export async function followReleases({ projects, newest, io, now, dryRun = false }) {
  const lines = [];
  const problems = [];
  const moved = [];
  let alarmRead = null;
  const readAlarms = async () => {
    alarmRead ??= await io.alarms();
    return alarmRead;
  };
  let timeRead = null;
  const releasedAt = async () => {
    if (!newest) return null;
    timeRead ??= await io.releasedAt(newest.commit);
    return typeof timeRead === 'number' ? timeRead : null;
  };

  for (const p of projects) {
    if (p.own || !(Number(p.quietDays) > 0)) continue;
    const base = { quietDays: p.quietDays, history: p.history, newest, now };
    // Read the time and the bus only for a project that could move.
    let plan = quietMovePlan({ ...base, releasedAt: 0, alarms: [] });
    if (plan.act === 'move') {
      const at = await releasedAt();
      plan = quietMovePlan({ ...base, releasedAt: at, alarms: [] });
      if (at == null && timeRead?.problem) plan = { ...plan, why: `${plan.why} (${timeRead.problem})` };
      if (plan.act === 'move') {
        const read = await readAlarms();
        plan = quietMovePlan({ ...base, releasedAt: at, alarms: read.times ?? null, alarmsWhy: read.problem ?? null });
      }
    }
    const say = (what) => lines.push(`${p.slug}\trelease-follow\t${what}`);
    if (plan.act === 'unknown') {
      say(`not moved: ${plan.why}`);
      problems.push(`release-follow ${p.slug}: ${plan.why}; nothing moved`);
      continue;
    }
    if (plan.act !== 'move') {
      say(`${plan.act}: ${plan.why}`);
      continue;
    }
    if (dryRun) {
      say(`would-move: ${plan.from} -> ${plan.to} (${plan.why})`);
      moved.push(p.slug);
      continue;
    }
    const named = await io.nameRelease(p.slug, plan.to);
    if (!named.ok) {
      say(`MOVE FAILED: ${plan.from} -> ${plan.to}`);
      problems.push(`release-follow ${p.slug}: naming ${plan.to} FAILED (${named.problem}); it still runs ${plan.from}, and the next pass tries again`);
      continue;
    }
    if (named.release !== plan.to) {
      say(`MOVE FAILED: ${plan.to} did not read back`);
      problems.push(`release-follow ${p.slug}: ${plan.to} was named but read back as ${named.release ?? 'none'}; treat it as not moved`);
      continue;
    }
    moved.push(p.slug);
    const bus = io.busOf(p.slug);
    if (!bus) {
      say(`moved: ${plan.from} -> ${plan.to}, read back (${plan.why}); it has no bus, so nothing was posted`);
      continue;
    }
    const posted = await io.postBus(bus, moveLine({ slug: p.slug, projectName: p.name ?? p.slug, from: plan.from, to: plan.to, quietDays: p.quietDays }));
    if (!posted.ok) {
      say(`moved: ${plan.from} -> ${plan.to}, read back; the bus line did NOT post`);
      problems.push(`release-follow ${p.slug}: moved to ${plan.to} (read back), but the line on its bus ${bus} did not post (${posted.problem}); its people have not been told`);
      continue;
    }
    say(`moved: ${plan.from} -> ${plan.to}, read back (${plan.why}); told its bus ${bus}`);
  }
  return { lines, problems, moved };
}
