/**
 * Test data for Dane's page: two projects and a handful of tickets covering
 * every way a ticket can stand with the operator. The tests read it
 * (tracker/web.test.mjs) and so does the demo server (tracker/demo.mjs), so
 * what is tested is what he clicks through.
 *
 * `expect` names, per ticket, what the loop's `waiting` rule says about it.
 */
import operatorCard from '../lib/operatorCard.js';
import machineComment from '../lib/machineComment.js';
import substrateConfig from '../lib/substrateConfig.js';

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
  file('alpha', 'Finished and merged', 'live', { priority: 'normal' }, 'machine');
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

  if (clock) {
    const start = clock.time();
    const DAY = 24 * 60 * 60_000;
    FINISHED_DAYS_AGO.forEach((days, i) => {
      clock.moveTo(start - days * DAY - 2 * 60 * 60_000);
      const id = file(i % 2 ? 'beta' : 'alpha', `A task finished ${days} day${days === 1 ? '' : 's'} ago`, 'in review', {}, 'machine');
      clock.moveTo(start - days * DAY);
      store.changeTicket(id, { actor: loop.id, status: 'live' });
    });
    clock.moveTo(start);
  }

  return { operator: op, loop, token, expect };
}
