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
import mergeOnComment from '../lib/mergeOnComment.js';
import substrateConfig from '../lib/substrateConfig.js';
import humanHours from '../lib/humanHours.js';

const { buildCard } = operatorCard;

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

/** The demo's home project: the one that always runs main, as Spirality's own does (SP-275). */
export const DEMO_OWN_PROJECT = 'alpha';

/** The demo's newest release cut, a stand-in for reading the tags (SP-275): the demo never calls GitHub. */
export const DEMO_NEWEST_RELEASE = 'release-3';

/** The server's newestRelease for the demo: always DEMO_NEWEST_RELEASE. */
export async function demoNewestRelease() {
  return { newest: { name: DEMO_NEWEST_RELEASE, number: 3, commit: '0'.repeat(40) }, problem: null };
}

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
  say(asked, loop.id, card.rendered);

  const answered = file('alpha', 'Merging stalls on a conflict: file the catch-up ticket', 'ready to launch',
    { assigned: true, description: 'Fix the relay.' }, 'answered');
  say(answered, loop.id, 'PR opened: https://github.com/example/repo/pull/7');
  say(answered, loop.id, 'REVIEW: PASSED. Ready for your merge word.');
  say(answered, op.id, 'merge');

  // SP-349: two open pull requests on Alpha that change the same file, so
  // each ticket page shows "Changes the same files as ...".
  store.recordPrFiles({ project: 'alpha', number: 7, ticket: answered, repo: 'example/repo', head: '7'.repeat(40), files: ['lib/relayLane.js', 'scripts/clickup.mjs'], actor: loop.id });
  store.recordPrFiles({ project: 'alpha', number: 8, ticket: asked, repo: 'example/repo', head: '8'.repeat(40), files: ['docs/TRACKER_MVP.md', 'lib/relayLane.js'], actor: loop.id });

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
  say(merged, loop.id, [
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
  ].join('\n'));
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

  // A loop's question with no machine stamp: its author says it is a loop's (SP-26).
  const unstamped = file('beta', 'A question a loop asked, with no machine stamp', 'needs your input',
    { assigned: true, description: 'The newest comment is a loop\'s, and carries no stamp: its author is what says so.' }, 'waiting');
  say(unstamped, loop.id, 'Which name should the tab show?');

  // An intake card, as loop-intake posts it: reply "go" to queue it (SP-86).
  const intake = file('beta', 'A request written up as a spec, waiting for your go', 'needs your input',
    { assigned: true, description: '## Asked\n```\nmake the board easier to read\n```\n\n## Goal\nA clearer board.' }, 'waiting');
  say(intake, loop.id, buildCard([
    '@@ASKED', 'make the board easier to read', '@@CONTEXT', CONTEXT,
    '@@NEEDED', 'Reply "go" to queue it as written, or reply with what to change.', 'Your move: Reply — "go", or what to change.',
  ].join('\n')).rendered);

  // A card that names its command mid-sentence and runs its options together
  // on one line, like SP-23's (SP-169): the command gets a Copy box, and the
  // red ask reads Options:, each option and Your move on lines of their own.
  const command = file('beta', 'Move WaveCenter to the tracker: pick when', 'needs your input',
    { assigned: true, description: '## Goal\nMove WaveCenter off ClickUp.' }, 'waiting');
  say(command, loop.id, buildCard([
    '@@ASKED', 'a wizard copy now is fine for now',
    '@@CONTEXT', 'Everything this move waits on is finished, so WaveCenter can now leave ClickUp for the tracker. '
      + 'A loop must not do it: the setup wizard stops the lanes first, so an unattended pass would cut itself off halfway. '
      + 'It needs a session started by hand on the Mini, which runs `npm run onboard -- --product wavecenter` and answers '
      + 'that WaveCenter is already on ClickUp. Nothing has changed yet.',
    '@@NEEDED', 'A decision that is yours: when to switch (switching back is in docs/TRACKER_MVP.md). Options: A) "go now": start a session by hand on the Mini and ask it to run the move. B) "later": name a time and it waits here.',
    'Your move: Reply "go now" or a time.',
  ].join('\n')).rendered);

  file('beta', 'A question with no comments yet', 'needs your input', { assigned: true }, 'waiting');

  // Shaped like SP-64: a catch-up ticket with no PR of its own, whose work
  // landed when the PR it unstuck merged. Its card's move is Close (SP-68).
  const unstuck = file('beta', 'Find out why PR #7 (conflict-fix) will not merge', 'ready to launch', {
    assigned: true,
    description: '## The branch\n\n- PR: https://github.com/example/repo/pull/7\n- Branch: `conflict-fix`',
  }, 'waiting');
  say(unstuck, loop.id, 'REVIEW: PASSED. PR #7 is merged; this ticket has no pull request of its own.');
  say(unstuck, loop.id, buildCard([
    '@@ASKED', 'merge', '@@CONTEXT', CONTEXT,
    '@@NEEDED', 'Nothing to merge: PR #7 has already landed.', 'Your move: Close — its work is live.',
  ].join('\n')).rendered);

  // SP-226: Dane's merge word landed on GitHub, but the relay has not moved
  // it to Live yet. By status alone it waits on him; the demo's stand-in
  // GitHub read (demoPrState) says PR #14 is merged, so the page leaves it
  // off Waiting on You and shows the "is merged" line in place of Merge.
  const mergedNotLive = file('beta', 'Merged on GitHub but not yet Live', 'ready to launch',
    { assigned: true, description: 'The pull request is merged; the relay moves this to Live at its next pass.' }, 'waiting');
  say(mergedNotLive, loop.id, `PR opened: ${DEMO_MERGED_PR}`);
  say(mergedNotLive, loop.id, 'REVIEW: PASSED. Ready for your merge word.');

  // SP-286: a website visitor's bug report, as StarCaster's Bug Report
  // module files it (composeBugReportTask, like SC-804): held in his status,
  // no card. The page's top reads "Bug Report:", the visitor's words in
  // bold, then where and who it came from.
  file('beta', 'Bug report: The Bug Report module should have a site-wide option under Placement. As it is, you can o… — Demo Site', 'needs your input', {
    assigned: true,
    tags: ['bug-report', 'demo-site'],
    description: [
      '## What the reporter said', '',
      '```', 'The Bug Report module should have a site-wide option under Placement.', 'As it is, you can only put it on one page at a time, and I typed <script>alert(1)</script> and **stars** to test it.', '```', '',
      '## Where and who', '',
      '- **Page:** https://example.com/pricing',
      '- **Project:** Demo Site (proj_demo)',
      '- **Viewer tier:** public',
      '- **Browser:** `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15`',
      '- **Submitted:** 2026-11-13T21:04:00.000Z',
      '- **Report id:** `br_demo_1`', '',
      '## Screenshots', '', '(none attached)', '',
      '---',
      '_Filed automatically from a public bug report. Held for the operator: nothing in the build loops will touch this until you move it._',
    ].join('\n'),
  }, 'waiting');

  // SP-287: a second held bug report, so Approve can be tried on one and
  // Reject on the other.
  file('beta', 'Bug report: The contact form forgets what I typed when I go back. — Demo Site', 'needs your input', {
    assigned: true,
    tags: ['bug-report', 'demo-site'],
    description: [
      '## What the reporter said', '',
      '```', 'The contact form forgets what I typed when I go back.', '```', '',
      '## Where and who', '',
      '- **Page:** https://example.com/contact',
      '- **Project:** Demo Site (proj_demo)',
      '- **Viewer tier:** member',
      '- **Submitted:** 2026-11-14T16:30:00.000Z',
      '- **Report id:** `br_demo_2`', '',
      '## Screenshots', '', '(none attached)',
    ].join('\n'),
  }, 'waiting');

  // SP-314: a third held bug report in the older shape ClickUp imported
  // (SC-111, SC-446 to SC-479): the page as a markdown link, and a spaced
  // `* * *` divider, which is a rule, not a screenshot.
  file('beta', 'Bug report: The search box on the blog returns nothing for two-word searches. — Demo Site', 'needs your input', {
    assigned: true,
    tags: ['bug-report', 'demo-site'],
    description: [
      '## What the reporter said', '',
      '```', 'The search box on the blog returns nothing for two-word searches.', '```', '',
      '## Where and who', '',
      '- **Page:** [https://example.com/blog](https://example.com/blog)',
      '- **Project:** Demo Site (proj_demo)',
      '- **Viewer tier:** public',
      '- **Submitted:** 2026-11-12T18:15:00.000Z',
      '- **Report id:** `br_demo_3`', '',
      '## Screenshots', '', '(none attached)', '',
      '* * *', '',
      '_Filed automatically from a public bug report. Held for the operator: nothing in the build loops will touch this until you move it._',
    ].join('\n'),
  }, 'waiting');

  // Two Pipeline Controls changes on Alpha (SP-224), so the Settings page's
  // change log shows rows: the cap tried at 3 and put back, which leaves every
  // control on its default.
  store.setPipelineSetting({ project: 'alpha', setting: 'wip-cap', value: '3', actor: op.id });
  store.setPipelineSetting({ project: 'alpha', setting: 'wip-cap', value: '5', actor: op.id });

  // Two Spirality releases named for Beta (SP-275), so the Settings page's
  // Spirality Release group shows one running and one before it, and Roll
  // Back has somewhere to go. Alpha is the demo's home project (DEMO_OWN_PROJECT).
  store.nameRelease({ project: 'beta', release: 'release-1', actor: loop.id, ownProject: DEMO_OWN_PROJECT });
  store.nameRelease({ project: 'beta', release: 'release-2', actor: op.id, ownProject: DEMO_OWN_PROJECT });

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
    `===== ${logDate(start)} START /${job} (model: default) =====`,
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

/**
 * The demo's five made-up next tasks (SP-251), answered by demoSuggest. The
 * first two carry SP-305's about, related, topics, tags and links; their
 * topics are DEMO_TOPICS, which tracker/demo.mjs adds to Alpha.
 */
export const DEMO_TOPICS = Object.freeze(['Board', 'Notifications']);
export const DEMO_SUGGESTIONS = Object.freeze([
  {
    title: 'Add a search box to the Board view',
    description: 'The List view can be searched; the Board cannot.\nPut the same search box above the columns.',
    why: 'Two open tickets ask for it.',
    // SP-305: the info box's fuller fields, as a checked answer holds them.
    about: 'The Board view shows every ticket as a card in its stage\'s column, but unlike the List view it has no way to look for one. On a busy project that means scrolling every column by eye to find a ticket whose name you half remember. This task puts the same search box the List view already has above the Board\'s columns, so typing a word narrows the cards in every column at once and clearing it brings them all back. It matters now because the queue has grown past what fits on one screen, and the two open tickets about the Board both run into it.',
    related: [{ id: 'AL-3', name: 'The board is missing: draw the seven columns' }, { id: 'AL-8', name: 'A pull request waiting for review' }],
    topics: ['Board'],
    tags: ['tracker'],
    links: [{ label: 'The tracker\'s plan', path: 'docs/TRACKER_MVP.md' }, { label: 'Where the page is drawn', path: 'tracker/web/render.mjs' }, { label: 'The Board ticket', ticket: 'AL-3' }],
  },
  {
    title: 'Show who last changed each ticket',
    description: 'Name the person or loop beside "Last Change".',
    why: 'The docs plan names it as the next step.',
    about: 'Each ticket shows when it last changed, but not who changed it, so a surprise move on the board leaves you opening the ticket\'s history to find out whether a loop or a person did it. This task names the person or loop beside the Last Change time on every card and row. It matters because the build and review loops move tickets all day, and telling their moves apart from a person\'s at a glance is how odd ones get noticed early.',
    related: [{ id: 'AL-6', name: 'A send-back with review notes' }],
    topics: ['Board', 'Notifications'],
    tags: ['tracker', 'fix'],
    links: [{ label: 'The Loop Contract', path: 'docs/LOOP_CONTRACT.md' }],
  },
  { title: 'Let a project be archived', description: 'An archived project leaves the picker but keeps its tickets.', why: 'Old test projects crowd the picker.' },
  { title: 'Send a weekly summary email', description: 'Every Monday morning, what went Live last week.', why: 'Asked for in the plan, never built.' },
  { title: 'Explain each status on hover', description: 'A short line under each stage name.', why: 'New people ask what "Rework" means.' },
]);

/**
 * The demo's stand-in next-task suggester: no copy, no Claude. It answers
 * DEMO_SUGGESTIONS after `ms` (two seconds unless set), so the Tasks page's
 * Suggest Next Tasks box shows a run going and then its list.
 */
export function demoSuggest({ ms = 2000 } = {}) {
  return () => new Promise((resolve) => { setTimeout(() => resolve(DEMO_SUGGESTIONS.map((s) => ({ ...s }))), ms); });
}
