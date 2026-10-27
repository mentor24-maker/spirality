'use strict';

const { operatorName } = require('./substrateConfig.js');

const loopStatuses = require('./loopStatuses.js');
// The staleness rule is IMPORTED, never re-derived. `pipelinePause` already
// owns "is this ticket in flight or stranded" for the pause drain and the
// sweep, and two definitions of how old is too old would drift the first time
// one was tuned — which is the failure this file already carries two comments
// about (`ticketIdFromPrBody`, and the 2026-08-31 two-call-sites incident).
const pipelinePause = require('./pipelinePause.js');

/**
 * Should loop-build claim another ticket, or is the merge side already full?
 *
 * WHY THIS EXISTS (2026-08-24). Branch protection is `strict: true` — a branch
 * must be current with `main` before it can merge. That rule is right: it
 * guarantees the tests that passed ran against exactly what becomes live, and
 * `main` auto-deploys to production.
 *
 * ITS COST IS QUADRATIC IN THE NUMBER OF OPEN PRs. Every merge invalidates
 * every other open branch, so with N open each merge dates N-1 branches, each
 * needing its own catch-up and its own CI run. On 2026-08-23 with 24 open PRs
 * a single merge dated 23 branches, and the relay spent most of its work
 * re-catching-up branches that were stale again before they could be used.
 *
 * Double the open PRs and you quadruple the churn. That is why the intuitive
 * fix — more build loops, more machines — makes throughput WORSE.
 *
 * Throughput is min(build rate, review rate, merge rate). Merge is the
 * slowest, so work queued beyond the merge rate does not ship sooner; it rots,
 * and rotting costs real work. Capping work in progress does not slow
 * delivery. It removes the churn that was eating the merge side's capacity.
 *
 * It also makes the queue honest: "26 queued, 5 in flight" is true. "26 queued
 * and 24 half-built" is not.
 */

/**
 * Where to start. Five is not measured — it is a starting point chosen to sit
 * comfortably above the observed merge rate (about 1.25/hour before the
 * in-pass merge fix, task 86bbk2fb5) while leaving room for review turnaround.
 * Raise it when the merge side demonstrably keeps up; lower it if the catch-up
 * churn is still visible. Override for experiments with CLAUDE_LOOP_WIP_CAP.
 */
const DEFAULT_WIP_CAP = 5;

const CAP_ENV = 'CLAUDE_LOOP_WIP_CAP';

/**
 * The SECOND ceiling: how much finished work may be parked on Dane at once.
 *
 * WHY THERE ARE TWO NUMBERS NOW (2026-09-04, task 86bbuzzbk). Until today one
 * cap of five covered both machine work and operator-held work, so a ticket
 * waiting on Dane's merge consumed a build slot. See IN_PROGRESS_STATUSES in
 * loopStatuses.js for the full argument; the short version is that "is the
 * merge pipeline full?" and "should loop-build stop producing?" are different
 * questions, and one number could only answer them by getting one wrong.
 *
 * WHY IT IS A CEILING AND NOT "UNCOUNTED". Simply not counting operator-held
 * work would leave the number of open pull requests unbounded, and that is the
 * exact cost the cap was built to control: branch protection is `strict:true`,
 * so every merge dates every other open branch (see this file's header). Ten
 * waiting PRs mean ten catch-up merges when they drain. That cost is real and
 * does not go away because it is inconvenient — so operator-held work is still
 * bounded, just at its own larger number, and the loop declines with a
 * DIFFERENT message saying which of the two limits it hit.
 *
 * TEN, and where it comes from: Dane's stated target on 2026-09-04 — wake in
 * the night and clear ten. It is his number, not a measurement, and it is the
 * right kind of number to put here because the thing being bounded is his
 * queue. Raise it once a merge queue absorbs the catch-up churn (task
 * 86bbv1qp9); until then ten is roughly ten catch-up merges to drain, which is
 * about the most a sitting at 3am should cost.
 */
const DEFAULT_OPERATOR_CAP = 10;

const OPERATOR_CAP_ENV = 'CLAUDE_LOOP_OPERATOR_CAP';

/**
 * How old a "Building" ticket must be before the cap stops counting it,
 * overridable for experiments and — the reason it exists — so the discount can
 * be WATCHED WORKING on real data. Without it the only way to see this fire is
 * to wait 90 minutes for a pass to die, which is how a rule ships having never
 * been observed. The sibling flag on `pipeline -- sweep` caught two real bugs
 * that way on the day this was written.
 *
 * Unset means the shared 90 minutes from `pipelinePause`, which stays the ONE
 * definition; this only moves the number for a run.
 */
const STRANDED_ENV = 'CLAUDE_LOOP_STRANDED_MINUTES';

function resolveStrandedAfterMs(env = process.env) {
  const raw = String(env?.[STRANDED_ENV] ?? '').trim();
  if (!raw) return pipelinePause.STRANDED_AFTER_MS;
  const n = Number(raw);
  // A negative or non-numeric override is IGNORED, never obeyed: a typo here
  // would discount every in-flight build at once and uncap the loop.
  if (!Number.isFinite(n) || n < 0) return pipelinePause.STRANDED_AFTER_MS;
  return n * 60000;
}

/**
 * The cap in force. A malformed or negative override is ignored rather than
 * obeyed — a typo in an env var must not silently switch the loop off.
 */
function resolveCap(env = process.env) {
  const raw = String(env?.[CAP_ENV] ?? '').trim();
  if (!raw) return DEFAULT_WIP_CAP;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return DEFAULT_WIP_CAP;
  return n;
}

/**
 * The operator ceiling in force. Same discipline as `resolveCap` — a malformed
 * or negative override is ignored rather than obeyed, because a typo here
 * would either uncap Dane's queue entirely or stop the loop dead, and neither
 * belongs to a mistyped environment variable.
 */
function resolveOperatorCap(env = process.env) {
  const raw = String(env?.[OPERATOR_CAP_ENV] ?? '').trim();
  if (!raw) return DEFAULT_OPERATOR_CAP;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return DEFAULT_OPERATOR_CAP;
  return n;
}

/**
 * The ticket statuses that mean "this work is genuinely in flight".
 *
 * WHY THIS LIST AND NOT "IS THE PR OPEN" (2026-08-25, task 86bbm4zwd). The
 * first version counted every open PR, and on the morning of 2026-08-25 that
 * deadlocked the build loop for four consecutive hourly passes: seven PRs open
 * against a cap of five, of which FIVE should never have counted — three whose
 * tickets had been sent back to `Queued` for rework (so the cap was blocking
 * the only thing that could close them) and two zombies whose tickets were
 * already `Live`, shipped by a different PR.
 *
 * The cap asks "how many PRs are open?" when it means "how much work is in
 * flight". Those are the same number only when every open PR has a ticket
 * somebody is moving, and they diverge in two entirely ordinary situations —
 * a send-back and an abandoned duplicate. Both were present.
 *
 * `Rework` and `Queued` are deliberately NOT here: a ticket in either with an
 * open PR is work waiting to be CLAIMED, and counting it is what caused the
 * deadlock. `Live` is not here either — the work shipped; the PR is a
 * leftover.
 *
 * `Rework` did not exist until 2026-08-31 (task 86bbr1u9v). Before it a
 * sent-back ticket sat in `Queued`, so this file had to INFER "that one is
 * rework" from the ticket being queued — which is precisely why it could not
 * tell a send-back from work nobody had started. It reads the real status now.
 * Dane took the recommendation that rework stays uncounted, for the reason
 * above: the cap answers "how many NEW things may I start", and rework is not
 * new. That is not a licence to omit it silently, which is the whole point of
 * the new status — `wipDecision` names the rework count in BOTH its messages.
 *
 * `Needs your input` IS here (review round 1). It is operator-held, exactly
 * like `Ready to launch` which was never in doubt: a ticket parked on Dane
 * with an open PR is real work occupying the merge pipeline, and its branch
 * still needs catching up every time something lands. Counting it is also the
 * honest answer — if his inbox is full, the pipeline genuinely is full, and a
 * cap that hid that would be lying in the more dangerous direction.
 */
// A VIEW of the one taxonomy since 2026-09-02 (task 86bbtujed) — the WHY
// above is unchanged; the list itself now has a single home.
const IN_FLIGHT_STATUSES = loopStatuses.IN_FLIGHT_STATUSES;

// The two halves of the set above, as VIEWS of the one taxonomy. The build cap
// measures against IN_PROGRESS; OPERATOR_HELD carries its own ceiling
// (task 86bbuzzbk). Both are imported rather than re-listed here.
const IN_PROGRESS_STATUSES = loopStatuses.IN_PROGRESS_STATUSES;
const OPERATOR_HELD_STATUSES = loopStatuses.OPERATOR_HELD_STATUSES;

/**
 * The one status a STRANDED ticket may be discounted from — and why it is only
 * this one (2026-09-02, task 86bbtmbum).
 *
 * On the night of 2026-09-01 the cap sat full for five consecutive passes with
 * 48 tickets queued. Two of its five slots were builds whose pass had died:
 * `86bbjt1b0` (#447) and `86bbjt1b4` (#449), both with finished, green pull
 * requests, both sitting in "Building" with nothing working on them. The loops
 * claim only from `Rework` and `Queued`, so nothing could ever pick them up
 * again — they were not a queue, they were a deadlock, and they consumed 40%
 * of the pipeline's capacity until a person moved them by hand.
 *
 * THE OTHER THREE IN-FLIGHT STATUSES KEEP COUNTING HOWEVER OLD THEY GET, and
 * that is deliberate rather than an omission:
 *
 *   ready to launch   operator-held, and MOVING — Dane or Lane A will merge
 *   needs your input  it. The file's existing reasoning stands: if his inbox
 *                     is full the pipeline genuinely is full, and a cap that
 *                     hid that would lie in the more dangerous direction.
 *   in review         a resting status as well as a working one. A ticket
 *                     waits there for a reviewer; its PR is real and still
 *                     needs catching up every time something lands.
 *
 * Only a stranded `building` is going nowhere BY CONSTRUCTION. That is the
 * difference between work that is slow and work that is dead, and it is the
 * whole of what this discount is allowed to act on.
 */
const STRANDABLE_STATUS = loopStatuses.BUILDING;

/**
 * Statuses that mean the work is finished and the PR is a leftover — `live`
 * only, per decision D1 (2026-09-02, task 86bbtujed; recorded in
 * loopStatuses.js). This list used to also hold complete/closed/done; a PR
 * whose ticket wears one of those now lands in `unrecognised`, which QUOTES
 * the status — reported loudly by name instead of silently counted as done
 * while pulse counted it in flight.
 */
const TERMINAL_STATUSES = loopStatuses.TERMINAL_STATUSES;

/**
 * Where `id` appears in `haystack` as a WHOLE id rather than as part of a
 * longer alphanumeric run, or -1. Both are lowercase already.
 *
 * Plain scanning rather than a built regex: a ClickUp id is alphanumeric, so
 * it needs no escaping, and building ~140 regexes per pull request to answer
 * a substring question is work for nothing.
 */
function indexOfWholeId(haystack, id) {
  for (let from = 0; ;) {
    const at = haystack.indexOf(id, from);
    if (at === -1) return -1;
    const before = at === 0 ? '' : haystack[at - 1];
    const after = haystack[at + id.length] || '';
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return at;
    from = at + 1;
  }
}

/**
 * The ClickUp task id a pull request declares in its body, lowercased.
 *
 * Reliable because `pr-opened` REFUSES to record a PR whose body carries no
 * link back to its ticket — so every PR the loops open has one by
 * construction. A PR without one is hand-made, and is reported rather than
 * counted (see classifyPrs).
 *
 * READ IT EXACTLY AS LOOSELY AS THAT GATE ACCEPTS IT (2026-08-25, review
 * round 2). The gate is `prBodyCarriesTicket` in scripts/builder/loopTrail.js,
 * and it takes the full URL **or a bare task id**, case-insensitively. This
 * used to demand the URL and capture it verbatim, so a body reading
 * `ClickUp: 86bbm4zwd` — or a URL in the mixed case ClickUp's own UI hands
 * out — passed `pr-opened` and then landed in `unknown` here, uncounted.
 * That is the cap failing OPEN, the direction this ticket calls dangerous.
 * Two functions disagreeing about the same string is what makes a bug like
 * that arrive later and silently, so they are matched deliberately.
 *
 * @param {string} body        the pull request body
 * @param {Iterable<string>} [knownIds]  every ticket id in the queue, which is
 *   what makes a BARE id findable at all — without a URL there is nothing in
 *   the text marking one alphanumeric word as an id, so it is recognised by
 *   being one we know. Omitted, only the URL form resolves.
 */
function ticketIdFromPrBody(body, knownIds) {
  const text = String(body || '');
  const m = /app\.clickup\.com\/t\/(?:\d+\/)?([a-z0-9]+)/i.exec(text);
  if (m) return m[1].toLowerCase();

  const hay = text.toLowerCase();
  // The EARLIEST id mentioned wins, so the answer does not depend on the order
  // ClickUp happened to return the queue in. A body naming two tickets is
  // already odd; giving it an unstable answer would make it unreproducible too.
  let best = null;
  for (const raw of knownIds || []) {
    const id = String(raw || '').trim().toLowerCase();
    if (!id) continue;
    const at = indexOfWholeId(hay, id);
    if (at !== -1 && (best === null || at < best.at)) best = { id, at };
  }
  return best ? best.id : null;
}

/**
 * Split open PRs by what their ticket says, so the message can name the split
 * rather than a bare total. A bare total is what made the deadlock invisible
 * for four passes: "7 open, cap 5" is true and useless.
 *
 * `ticketStatusById` is a plain object of id -> status string; its keys are
 * lowercased here, because `ticketIdFromPrBody` lowercases what it reads and a
 * mixed-case key would then miss (review round 2).
 *
 * FIVE buckets do not count, and they are kept APART on purpose:
 *
 *   rework        a send-back the loop must be free to claim FIRST
 *   queued        fresh work the loop must be free to claim
 *   live          the work shipped elsewhere; the PR is a leftover
 *   unknown       no ticket could be found for the PR at all
 *   unrecognised  a ticket WAS found, in a status this file does not know
 *
 * `rework` and `queued` are two buckets and not one because they are two
 * different statements — "five branches are half-built and waiting to be
 * finished" and "five tickets have a stray PR against work nobody started"
 * call for opposite responses. Collapsing them is the reading that made
 * "1 in flight" true and useless while five branches sat open.
 *
 * The last two used to share one bucket reported as "no ticket found", which
 * is a false statement about the second: it sends the reader hunting for a
 * missing ClickUp link that is not missing. That is verbatim the shape review
 * round 1 rejected for `live`, so it gets the same treatment — say the thing
 * you actually know, including the status you did not recognise.
 */
/**
 * What a caller told us about one ticket, in a single shape.
 *
 * The map may carry either a plain status string — which is what every caller
 * passed before 2026-09-02, and what `loop_throughput.mjs` still passes — or a
 * record `{ status, dateUpdated, loopNote }`. ONE map either way, deliberately:
 * a parallel "and here is the freshness" map would be a second thing to build
 * at each call site, and this file already carries the scar of two call sites
 * building slightly different inputs and reaching opposite answers
 * (2026-08-31, `probeCap`).
 *
 * `dateUpdated` absent means freshness is UNKNOWN, not fresh and not stale.
 * The caller then gets no discount at all, which keeps the cap where it has
 * always been — counting it. Failing toward the cap costs idle time; failing
 * away from it costs the churn the cap exists to prevent, and this file is
 * explicit that open is the dangerous direction.
 */
function normalizeTicketInfo(value) {
  if (value && typeof value === 'object') {
    return {
      status: String(value.status ?? '').trim(),
      dateUpdated: Number(value.dateUpdated),
      loopNote: value.loopNote == null ? '' : String(value.loopNote),
    };
  }
  return { status: String(value ?? '').trim(), dateUpdated: NaN, loopNote: '' };
}

/**
 * Is this ticket a build whose pass died?
 *
 * Answered by `pipelinePause.classifyTicket`, not by a rule written here — the
 * sweep that MOVES stranded tickets and the cap that DISCOUNTS them have to
 * agree about which ones they are, or the cap forgives a ticket the sweep will
 * not rescue and the deadlock simply moves.
 *
 * Returns false whenever freshness is unknown, so "we could not tell" never
 * reads as "not in flight".
 */
function isStrandedBuild(info, nowMs, strandedAfterMs) {
  if (String(info.status || '').toLowerCase() !== STRANDABLE_STATUS) return false;
  if (!Number.isFinite(info.dateUpdated)) return false;
  const row = pipelinePause.classifyTicket(
    { id: 'x', status: { status: info.status }, date_updated: info.dateUpdated, loopNote: info.loopNote },
    { nowMs, strandedAfterMs },
  );
  return Boolean(row && row.stranded);
}

/**
 * WHAT IS ACTUALLY HOLDING THE BUILD SLOTS — not a guess at why.
 *
 * WHY THIS EXISTS (2026-09-05, task 86bbvh285). The decline message used to
 * end "Not claiming; the merge side is the bottleneck." That sentence asserts
 * a CAUSE this function never measured, and on the morning it was written it
 * was false: merges were landing unattended in about nine minutes, while
 * `loop-review` sat pinned at an hourly cadence and four tickets waited in
 * `In review`. Review was the bottleneck. A reader who trusted the message
 * would have gone looking at the merge lane, which was fine.
 *
 * The cap can only see which statuses hold its slots, so that is all it says.
 * `1 building, 4 in review` is a reading; "the merge side is the bottleneck"
 * is a diagnosis, and the two are not the same claim.
 *
 * A slot held by a status this file does not recognise is reported as such
 * rather than dropped — a total that does not add up to the cap is how a
 * partition quietly stops being one.
 */
function holdingPhrase(groups) {
  const building = groups.building.length;
  const reviewing = groups.reviewing.length;
  const parts = [];
  // Both halves are stated even at zero. "4 in review" alone leaves the reader
  // to work out whether the other slot is a build or something unaccounted
  // for, and that is exactly the inference the old sentence invited.
  parts.push(`${building} building`);
  parts.push(`${reviewing} in review`);
  const other = groups.inProgress.length - building - reviewing;
  if (other > 0) parts.push(`${other} in an in-progress status this check does not recognise`);
  return parts.join(', ');
}

function classifyPrs({ prs, ticketStatusById, nowMs = Date.now(), strandedAfterMs = resolveStrandedAfterMs() } = {}) {
  const source = ticketStatusById && typeof ticketStatusById === 'object' ? ticketStatusById : {};
  const byId = Object.create(null);
  for (const [k, v] of Object.entries(source)) byId[String(k).trim().toLowerCase()] = v;
  const knownIds = Object.keys(byId);

  // `inFlight` stays the honest union of the two below — pulse, the throughput
  // report and this module's own reporting all want that total. The cap is the
  // only thing that stopped measuring against it (task 86bbuzzbk).
  const groups = {
    inFlight: [], inProgress: [], operatorHeld: [],
    // The two halves of `inProgress`, kept as a PARTITION of it rather than as
    // independent tests, the same way `operatorHeld` is a partition of
    // `inFlight`. Named because the decline message has to say which of them
    // is holding the slots (2026-09-05, task 86bbvh285) and a message that
    // names a cause must be reading the number it names.
    building: [], reviewing: [],
    strandedBuilds: [], rework: [], queued: [], live: [], unknown: [], unrecognised: [],
  };
  // Whether the discount could be assessed AT ALL. Told apart from "assessed,
  // found none" everywhere below: a clause that vanishes when nobody looked is
  // how "could not tell" comes to read as an all-clear (DOCTRINE 3.11).
  let freshnessKnown = false;
  for (const pr of Array.isArray(prs) ? prs : []) {
    if (!pr || typeof pr !== 'object') continue;
    if (String(pr.state || 'OPEN').toUpperCase() !== 'OPEN') continue;
    const id = ticketIdFromPrBody(pr.body, knownIds);
    const info = normalizeTicketInfo(id ? byId[id] : '');
    if (Number.isFinite(info.dateUpdated)) freshnessKnown = true;
    // Kept in the casing ClickUp gave it, so the message can quote it back.
    const raw = info.status;
    const status = raw.toLowerCase();
    if (!id || !status) groups.unknown.push(pr.number);
    // A build whose pass died is not work in progress. It is the only
    // in-flight status that can be going nowhere by construction, and two of
    // them held 40% of the cap for a whole night (2026-09-02).
    else if (isStrandedBuild(info, nowMs, strandedAfterMs)) groups.strandedBuilds.push(pr.number);
    else if (IN_FLIGHT_STATUSES.includes(status)) {
      groups.inFlight.push(pr.number);
      // The same PR lands in exactly one of these two as well. Kept as a
      // partition of `inFlight` rather than as an independent test, so the
      // three counts cannot drift into disagreeing about one pull request.
      if (OPERATOR_HELD_STATUSES.includes(status)) groups.operatorHeld.push(pr.number);
      else {
        groups.inProgress.push(pr.number);
        // A partition again: `IN_PROGRESS_STATUSES` is exactly `building` and
        // `in review`, so every ticket landing here goes in one of the two.
        // If a third is ever added to the taxonomy it lands in neither, and
        // `holdingPhrase` below says so rather than quietly under-reporting.
        if (status === loopStatuses.BUILDING) groups.building.push(pr.number);
        else if (status === loopStatuses.IN_REVIEW) groups.reviewing.push(pr.number);
      }
    }
    // The REAL status, not "queued means rework". Until task 86bbr1u9v there
    // was no other way to tell, and that guess is the bug this ticket closes.
    else if (status === loopStatuses.REWORK) groups.rework.push(pr.number);
    else if (status === loopStatuses.QUEUED) groups.queued.push(pr.number);
    else if (TERMINAL_STATUSES.includes(status)) groups.live.push(pr.number);
    // A status nobody anticipated: not counted, and NOT called "live" — that
    // label is a claim about the work having shipped, and a wrong claim here
    // is what this ticket exists to stop.
    else groups.unrecognised.push({ number: pr.number, status: raw });
  }
  groups.freshnessKnown = freshnessKnown;
  return groups;
}

/**
 * How many of these pull requests are actually in flight.
 *
 * OPEN only. Counting a merged or closed PR silently halves the effective cap
 * and the loop stops for no reason; missing one doubles it and the churn comes
 * back. `gh pr list --state open` already filters, but the count is derived
 * here so a caller that passes everything still gets the right answer.
 */
function countOpenPrs(prs) {
  return (Array.isArray(prs) ? prs : [])
    // A null or non-object entry is not a pull request. The first version used
    // `pr?.state || 'OPEN'`, which turned every null in the list into an open
    // PR and would have capped the loop on garbage.
    .filter((pr) => pr && typeof pr === 'object')
    .filter((pr) => String(pr.state || 'OPEN').toUpperCase() === 'OPEN')
    .length;
}

/**
 * @returns {{ claim: boolean, code: 0|3, openCount: number, cap: number, message: string }}
 *   `code` mirrors the node-role guard: 0 = go ahead, 3 = a normal decline.
 */
function wipDecision({
  prs, cap, operatorCap, ticketStatusById,
  nowMs = Date.now(), strandedAfterMs = resolveStrandedAfterMs(),
} = {}) {
  const limit = Number.isInteger(cap) ? cap : DEFAULT_WIP_CAP;
  const operatorLimit = Number.isInteger(operatorCap) ? operatorCap : DEFAULT_OPERATOR_CAP;

  // No ticket statuses supplied — ClickUp could not be read, or an older
  // caller. Fall back to counting every open PR, which is the pre-2026-08-25
  // behaviour: MORE restrictive, never less. Failing toward the cap costs some
  // idle time; failing away from it costs the churn the cap exists to prevent.
  if (!ticketStatusById || typeof ticketStatusById !== 'object') {
    const openCount = countOpenPrs(prs);
    const capped = openCount >= limit;
    return {
      claim: !capped, code: capped ? 3 : 0, openCount, inFlight: openCount, cap: limit,
      // WITHOUT STATUSES THE SPLIT CANNOT BE MADE, so it is reported as null
      // rather than as zero (task 86bbuzzbk). Zero would read as "nothing is
      // waiting on Dane", which is a finding this path did not make — the same
      // could-not-tell-versus-all-clear distinction `strandedPhrase` above
      // already carries, and DOCTRINE 3.2.
      inProgress: null,
      operatorHeld: null,
      operatorCap: operatorLimit,
      limitHit: capped ? 'wip' : null,
      groups: null,
      message: capped
        ? `WIP cap reached — ${openCount} PR(s) open, cap ${limit}. Not claiming; which stage is holding the\n` +
          'slots could NOT be determined — ticket statuses were unavailable, so this counted open PRs only.\n' +
          'This is a normal outcome, not a failure. Ticket statuses were NOT available, so every open PR was\n' +
          `counted — the conservative reading, and it means work parked on ${operatorName()} was counted against the build\n` +
          `cap too, which it normally is not. Raise it with ${CAP_ENV} for an experiment.`
        : `${openCount} PR(s) open, cap ${limit} — room to claim another (ticket statuses unavailable; counted them all).`,
    };
  }

  const groups = classifyPrs({ prs, ticketStatusById, nowMs, strandedAfterMs });
  const inFlight = groups.inFlight.length;
  const inProgress = groups.inProgress.length;
  const operatorHeld = groups.operatorHeld.length;
  const notCounted = groups.rework.length + groups.queued.length + groups.live.length
    + groups.unknown.length + groups.unrecognised.length + groups.strandedBuilds.length;

  // The split, always — a bare total is what hid the 2026-08-25 deadlock.
  const parts = [];
  // Rework leads the list, and is named as rework rather than as "queued",
  // because it is the number this ticket exists to stop hiding: half-finished
  // branches with review notes already on them.
  // Stranded builds lead the list because they are the only bucket that names
  // a FAULT rather than a state: every other line here is work waiting its
  // turn, while this one is work nothing will ever pick up.
  if (groups.strandedBuilds.length) {
    parts.push(`${groups.strandedBuilds.length} whose build pass died and left the ticket in "Building" (#`
      + groups.strandedBuilds.join(', #') + ') — `npm run pipeline -- sweep` puts them back in the line');
  }
  if (groups.rework.length) parts.push(`${groups.rework.length} in rework, waiting to be re-claimed (#${groups.rework.join(', #')})`);
  if (groups.queued.length) parts.push(`${groups.queued.length} queued with a PR already open (#${groups.queued.join(', #')})`);
  if (groups.live.length) parts.push(`${groups.live.length} whose ticket is already live (#${groups.live.join(', #')})`);
  if (groups.unknown.length) parts.push(`${groups.unknown.length} with no ticket found (#${groups.unknown.join(', #')})`);
  // Said separately from "no ticket found", because a ticket WAS found here
  // (review round 2). Reporting a missing ClickUp link that is not missing
  // sends the reader after drift that does not exist — and naming the status
  // is what turns this line into something actionable: either the status list
  // in this file is out of date, or someone typed a status by hand.
  if (groups.unrecognised.length) {
    parts.push(`${groups.unrecognised.length} whose ticket is in an unrecognised status (`
      + groups.unrecognised.map((u) => `#${u.number} — "${u.status}"`).join('; ') + ')');
  }
  const tail = notCounted ? `\n${notCounted} open PR(s) not counted: ${parts.join('; ')}.` : '';

  // The rework count goes in the HEADLINE of both messages, not only in the
  // tail (task 86bbr1u9v, acceptance criterion 3). "1 in flight, cap 5" while
  // five real branches sat open is the statement the Rework status exists to
  // end, and a number that appears only in a trailing clause is a number that
  // gets skimmed. Zero is stated too: a clause that vanishes when it is zero
  // tells the reader nothing about whether it was checked at all.
  const reworkPhrase = `${groups.rework.length} in rework`;
  // THE HEADLINE SAYS WHAT WAS DISCOUNTED, and says separately when it could
  // not tell. A cap that quietly forgives two PRs reads exactly like a cap
  // that was never full — and "0 stranded" and "stranded not checked" are
  // different news, only one of which is an all-clear.
  const strandedPhrase = groups.freshnessKnown
    ? `${groups.strandedBuilds.length} stranded`
    : 'stranded builds NOT checked';

  // EVERY message names all three numbers, whichever way the decision goes
  // (task 86bbuzzbk). Splitting one cap into two makes it possible to report a
  // count that is no longer the one being enforced, and "4 in flight, cap 5"
  // while the loop was actually declining on the OTHER limit would be the same
  // class of defect the rework phrase above exists to prevent — a true number
  // standing where the deciding one belongs.
  const census = `${inProgress} building or in review (cap ${limit}), `
    + `${operatorHeld} waiting on ${operatorName()} (ceiling ${operatorLimit}), `
    + `${strandedPhrase}, ${reworkPhrase}, which never count`;

  const common = {
    openCount: countOpenPrs(prs),
    inFlight,
    inProgress,
    building: groups.building.length,
    reviewing: groups.reviewing.length,
    operatorHeld,
    rework: groups.rework.length,
    stranded: groups.strandedBuilds.length,
    cap: limit,
    operatorCap: operatorLimit,
    groups,
  };

  if (inProgress >= limit) {
    return {
      ...common, claim: false, code: 3, limitHit: 'wip',
      message:
        `WIP cap reached — ${census}. ` +
        `Not claiming; the slots are held by ${holdingPhrase(groups)}.${tail}\n` +
        'This is a normal outcome, not a failure. Work queued beyond the merge rate does not ship sooner —\n' +
        `it goes stale, and every merge re-dates every open branch. Raise it with ${CAP_ENV} for an experiment.`,
    };
  }

  // The second limit, and it is a DIFFERENT sentence on purpose. Naming the
  // build stages would be false here — the machines are idle and the queue is
  // deep; what is full is Dane's own inbox, and only he can empty it. A reader
  // who cannot tell those two apart cannot act on either. (Until 2026-09-05
  // the sentence this one contrasts with said "the merge side is the
  // bottleneck"; that was retired for asserting a cause nothing had measured —
  // task 86bbvh285 — but the contrast it draws here is unchanged.)
  if (operatorHeld >= operatorLimit) {
    return {
      ...common, claim: false, code: 3, limitHit: 'operator',
      message:
        `OPERATOR CEILING reached — ${census}. ` +
        `Not claiming: ${operatorHeld} finished ticket(s) are already waiting on ${operatorName()}, and building more\n` +
        `would only deepen a pile he has to clear by hand — every one of them needs a catch-up merge once\n` +
        `the first lands. The machines are not blocked; his inbox is full.${tail}\n` +
        `This is a normal outcome, not a failure. It clears the moment he merges. Raise it with\n` +
        `${OPERATOR_CAP_ENV} for an experiment.`,
    };
  }

  return {
    ...common, claim: true, code: 0, limitHit: null,
    message: `${census} — room to claim another.${tail}`,
  };
}

/**
 * The ONE reading of "is the merge side full?", shared by every caller.
 *
 * WHY THIS EXISTS (2026-08-31, task 86bbq8br2). `wip-check` and
 * `next-interval` both answered that question, from the same module, and
 * reached OPPOSITE answers for eight months' worth of a morning: the claim
 * gate said "4 in flight, cap 5 — room to claim another" while the sleep timer
 * wrote "the work-in-progress cap is full" into the log and slept the maximum
 * hour, with 38 tickets claimable.
 *
 * The cause was not a wrong rule. It was two call sites: `next-interval` asked
 * GitHub for `number,state` and called `wipDecision` with no
 * `ticketStatusById`, so it took the documented conservative fallback — count
 * EVERY open PR — while `wip-check` asked for `body` too, read the queue, and
 * correctly excluded the four PRs whose tickets were `Queued` for rework. Both
 * behaved exactly as written. They were simply not the same reading.
 *
 * That is the failure mode `ticketIdFromPrBody` already carries a comment
 * about — two functions disagreeing about the same string — so the fix is
 * structural rather than a matching edit in two places: the reading happens
 * HERE, once, and a caller supplies only the two I/O calls.
 *
 * What is deliberately NOT shared is the direction each caller fails in, which
 * is a real difference and not duplication:
 *
 *   - `wip-check` fails OPEN. Refusing on a transient `gh` hiccup would stop
 *     all work; the cost of guessing wrong is some catch-up churn.
 *   - `next-interval` fails toward CAPPED. Its pass has already run and the
 *     only question is how long to sleep, so the safe direction is the long
 *     one.
 *
 * So this returns `determined:false` and says why, rather than choosing.
 *
 * @param {object} opts
 * @param {() => Promise<object[]|null>} opts.listOpenPrs  open PRs, each with
 *   `number`, `state` AND `body` — `classifyPrs` matches a PR to its ticket
 *   through the body, so a caller that omits it gets the statuses-unavailable
 *   fallback no matter how well the queue read went.
 * @param {() => Promise<object|null>} opts.readTicketStatuses  id -> status
 *   string for the Loop Queue, closed tickets INCLUDED (a zombie PR's ticket
 *   is `Live`, and without it the PR reports as "no ticket found").
 * @param {number} [opts.cap]
 * @returns {Promise<{determined:boolean, why:string|null, decision:object|null,
 *   statusesAvailable:boolean, queueFailure:string|null}>}
 */
async function probeCap({ listOpenPrs, readTicketStatuses, cap, operatorCap } = {}) {
  const limit = Number.isInteger(cap) ? cap : DEFAULT_WIP_CAP;
  const operatorLimit = Number.isInteger(operatorCap) ? operatorCap : DEFAULT_OPERATOR_CAP;

  let prs = null;
  let why = null;
  try {
    prs = typeof listOpenPrs === 'function' ? await listOpenPrs() : null;
  } catch (err) {
    why = String(err?.message || err);
  }
  // Not an array = not a count. There is no conservative reading of "we do not
  // know how many PRs are open", so the caller is told and decides.
  if (!Array.isArray(prs)) {
    return {
      determined: false,
      why: why || 'the open pull requests could not be listed',
      decision: null,
      statusesAvailable: false,
      queueFailure: null,
    };
  }

  let ticketStatusById;
  let queueFailure = null;
  try {
    const read = typeof readTicketStatuses === 'function' ? await readTicketStatuses() : null;
    if (read && typeof read === 'object' && Object.keys(read).length) ticketStatusById = read;
    else queueFailure = 'no tasks came back';
  } catch (err) {
    queueFailure = String(err?.message || err);
  }

  return {
    determined: true,
    why: null,
    // With ticketStatusById undefined this is the documented conservative
    // fallback — count every open PR — which is exactly what BOTH callers
    // want when the queue is unreadable. Unchanged behaviour, one code path.
    decision: wipDecision({ prs, cap: limit, operatorCap: operatorLimit, ticketStatusById }),
    statusesAvailable: ticketStatusById !== undefined,
    queueFailure: ticketStatusById === undefined ? queueFailure : null,
  };
}

/**
 * What to do when the count itself could not be read.
 *
 * DELIBERATELY FAILS OPEN, and this is the one place that differs from
 * `node:owns`. That guard protects a check-then-act claim, where guessing
 * wrong means two machines building the same ticket — a correctness problem,
 * so it must refuse. This one is a THROUGHPUT optimisation: guessing wrong
 * costs some catch-up churn, while refusing on a transient `gh` failure would
 * stop all work outright. So it proceeds — and says loudly that it is
 * proceeding without knowing, which is the part that must never be silent.
 */
function undeterminedDecision(why) {
  return {
    claim: true,
    code: 1,
    openCount: null,
    cap: null,
    message:
      `Could not count open PRs (${why}), so the work-in-progress cap was NOT applied this pass.\n` +
      'Proceeding, because refusing on a transient failure would stop all work — but this pass is\n' +
      'unbounded by the cap and that is worth noticing if it repeats.',
  };
}

module.exports = {
  STRANDABLE_STATUS,
  STRANDED_ENV,
  resolveStrandedAfterMs,
  normalizeTicketInfo,
  isStrandedBuild,
  DEFAULT_WIP_CAP,
  CAP_ENV,
  DEFAULT_OPERATOR_CAP,
  OPERATOR_CAP_ENV,
  IN_FLIGHT_STATUSES,
  IN_PROGRESS_STATUSES,
  OPERATOR_HELD_STATUSES,
  TERMINAL_STATUSES,
  resolveCap,
  resolveOperatorCap,
  ticketIdFromPrBody,
  classifyPrs,
  countOpenPrs,
  wipDecision,
  probeCap,
  undeterminedDecision,
};
