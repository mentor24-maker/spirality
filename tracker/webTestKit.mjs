/**
 * What the page's test files share (tracker/web-*.test.mjs): the demo
 * tracker fixture, the door it runs, and the page's own files. Moved out of
 * tracker/web.test.mjs, one file per page since SP-352.
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openStore } from './store.mjs';
import { seedDemo, tickingClock } from './demoData.mjs';
import { startServer } from './server.mjs';
import { withTokensResolved } from './cssTokens.mjs';

export const DOOR = fileURLToPath(new URL('../scripts/clickup.mjs', import.meta.url));
export const WEB = (name) => fileURLToPath(new URL(`./web/${name}`, import.meta.url));
/** app.css with its tokens filled in (SP-320), for a check on the colour or size the page draws. */
export const drawnCss = () => withTokensResolved(readFileSync(WEB('app.css'), 'utf8'));

/** The demo data in a fresh store, a server on a free port, and a caller signed in as the operator. */
export async function fixture({ mergePhrase, closePhrase, goPhrase, suggest } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tracker-web-'));
  const clock = tickingClock();
  const store = openStore(join(dir, 'tracker.db'), { now: clock });
  const seed = seedDemo(store, { operatorName: 'Dane', clock });
  const loopToken = store.issueToken(seed.loop.id);
  const server = await startServer({ store, port: 0, mergePhrase, closePhrase, goPhrase, suggest });
  const url = `http://127.0.0.1:${server.address().port}`;
  async function call(method, path, { token = seed.token, body } = {}) {
    const headers = token ? { authorization: `Bearer ${token}` } : {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${url}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* a page, not JSON */ }
    return { status: res.status, headers: res.headers, text, body: json };
  }
  /** Run the real door against this tracker, for one project, as the loop. */
  function door(slug, ...args) {
    const project = join(dir, slug);
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'spirality.project.json'), JSON.stringify({
      manifestVersion: 2, workspaceId: '111', spaceId: '222', loopQueueListId: '333',
      operatorUserId: seed.operator.id, machineUserId: seed.loop.id,
      githubRepo: 'owner/repo', dopplerProject: 'proj', dopplerConfig: 'dev',
      launchdPrefix: 'com.example', logDir: '~/loop-logs', mergePhrases: ['merge'],
      governancePaths: [], autoMergeLanes: [], operatorName: 'Dane', projectSlug: slug,
      legacyMachinePrefixes: [], projectScripts: {}, tracker: 'api', trackerUrl: url,
    }));
    return new Promise((resolve) => {
      const env = { PATH: process.env.PATH, HOME: process.env.HOME, TRACKER_TOKEN_HAND_RUN: loopToken };
      const child = spawn(process.execPath, [DOOR, ...args], { cwd: project, env });
      let out = '';
      let err = '';
      child.stdout.on('data', (c) => { out += c; });
      child.stderr.on('data', (c) => { err += c; });
      child.on('close', (code) => resolve({ code, out, err }));
    });
  }
  async function cleanup() {
    await new Promise((r) => server.close(r));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
  const waitingCommand = (slug) => door(slug, 'waiting');
  return { ...seed, store, url, call, door, waitingCommand, cleanup };
}

// ── His answer is in (SP-93) ─────────────────────────────────────────────────

/** Every ticket on a project's board, flattened, by id. */
export async function boardTickets(f, slug) {
  const board = (await f.call('GET', `/projects/${slug}/board`)).body;
  return new Map(board.columns.flatMap((c) => c.tickets).map((t) => [t.id, t]));
}

/** The text a `<code>` element holds, as the browser's textContent reads it. */
export const unescape = (html) => html.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]);
export const codes = (html) => [...html.matchAll(/<code>([\s\S]*?)<\/code>/g)].map((m) => unescape(m[1]));
