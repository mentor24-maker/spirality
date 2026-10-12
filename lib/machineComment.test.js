'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MACHINE_MARKER,
  MACHINE_MARKER_LINE,
  isMachineComment,
  isStampedMachineComment,
  stampMachineComment,
  commentTextKey,
  isCommentPostPath,
  stampCommentBody,
  blocksToText,
} = require('./machineComment.js');

const { waitingVerdict, newestComment, operatorSpokeLast, WAITING, NOT_WAITING } = require('./waitingOnOperator.js');

const DANE = 48012725;

/* ------------------------------------------------------------------ *
 * The marker itself
 * ------------------------------------------------------------------ */

test('an unmarked comment is not machine-written', () => {
  assert.equal(isMachineComment('A'), false);
  assert.equal(isMachineComment('merge'), false);
});

test('a stamped comment is machine-written, and the original text survives', () => {
  const stamped = stampMachineComment('Card body here');
  assert.equal(isMachineComment(stamped), true);
  assert.ok(stamped.startsWith('Card body here'));
});

test('stamping is idempotent — a retry cannot leave two markers', () => {
  const once = stampMachineComment('body');
  const twice = stampMachineComment(once);
  assert.equal(once, twice);
  assert.equal(twice.split(MACHINE_MARKER).length - 1, 1);
});

test('an empty comment is not machine-written (nothing was read)', () => {
  assert.equal(isMachineComment(''), false);
  assert.equal(isMachineComment('   \n  '), false);
});

test('an unreadable comment is NOT called machine-written — that is a "could not tell"', () => {
  assert.equal(isMachineComment(null), false);
  assert.equal(isMachineComment(undefined), false);
});

test('legacy machine comments are recognised by their announced prefix', () => {
  assert.equal(isMachineComment('[CC-starcaster bus-relay] Dane replied on "x"'), true);
  assert.equal(isMachineComment('[auto-merge] armed PR #438 lane A — 2026-08-30'), true);
});

/* --- the direction it fails in, which is the point of the anchoring --- */

test('Dane quoting a machine card is still Dane — the marker is not the last line', () => {
  const hisAnswer = `You wrote:\n\n${MACHINE_MARKER_LINE}\n\nand my answer is B`;
  assert.equal(isMachineComment(hisAnswer), false);
});

test('the marker is only honoured on the LAST non-empty line', () => {
  assert.equal(isMachineComment(`${MACHINE_MARKER_LINE}\n\nbut then he typed more`), false);
  assert.equal(isMachineComment(`he typed this\n\n${MACHINE_MARKER_LINE}\n\n  \n`), true);
});

/* ------------------------------------------------------------------ *
 * The choke point: which requests get stamped
 * ------------------------------------------------------------------ */

test('task-comment and reply POSTs are comment posts; nothing else is', () => {
  assert.equal(isCommentPostPath('/api/v2/task/86bbqx2xe/comment'), true);
  assert.equal(isCommentPostPath('/api/v2/comment/12345/reply'), true);
  assert.equal(isCommentPostPath('/api/v2/task/86bbqx2xe'), false);
  assert.equal(isCommentPostPath('/api/v2/list/901418546619/task'), false);
  // The bus is a chat channel, not a ticket — his own relayed words must never
  // be stamped as a machine's.
  assert.equal(isCommentPostPath('/api/v3/workspaces/1/channels/2/messages'), false);
});

test('the text key is found in every comment body shape', () => {
  assert.equal(commentTextKey({ comment_text: 'x' }), 'comment_text');
  assert.equal(commentTextKey({ comment: 'x' }), 'comment');
  assert.equal(commentTextKey({ comment: [{ text: 'x' }] }), 'comment');
  assert.equal(commentTextKey(null), null);
});

/* The `ask` card — the comment whose misreading caused this ticket — is posted
 * as rich blocks, not as a string. The first cut of this module skipped
 * non-string bodies; the live break-test posted a real card and found it
 * unmarked. These exist so that hole cannot reopen. */

const cardBlocks = [
  { text: "DANE'S WORDS", attributes: { bold: true } },
  { text: '\n\nWhich option?\n' },
];

test('an operator card posted as rich blocks IS stamped', () => {
  const out = stampCommentBody({ comment: cardBlocks });
  assert.equal(isMachineComment(blocksToText(out.comment)), true);
});

test('stamping blocks preserves every original block untouched', () => {
  const out = stampCommentBody({ comment: cardBlocks });
  assert.deepEqual(out.comment.slice(0, cardBlocks.length), cardBlocks);
  assert.equal(out.comment.length, cardBlocks.length + 1);
});

test('stamping blocks is idempotent', () => {
  const once = stampCommentBody({ comment: cardBlocks });
  const twice = stampCommentBody(once);
  assert.deepEqual(twice.comment, once.comment);
});

test('a body that posts no comment is passed through untouched', () => {
  const body = { name: 'a task', status: 'Queued' };
  assert.deepEqual(stampCommentBody(body), body);
});

test('the plain-string body shape is stamped too', () => {
  assert.equal(isMachineComment(stampCommentBody({ comment_text: 'hello' }).comment_text), true);
});

/* ------------------------------------------------------------------ *
 * The two consumers. This is the bug itself, in both directions.
 * ------------------------------------------------------------------ */

const machineCard = {
  id: '1', date: '2000', user: { id: DANE, username: 'Dane' },
  comment_text: stampMachineComment('@@ASKED Which option?'),
};
const hisAnswer = {
  id: '2', date: '3000', user: { id: DANE, username: 'Dane' }, comment_text: 'B',
};

test('a machine card under his id is not his last word', () => {
  assert.equal(operatorSpokeLast([machineCard], { operatorId: DANE }), false);
  assert.equal(newestComment([machineCard], { operatorId: DANE }).isOperator, false);
  assert.equal(newestComment([machineCard], { operatorId: DANE }).byMachine, true);
});

test('his real answer still counts as his — the guard did not break the good case', () => {
  assert.equal(operatorSpokeLast([machineCard, hisAnswer], { operatorId: DANE }), true);
  assert.equal(newestComment([machineCard, hisAnswer], { operatorId: DANE }).isOperator, true);
});

test('THE BUG: an escalated ticket whose newest comment is its own ask card is WAITING on Dane', () => {
  const verdict = waitingVerdict({
    task: { status: { status: 'Needs your input' }, assignees: [{ id: DANE }] },
    comments: [machineCard],
  }, { operatorId: DANE });
  assert.equal(verdict.verdict, WAITING);
});

test('and once he answers it, it is NOT waiting on him any more', () => {
  const verdict = waitingVerdict({
    task: { status: { status: 'Needs your input' }, assignees: [{ id: DANE }] },
    comments: [machineCard, hisAnswer],
  }, { operatorId: DANE });
  assert.equal(verdict.verdict, NOT_WAITING);
});

test('THE UNDER-REPORT: Ready to launch with a machine verdict card still reports as his', () => {
  const passCard = {
    id: '9', date: '5000', user: { id: DANE, username: 'Dane' },
    comment_text: stampMachineComment('REVIEW: PASS — every gate green.'),
  };
  const verdict = waitingVerdict({
    task: { status: { status: 'Ready to launch' }, assignees: [{ id: DANE }] },
    comments: [passCard],
  }, { operatorId: DANE });
  assert.equal(verdict.verdict, WAITING);
});

// ── ClickUp's chat api escapes the brackets every prefix starts with ─────────
//
// Task 86bbt038u. The party-line api returns "\[CC-starcaster bus-relay\] ..."
// — it escapes what it would otherwise read as markdown. Every entry in
// LEGACY_MACHINE_PREFIXES begins with "[", so before this every agent post on
// the bus classified as Dane's own words. Checked against live channel content
// rather than assumed: all six most recent messages read as "his word",
// including three the relay had posted itself.

test('an escaped bus-relay prefix is recognised as machine-written', () => {
  assert.equal(isMachineComment('\\[CC-starcaster bus-relay\\] MERGED on Dane\'s say-so'), true);
});

test('the unescaped form still works — this did not replace the old reading', () => {
  assert.equal(isMachineComment('[CC-starcaster bus-relay] MERGED on Dane\'s say-so'), true);
});

test('the other agents posting to the same party line under his token', () => {
  assert.equal(isMachineComment('\\[CC-pulse\\] Steward digest — reviewed 4 messages'), true);
  assert.equal(isMachineComment('\\[CC-starcaster\\] Review PASSED'), true);
});

test('a signature the list never thought of is still a machine — the family, not the string', () => {
  // Found by rehearsal on 2026-09-05 (task 86bbuv99r): all three of these are
  // posted to the party line many times a day and NONE of them matched, so
  // every one was being read as Dane's own words on the channel the kill
  // switch is read from. The exact string "[CC-starcaster]" is not a prefix
  // of "[CC-starcaster loop-build]", and "[reconciler]" was never listed.
  assert.equal(isMachineComment('[CC-starcaster loop-build] built 86bbuv99r'), true);
  assert.equal(isMachineComment('[CC-starcaster loop-review] PASS — 86bbuv9jt, PR #616'), true);
  assert.equal(isMachineComment('[reconciler] branch `x` is still on this Mac'), true);
  assert.equal(isMachineComment('\\[CC-starcaster loop-build\\] built 86bbuv99r'), true,
    'and in the escaped form the chat api actually returns');
  assert.equal(isMachineComment('[CC-normie build] anything'), true, 'any CC- sibling repo');
  // NOT the [machine] marker — that one is honoured on the LAST line only, and
  // adding it to this head-anchored family silently repealed that rule when
  // this test was first written. The test above it caught it.
  assert.equal(isMachineComment(`${MACHINE_MARKER_LINE}\n\nbut then he typed more`), false);
});

test('a bracket Dane typed himself is NOT a machine tag', () => {
  // The whole risk of matching a family rather than a list. His messages are
  // prose; the tag has to be the first thing in the message AND name a sender.
  assert.equal(isMachineComment('[monday] lets merge 599'), false);
  assert.equal(isMachineComment('[note to self] stop auto-merging tonight'), false);
  assert.equal(isMachineComment('resume auto-merging'), false);
  assert.equal(isMachineComment('I read the [CC-starcaster bus-relay] post and disagree'), false,
    'a tag QUOTED mid-sentence is him talking about a machine, not a machine talking');
});

test('HIS OWN WORDS ARE STILL HIS — unescaping must not swallow the operator', () => {
  // The exact message the switch was supposed to read on 2026-09-01.
  assert.equal(isMachineComment('```cpp\nresume auto-merging\n```'), false);
  assert.equal(isMachineComment('resume auto-merging'), false);
  assert.equal(isMachineComment('merge'), false);
  // A backslash he typed himself in ordinary prose does not make it machine.
  assert.equal(isMachineComment('the path is C:\\Users\\Dane — merge when you can'), false);
});

// ── The strict reader: the stamp, and only the stamp ─────────────────────────

test('the strict reader answers on the tail stamp alone', () => {
  // What it is FOR: `isMachineComment` also honours a head-anchored tag, and a
  // head tag is what Dane types when he quotes a card and replies underneath.
  // At a call site where a false "a machine wrote this" DISCARDS his words —
  // Lane A's objection test, task 86bbv8nvy — that half must not apply.
  const quoted = [
    '[CC-starcaster loop-review] REVIEW: PASSED\n\nwait, do not merge this yet',
    '[auto-merge] armed PR #618 lane A — 6pm\n\nno, hold this one',
    '[bus-relay] relayed\n\nstop, this is wrong',
    '[reconciler] moved it to Live\n\nput it back',
  ];
  for (const body of quoted) {
    assert.equal(isMachineComment(body), true, 'the wide reader still matches the head tag');
    assert.equal(isStampedMachineComment(body), false,
      `his words under a quoted card are his: ${JSON.stringify(body.split('\n')[0])}`);
  }
});

test('the strict reader still recognises every real machine card', () => {
  // It costs nothing, because `call()` stamps at the door: every card a loop
  // posts carries the tail marker whatever else it opens with.
  assert.equal(isStampedMachineComment(stampMachineComment('PR opened: https://x/1')), true);
  assert.equal(isStampedMachineComment(
    stampMachineComment('[CC-starcaster loop-review] REVIEW: PASSED')), true);
  assert.equal(isStampedMachineComment(`some words\n\n${MACHINE_MARKER_LINE}`), true);
});

test('the strict reader keeps every "could not tell" as NOT machine', () => {
  // Same asymmetry as the wide one: an unknown is not a verdict. Answering
  // "machine" for a read nobody made is the DOCTRINE 3.11 failure.
  assert.equal(isStampedMachineComment(null), false);
  assert.equal(isStampedMachineComment(undefined), false);
  assert.equal(isStampedMachineComment(''), false);
  assert.equal(isStampedMachineComment('   \n  '), false);
  assert.equal(isStampedMachineComment('hold off on this one'), false);
});

test('the strict reader honours the marker only on the LAST non-empty line', () => {
  assert.equal(isStampedMachineComment(`${MACHINE_MARKER_LINE}\n\nwhy is this merging?`), false,
    'a pasted card at the top is him quoting one');
  assert.equal(isStampedMachineComment(`ok\n${MACHINE_MARKER_LINE}\n\n\n`), true,
    'trailing blank lines do not hide the stamp');
  // Escaped brackets from the chat API still resolve — same unescaping as the
  // wide reader, so the two cannot disagree about a stamp.
  assert.equal(isStampedMachineComment(`ok\n\\${MACHINE_MARKER}\\ posted by a loop`), true);
});

test('a card that OPENS with a machine tag still gets its own stamp', () => {
  // The door used to skip these: they already "looked machine" to the wide
  // reader, so nothing was appended, and the strict reader would then have
  // called the card Dane's word. Break-test — put `isMachineComment` back in
  // `stampMachineComment` and this fails.
  const card = '[CC-starcaster bus-relay] MERGED: PR #618 is in main';
  const stamped = stampMachineComment(card);
  assert.equal(isStampedMachineComment(stamped), true, 'the stamp is written');
  assert.ok(stamped.startsWith(card), 'the original text is untouched');
  // Still idempotent on the stamp itself.
  assert.equal(stampMachineComment(stamped), stamped, 'a retry cannot leave two');
});
