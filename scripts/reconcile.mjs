#!/usr/bin/env node
/**
 * `npm run reconcile` — open tickets whose pull request was merged or closed
 * straight on GitHub (SP-354). The rules and why are in lib/reconcile.js.
 *
 *   npm run reconcile                        read everything, print the report, post nothing
 *   npm run reconcile -- --check             the same, and post each finding to the bus
 *   npm run reconcile -- --check --dry-run   say what it WOULD post, send nothing
 *   npm run reconcile -- --check --force     ignore the hourly read throttle
 *
 * It changes no ticket: no status move, no comment on a ticket. The only
 * write is the bus post, read back by `bus-post`.
 *
 * Exit codes, the same as stale-ready's. Without --check, the verdict:
 *   0  nothing found
 *   1  at least one ticket's pull request is merged or closed
 *   2  CANNOT TELL: a ticket's pull request could not be checked, or the
 *      tickets could not be read
 * With --check, whether the check did its job:
 *   0  read, and every finding due was posted (or was already said)
 *   1  a bus post failed (not stamped, so the next pass tries again)
 *   2  the tickets could not be read at all, or the project has no bus
 *
 * Tickets and comments come through Spirality's door (scripts/lib/
 * watchdogDoor.mjs), pull request state through `gh` against the config's
 * `githubRepo`. The reminder stamps live in the project's log folder
 * (`<logDir>/<slug>-reconcile/`), one per ticket and finding, 6 hours each
 * (lib/watchdogPosts.js); a finding that goes away clears its stamp.
 *
 * Run by scripts/run_relay.sh on every wake (scripts/lib/relay_watchdogs.sh);
 * nothing here can fail the relay.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { hostname } from 'node:os';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadProjectConfig, namedProjectFolder } from '../lib/projectConfig.mjs';
import { laneFile } from './lib/laneFiles.mjs';
import * as door from './lib/watchdogDoor.mjs';
import { folderStamps, fileClock } from './stale_ready.mjs';

const require = createRequire(import.meta.url);
const reconcile = require('../lib/reconcile.js');
const posts = require('../lib/watchdogPosts.js');

/**
 * The tickets are read at most once an hour under --check. The relay wakes
 * every ten minutes; a pull request merged on GitHub an hour ago is no
 * emergency, and each reading costs one `gh` call per open ticket with a
 * pull request. A hand-run `npm run reconcile` is never throttled.
 */
export const READ_EVERY_MS = 60 * 60 * 1000;

function nodeName() {
  return String(hostname() || '').split('.')[0] || 'an unnamed machine';
}

/**
 * One pull request's state: { state: 'OPEN'|'MERGED'|'CLOSED', at, why: null },
 * or { state: null, why } when GitHub could not be read.
 */
export function prState(number, { repo, run = spawnSync } = {}) {
  const args = ['pr', 'view', String(number), '--json', 'state,mergedAt,closedAt'];
  if (repo) args.push('--repo', repo);
  const out = run('gh', args, { encoding: 'utf8', timeout: 60_000 });
  if (out.error) {
    const why = out.error.code === 'ENOENT' ? 'the `gh` command is not installed on this machine' : String(out.error.message);
    return { state: null, why };
  }
  if (out.status !== 0) {
    return { state: null, why: String(out.stderr || '').trim().split('\n')[0].slice(0, 160) || 'gh failed' };
  }
  try {
    const json = JSON.parse(String(out.stdout || ''));
    const state = String(json.state || '').toUpperCase() || null;
    const at = state === 'MERGED' ? json.mergedAt : state === 'CLOSED' ? json.closedAt : '';
    return { state, at: at || '', why: state ? null : 'gh gave no state' };
  } catch {
    return { state: null, why: 'gh returned output that is not JSON' };
  }
}

/**
 * One pass. Every read and write is handed in, so a test drives the whole of
 * it without a tracker, GitHub or the bus.
 *
 *   config       the project config (busProject, githubRepo, projectSlug)
 *   readTickets  () => { tasks, commentsById }, throws on a failed read
 *   prState      (number) => { state, at, why }
 *   paused       () => { paused, why }
 *   post         (text) => { ok, why }
 *   stamps       folderStamps(...)-shaped
 *   readClock    fileClock(...)-shaped
 */
export function runReconcile({
  argv = [], config, now = Date.now(), readTickets, prState: snapshot, paused, post, stamps, readClock,
  node = 'an unnamed machine', out = console.log, when = posts.mountainTime,
}) {
  const flag = (name) => argv.includes(`--${name}`);
  const CHECK = flag('check');
  const DRY = flag('dry-run');
  const FORCE = flag('force');

  if (CHECK && !config.busProject) {
    out(`reconcile --check: ${config.projectSlug || 'this project'} names no busProject in its project config, so there is nowhere to post. Nothing was read or posted.`);
    return 2;
  }

  if (CHECK && !FORCE && !posts.dueAgain({ lastAt: readClock.read(), now, everyMs: READ_EVERY_MS })) {
    out('reconcile: read within the last hour, not asking the tracker or GitHub again. '
      + '(`--force` takes a fresh reading; a hand-run `npm run reconcile` is never throttled.)');
    return 0;
  }

  let read;
  try {
    read = readTickets();
  } catch (err) {
    out(`CANNOT TELL: the tracker's tickets could not be read: ${String(err?.message || err).slice(0, 300)}`);
    out('Nothing about the tickets and their pull requests is known this pass. This is not an all-clear.');
    return 2;
  }

  // The reading happened, so the hourly clock restarts whatever was found.
  if (CHECK && !DRY) readClock.write(new Date(now).toISOString());

  const plan = reconcile.planChecks({ tasks: read.tasks, commentsById: read.commentsById, githubRepo: config.githubRepo });
  const findings = [...plan.unchecked];
  for (const { task, pr } of plan.toAsk) {
    const f = reconcile.classify({ task, pr, snap: snapshot(pr.number) });
    if (f) findings.push(f);
  }
  // In the order the tickets were read, so the report and the post read alike.
  const order = new Map(plan.checked.map((t, i) => [String(t.id), i]));
  findings.sort((a, b) => (order.get(a.taskId) ?? 0) - (order.get(b.taskId) ?? 0));

  out(reconcile.renderReport({ checked: plan.checked, findings, noPr: plan.noPr, asked: plan.toAsk.length, when }));

  if (!CHECK) return reconcile.exitCodeFor(findings);

  const all = stamps.readAll();
  const gone = reconcile.staleKeys({ stampKeys: all.keys(), findings });
  if (!DRY) stamps.clear(gone);

  if (!findings.length) return 0;

  const p = paused();
  if (p.paused) {
    out('');
    out(`Not posting: the Settings page has the relay paused, or could not be read (${p.why}). The findings above still stand.`);
    return 0;
  }

  const due = [];
  let held = 0;
  for (const f of findings) {
    if (posts.dueAgain({ lastAt: all.get(reconcile.postKey(f)) || '', now, everyMs: posts.REPOST_EVERY_MS })) due.push(f);
    else held += 1;
  }
  if (held) {
    out('');
    out(`${held} finding(s) already said on the bus within the last ${Math.round(posts.REPOST_EVERY_MS / 3600000)}h; not posting those again.`);
  }
  if (!due.length) return 0;

  const text = reconcile.renderPost({ findings: due, node, when });
  if (DRY) {
    out('');
    out('--dry-run: this is what would go to the bus, and nothing was sent:');
    out('');
    out(text);
    return 0;
  }

  const sent = post(text);
  if (!sent.ok) {
    out('');
    out(`Could NOT post to the bus (${sent.why}). Not stamping it as sent, so the next pass tries again.`);
    return 1;
  }
  for (const f of due) {
    const why = stamps.write(reconcile.postKey(f), new Date(now).toISOString());
    if (why) out(`Posted, but the reminder stamp for ${f.taskId} could not be written (${why}).`);
  }
  out('');
  out(`Posted ${due.length} finding(s) to the bus.`);
  return 0;
}

function main(argv) {
  const config = loadProjectConfig({ project: namedProjectFolder() });
  const code = runReconcile({
    argv,
    config,
    readTickets: () => door.readTickets({ trackerUrl: config.trackerUrl }),
    prState: (n) => prState(n, { repo: config.githubRepo }),
    paused: () => door.pausedNow(),
    post: (text) => door.postToBus(text),
    stamps: folderStamps(laneFile(config, 'reconcile')),
    readClock: fileClock(laneFile(config, 'reconcile-read.stamp')),
    node: nodeName(),
  });
  process.exit(code);
}

function runAsCommand() {
  try {
    return Boolean(process.argv[1]) && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (runAsCommand()) main(process.argv.slice(2));
