'use strict';

/**
 * "Is this actually waiting on Dane?" — derived from live facts, never from
 * an impression.
 *
 * WHY THIS EXISTS (2026-08-23, task 86bbk34x7). Twice in one evening an agent
 * told the operator something was waiting on him when it was not, and he acted
 * on it both times:
 *
 *   - "Seventeen Ready-to-launch tickets are waiting on your merge word."
 *     Eleven already carried his approval and were stuck on a machine that
 *     could not push to GitHub. He went looking for work that was not his.
 *   - "The YouTube worker decision is the one thing waiting on you." He had
 *     answered `A` an hour earlier; the relay had already cleared his name and
 *     moved the ticket to Queued. He asked whether he had to answer a third
 *     time.
 *
 * Neither was a lie and neither was a reasoning failure. Both were A CLAIM
 * ABOUT CURRENT STATE, STATED FLATLY, BY AN AGENT READING SOMETHING OTHER THAN
 * THE STATE — a terminal buffer in one case, a stale impression of a list in
 * the other. The authoritative answer was one API call away each time.
 *
 * Him, that night: "The issue is making assumptions and stating them with
 * confidence. It has come up many times."
 *
 * A RULE ALONE WOULD NOT HOLD. Every claim that was RIGHT that evening carried
 * its evidence welded on ("854/854, verified by read-back"; "exit 0, here is
 * the output"). Every claim that was WRONG was a confident sentence with
 * nothing attached. The discipline is obvious in hindsight and lost every
 * time, because asking the question costs a thought and answering it costs a
 * command nobody has to hand. So: make the cheapest path the correct one. One
 * command, faster to run than the claim is to reason about.
 *
 * This module is the verdict, and only the verdict — no network, no clock, no
 * writes. clickup_direct.mjs does the live reads and hands the raw shapes in.
 *
 * AUTHORSHIP IS NOT THE USER ID (2026-09-01, task 86bbqx2xe). The loops post
 * under Dane's own token, so a card a machine wrote comes back with his user
 * id on it. That fooled this module in its quieter direction — it
 * UNDER-reports. A `Ready to launch` ticket always has a machine card as its
 * newest comment, so rule 1 fired ("his own comment is the newest word on
 * it") and the ticket came back NOT_WAITING. An agent asking "does anything
 * need Dane?" before writing its run report was told no while five approved
 * merges sat parked, invisible. The blindness was already self-confirming
 * once: an override note on 86bbpz1ed cited `waiting` as its evidence that the
 * hand-back guard had been fooled — a tool fooled by the same mechanism.
 * `isMachineComment` was the second half of the question then, and it is the
 * same check the relay makes, from the same module, so the two cannot drift.
 *
 * SINCE SP-26 the question is the author's kind, not the stamp: in the
 * tracker every loop posts as its own machine actor, so `isOperatorAuthored`
 * (his id, and not a machine) answers it from the row.
 */

const { isMachineAuthored, isOperatorAuthored } = require('./machineComment.js');
const { operatorName } = require('./substrateConfig.js');
const { isMergeCommand, isReviewVerdict, isReviewPassed } = require('./mergeOnComment.js');

/** The two statuses that belong to the operator. Everything else is a machine
 *  status, and a machine status means a machine owns the next move. */
const OPERATOR_LANE = ['needs your input', 'ready to launch'];

const WAITING = 'WAITING';
const NOT_WAITING = 'NOT_WAITING';
const CANNOT_TELL = 'CANNOT_TELL';

/**
 * The newest comment on a ticket, and whether it is his.
 *
 * ClickUp returns comments newest-first. Rather than trust that, sort by date
 * — the whole point of this module is not assuming the shape of what it read.
 *
 * `comments` of `null`/`undefined` means THE READ FAILED, which is different
 * from a ticket with no comments (`[]`). Conflating the two is how a failed
 * read becomes a confident answer.
 */
function newestComment(comments, { operatorId } = {}) {
  if (!Array.isArray(comments)) return null;
  if (comments.length === 0) return { none: true };
  const newest = comments
    .slice()
    .sort((a, b) => Number(b.date || 0) - Number(a.date || 0))[0];
  const byMachine = isMachineAuthored(newest);
  return {
    none: false,
    author: newest.user?.username || '(unknown)',
    // His id AND not a machine actor (task 86bbqx2xe, SP-26) — see the note
    // at the top of this file.
    isOperator: isOperatorAuthored(newest, operatorId),
    byMachine,
    text: String(newest.comment_text || '').trim(),
    date: Number(newest.date) || null,
  };
}

/**
 * Has the operator had the last word? If so a MACHINE owes the next move,
 * whatever the status column says — this is the 86bbjve6b case exactly: his
 * "A" is the newest comment on that ticket, and telling him it needs an answer
 * is asking him to say the same thing a third time.
 *
 * Authorship only. No reading of intent from the text (the ticket's own
 * non-goal): authorship plus status is enough, and it is the part that cannot
 * drift.
 */
function operatorSpokeLast(comments, { operatorId } = {}) {
  const last = newestComment(comments, { operatorId });
  return Boolean(last && !last.none && last.isOperator);
}

/**
 * His merge word that still stands on a `Ready to launch` ticket, or null
 * (SP-285). Exactly the comment the relay would act on (mergeDecision in
 * lib/mergeOnComment.js): his own (his actor, not a machine's), one of the
 * project's merge phrases, and newer than the newest review verdict, which
 * is a PASS. While it stands, the relay re-tries the merge on every pass, so
 * the next move is a machine's, however many machine notes come after it.
 *
 * WHY (SP-237, 2026-11-13). Dane said `merge` four times in two hours. Each
 * time the relay hit a conflict, filed the catch-up ticket and wrote "your
 * approval is still standing — you do not have to say merge again". That
 * note became the newest comment, so the newest-comment rule put the ticket
 * straight back on his Waiting on You list, telling him the opposite of what
 * the note said. A machine acknowledging his answer is not a new question.
 *
 * It stops standing when a new review verdict lands after it (a new round,
 * whose PR he has not approved), the same line the relay draws.
 *
 * Returns `{ id, date }` of that comment. `comments` as ClickUp shapes them;
 * the status is the caller's to check (only Ready to launch takes a merge).
 */
function standingMergeWord(comments, { operatorId } = {}) {
  if (!Array.isArray(comments) || operatorId == null) return null;
  const newestFirst = comments.slice().sort((a, b) => Number(b.date || 0) - Number(a.date || 0));
  const verdictAt = newestFirst.findIndex((c) => isReviewVerdict(c.comment_text));
  if (verdictAt < 0 || !isReviewPassed(newestFirst[verdictAt].comment_text)) return null;
  const word = newestFirst.slice(0, verdictAt).find((c) => isOperatorAuthored(c, operatorId)
    && isMergeCommand(c.comment_text));
  return word ? { id: word.id == null ? null : String(word.id), date: Number(word.date) || null } : null;
}

/**
 * The verdict for one ticket, from three facts and nothing else:
 *
 *   1. the status — `needs your input` / `ready to launch` are his lane,
 *   2. whether he is assigned — assignment IS the handoff signal
 *      (loop-build SKILL.md, "Assignment is the handoff signal"),
 *   3. whether the newest comment is his.
 *
 * Anything that cannot be established from those returns CANNOT_TELL with the
 * reason, never a confident verdict either way (DOCTRINE 3.11). A wrong "not
 * waiting" is how an answered ticket sits for nine hours; a wrong "waiting"
 * sends him looking for work that is not his. Both happened.
 *
 * A fourth fact, optional (SP-217): the ticket's recorded pull request, as
 * `{ number, state }`, state `OPEN`, `MERGED`, `CLOSED`, or `null` when the
 * read failed. On SP-207 Dane's "merge" had already landed PR #169, the
 * status still said `Ready to launch`, and this verdict told him the merge
 * was his move. The status column lags GitHub; the PR's own state does not.
 *
 *   - merged or closed, on a `Ready to launch` ticket: NOT_WAITING. The
 *     only thing that lane asks of him is the merge word, and the PR is past
 *     it. A machine owes the move to Live (or, closed, the next move).
 *   - read failed: the verdict is what it would have been without it, and
 *     the why says the PR could not be checked. A failed read never counts
 *     as merged: that is how a real wait would hide.
 *   - no PR recorded (`pr` absent): exactly as before.
 *
 * `Needs your input` is NOT settled by the PR. A question there (a closed PR
 * included: "it was closed, what now?") is still his to answer, so the
 * PR's state only joins the why.
 *
 * @param task      the task as ClickUp returns it (null = the read failed)
 * @param comments  its comments as ClickUp returns them (null = read failed)
 * @param pr        its recorded PR, `{ number, state }`, or absent for none
 */
function waitingVerdict({ task, comments, pr } = {}, { operatorId } = {}) {
  const facts = { status: null, assignedToOperator: null, lastWord: null, pr: prFact(pr) };

  if (!task) {
    return { verdict: CANNOT_TELL, why: 'the ticket itself could not be read', facts };
  }

  const status = String(task.status?.status || '').trim().toLowerCase();
  if (!status) {
    return { verdict: CANNOT_TELL, why: 'the ticket has no readable status', facts };
  }
  facts.status = status;

  // ClickUp always returns an assignees array, empty or not. Its ABSENCE means
  // we are looking at a partial read, which is not the same as "nobody is
  // assigned" — and treating it as such would answer with a fact we never saw.
  if (!Array.isArray(task.assignees)) {
    return { verdict: CANNOT_TELL, why: 'the ticket\'s assignees could not be read', facts };
  }
  facts.assignedToOperator = task.assignees.some((a) => Number(a?.id) === Number(operatorId));

  if (!Array.isArray(comments)) {
    return { verdict: CANNOT_TELL, why: 'the ticket\'s comments could not be read', facts };
  }
  facts.lastWord = newestComment(comments, { operatorId });

  // Rule 1, and it outranks the status column. He has spoken; something else
  // owes the next move.
  if (facts.lastWord && !facts.lastWord.none && facts.lastWord.isOperator) {
    return {
      verdict: NOT_WAITING,
      why: 'his own comment is the newest word on it — a machine owes the next move, whatever the status says',
      facts,
    };
  }

  // Rule 2: a machine status means a machine owns it.
  if (!OPERATOR_LANE.includes(status)) {
    return {
      verdict: NOT_WAITING,
      why: `"${status}" is a machine status — a machine owns this`,
      facts,
    };
  }

  // Rule 3 (SP-217): the merge he is asked for has already happened, or the
  // PR was closed. Not his, whoever is assigned.
  const prNote = prWhy(facts.pr);
  if (status === 'ready to launch' && facts.pr && (facts.pr.state === 'MERGED' || facts.pr.state === 'CLOSED')) {
    return {
      verdict: NOT_WAITING,
      why: facts.pr.state === 'MERGED'
        ? `PR #${facts.pr.number} is merged; a machine owes the move to Live, not ${operatorName()}`
        : `PR #${facts.pr.number} is closed without merging; a machine owes the next move, not ${operatorName()}`,
      facts,
    };
  }

  // Rule 3b (SP-285): he has already said merge for this round, and the relay
  // holds that word until the merge goes through. A machine note after it
  // ("your approval is still standing") is not a new question.
  if (status === 'ready to launch') {
    const word = standingMergeWord(comments, { operatorId });
    if (word) {
      return {
        verdict: NOT_WAITING,
        why: `his merge word${word.id ? ` (comment ${word.id})` : ''} still stands; the relay owes the merge, not ${operatorName()}${prNote}`,
        facts,
      };
    }
  }

  // Rule 4: his lane, his name on it, and the last word is not his.
  if (facts.assignedToOperator) {
    return {
      verdict: WAITING,
      why: `"${status}" is his lane, he is assigned, and the newest comment is not his${prNote}`,
      facts,
    };
  }

  // His lane but NOT assigned: the two signals disagree, so there is no honest
  // verdict here. The status says a machine is asking him something; the empty
  // assignee says it never reached the one view he actually watches (ClickUp's
  // own "Assigned to me" — a filtered view cannot span both spaces, assignment
  // can). That is a half-finished handoff, and it is a real defect rather than
  // a cosmetic one: the ticket is invisible to him. Say so; do not pick a side.
  return {
    verdict: CANNOT_TELL,
    why: `"${status}" is his lane but he is NOT assigned — a half-finished handoff, so it is not in the one `
      + 'view he watches. Fix the assignment (`clickup status --task <id> --status "'
      + `${status}" --assign <his id>\`) rather than guessing whether he owes anything${prNote}`,
    facts,
  };
}

const PR_STATES = ['OPEN', 'MERGED', 'CLOSED'];

/**
 * The PR fact as the verdict keeps it: null for no PR recorded, else
 * `{ number, state }` with state one of PR_STATES or null. Anything else
 * GitHub might say (a state this module does not know) is treated as a
 * failed read, never as merged.
 */
function prFact(pr) {
  if (!pr || typeof pr !== 'object') return null;
  const state = String(pr.state || '').trim().toUpperCase();
  return { number: pr.number ?? null, state: PR_STATES.includes(state) ? state : null };
}

/** The PR's part of a why that the PR did not decide. Empty with no PR. */
function prWhy(pr) {
  if (!pr) return '';
  if (pr.state === null) return `; PR #${pr.number}'s state could not be checked`;
  return `; PR #${pr.number} is ${pr.state.toLowerCase()}`;
}

/** The PR's state as the command prints it on a ticket's line. */
function prLabel(pr) {
  const f = prFact(pr);
  if (!f) return 'no PR';
  return `PR #${f.number} ${f.state === null ? 'could not check' : f.state.toLowerCase()}`;
}

/**
 * Can this ticket be decided WITHOUT reading its comments?
 *
 * Only for a machine status, and the reason is not economy but arithmetic:
 * both of the first two rules send a machine-status ticket to NOT_WAITING —
 * whether or not his comment is the newest one — so the comment read cannot
 * change the answer. It costs one HTTP request per ticket and the sweep runs
 * over every open ticket in two lists, which is most of ClickUp's
 * per-minute allowance spent to confirm something already settled.
 *
 * This is a shortcut, so it is PINNED: the test asserts it agrees with the
 * full verdict for every shape it answers, including the partial reads.
 * Returns null when the comments really are needed — his lane, where the
 * newest comment decides everything.
 */
function verdictFromStatusAlone(task, { operatorId } = {}) {
  const facts = { status: null, assignedToOperator: null, lastWord: null, pr: null };
  if (!task) return { verdict: CANNOT_TELL, why: 'the ticket itself could not be read', facts };
  const status = String(task.status?.status || '').trim().toLowerCase();
  if (!status) return { verdict: CANNOT_TELL, why: 'the ticket has no readable status', facts };
  if (OPERATOR_LANE.includes(status)) return null; // his lane — the comments decide
  facts.status = status;
  // A missing assignees array means a PARTIAL READ, and the full verdict stops
  // on it before it ever reaches the machine-status rule. The shortcut has to
  // stop there too: two commands answering one ticket differently is the
  // "stated with confidence" failure this whole module exists to remove, and
  // the sweep is where it would show — `waiting --task X` saying CANNOT TELL
  // while `waiting` calls the same ticket settled.
  if (!Array.isArray(task.assignees)) {
    return { verdict: CANNOT_TELL, why: 'the ticket\'s assignees could not be read', facts };
  }
  facts.assignedToOperator = task.assignees.some((a) => Number(a?.id) === Number(operatorId));
  return {
    verdict: NOT_WAITING,
    why: `"${status}" is a machine status — a machine owns this`,
    facts,
  };
}

/** The one-line answer, in his register rather than the enum's. */
function verdictLine(result) {
  if (!result) return 'CANNOT TELL — no verdict was produced';
  if (result.verdict === WAITING) return `WAITING ON ${operatorName().toUpperCase()} — ${result.why}`;
  if (result.verdict === NOT_WAITING) return `NOT waiting on ${operatorName()} — ${result.why}`;
  return `CANNOT TELL — ${result.why}`;
}

/** A short, single-line quote of the newest comment, for the "last word" row.
 *  Long cards and multi-paragraph answers get one line and an ellipsis. */
function excerpt(text, max = 60) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (!flat) return '(empty)';
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * The block the command prints for one ticket. Rendering lives here, beside
 * the verdict, so a test can pin the exact words — the output IS the evidence
 * this whole ticket exists to make cheap, and evidence nobody checks the
 * wording of is evidence that can quietly stop saying anything.
 *
 * `formatWhen` is injected: the module owns no clock.
 */
function renderTicket({ id, name, result }, { formatWhen } = {}) {
  const f = result.facts || {};
  const when = (ms) => (typeof formatWhen === 'function' && ms ? formatWhen(ms) : String(ms || ''));
  const lines = [`${id}  ${name || '(no name)'}`];
  lines.push(`  status:     ${f.status ?? '(unreadable)'}`);
  lines.push(`  assignee:   ${f.assignedToOperator === null
    ? '(unreadable)'
    : (f.assignedToOperator ? operatorName() : `(not ${operatorName()})`)}`);
  if (!f.lastWord) {
    lines.push('  last word:  (unreadable)');
  } else if (f.lastWord.none) {
    lines.push('  last word:  (no comments)');
  } else {
    const whenTxt = when(f.lastWord.date);
    // Name the machine ones. The author column reads "Dane" for every card the
    // loops wrote — that is the whole bug (86bbqx2xe) — so the evidence line
    // has to say which it was, or the verdict looks wrong to anyone checking.
    const who = f.lastWord.byMachine ? `${f.lastWord.author} (a machine, under his token)` : f.lastWord.author;
    lines.push(`  last word:  ${who}, "${excerpt(f.lastWord.text)}"${whenTxt ? `, ${whenTxt}` : ''}`);
  }
  if (f.pr) lines.push(`  pr:         ${prLabel(f.pr)}`);
  lines.push(`  VERDICT:    ${verdictLine(result)}`);
  return lines.join('\n');
}

/**
 * The exit code, so a caller can branch without parsing prose. Same three
 * codes the rest of the loop tooling uses (`node:owns`, `build-start`,
 * `wip-check`): 0 = carry on, 3 = it is somebody else's — here, HIS — and
 * 1 = could not tell, which is never a soft 0.
 */
function exitCodeFor(verdicts) {
  const all = [].concat(verdicts || []);
  if (all.some((v) => v === CANNOT_TELL)) return 1;
  if (all.some((v) => v === WAITING)) return 3;
  return 0;
}

/**
 * The summary line for the no-argument form. It states HOW MANY tickets it
 * looked at, because a silent partial read is the failure mode this command
 * exists to remove: "nothing is waiting on you" and "I only managed to read
 * four of them" must never look the same (DOCTRINE 3.11).
 */
function sweepSummary({ checked, waiting, cannotTell, lists } = {}) {
  const n = Number(checked) || 0;
  const w = Number(waiting) || 0;
  const c = Number(cannotTell) || 0;
  const where = lists && lists.length ? ` across ${lists.join(' + ')}` : '';
  const head = w === 0
    ? `Nothing is waiting on ${operatorName()} — checked ${n} open ticket(s)${where}.`
    : `${w} ticket(s) waiting on ${operatorName()} — checked ${n} open ticket(s)${where}.`;
  return c === 0 ? head : `${head} ${c} could NOT be decided — do not assume either way.`;
}

module.exports = {
  OPERATOR_LANE,
  WAITING,
  NOT_WAITING,
  CANNOT_TELL,
  newestComment,
  operatorSpokeLast,
  standingMergeWord,
  waitingVerdict,
  prFact,
  prLabel,
  verdictFromStatusAlone,
  verdictLine,
  excerpt,
  renderTicket,
  exitCodeFor,
  sweepSummary,
};
