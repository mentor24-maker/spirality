/**
 * The three SP-268 watchdog scripts and their two shell hooks, run for real
 * against fakes: a fake `npm` on a `PATH` holding nothing else stands in for
 * the door (so nothing reaches the tracker, Doppler or the bus), a scratch git
 * repository with its own bare origin stands in for the checkout, and
 * SPIRALITY_PROJECT names a temporary copy of this project's config whose
 * `logDir` is a temporary folder (so no real stamp is read or written).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE_DIR = path.dirname(process.execPath);
const GIT = spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();

const FAKE_NPM = `#!/bin/sh
case "$*" in
  *" tickets "*)
    if [ -z "$STUB_TASKS" ]; then echo "tickets FAILED: stubbed outage" >&2; exit 1; fi
    /bin/cat "$STUB_TASKS" ;;
  *" bus-post "*)
    if [ -n "$FAKE_POST_FAILS" ]; then echo "bus-post: the tracker is down (stub)" >&2; exit 1; fi
    # The message comes on stdin (--body-file -) or in the file it names.
    body=-; prev=; for a in "$@"; do [ "$prev" = "--body-file" ] && body="$a"; prev="$a"; done
    echo "--- POST ---" >> "$STUB_POSTS"
    if [ "$body" = "-" ]; then /bin/cat >> "$STUB_POSTS"; else /bin/cat "$body" >> "$STUB_POSTS"; fi
    echo >> "$STUB_POSTS" ;;
  *) echo "fake npm: not expected: $*" >&2; exit 9 ;;
esac
`;

function bench() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp268-'));
  const project = path.join(dir, 'project');
  const logs = path.join(dir, 'logs');
  const bin = path.join(dir, 'bin');
  const postsFile = path.join(dir, 'posts.txt');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  const config = JSON.parse(fs.readFileSync(path.join(REPO, 'spirality.project.json'), 'utf8'));
  config.logDir = logs;
  fs.writeFileSync(path.join(project, 'spirality.project.json'), JSON.stringify(config, null, 2));
  fs.writeFileSync(path.join(bin, 'npm'), FAKE_NPM, { mode: 0o755 });
  fs.writeFileSync(postsFile, '');
  const stamps = path.join(logs, `${config.projectSlug}-watchdogs`);
  return {
    dir, logs, stamps, slug: config.projectSlug,
    posts: () => fs.readFileSync(postsFile, 'utf8'),
    postCount: () => fs.readFileSync(postsFile, 'utf8').split('--- POST ---').length - 1,
    env: (extra = {}) => ({
      ...process.env,
      // The fake npm, node and git, nothing else: no gh, no doppler, no network.
      PATH: [bin, NODE_DIR, path.dirname(GIT), '/usr/bin', '/bin'].join(':'),
      SPIRALITY_PROJECT: project,
      STUB_POSTS: postsFile,
      STUB_TASKS: '',
      ...extra,
    }),
    run(script, args, { cwd = REPO, env = {} } = {}) {
      const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', script), ...args], {
        cwd, encoding: 'utf8', timeout: 60000, env: this.env(env),
      });
      assert.equal(r.error, undefined, String(r.error));
      return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, stdout: r.stdout || '' };
    },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

const ticket = (id, status, createdAgoMs, sinceAgoMs) => {
  const now = Date.now();
  return {
    id, name: `ticket ${id}`, status,
    created: new Date(now - createdAgoMs).toISOString(),
    updated: new Date(now - sinceAgoMs).toISOString(),
    statusSince: new Date(now - sinceAgoMs).toISOString(),
  };
};
const HOUR = 3600000;
const DAY = 24 * HOUR;

// --- throughput ------------------------------------------------------------------

test('npm run throughput prints the queue counts and what moved, and posts nothing', () => {
  const b = bench();
  try {
    const tasks = path.join(b.dir, 'tasks.json');
    fs.writeFileSync(tasks, JSON.stringify([
      ticket('SP-1', 'live', 3 * DAY, 2 * HOUR),
      ticket('SP-2', 'queued', 3 * DAY, 3 * DAY),
      ticket('SP-3', 'rework', 3 * DAY, 3 * DAY),
      ticket('SP-4', 'in review', 2 * DAY, HOUR),
    ]));
    const r = b.run('loop_throughput.mjs', [], { env: { STUB_TASKS: tasks } });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /MOVING/);
    assert.match(r.out, /1 ticket\(s\) reached Live in the last 24h/);
    assert.match(r.out, /2 queued, 1 in flight, 3 a loop can move\./);
    assert.match(r.out, /0 waiting on Dane, 0 requested \(no loop moves these\)\./);
    assert.match(r.out, /Rework pull requests could NOT be read/, 'no gh here: said, not shown as none');
    assert.equal(b.postCount(), 0, 'without --check nothing is posted');
    assert.equal(fs.existsSync(b.stamps), false, 'and nothing is written');
  } finally { b.cleanup(); }
});

test('an empty queue is IDLE, not an unreadable one; a config it cannot read exits 4, not a verdict', () => {
  // SP-268, review round 1: a new project's empty queue used to read as
  // UNKNOWN "no tickets came back" and post every 6 hours.
  const b = bench();
  try {
    const tasks = path.join(b.dir, 'tasks.json');
    fs.writeFileSync(tasks, '[]');
    const empty = b.run('loop_throughput.mjs', ['--check', '--force'], { env: { STUB_TASKS: tasks } });
    assert.equal(empty.status, 0, empty.out);
    assert.match(empty.out, /IDLE/);
    assert.doesNotMatch(empty.out, /UNKNOWN/);
    assert.equal(b.postCount(), 0, 'nothing posted for a healthy, empty queue');

    // 2 is UNKNOWN, which the relay treats as a reading said on the bus. A
    // watchdog that could not start must exit outside 0-2 so it is named.
    const broken = b.run('loop_throughput.mjs', [], { env: { STUB_TASKS: tasks, SPIRALITY_PROJECT: path.join(b.dir, 'no-such-project') } });
    assert.equal(broken.status, 4, broken.out);
    assert.match(broken.out, /the project config could not be read/);
  } finally { b.cleanup(); }
});

test('a stalled queue under --check is one ALARM, then quiet inside the window; a failed post exits 3', () => {
  const b = bench();
  try {
    const tasks = path.join(b.dir, 'tasks.json');
    fs.writeFileSync(tasks, JSON.stringify([
      ticket('SP-1', 'live', 9 * DAY, 3 * DAY),
      ticket('SP-2', 'queued', 9 * DAY, 3 * DAY),
    ]));
    const failed = b.run('loop_throughput.mjs', ['--check', '--force'], { env: { STUB_TASKS: tasks, FAKE_POST_FAILS: '1' } });
    assert.equal(failed.status, 3, 'the post did not land: said, and a distinct exit');
    assert.match(failed.out, /Could NOT post to the bus \(bus-post exited 1: bus-post: the tracker is down \(stub\)\)/);
    assert.equal(b.postCount(), 0);

    const first = b.run('loop_throughput.mjs', ['--check', '--force'], { env: { STUB_TASKS: tasks } });
    assert.equal(first.status, 1, 'STALLED');
    assert.equal(b.postCount(), 1);
    assert.match(b.posts(), /ALARM: 🐌 \*\*The queue is not getting shorter\.\*\*/);
    const second = b.run('loop_throughput.mjs', ['--check', '--force'], { env: { STUB_TASKS: tasks } });
    assert.equal(second.status, 1);
    assert.equal(b.postCount(), 1, 'not again within 6 hours');
    assert.match(second.out, /Already reported within the last 6h/);
  } finally { b.cleanup(); }
});

test('--no-post (a project with no bus, SP-386) posts nothing and still reads only once an hour', () => {
  // Review round 1 on SP-386: the relay ran a bus-less project's check as a
  // --dry-run, which skips the hourly read stamp, so every ten-minute wake
  // read the whole queue and GitHub again.
  const b = bench();
  try {
    const tasks = path.join(b.dir, 'tasks.json');
    fs.writeFileSync(tasks, JSON.stringify([
      ticket('SP-1', 'live', 9 * DAY, 3 * DAY),
      ticket('SP-2', 'queued', 9 * DAY, 3 * DAY),
    ]));
    // FAKE_POST_FAILS: a post attempted here would exit 3, so exit 1 proves none was.
    const first = b.run('loop_throughput.mjs', ['--check', '--no-post'], { env: { STUB_TASKS: tasks, FAKE_POST_FAILS: '1' } });
    assert.equal(first.status, 1, `STALLED is still the verdict: ${first.out}`);
    assert.match(first.out, /--no-post — this project has no bus, so this was not sent anywhere:/);
    assert.match(first.out, /The queue is not getting shorter/);
    assert.equal(b.postCount(), 0, 'nothing posted');
    assert.equal(fs.existsSync(path.join(b.stamps, 'throughput-read.stamp')), true, 'the hourly read stamp is written');
    assert.equal(fs.existsSync(path.join(b.stamps, 'stalled-loop-queue.stamp')), false, 'no post stamp is written');

    const second = b.run('loop_throughput.mjs', ['--check', '--no-post'], { env: { STUB_TASKS: tasks } });
    assert.equal(second.status, 0, second.out);
    assert.match(second.out, /Read within the last hour — not asking the tracker or GitHub again\./);
    assert.doesNotMatch(second.out, /STALLED/, 'the second pass did not read');
    assert.equal(b.postCount(), 0);
  } finally { b.cleanup(); }
});

// --- the failed-pass report ------------------------------------------------------

test('a failed pass is one bus line naming the lane and its exit; a failed post exits 1', () => {
  const b = bench();
  try {
    const log = path.join(b.dir, 'lane.log');
    fs.writeFileSync(log, 'line one\nFailed to authenticate. API Error: 403\n===== END /loop-build (exit 1) =====\n');

    const down = b.run('report_job_failure.mjs', ['--job', 'loop-build', '--status', '1', '--log', log], { env: { FAKE_POST_FAILS: '1' } });
    assert.equal(down.status, 1);
    assert.match(down.out, /could NOT post loop-build's failure to the bus/);
    assert.equal(fs.existsSync(path.join(b.stamps, 'failed-loop-build.stamp')), false, 'not stamped, so the next failure tries again');

    const r = b.run('report_job_failure.mjs', ['--job', 'loop-build', '--status', '1', '--log', log]);
    assert.equal(r.status, 0, r.out);
    assert.equal(b.postCount(), 1);
    assert.match(b.posts(), /^ALARM: 🚨 \*\*loop-build FAILED on .+\*\*, exit status 1 at .+ MT\./m);
    assert.match(b.posts(), /Failed to authenticate\. API Error: 403/);
    assert.ok(fs.existsSync(path.join(b.stamps, 'failed-loop-build.stamp')));

    const again = b.run('report_job_failure.mjs', ['--job', 'loop-build', '--status', '1', '--log', log]);
    assert.equal(again.status, 0);
    assert.equal(b.postCount(), 1, 'once per lane per 6 hours');
    const other = b.run('report_job_failure.mjs', ['--job', 'loop-review', '--status', '124', '--log', log]);
    assert.equal(other.status, 0);
    assert.equal(b.postCount(), 2, 'another lane has its own window');

    assert.equal(b.run('report_job_failure.mjs', ['--status', '1']).status, 2, 'no --job: refused, nothing posted');
    assert.equal(b.postCount(), 2);
  } finally { b.cleanup(); }
});

// --- checkout currency, against a scratch checkout --------------------------------

function git(cwd, ...args) {
  const r = spawnSync(GIT, args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function scratchCheckout(dir) {
  const origin = path.join(dir, 'origin.git');
  const work = path.join(dir, 'work');
  const other = path.join(dir, 'other');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  git(dir, 'clone', '-q', origin, work);
  git(work, 'checkout', '-q', '-b', 'main');
  fs.writeFileSync(path.join(work, 'README'), 'hello\n');
  git(work, 'add', 'README');
  git(work, 'commit', '-q', '-m', 'first');
  git(work, 'push', '-q', 'origin', 'main');
  git(dir, 'clone', '-q', origin, other);
  return { origin, work, other };
}

test('checkout:current reads current, behind with the blocking files, and behind, pulled; it never pulls', () => {
  const b = bench();
  try {
    const { work, other } = scratchCheckout(b.dir);
    const current = b.run('checkout_currency.mjs', [], { cwd: work });
    assert.equal(current.status, 0, current.out);
    assert.match(current.stdout, /^current\n/);

    // Main gains a file that sits here untracked: the 2026-09-01 incident.
    fs.mkdirSync(path.join(other, 'docs'));
    fs.writeFileSync(path.join(other, 'docs', 'report.json'), '{}\n');
    git(other, 'add', 'docs/report.json');
    git(other, 'commit', '-q', '-m', 'track the report');
    git(other, 'push', '-q', 'origin', 'main');
    fs.mkdirSync(path.join(work, 'docs'));
    fs.writeFileSync(path.join(work, 'docs', 'report.json'), '{"local":true}\n');

    const before = git(work, 'rev-parse', 'HEAD');
    // It never fetches (SP-268, review round 1): until the relay's pull
    // fetches, it reads origin/main as the last fetch left it.
    const unfetched = b.run('checkout_currency.mjs', ['--dry-run'], { cwd: work });
    assert.match(unfetched.stdout, /^current\n/, 'no fetch of its own: the new commit is not seen yet');
    git(work, 'fetch', '-q', 'origin', 'main'); // the relay's pull, fetching
    const blocked = b.run('checkout_currency.mjs', ['--check'], { cwd: work });
    assert.equal(blocked.status, 0, blocked.out);
    assert.match(blocked.stdout, /^behind, could not pull: 1 untracked file\(s\) would be overwritten by the update: docs\/report\.json\n/);
    assert.equal(git(work, 'rev-parse', 'HEAD'), before, 'it never pulls');
    assert.equal(b.postCount(), 1);
    assert.match(b.posts(), /^ALARM: STALE CHECKOUT on /m);
    assert.match(b.posts(), /docs\/report\.json/);

    // The relay's pull, once the file is moved, then the reading after it.
    fs.rmSync(path.join(work, 'docs', 'report.json'));
    git(work, 'pull', '-q', '--ff-only', 'origin', 'main');
    const pulled = b.run('checkout_currency.mjs', ['--check', '--before', before], { cwd: work });
    assert.equal(pulled.status, 0, pulled.out);
    assert.match(pulled.stdout, /^behind, pulled\n/);
    assert.equal(b.postCount(), 1, 'level again: nothing more posted');
    assert.equal(fs.existsSync(path.join(b.stamps, 'stale-checkout.stamp')), false, 'and the reminder is cleared');
  } finally { b.cleanup(); }
});

test('checkout:current names git\'s own reason from a refused pull, and a failed alarm post exits 1', () => {
  const b = bench();
  try {
    const { work, other } = scratchCheckout(b.dir);
    fs.writeFileSync(path.join(other, 'NEW'), 'x\n');
    git(other, 'add', 'NEW');
    git(other, 'commit', '-q', '-m', 'new');
    git(other, 'push', '-q', 'origin', 'main');
    git(work, 'fetch', '-q', 'origin', 'main'); // the relay's pull, fetching
    const said = path.join(b.dir, 'pull.txt');
    fs.writeFileSync(said, 'fatal: Not possible to fast-forward, aborting.\n');
    const r = b.run('checkout_currency.mjs', ['--check', '--pull-output', said], { cwd: work, env: { FAKE_POST_FAILS: '1' } });
    assert.equal(r.status, 1, r.out);
    assert.match(r.stdout, /^behind, could not pull: the fast-forward failed: fatal: Not possible to fast-forward, aborting\.\n/);
    assert.match(r.out, /Could NOT post to the bus/);

    const waiting = b.run('checkout_currency.mjs', ['--check'], { cwd: work });
    assert.equal(waiting.status, 0);
    assert.match(waiting.stdout, /^behind, not pulled yet: /, 'nothing blocks it and no pull was refused: no alarm');
    assert.equal(b.postCount(), 0);
  } finally { b.cleanup(); }
});

// --- the two shell hooks -------------------------------------------------------------

function fakeRepo(dir, scripts) {
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'scripts', 'run_with_time_limit.sh'), path.join(repo, 'scripts', 'run_with_time_limit.sh'));
  fs.chmodSync(path.join(repo, 'scripts', 'run_with_time_limit.sh'), 0o755);
  for (const [name, code] of Object.entries(scripts)) {
    fs.writeFileSync(path.join(repo, 'scripts', name),
      `import fs from 'node:fs';\nfs.appendFileSync(process.env.CALLS, ${JSON.stringify(name)} + ' ' + process.argv.slice(2).join(' ') + '\\n');\nprocess.exit(Number(process.env[${JSON.stringify(`EXIT_${name.replace(/\W/g, '_')}`)}] || ${code}));\n`);
  }
  return repo;
}

function bash(script, env) {
  return spawnSync('/bin/bash', ['-c', script], { encoding: 'utf8', timeout: 60000, env: { ...process.env, ...env } });
}

test('the lane runner\'s hook reports a failed pass, clears the reminder on a good one, and never fails', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp268-lane-'));
  try {
    const repo = fakeRepo(dir, { 'report_job_failure.mjs': 0 });
    const calls = path.join(dir, 'calls.txt');
    const stamp = path.join(dir, 'failed-loop-build.stamp');
    const hook = path.join(REPO, 'scripts', 'lib', 'lane_failure.sh');
    const run = (code, extra = {}) => bash(`source "${hook}"; report_lane_pass "${repo}" "${stamp}" loop-build ${code} /logs/lane.log; echo "returned $?"`, { CALLS: calls, ...extra });

    fs.writeFileSync(stamp, 'then\n');
    const good = run(0);
    assert.match(good.stdout, /returned 0/);
    assert.equal(fs.existsSync(stamp), false, 'a good pass clears the reminder');
    assert.equal(fs.existsSync(calls), false, 'and reports nothing');

    const bad = run(1);
    assert.match(bad.stdout, /returned 0/);
    assert.equal(fs.readFileSync(calls, 'utf8'), 'report_job_failure.mjs --job loop-build --status 1 --log /logs/lane.log\n');

    const downed = run(124, { EXIT_report_job_failure_mjs: '1' });
    assert.match(downed.stdout, /the failed-pass report for \/loop-build did NOT reach the bus \(exit 1/);
    assert.match(downed.stdout, /returned 0/, 'a report that did not land never fails the runner');

    fs.rmSync(path.join(repo, 'scripts', 'report_job_failure.mjs'));
    const missing = run(1);
    assert.match(missing.stdout, /no failed-pass report in this checkout/);
    assert.match(missing.stdout, /returned 0/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the lane runner\'s sign-in hook posts one ALARM a day from a week before the end, and never fails (SP-388)', () => {
  const b = bench();
  try {
    const repo = fakeRepo(b.dir, {});
    const hook = path.join(REPO, 'scripts', 'lib', 'signin_warning.sh');
    const stamp = path.join(b.stamps, 'claude-signin-warning.stamp');
    const out = path.join(b.dir, 'pass.txt');
    const warning = (from, to) => `Some pass output\nWarning: this sign-in ends between ${from} and ${to} (in N days at the earliest). Renewing it does not move those dates. Run claude auth login before then, or use claude setup-token for unattended jobs.\nREPORT: done\n`;
    const run = (today, extra = {}) => bash(`source "${hook}"; report_signin_warning "${repo}" "${stamp}" "${out}"; echo "returned $?"`, b.env({ SIGNIN_WARNING_TODAY: today, ...extra }));

    fs.writeFileSync(out, warning('2026-11-22', '2026-11-25'));
    const first = run('2026-11-17');
    assert.match(first.stdout, /returned 0/);
    assert.equal(b.postCount(), 1, 'five days out: one alarm');
    assert.match(b.posts(), /^ALARM: the Claude sign-in the lanes on .+ use ends as early as 2026-11-22 \(in 5 days\), and every loop there stops with it\. Make a long-lived one on that machine: claude setup-token, then bash scripts\/claude_token_to_doppler\.sh\.$/m);
    assert.equal(fs.readFileSync(stamp, 'utf8').trim(), '2026-11-17');

    const again = run('2026-11-17');
    assert.match(again.stdout, /returned 0/);
    assert.equal(b.postCount(), 1, 'a second pass the same day posts nothing');

    run('2026-11-18');
    assert.equal(b.postCount(), 2, 'the next day says it again');
    assert.match(b.posts(), /ends as early as 2026-11-22 \(in 4 days\)/);

    fs.writeFileSync(out, warning('2026-11-28', '2026-12-01'));
    run('2026-11-18');
    assert.equal(b.postCount(), 2, 'ten days out: nothing');

    fs.writeFileSync(out, 'A pass with no warning at all\n');
    run('2026-11-30');
    assert.equal(b.postCount(), 2, 'no warning line: nothing');

    fs.writeFileSync(out, warning('2026-11-22', '2026-11-25'));
    const downed = run('2026-11-19', { FAKE_POST_FAILS: '1' });
    assert.match(downed.stdout, /the alarm that Claude's sign-in ends as early as 2026-11-22 \(in 3 days\) did NOT reach the bus \(exit 1/);
    assert.match(downed.stdout, /returned 0/, 'a post that did not land never fails the runner');
    assert.equal(b.postCount(), 2);
    assert.equal(fs.readFileSync(stamp, 'utf8').trim(), '2026-11-18', 'a post that did not land leaves no stamp');
    run('2026-11-19');
    assert.equal(b.postCount(), 3, 'so the next pass tries again');
    assert.match(b.posts(), /\(in 3 days\)/);

    const gone = run('2026-11-21');
    assert.match(gone.stdout, /returned 0/);
    assert.match(b.posts(), /2026-11-22 \(tomorrow\)/);

    fs.rmSync(out);
    assert.match(run('2026-11-22').stdout, /returned 0/, 'no pass output: nothing, and no failure');
    assert.equal(b.postCount(), 4);
  } finally { fs.rmSync(b.dir, { recursive: true, force: true }); }
});

test('the relay\'s hook runs both watchdogs, passes the pull\'s readings, and never fails the relay', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp268-relay-'));
  try {
    const repo = fakeRepo(dir, { 'loop_throughput.mjs': 1, 'checkout_currency.mjs': 0 });
    const calls = path.join(dir, 'calls.txt');
    const said = path.join(dir, 'pull.txt');
    const hook = path.join(REPO, 'scripts', 'lib', 'relay_queue_watchdogs.sh');
    const run = (extra = {}, dry = '') => bash(`source "${hook}"; run_relay_queue_watchdogs "${repo}" 30 abc123 "${said}" ${dry}; echo "returned $?"`, { CALLS: calls, ...extra });

    fs.writeFileSync(said, '');
    const stalled = run();
    assert.match(stalled.stdout, /returned 0/);
    assert.doesNotMatch(stalled.stdout, /FAILED/, 'a STALLED verdict (exit 1) is a reading, not a failure');
    assert.equal(fs.readFileSync(calls, 'utf8'),
      'loop_throughput.mjs --check\ncheckout_currency.mjs --check --before abc123\n',
      'an empty pull output is not passed on');

    fs.writeFileSync(calls, '');
    fs.writeFileSync(said, 'error: cannot fast-forward\n');
    const broken = run({ EXIT_loop_throughput_mjs: '7', EXIT_checkout_currency_mjs: '1' }, '--dry-run');
    assert.match(broken.stdout, /the throughput check FAILED \(exit 7/);
    assert.match(broken.stdout, /the checkout-currency check FAILED \(exit 1/);
    assert.match(broken.stdout, /returned 0/, 'whatever they do, the relay carries on');
    assert.equal(fs.readFileSync(calls, 'utf8'),
      `loop_throughput.mjs --check --dry-run\ncheckout_currency.mjs --check --before abc123 --pull-output ${said} --dry-run\n`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the runners source the hooks only when present and never let them change an exit', () => {
  const runner = fs.readFileSync(path.join(REPO, 'scripts', 'loop_runner.sh'), 'utf8');
  assert.match(runner, /\[ -f "\$REPO\/scripts\/lib\/lane_failure\.sh" \] && source "\$REPO\/scripts\/lib\/lane_failure\.sh"/);
  assert.match(runner, /report_lane_pass "\$RUN_DIR" "\$FAILURE_STAMP" "\$SKILL" "\$CODE" "\$LOG" >> "\$LOG" 2>&1 \|\| true/);
  assert.match(runner, /\[ -f "\$REPO\/scripts\/lib\/signin_warning\.sh" \] && source "\$REPO\/scripts\/lib\/signin_warning\.sh"/);
  assert.match(runner, /report_signin_warning "\$RUN_DIR" "\$SIGNIN_WARNING_STAMP" "\$PASS_OUT" >> "\$LOG" 2>&1 \|\| true/);
  // After the pass's output is written and before the next pass overwrites it.
  assert.ok(runner.indexOf('tee "$PASS_OUT"') < runner.indexOf('report_signin_warning "$RUN_DIR"'));
  const relay = fs.readFileSync(path.join(REPO, 'scripts', 'run_relay.sh'), 'utf8');
  assert.match(relay, /\[ -f "\$REPO\/scripts\/lib\/relay_queue_watchdogs\.sh" \] && source/);
  assert.match(relay, /if declare -F run_relay_queue_watchdogs >\/dev\/null; then/);
  // The watchdogs run before the END line, and the exit is still the relay's own verdict.
  assert.ok(relay.indexOf('run_relay_queue_watchdogs "$RUN_DIR"') < relay.lastIndexOf('END relay'));
  assert.match(relay, /exit "\$\(relay_pass_exit "\$status" "\$checks_status"\)"/);
});
