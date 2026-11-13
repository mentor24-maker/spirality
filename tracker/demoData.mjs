/**
 * Test data for Dane's page: two projects and a handful of tickets covering
 * every way a ticket can stand with the operator. The tests read it
 * (tracker/web.test.mjs) and so does the demo server (tracker/demo.mjs), so
 * what is tested is what he clicks through.
 *
 * `expect` names, per ticket, what the loop's `waiting` rule says about it.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import operatorCard from '../lib/operatorCard.js';
import machineComment from '../lib/machineComment.js';
import mergeOnComment from '../lib/mergeOnComment.js';
import substrateConfig from '../lib/substrateConfig.js';
import humanHours from '../lib/humanHours.js';

const { buildCard } = operatorCard;
const { stampMachineComment } = machineComment;

const CONTEXT = 'The page that shows tickets outside ClickUp needs a place to run. '
  + 'The loops already live on the Mini, so the simplest home is the Mini as well, '
  + 'reached from the desktop over the home network. A small hosted server would also '
  + 'work and would be reachable from anywhere, but it costs a few dollars a month and '
  + 'adds a second machine to keep running. Nothing is spent until you choose.';

/**
 * A clock for `openStore` that moves one minute per reading, starting
 * `start`. `time()` is where it stands; `moveTo(ms)` sets it, so seedDemo
 * can file the Reporting page's finished tasks days in the past.
 */
export function tickingClock(start = Date.parse('2026-10-27T15:00:00Z')) {
  let t = start;
  const clock = () => {
    const at = new Date(t).toISOString();
    t += 60_000;
    return at;
  };
  clock.time = () => t;
  clock.moveTo = (ms) => { t = ms; };
  return clock;
}

/** How many days before the demo's start each of its earlier finished tasks moved to Live. */
const FINISHED_DAYS_AGO = Object.freeze([1, 3, 6, 12, 20, 27, 45]);

/** The human-hours estimate on each of those tasks' pull requests; null is a task with none. */
const FINISHED_HUMAN_HOURS = Object.freeze([6, 2.5, null, 12, 4, 8, null]);

/**
 * Fill an empty store. Answers the actors (with the operator's token, for
 * signing in), and each ticket's id with what `waiting` would say about it:
 * 'waiting', 'answered', 'machine' (a machine status) or 'unassigned'.
 *
 * Given the store's `clock` (a tickingClock), it also files tasks finished
 * over the last month and a half, each built and moved to Live on its own
 * day, for the Reporting page, then puts the clock back where it was.
 */
export function seedDemo(store, { operatorName = substrateConfig.operatorName(), clock = null } = {}) {
  const op = store.createActor({ kind: 'human', name: operatorName });
  const loop = store.createActor({ kind: 'machine', name: 'Loop (build)' });
  const token = store.issueToken(op.id);
  store.createProject({ slug: 'alpha', name: 'Alpha', prefix: 'AL', operator: op.id });
  store.createProject({ slug: 'beta', name: 'Beta', prefix: 'BE', operator: op.id });

  const expect = {};
  const file = (project, name, status, { assigned = false, description = '', priority = null, tags = [] } = {}, outcome) => {
    const t = store.fileTicket({ project, actor: loop.id, name, status, description, priority, tags, assignee: assigned ? op.id : null });
    expect[t.id] = outcome;
    return t.id;
  };
  const say = (ticket, author, body) => store.postComment({ ticket, author, body });

  const card = buildCard([
    '@@ASKED', 'put the tracker somewhere I can reach it',
    '@@WHEN', '2026-10-26, on the tracker plan',
    '@@CONTEXT', CONTEXT,
    '@@NEEDED', 'Reply A (the Mini) or B (a hosted server).', 'Your move: Reply — A or B.',
  ].join('\n'));

  const asked = file('alpha', 'The tracker has nowhere to run: choose where it lives', 'needs your input',
    { assigned: true, description: '## Goal\nChoose where the tracker runs.\n\n- [x] Options written up\n- [ ] Choice made' }, 'waiting');
  say(asked, loop.id, 'Started building this.');
  say(asked, loop.id, stampMachineComment(card.rendered));

  const answered = file('alpha', 'Merging stalls on a conflict: file the catch-up ticket', 'ready to launch',
    { assigned: true, description: 'Fix the relay.' }, 'answered');
  say(answered, loop.id, 'PR opened: https://github.com/example/repo/pull/7');
  say(answered, loop.id, 'REVIEW: PASSED. Ready for your merge word.');
  say(answered, op.id, 'merge');

  file('alpha', 'The board is missing: draw the seven columns', 'queued', { description: 'Later.' }, 'machine');

  // One of each machine status, and Live, for the board. Queued holds three
  // of mixed priority, filed out of order, so its column shows `queue` order
  // (priority, then oldest) rather than filing order.
  file('alpha', 'A low-priority chore filed first', 'queued', { priority: 'low', tags: ['chore'] }, 'machine');
  file('alpha', 'An urgent fix filed after it', 'queued', { priority: 'urgent', tags: ['tracker', 'fix'] }, 'machine');
  file('alpha', 'A send-back with review notes', 'rework', { priority: 'normal' }, 'machine');
  file('alpha', 'A ticket a build loop is on', 'building', { priority: 'high' }, 'machine');
  file('alpha', 'A pull request waiting for review', 'in review', { tags: ['tracker'] }, 'machine');
  const merged = file('alpha', 'Finished and merged', 'live', { priority: 'normal' }, 'machine');
  // The relay's merge note, with the files the pull request made: its page shows the Files Made box (SP-170).
  say(merged, loop.id, 'PR opened: https://github.com/example/repo/pull/9');
  say(merged, loop.id, stampMachineComment([
    'Merged: PR #9 (https://github.com/example/repo/pull/9) squash-merged into main at 2026-11-09T12:00:00Z, on your comment 1.',
    'Checks were green and the branch was up to date at merge time; the branch has been deleted.',
    '',
    'This ticket is now Live (its pull request merged).',
    '',
    ...mergeOnComment.filesMadeLines({
      repo: 'example/repo', branch: 'main',
      files: [{ filename: 'docs/OVERVIEW.md', status: 'added' }, { filename: 'lib/newModule.js', status: 'added' }],
    }).lines,
    '',
    '(Automatic — relay merge step.)',
  ].join('\n')));
  file('alpha', 'A request filed from the page', 'requested', { description: 'Nobody has specced it yet.' }, 'machine');

  const review = file('beta', 'Descriptions with HTML break the page: show them as text', 'ready to launch', {
    assigned: true,
    description: 'This description holds markup that must show as text:\n\n<script>alert("ran")</script>\n\n'
      + '<img src=x onerror="alert(1)"> and [a bad link](javascript:alert(1)).\n\n```\ncode <b>stays</b> code\n```',
  }, 'waiting');
  say(review, loop.id, 'PR opened: https://github.com/example/repo/pull/12');
  say(review, loop.id, 'REVIEW: PASSED. `npm run verify` is green; ready for your merge word.');

  file('beta', 'A hand-off that never finished: in your status but not assigned', 'needs your input',
    { description: 'Nobody is assigned.' }, 'unassigned');

  // A loop posting under the operator's own token: his id, but the machine stamp.
  const underToken = file('beta', 'A question a loop asked under your token', 'needs your input',
    { assigned: true, description: 'The newest comment carries your id and the machine stamp.' }, 'waiting');
  say(underToken, op.id, stampMachineComment('Which name should the tab show?'));

  // An intake card, as loop-intake posts it: reply "go" to queue it (SP-86).
  const intake = file('beta', 'A request written up as a spec, waiting for your go', 'needs your input',
    { assigned: true, description: '## Asked\n```\nmake the board easier to read\n```\n\n## Goal\nA clearer board.' }, 'waiting');
  say(intake, loop.id, stampMachineComment(buildCard([
    '@@ASKED', 'make the board easier to read', '@@CONTEXT', CONTEXT,
    '@@NEEDED', 'Reply "go" to queue it as written, or reply with what to change.', 'Your move: Reply — "go", or what to change.',
  ].join('\n')).rendered));

  // A card that names its command mid-sentence and runs its options together
  // on one line, like SP-23's (SP-169): the command gets a Copy box, and the
  // red ask reads Options:, each option and Your move on lines of their own.
  const command = file('beta', 'Move WaveCenter to the tracker: pick when', 'needs your input',
    { assigned: true, description: '## Goal\nMove WaveCenter off ClickUp.' }, 'waiting');
  say(command, loop.id, stampMachineComment(buildCard([
    '@@ASKED', 'a wizard copy now is fine for now',
    '@@CONTEXT', 'Everything this move waits on is finished, so WaveCenter can now leave ClickUp for the tracker. '
      + 'A loop must not do it: the setup wizard stops the lanes first, so an unattended pass would cut itself off halfway. '
      + 'It needs a session started by hand on the Mini, which runs `npm run onboard -- --product wavecenter` and answers '
      + 'that WaveCenter is already on ClickUp. Nothing has changed yet.',
    '@@NEEDED', 'A decision that is yours: when to switch (switching back is in docs/TRACKER_MVP.md). Options: A) "go now": start a session by hand on the Mini and ask it to run the move. B) "later": name a time and it waits here.',
    'Your move: Reply "go now" or a time.',
  ].join('\n')).rendered));

  file('beta', 'A question with no comments yet', 'needs your input', { assigned: true }, 'waiting');

  // Shaped like SP-64: a catch-up ticket with no PR of its own, whose work
  // landed when the PR it unstuck merged. Its card's move is Close (SP-68).
  const unstuck = file('beta', 'Find out why PR #7 (conflict-fix) will not merge', 'ready to launch', {
    assigned: true,
    description: '## The branch\n\n- PR: https://github.com/example/repo/pull/7\n- Branch: `conflict-fix`',
  }, 'waiting');
  say(unstuck, loop.id, 'REVIEW: PASSED. PR #7 is merged; this ticket has no pull request of its own.');
  say(unstuck, loop.id, stampMachineComment(buildCard([
    '@@ASKED', 'merge', '@@CONTEXT', CONTEXT,
    '@@NEEDED', 'Nothing to merge: PR #7 has already landed.', 'Your move: Close — its work is live.',
  ].join('\n')).rendered));

  // SP-226: Dane's merge word landed on GitHub, but the relay has not moved
  // it to Live yet. By status alone it waits on him; the demo's stand-in
  // GitHub read (demoPrState) says PR #14 is merged, so the page leaves it
  // off Waiting on You and shows the "is merged" line in place of Merge.
  const mergedNotLive = file('beta', 'Merged on GitHub but not yet Live', 'ready to launch',
    { assigned: true, description: 'The pull request is merged; the relay moves this to Live at its next pass.' }, 'waiting');
  say(mergedNotLive, loop.id, `PR opened: ${DEMO_MERGED_PR}`);
  say(mergedNotLive, loop.id, 'REVIEW: PASSED. Ready for your merge word.');

  // Two Pipeline Controls changes on Alpha (SP-224), so the Settings page's
  // change log shows rows: the cap tried at 3 and put back, which leaves every
  // control on its default.
  store.setPipelineSetting({ project: 'alpha', setting: 'wip-cap', value: '3', actor: op.id });
  store.setPipelineSetting({ project: 'alpha', setting: 'wip-cap', value: '5', actor: op.id });

  if (clock) {
    const start = clock.time();
    const HOUR = 60 * 60_000;
    // Each one queued, built, reviewed and waiting on the operator before it
    // went Live, so the flow reports have figures; every third was sent back
    // once, and the oldest was filed straight into review (never Queued).
    // Most carry a human-hours estimate on their pull request; two do not.
    FINISHED_DAYS_AGO.forEach((days, i) => {
      const live = start - days * 24 * HOUR;
      const oldest = i === FINISHED_DAYS_AGO.length - 1;
      const name = `A task finished ${days} day${days === 1 ? '' : 's'} ago`;
      const steps = oldest
        ? [[2, 'in review']]
        : [[30 + 4 * i, 'queued'], [26, 'building'], ...(i % 3 ? [] : [[20, 'in review'], [18, 'rework'], [14, 'building']]),
          [8, 'in review'], [4 + (i % 4), 'ready to launch']];
      const [[firstAt, firstStatus], ...rest] = steps;
      clock.moveTo(live - firstAt * HOUR);
      const id = file(i % 2 ? 'beta' : 'alpha', name, firstStatus, {}, 'machine');
      for (const [hoursBefore, status] of [...rest, [0, 'live']]) {
        clock.moveTo(live - hoursBefore * HOUR);
        store.changeTicket(id, { actor: loop.id, status });
      }
      const estimate = FINISHED_HUMAN_HOURS[i];
      const pr = `PR opened: https://github.com/example/repo/pull/${100 + i}`;
      say(id, loop.id, estimate == null ? pr : `${pr}\n${humanHours.humanHoursLine(estimate)}`);
    });
    clock.moveTo(start);
  }

  return { operator: op, loop, token, expect };
}

/** The demo pull request that reads as merged on GitHub (SP-226): "Merged on GitHub but not yet Live". */
export const DEMO_MERGED_PR = 'https://github.com/example/repo/pull/14';

/**
 * The demo's stand-in for the GitHub read (tracker/prState.mjs, ghPrState):
 * PR #14 is merged, every other one is open. It never calls GitHub.
 */
export async function demoPrState({ repo, number }) {
  return `https://github.com/${repo}/pull/${number}` === DEMO_MERGED_PR ? 'MERGED' : 'OPEN';
}

/** A local time as the runners write it: `2026-11-09 18:22:34` (date) or `18:22:34` (clock). */
const pad = (n) => String(n).padStart(2, '0');
export const logDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${logClock(d)}`;
export const logClock = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

/**
 * Scratch loop logs for the demo's Pipeline Status pod (SP-168), in the
 * runners' own line shapes: the relay ran four minutes ago, Build is running
 * now (its pass before slept 1,800 seconds), Review and Intake are sleeping
 * until later. Written to `folder` as `<slug>-<job>.log`, the names
 * tracker/pipeline.mjs reads. Test data only.
 */
export function writeDemoLogs(folder, slug, now = new Date()) {
  const ago = (min) => new Date(now.getTime() - min * 60_000);
  const lane = (job, start, end, seconds) => [
    `===== ${logDate(start)} START /${job} =====`,
    'A pass report, which the pod never shows.',
    ...(end ? [`===== ${logDate(end)} END /${job} (exit 0 — not a verdict; the pass's report above is) =====`, `[loop-runner] ${logClock(end)} sleeping ${seconds}s before the next /${job} (a wake ends it early)`] : []),
  ].join('\n');
  const files = {
    relay: [`===== ${logDate(ago(4))} START relay — demo =====`, `===== ${logDate(ago(3.9))} END relay — pass complete (exit 0) =====`].join('\n'),
    'loop-build': [lane('loop-build', ago(36), ago(32), 1800), lane('loop-build', ago(2), null, 1800)].join('\n'),
    'loop-review': lane('loop-review', ago(20), ago(17), 1800),
    'loop-intake': lane('loop-intake', ago(9), ago(8), 1800),
  };
  for (const [job, text] of Object.entries(files)) writeFileSync(join(folder, `${slug}-${job}.log`), `${text}\n`);
}
