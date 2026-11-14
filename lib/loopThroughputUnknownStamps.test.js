'use strict';

/**
 * ROUND 3'S SEND-BACK: a second road to the silence round 2 closed.
 *
 * `npm run throughput` can report two different UNKNOWNs — "I could not read
 * the Loop Queue" and "a ticket in Live has no closure date, so the zero this
 * stall rests on cannot be trusted" — and each keeps its own six-hour
 * suppression window so neither can gag the other. That was round 2's fix, and
 * it works.
 *
 * It left this: `clearUnknownStamps()` sits at the BOTTOM of
 * `scripts/loop_throughput.mjs`, below the `if (v.state === 'UNKNOWN')` block
 * that exits. So a pass that read ClickUp perfectly and then landed on the
 * `undated-closure` verdict exited without clearing the `unreadable` window —
 * while its own bus post said, in as many words, that the reading had
 * SUCCEEDED. Nine o'clock outage posts and stamps; ten o'clock reads fine and
 * posts the undated alert; eleven o'clock outage is swallowed until three.
 * The sentence being silenced is the most serious one in the file: "nothing in
 * the system is watching whether the queue is getting shorter."
 *
 * WHY THESE TESTS SPAWN THE SCRIPT. The round-3 review named the reason the
 * existing tests missed it: they assert the clearing loop EXISTS in the source,
 * and this defect is entirely about WHERE it sits. A test made of the same
 * material as the bug cannot catch the bug. So these run the real script, with
 * only the door stubbed, and then look at which stamp files are on disk
 * afterwards.
 *
 * MOVED FROM STARCASTER (scripts/builder/loopThroughputUnknownStamps.test.js,
 * commit 0682572) for SP-268. StarCaster stubbed `scripts/lib/clickup.cjs` in
 * the require cache; Spirality's script reaches the tracker through the door
 * (`npm run clickup -- tickets --json`, `bus-post`), so the stub is a fake
 * `npm` on a `PATH` holding nothing else: it prints the stub tickets (or
 * fails, for an outage) and records each post. With no `gh` on that `PATH`
 * the pull-request read takes its "not installed" branch, never the network.
 * `SPIRALITY_PROJECT` names a temporary copy of this project's config whose
 * `logDir` is a temporary folder, so no real stamp is read or written.
 *
 * BREAK TEST, MEASURED — see each test.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const SCRIPT = path.join(REPO, 'scripts', 'loop_throughput.mjs');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * The fake door. `STUB_TASKS` empty means the tickets read FAILS, which is
 * the unreadable UNKNOWN; `bus-post` appends its message to `STUB_POSTS`.
 */
const FAKE_NPM = `#!/bin/sh
case "$*" in
  *" tickets "*)
    if [ -z "$STUB_TASKS" ]; then echo "tickets FAILED: the tracker said HTTP 500 (stubbed outage)" >&2; exit 1; fi
    /bin/cat "$STUB_TASKS" ;;
  *" bus-post "*)
    echo "--- POST ---" >> "$STUB_POSTS"; /bin/cat >> "$STUB_POSTS"; echo >> "$STUB_POSTS" ;;
  *) echo "fake npm: not expected: $*" >&2; exit 9 ;;
esac
`;

/** A ticket as the door's `tickets --json` prints it: ISO times. */
function task({ id, status, created, closed = null, updated = null }) {
  return {
    id,
    name: `ticket ${id}`,
    status,
    created: new Date(created).toISOString(),
    updated: new Date(updated === null ? created : updated).toISOString(),
    // The tracker's closure time is when a finished ticket entered its
    // status; an open ticket's statusSince is not a closure. null = undated.
    statusSince: closed === null ? (status === 'live' ? null : new Date(created).toISOString()) : new Date(closed).toISOString(),
  };
}

/**
 * The fixture that produces the `undated-closure` UNKNOWN: open work, nothing
 * DATED closed in the last 24h, and one finished ticket carrying no closure
 * date that was edited inside the window.
 */
function undatedClosureTasks(now) {
  return [
    task({ id: 'q1', status: 'queued', created: now - 9 * DAY, updated: now - 2 * HOUR }),
    task({ id: 'q2', status: 'queued', created: now - 9 * DAY, updated: now - 3 * HOUR }),
    task({ id: 'SP-9', status: 'live', created: now - 9 * DAY, closed: null, updated: now - HOUR }),
  ];
}

function makeBench() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'throughput-stamps-'));
  const project = path.join(dir, 'project');
  const logs = path.join(dir, 'logs');
  const bin = path.join(dir, 'bin');
  const posts = path.join(dir, 'posts.txt');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  const config = JSON.parse(fs.readFileSync(path.join(REPO, 'spirality.project.json'), 'utf8'));
  config.logDir = logs;
  fs.writeFileSync(path.join(project, 'spirality.project.json'), JSON.stringify(config, null, 2));
  fs.writeFileSync(path.join(bin, 'npm'), FAKE_NPM, { mode: 0o755 });
  fs.writeFileSync(posts, '');
  const stamps = path.join(logs, `${config.projectSlug}-watchdogs`);
  fs.mkdirSync(stamps, { recursive: true });

  const stampFor = (kind) => path.join(stamps, `unknown-${kind}-loop-queue.stamp`);

  return {
    dir,
    stampFor,
    /** Is that suppression window currently held? */
    held: (kind) => fs.existsSync(stampFor(kind)),
    /** Hold a window as if an alarm of that kind had just fired. */
    hold(kind, at = new Date().toISOString()) {
      fs.writeFileSync(stampFor(kind), `${at}\n`);
    },
    postCount: () => fs.readFileSync(posts, 'utf8').split('--- POST ---').length - 1,
    postsText: () => fs.readFileSync(posts, 'utf8'),
    /** Run the real script. `tasks: null` means the tickets read fails. */
    run(tasks) {
      const tasksFile = path.join(dir, 'tasks.json');
      if (tasks) fs.writeFileSync(tasksFile, JSON.stringify(tasks));
      // `--force` because `--check` throttles the READ to once an hour, and
      // these scenarios are deliberately three passes in a row.
      const r = spawnSync(process.execPath, [SCRIPT, '--check', '--force'], {
        encoding: 'utf8',
        timeout: 60000,
        cwd: REPO,
        env: {
          ...process.env,
          PATH: bin, // the fake npm and nothing else: no `gh`, no network
          SPIRALITY_PROJECT: project,
          STUB_TASKS: tasks ? tasksFile : '',
          STUB_POSTS: posts,
        },
      });
      // A harness that could not RUN the script must say so rather than
      // reporting its silence as a reading.
      assert.equal(r.error, undefined,
        `the script could not be executed at all: ${r.error && r.error.message}`);
      assert.notEqual(r.status, null,
        `the script did not exit normally (signal ${r.signal}) — no verdict was taken`);
      return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
    },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * THE DEFECT ITSELF, as three passes on a clock — the shape the round-3 review
 * reproduced by hand.
 *
 * BREAK TEST, MEASURED. Moving `if (CHECK) clearUnknownStamp('unreadable');`
 * back below the `if (v.state === 'UNKNOWN')` exit — i.e. deleting it and
 * relying on `clearUnknownStamps()` where it was — fails this test, and only
 * this one (1 of 4). Adding `clearUnknownStamps()` to the unreadable branch
 * instead fails this one and the asymmetry test below it (2 of 4), because
 * that pass then wipes the very window it has just opened.
 */
test('a good reading ends the outage window, so the next outage still gets through', () => {
  const bench = makeBench();
  try {
    const now = Date.now();

    // 9am: The tracker is unreachable. The serious alarm fires and holds its window.
    const nine = bench.run(null);
    assert.equal(nine.status, 2, 'an unreadable queue is UNKNOWN');
    assert.match(bench.postsText(), /could not take a reading/,
      'and it says so on the bus');
    assert.ok(bench.held('unreadable'), 'holding its own six-hour window');

    // 10am: the tracker answers perfectly; the verdict is the OTHER unknown.
    const ten = bench.run(undatedClosureTasks(now));
    assert.equal(ten.status, 2, 'an undated closure inside the window is UNKNOWN too');
    assert.match(bench.postsText(), /cannot be read as a zero/,
      'and gets its own message, because this reading SUCCEEDED');

    // THE FINDING. That pass read the queue, so the outage is demonstrably
    // over and its window must not still be held.
    assert.equal(bench.held('unreadable'), false,
      'a pass that read the queue proves the outage ended — it must tear that window up, '
      + 'whatever verdict it then reaches');

    // 11am: the tracker is unreachable again. This is the post that used to vanish.
    const before = bench.postCount();
    const eleven = bench.run(null);
    assert.equal(eleven.status, 2);
    assert.equal(bench.postCount(), before + 1,
      'so the outage alarm gets through, instead of being swallowed for six hours');
    assert.doesNotMatch(eleven.out, /not posting again/,
      'and it is not reported as a duplicate of the nine o\'clock one');
  } finally {
    bench.cleanup();
  }
});

/**
 * THE ASYMMETRY, DIRECTION ONE. A pass that reads the queue clears the
 * `unreadable` window and MUST NOT clear the other: it has no idea whether a
 * ticket in `Live` grew a closure date. Widening the new line to both kinds
 * would re-open the undated alarm's six-hour window on every hourly pass,
 * undoing round 2's fix from the other end.
 *
 * BREAK TEST, MEASURED. Widening the read-path clear to
 * `for (const k of UNKNOWN_KINDS) clearUnknownStamp(k)` fails this test, and
 * only this one (1 of 4). It does NOT fail the test below it, because that
 * path exits before this line is ever reached — which is exactly why the two
 * directions need a test each. That was measured the hard way: this test was
 * written first, and the widening break was tried against IT and passed.
 */
test('reading the queue does not re-arm the OTHER alarm — its window still holds', () => {
  const bench = makeBench();
  try {
    const now = Date.now();

    const first = bench.run(undatedClosureTasks(now));
    assert.equal(first.status, 2);
    assert.equal(bench.postCount(), 1, 'the undated alarm fires once');
    assert.ok(bench.held('undated-closure'), 'and holds its window');

    // An hour later: the queue reads fine again, same verdict. That reading is
    // evidence the OUTAGE is over; it is no evidence at all about this alarm.
    const second = bench.run(undatedClosureTasks(now));
    assert.equal(second.status, 2);
    assert.equal(bench.postCount(), 1,
      'the same alarm must not repeat inside its own six-hour window');
    assert.match(second.out, /Already reported as unknown \(undated-closure\)/,
      'and it says why it stayed quiet');
  } finally {
    bench.cleanup();
  }
});

/**
 * THE ASYMMETRY, DIRECTION TWO. A pass that could NOT read the queue is
 * evidence of nothing at all — least of all that some ticket in `Live` has
 * grown a closure date — so it must leave the undated-closure window exactly
 * where it found it. Pinned here so it is not "tidied" into a symmetrical pair.
 *
 * BREAK TEST, MEASURED. Adding `clearUnknownStamps();` to the
 * `if (!queueRead.tasks)` branch fails this test and the first one (2 of 4).
 */
test('an unreadable pass leaves the OTHER window alone — it is evidence of nothing', () => {
  const bench = makeBench();
  try {
    bench.hold('undated-closure');

    const r = bench.run(null);
    assert.equal(r.status, 2);
    assert.ok(bench.held('undated-closure'),
      'a pass that could not read the queue must not clear a window it knows nothing about');
  } finally {
    bench.cleanup();
  }
});

/**
 * And the clean pass still clears everything, or the fix above would have
 * bought the outage alarm's recovery at the cost of the other one's.
 *
 * BREAK TEST, MEASURED. Deleting `clearUnknownStamps();` from the bottom of
 * the script fails this test (1 of 4).
 */
test('a complete, healthy pass still clears every window', () => {
  const bench = makeBench();
  try {
    const now = Date.now();
    bench.hold('unreadable');
    bench.hold('undated-closure');

    // Something closed WITH a date inside the window: MOVING, not unknown.
    const r = bench.run([
      task({ id: 'q1', status: 'queued', created: now - 9 * DAY, updated: now - 2 * HOUR }),
      task({ id: 'd1', status: 'live', created: now - 9 * DAY, closed: now - 2 * HOUR, updated: now - 2 * HOUR }),
    ]);
    assert.equal(r.status, 0, 'a dated closure inside the window is MOVING');
    assert.equal(bench.held('unreadable'), false);
    assert.equal(bench.held('undated-closure'), false,
      'a reading that is both complete and not stalled is evidence against BOTH causes');
    assert.equal(bench.postCount(), 0, 'and a healthy pass says nothing on the bus');
  } finally {
    bench.cleanup();
  }
});
