'use strict';

/**
 * relayAutoMerge — the relay's auto-merge lane pass, up to a "would merge"
 * note (SP-202, slice 2 of 3 of SP-199).
 *
 * WHAT THIS IS. StarCaster's relay (`scripts/clickup_direct.mjs`, `bus-relay`,
 * the block headed "Lane A: announce, wait one hour, merge") runs Lanes A and
 * B inline in a 6,000-line door, where only source-matching tests can reach
 * it. Its decisions already came across in `autoMergeLane.js` with their
 * tests; this file is the same sequence of steps, in the same order, with
 * every read and write handed in as a function, so each rule can be tested
 * with no tracker, no GitHub and no disk:
 *
 *   1. the ledger is read; an unreadable one means OFF (it may hold a stop);
 *   2. the switch is read from the bus and from every ticket the relay read
 *      this pass; an unreadable bus means OFF;
 *   3. a message that nearly said "resume auto-merging" gets one answer;
 *   4. a stop is remembered in the ledger the moment it is seen;
 *   5. the lane disables itself on an unverified pass or a red main, says so
 *      on the bus, and says so again once a day while it stays off;
 *   6. the gate: switch, self-disable, then the hourly and daily caps;
 *   7. each candidate: announce, cancel on his comment, and at the end of the
 *      hour, here, ONE "would merge" note and nothing else;
 *   8. the daily digest on the bus;
 *   9. the ledger is written back, never over one that could not be read.
 *
 * WHAT IS DIFFERENT FROM STARCASTER, AND WHY. Three things, each because
 * this slice must not merge:
 *
 *   - Step 7's merge is a note. No merge step is called, no status moves. The
 *     note is said once per announcement (its marker is read back on later
 *     passes), and it is counted in the ledger as a REHEARSED merge, so the
 *     caps hold exactly as they will once the lane merges for real. A
 *     rehearsed merge is never counted as a merge: not in `everMerged`, not
 *     as "auto-merged" in the digest, and not as the last merge main's build
 *     is judged against.
 *   - The announcement says, inside the notice, that this lane does not merge
 *     yet. A notice that promised a merge that never comes would be the
 *     dishonest card the whole loop exists to avoid.
 *   - Only the lanes the project config lists run (`autoMergeLanes`). With
 *     none listed the pass does nothing at all, reads nothing and writes
 *     nothing, which is what keeps Spirality's and WaveCenter's relay
 *     unchanged. The protected-file list is the project's, handed in, and a
 *     pass with no list refuses to run rather than read "no list" as
 *     "nothing protected" (review note 1 on SP-199).
 *
 * The CANNOT TELL bound and the merge step's own readings stay with the real
 * merge (SP-203): a rehearsal asks GitHub nothing it could get stuck on.
 */

const lane = require('./autoMergeLane');
const { isMachineComment, isStampedMachineComment } = require('./machineComment');
const { githubGate } = require('./mergeOnComment');

const {
  WINDOW_MS,
  laneADecision, laneEligibility, announcementNotice, cancellationNotice,
  switchCommand, nearMissResume, nearMissNotice, newNearMisses, ledgerAfterNearMiss,
  killSwitchState, rateCapState, selfDisableState, laneGate, latchNagDue,
  digestDue, digestSince, digestBody, mergesSince,
  asLedger, pruneMerges, ledgerAfterSwitch, ledgerAfterDisable, ledgerAfterLatchNag, ledgerAfterDigest,
  switchSignalsFromLedger,
} = lane;

/** The lanes this package knows. Anything else in a config is named and skipped. */
const KNOWN_LANES = ['A', 'B'];

// ── The rehearsal note ───────────────────────────────────────────────────────

const REHEARSAL_MARKER = '[auto-merge-rehearsal]';
const REHEARSAL_MARKER_RE = /^\s*\[auto-merge-rehearsal\]\s+would-merge PR #(\d+) lane ([AB]) announcement (\S+)/m;
const rehearsalOpening = (prNumber) => `**Would merge PR #${prNumber} now. Nothing was merged.**`;

function rehearsalMarkerLine(prNumber, laneName, announcementId) {
  return `${REHEARSAL_MARKER} would-merge PR #${prNumber} lane ${laneName} announcement ${announcementId}`;
}

function parseRehearsalMarker(text) {
  const m = REHEARSAL_MARKER_RE.exec(String(text || ''));
  return m ? { pr: Number(m[1]), lane: m[2], announcementId: m[3] } : null;
}

/**
 * Has this announcement's "would merge" note already been said? Only a note
 * a machine wrote counts (the tail stamp): Dane quoting it is his comment,
 * and his comment cancels before this is ever asked.
 */
function rehearsalAlreadySaid(comments, prNumber, announcementId) {
  return (comments || []).some((c) => {
    if (!isStampedMachineComment(c && c.comment_text)) return false;
    const got = parseRehearsalMarker(c.comment_text);
    return Boolean(got && got.pr === Number(prNumber) && got.announcementId === String(announcementId));
  });
}

/**
 * The one comment the end of the window gets in this slice. It names the
 * gate GitHub reported, so the note says exactly what a real merge would have
 * stood on, and it hands the ticket back to his word in so many words.
 */
function rehearsalNotice({ pr, laneName, announcementId, why, gateReason, operator = 'the operator', mergePhrase = 'merge' }) {
  return {
    marker: rehearsalMarkerLine(pr.number, laneName, announcementId),
    body: [
      rehearsalOpening(pr.number),
      '',
      `The hour announced on this ticket has ended (${why}). PR #${pr.number} still qualifies for Lane ${laneName}, and GitHub reads it as ${gateReason}.`,
      '',
      'This is the moment the lane would merge it. It does not merge on its own yet: this project\'s relay rehearses the lane first, so the announcement, the cancel, the caps, the stop switch and the digest can be watched on real tickets before anything merges without you.',
      '',
      `So nothing has changed. The PR is still open and this ticket is still Ready to launch, waiting on ${operator}'s word exactly as before: say "${mergePhrase}" and it goes through.`,
      '',
      `${pr.url}`,
      '',
      `(Automatic — Lane ${laneName} rehearsal, relay auto-merge.)`,
      '',
      rehearsalMarkerLine(pr.number, laneName, announcementId),
    ].join('\n'),
  };
}

/** The line inside the announcement that says it will not merge yet. */
const REHEARSAL_ANNOUNCEMENT_LINE = '**This lane does not merge on its own yet.** When the hour ends it says here that it would merge, and nothing merges: the ticket stays in Ready to launch, waiting on your word.';

/** A rehearsed merge, recorded so the caps count it. Never `everMerged`. */
function ledgerAfterRehearsal(ledger, entry, now) {
  const l = asLedger(ledger);
  return { ...l, merges: pruneMerges([...l.merges, { ...entry, rehearsal: true }], now) };
}

/** Real merges only: a rehearsal merged nothing, so it is not the lane's evidence. */
function realMerges(entries) {
  return (entries || []).filter((m) => m && !m.rehearsal);
}

/**
 * The daily digest. The real-merge half is `digestBody`, unchanged; a
 * rehearsal day adds what WOULD have merged under it, never counted as merged.
 */
function rehearsalDigestBody({ ledger, since, sinceLabel, clockLabel }) {
  const entries = mergesSince(ledger, since);
  const head = digestBody({ entries: realMerges(entries), sinceLabel, clockLabel });
  const rehearsed = entries.filter((m) => m.rehearsal);
  if (!rehearsed.length) return head;
  const lines = rehearsed.map((e) => {
    const files = (e.files || []).map((f) => `\`${f}\``).join(', ');
    return `- **Lane ${e.lane || 'A'}** · PR #${e.pr} · ${e.task ? `ticket ${e.task}` : 'ticket unknown'}\n  qualified by: ${files || '(files not recorded)'}`;
  });
  return `${head}\n\nWould have merged (rehearsal: nothing merged, each is still waiting on a "merge"), ${rehearsed.length} in ${sinceLabel}:\n\n${lines.join('\n')}`;
}

function latchItemLines(d) {
  const items = (d && Array.isArray(d.items)) ? d.items : [];
  if (!items.length) return '';
  const dropped = Number(d.droppedItems) || 0;
  const more = dropped ? `\n  ...and ${dropped} more (the stored list is capped)` : '';
  return `\n\nWhat it could not verify:\n${items.map((x) => `  - ${x}`).join('\n')}${more}`;
}

// ── The switch, from the bus and the tickets ─────────────────────────────────

/**
 * Only the operator's own words, and never a machine's (the machine stamp or
 * a bracketed tag): a bus full of loops discussing the switch would otherwise
 * hold it down for good.
 */
function switchFromBus(read, operatorId) {
  if (!read || !read.ok) {
    return { readable: false, signals: [], nearMisses: [], why: (read && read.why) || 'the bus could not be read' };
  }
  if (!Array.isArray(read.messages)) {
    return { readable: false, signals: [], nearMisses: [], why: 'the bus answered, but not with a list of messages' };
  }
  const signals = [];
  const nearMisses = [];
  for (const m of read.messages) {
    if (Number(m && m.authorId) !== Number(operatorId)) continue;
    if (isMachineComment(m.text)) continue;
    const at = Number(m.at) || 0;
    const kind = switchCommand(m.text);
    if (kind) signals.push({ kind, at, where: `on the bus (${m.ticket})` });
    const miss = nearMissResume(m.text);
    if (miss) nearMisses.push({ id: `bus-${m.id}`, at, where: `on the bus (${m.ticket})`, saw: miss.saw });
  }
  return { readable: true, signals, nearMisses };
}

function switchFromTickets(read, operatorId) {
  const signals = [];
  const nearMisses = [];
  for (const { task, comments } of read || []) {
    for (const c of comments || []) {
      if (Number(c && c.user && c.user.id) !== Number(operatorId)) continue;
      if (isMachineComment(c.comment_text)) continue;
      const at = Number(c.date) || 0;
      const kind = switchCommand(c.comment_text);
      if (kind) signals.push({ kind, at, where: `on ticket ${task.id}` });
      const miss = nearMissResume(c.comment_text);
      if (miss) nearMisses.push({ id: `comment-${c.id}`, at, where: `on ticket ${task.id}`, saw: miss.saw });
    }
  }
  return { signals, nearMisses };
}

// ── The pass ─────────────────────────────────────────────────────────────────

function emptyCounts() {
  return { considered: 0, announced: 0, waiting: 0, wouldMerge: 0, cancelled: 0, ineligible: 0, halted: '' };
}

/**
 * Run the lane pass once.
 *
 * @param {object}   o
 * @param {string[]} o.lanes            the project config's `autoMergeLanes`
 * @param {string[]|null} o.governancePaths the project's protected list; null refuses
 * @param {Array}    o.candidates       [{ task, comments }]: Ready to launch tickets the
 *                                      relay did not merge or close this pass
 * @param {Array}    o.switchTickets    [{ task, comments }]: every ticket the relay read
 * @param {number}   o.operatorId
 * @param {string}   o.repo             "owner/name"; a PR elsewhere is never a candidate
 * @param {string[]} o.unchecked        the pass's could-not-verify list (lane lines are added)
 * @param {boolean}  o.dryRun
 * @param {object}   o.io               every read and write; see the test for the shapes
 * @returns {Promise<{ ran: boolean, counts, busSkipped: string[], line: string }>}
 */
async function runLanePass({
  lanes = [],
  governancePaths = null,
  candidates = [],
  switchTickets = [],
  operatorId,
  operatorName = 'the operator',
  mergePhrase = 'merge',
  repo = '',
  unchecked = [],
  dryRun = false,
  now = () => Date.now(),
  clock = (ms) => new Date(Number(ms)).toISOString(),
  tag = '[relay]',
  io,
  log = () => {},
} = {}) {
  const counts = emptyCounts();
  const busSkipped = [];
  const listed = (Array.isArray(lanes) ? lanes : []).map((l) => String(l).trim().toUpperCase()).filter(Boolean);

  // Nothing listed: nothing read, nothing written, nothing said.
  if (!listed.length) return { ran: false, counts, busSkipped, line: '' };

  const on = listed.filter((l) => KNOWN_LANES.includes(l));
  for (const l of listed.filter((x) => !KNOWN_LANES.includes(x))) {
    log(`  autoMergeLanes names "${l}", which is not a lane this package knows (${KNOWN_LANES.join(', ')}) — skipped`);
  }
  const lanesLabel = on.join(', ') || '(none known)';
  const summary = () => `auto-merge lanes ${lanesLabel} (rehearsal, nothing merges): ${counts.considered} considered, ${counts.announced} announced, ${counts.waiting} in window, ${counts.wouldMerge} would merge, ${counts.cancelled} cancelled, ${counts.ineligible} ineligible${counts.halted ? ` (HALTED: ${counts.halted})` : ''}`;

  if (!on.length) {
    counts.halted = 'the project config lists no lane this package knows';
    return { ran: true, counts, busSkipped, line: summary() };
  }
  if (!Array.isArray(governancePaths)) {
    counts.halted = 'the project\'s protected-file list (governancePaths) could not be read';
    unchecked.push(`auto-merge lanes: ${counts.halted}, so no lane ran — a missing list is not "nothing protected"`);
    return { ran: true, counts, busSkipped, line: summary() };
  }

  const at = Number(now());
  const led = io.readLedger();
  let ledger = led.ledger;

  // Every source the switch can be set from. Unreadable means OFF.
  const busSw = switchFromBus(await io.readBus(), operatorId);
  const ticketSw = switchFromTickets(switchTickets, operatorId);
  const readable = busSw.readable && led.ok;
  if (!busSw.readable) busSkipped.push(`the stop switch could not be read from the bus (${busSw.why}) — auto-merge is OFF this pass`);
  if (!led.ok) unchecked.push(led.why);

  // A message that ALMOST said resume gets one answer, remembered in the ledger.
  const nearMissCandidates = [...busSw.nearMisses, ...ticketSw.nearMisses];
  const freshNearMisses = led.ok ? newNearMisses({ candidates: nearMissCandidates, ledger }) : [];
  if (!led.ok && nearMissCandidates.length) {
    unchecked.push(`${nearMissCandidates.length} message(s) nearly said "resume auto-merging" and could not be answered — the auto-merge ledger is unreadable, so there is no way to answer each one once`);
  }
  for (const miss of freshNearMisses) {
    const text = nearMissNotice({ where: miss.where, saw: miss.saw }).replace(/^\[[^\]]*\]/, tag);
    if (dryRun) { log(`  DRY RUN — would post to the bus: a near-miss notice for the message ${miss.where}`); continue; }
    const posted = await io.postBus(text);
    if (!posted.ok) { busSkipped.push(`a near-miss switch notice for the message ${miss.where} could not be posted (${posted.why}) — it will be tried again next pass`); continue; }
    ledger = ledgerAfterNearMiss(ledger, [miss.id]);
    log(`  NEAR MISS answered: a message ${miss.where} nearly said "resume auto-merging" and did not match`);
  }

  // A stop is remembered the moment it is seen, so a ticket that goes Live
  // cannot take its stop out of view and switch the lane back on.
  const liveSignals = [...busSw.signals, ...ticketSw.signals];
  const newestLive = liveSignals.slice().sort((a, b) => b.at - a.at)[0];
  if (newestLive) ledger = ledgerAfterSwitch(ledger, newestLive);
  const killSwitch = killSwitchState({ signals: [...liveSignals, ...switchSignalsFromLedger(ledger)], readable });

  // Main going red after the last REAL auto-merge.
  const merged = realMerges(asLedger(ledger).merges);
  const lastMerge = merged[merged.length - 1];
  let mainRed = false;
  if (lastMerge && lastMerge.repo && !ledger.disabled) {
    const build = io.mainBuildIsRed(lastMerge.repo);
    if (!build.known) unchecked.push(`${build.why} — auto-merge cannot confirm main is healthy`);
    else if (build.red && Number(build.at) >= Number(lastMerge.at)) mainRed = true;
  }

  const selfDisable = selfDisableState({ unchecked, mainBuildRed: mainRed, persisted: ledger.disabled });
  if (selfDisable.disabled && selfDisable.fresh) {
    ledger = ledgerAfterDisable(ledger, selfDisable.why, at, { items: selfDisable.items, trigger: selfDisable.trigger });
    const text = `${tag} AUTO-MERGE DISABLED ITSELF: ${selfDisable.why}. No pull request will be auto-merged until a human says "resume auto-merging". Merges on your own word are unaffected.${latchItemLines(selfDisable)}`;
    if (dryRun) log(`  DRY RUN — would post to the bus: ${text}`);
    else {
      const posted = await io.postBus(text);
      if (!posted.ok) unchecked.push(`auto-merge disabled itself and the bus did not take the announcement (${posted.why})`);
    }
  }

  const nag = latchNagDue({ disabled: selfDisable, now: at, lastNagAt: ledger.disabled && ledger.disabled.lastNagAt });
  if (nag.due) {
    const text = `${tag} AUTO-MERGE IS STILL LATCHED OFF — ${nag.why}. ${selfDisable.why}${latchItemLines(selfDisable)}\n\nNothing will auto-merge until a human says "resume auto-merging". Your own merge commands still work.`;
    if (dryRun) log(`  DRY RUN — would post to the bus: ${text}`);
    else {
      const posted = await io.postBus(text);
      if (posted.ok) ledger = ledgerAfterLatchNag(ledger, at);
      else busSkipped.push('the auto-merge latch reminder could not be posted to the bus — it will be tried again next pass');
    }
  }

  const gate = laneGate({ killSwitch, selfDisable, rateCap: rateCapState(ledger.merges, at) });
  counts.considered = candidates.length;

  if (!gate.allowed) {
    counts.halted = gate.why;
    log(`  The auto-merge lanes are not running this pass: ${gate.why}`);
  } else {
    for (const cand of candidates) {
      const t = cand.task;
      const label = `"${t.name}" (${t.id})`;

      // Re-checked per ticket: a cap read once per pass lets the fourth through.
      const cap = rateCapState(ledger.merges, Number(now()));
      if (!cap.allowed) { counts.halted = cap.why; log(`  Auto-merge stopping: ${cap.why}`); break; }

      const decide = (files) => laneADecision({
        status: t.status && t.status.status,
        comments: cand.comments,
        operatorId,
        now: Number(now()),
        files,
        projectPaths: governancePaths,
      });
      let decision = decide(null);

      if (decision.pr && `${decision.pr.owner}/${decision.pr.repo}`.toLowerCase() !== String(repo).toLowerCase()) {
        counts.ineligible++;
        log(`  ${label}: PR #${decision.pr.number} is in ${decision.pr.owner}/${decision.pr.repo}, not ${repo} — no lane carries it`);
        continue;
      }

      // AN ANNOUNCEMENT ENDS AT ITS "WOULD MERGE" NOTE. The armed marker stays
      // the newest marker after the note, so the decision module goes on
      // judging it: a comment of his after the hour reads as an objection,
      // and a day later the announcement reads as stale. Both would post a
      // false "Auto-merge stopped" card on a ticket that was only ever
      // waiting on his word (SP-202, round 1). Once this announcement's note
      // is said, the lane has said all it will, whatever comes after.
      if (decision.announcementId && decision.pr
        && rehearsalAlreadySaid(cand.comments, decision.pr.number, decision.announcementId)) {
        counts.waiting++;
        log(`  ${label}: Lane ${decision.lane || 'A'} already said it would merge PR #${decision.pr.number}; waiting on ${operatorName}'s word`);
        continue;
      }

      if (decision.act === 'need-files') {
        const got = io.prFiles(decision.pr.number);
        if (!got.ok) {
          unchecked.push(`${t.id}: could not read PR #${decision.pr.number}'s changed files (${got.why}) — the auto-merge lanes did not judge it`);
          continue;
        }
        decision = decide(got.files);
      }

      // A lane this project has not switched on is the same as no lane.
      if (decision.act === 'announce' && !on.includes(decision.lane)) {
        counts.ineligible++;
        log(`  ${label}: PR #${decision.pr.number} needs Lane ${decision.lane}, which this project has not switched on`);
        continue;
      }
      if (decision.act === 'merge' && !on.includes(decision.lane)) {
        decision = { ...decision, act: 'cancel', reason: `the PR now needs Lane ${decision.lane}, which this project has not switched on` };
      }

      if (decision.act === 'ignore') {
        if (decision.eligibility) counts.ineligible++;
        else if (decision.deadlineAt) counts.waiting++;
        continue;
      }

      const pr = decision.pr;

      if (decision.act === 'announce') {
        const laneName = decision.lane || 'A';
        const deadlineLabel = clock(Number(now()) + WINDOW_MS);
        const notice = announcementNotice({
          pr, files: decision.eligibility.files, deadlineLabel, at: new Date(Number(now())).toISOString(), lane: laneName,
          rehearsal: REHEARSAL_ANNOUNCEMENT_LINE,
        });
        if (dryRun) { log(`  DRY RUN — would announce Lane ${laneName} on ${label}: PR #${pr.number}, the hour ending ${deadlineLabel}`); counts.announced++; continue; }
        const posted = await io.postNotice(t.id, notice.body);
        if (!posted.ok) {
          // An announcement that did not post is not a window.
          unchecked.push(`${t.id}: the Lane ${laneName} announcement failed (${posted.why}) — nothing is armed and nothing will merge`);
          continue;
        }
        // The binding hour runs from the tracker's own time for the comment.
        const ends = clock(posted.at + WINDOW_MS);
        const bus = await io.postBus(`${tag} Lane ${laneName} armed on ${label}: PR #${pr.number} has a review PASS and qualifies for Lane ${laneName}. Its hour ends at ${ends} unless ${operatorName} comments on the ticket. This is a rehearsal: at the end it says it would merge, and nothing merges.\n\n${pr.url}`);
        if (!bus.ok) busSkipped.push(`${t.id}: Lane ${laneName} announced on the ticket but the bus post failed (${bus.why})`);
        log(`  LANE ${laneName} ARMED on ${label}: PR #${pr.number}, its hour ends at ${ends}`);
        counts.announced++;
        continue;
      }

      if (decision.act === 'cancel') {
        const laneName = decision.lane || 'A';
        const notice = cancellationNotice({ pr, why: decision.reason, at: new Date(Number(now())).toISOString(), lane: laneName });
        if (dryRun) { log(`  DRY RUN — would cancel Lane ${laneName} on ${label}: ${decision.reason}`); counts.cancelled++; continue; }
        const posted = await io.postNotice(t.id, notice.body);
        if (!posted.ok) {
          unchecked.push(`${t.id}: Lane ${laneName} was cancelled (${decision.reason}) but the notice FAILED to post (${posted.why}) — ${operatorName} has not been told, and the announcement is still armed`);
          continue;
        }
        log(`  LANE ${laneName} CANCELLED on ${label}: ${decision.reason}`);
        counts.cancelled++;
        continue;
      }

      // decision.act === 'merge': the hour is up with no objection. A rehearsal.
      const laneName = decision.lane || 'A';
      const view = io.prView(pr.number);
      if (!view.ok) {
        unchecked.push(`${t.id}: Lane ${laneName}'s hour is up, but PR #${pr.number} could not be read from GitHub (${view.why}) — nothing was said this pass`);
        continue;
      }
      const gh = githubGate(view.pr);
      if (gh.action !== 'merge' && gh.action !== 'refuse' && gh.action !== 'conflict') {
        // Checks still running, or the branch is behind: a real merge would
        // wait, so the rehearsal waits too, and says nothing yet.
        counts.waiting++;
        log(`  ${label}: Lane ${laneName}'s hour is up and GitHub says wait (${gh.reason})`);
        continue;
      }
      if (gh.action !== 'merge') {
        // The gate said no after the hour: a real merge would cancel here.
        const notice = cancellationNotice({ pr, why: `at the end of the hour GitHub would not merge it: ${gh.reason}`, at: new Date(Number(now())).toISOString(), lane: laneName });
        if (dryRun) { log(`  DRY RUN — would cancel Lane ${laneName} on ${label}: ${gh.reason}`); counts.cancelled++; continue; }
        const posted = await io.postNotice(t.id, notice.body);
        if (!posted.ok) { unchecked.push(`${t.id}: Lane ${laneName} was cancelled at the end of the hour (${gh.reason}) but the notice FAILED to post (${posted.why})`); continue; }
        log(`  LANE ${laneName} CANCELLED at the end of the hour on ${label}: ${gh.reason}`);
        counts.cancelled++;
        continue;
      }
      const notice = rehearsalNotice({
        pr, laneName, announcementId: decision.announcementId, why: decision.reason, gateReason: gh.reason,
        operator: operatorName, mergePhrase,
      });
      if (dryRun) { log(`  DRY RUN — would say Lane ${laneName} would merge PR #${pr.number} on ${label} (${decision.reason})`); counts.wouldMerge++; continue; }
      const posted = await io.postNotice(t.id, notice.body);
      if (!posted.ok) {
        unchecked.push(`${t.id}: Lane ${laneName}'s hour is up, but the "would merge" note FAILED to post (${posted.why}) — the next pass says it again`);
        continue;
      }
      ledger = ledgerAfterRehearsal(ledger, {
        at: Number(now()), lane: laneName, pr: pr.number, url: pr.url, task: t.id, repo: `${pr.owner}/${pr.repo}`, files: decision.eligibility.files,
      }, Number(now()));
      log(`  LANE ${laneName} WOULD MERGE PR #${pr.number} on ${label} (${decision.reason}) — nothing merged`);
      counts.wouldMerge++;
    }
  }

  // Announced, never silent: once a day, "none" included.
  if (!dryRun && digestDue(ledger.lastDigestAt, at)) {
    const since = digestSince(ledger, at);
    const body = rehearsalDigestBody({
      ledger,
      since,
      sinceLabel: ledger.lastDigestAt > 0 ? `the time since the last digest (${clock(since)})` : 'the last 24 hours',
      clockLabel: clock(at),
    }).replace(/^\[[^\]]*\]/, tag);
    const bus = await io.postBus(body);
    if (bus.ok) ledger = ledgerAfterDigest(ledger, at);
    else unchecked.push(`the daily auto-merge digest could not be posted (${bus.why}) — it will be retried next pass`);
  }

  // NEVER over a ledger that could not be read: it may hold a stop.
  if (!dryRun) {
    const saved = io.saveLedger(led, ledger);
    if (!saved.ok && !saved.skipped) unchecked.push(`the auto-merge ledger could not be written (${saved.why})`);
    else if (saved.skipped && !led.ok) log(`  ${saved.why}`);
  }

  return { ran: true, counts, busSkipped, line: summary(), ledger };
}

module.exports = {
  KNOWN_LANES,
  REHEARSAL_MARKER,
  REHEARSAL_ANNOUNCEMENT_LINE,
  rehearsalMarkerLine,
  parseRehearsalMarker,
  rehearsalAlreadySaid,
  rehearsalNotice,
  ledgerAfterRehearsal,
  realMerges,
  rehearsalDigestBody,
  switchFromBus,
  switchFromTickets,
  runLanePass,
};
