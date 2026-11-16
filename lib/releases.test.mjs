import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isReleaseName, newestReleaseReader, nextRelease, OWN_PROJECT_RELEASE, parseReleaseTags, readReleaseTags, releaseName, releaseNumber, releaseRemote, rollBackTarget,
} from './releases.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

test('a release is named release-<n>, n a whole number from 1 (SP-265)', () => {
  assert.equal(releaseNumber('release-1'), 1);
  assert.equal(releaseNumber('release-42'), 42);
  for (const bad of ['release-0', 'release-01', 'release-', 'Release-1', 'release-1 ', 'v1', null, undefined, 7]) {
    assert.equal(releaseNumber(bad), null, String(bad));
    assert.equal(isReleaseName(bad), false);
  }
  assert.equal(releaseName(3), 'release-3');
  assert.throws(() => releaseName(0));
  assert.equal(OWN_PROJECT_RELEASE, 'main (always the newest)');
});

test('parseReleaseTags keeps only release tags, newest first, an annotated tag by the commit it points at (SP-265)', () => {
  const out = [
    `${A}\trefs/tags/release-1`,
    `${B}\trefs/tags/release-10`,
    `${C}\trefs/tags/release-2`,
    `${A}\trefs/tags/release-2^{}`,
    `${B}\trefs/tags/v1.0`,
    `${C}\trefs/tags/release-02`,
    '',
  ].join('\n');
  assert.deepEqual(parseReleaseTags(out), [
    { name: 'release-10', number: 10, commit: B },
    { name: 'release-2', number: 2, commit: A },
    { name: 'release-1', number: 1, commit: A },
  ]);
  assert.deepEqual(parseReleaseTags(''), []);
});

test('nextRelease counts up from the newest, and refuses when main has not moved since it (SP-265)', () => {
  assert.deepEqual(nextRelease([], A), { cut: true, name: 'release-1', after: null });
  const tags = parseReleaseTags(`${A}\trefs/tags/release-1\n${B}\trefs/tags/release-2`);
  assert.deepEqual(nextRelease(tags, C), { cut: true, name: 'release-3', after: 'release-2' });
  const same = nextRelease(tags, B);
  assert.equal(same.cut, false);
  assert.match(same.why, /main has not moved since release-2/);
});

test('rollBackTarget walks back to the newest earlier release numbered lower, or none (SP-265)', () => {
  const h = (...names) => names.map((release) => ({ release }));
  assert.equal(rollBackTarget([]), null);
  assert.equal(rollBackTarget(h('release-1')), null);
  assert.equal(rollBackTarget(h('release-3', 'release-2', 'release-1')), 'release-2');
  assert.equal(rollBackTarget(h('release-2', 'release-3', 'release-2', 'release-1')), 'release-1', 'never back up to the one just rolled away from');
  assert.equal(rollBackTarget(h('release-3', 'release-5', 'release-1')), 'release-1');
  assert.equal(rollBackTarget(h('release-1', 'release-4')), null);
});

test('readReleaseTags asks the remote, and says why when it cannot (SP-265)', () => {
  const calls = [];
  const ok = readReleaseTags({ remote: 'origin', git: (args) => { calls.push(args); return { status: 0, stdout: `${A}\trefs/tags/release-1\n`, stderr: '' }; } });
  assert.deepEqual(calls, [['ls-remote', '--tags', 'origin', 'refs/tags/release-*']]);
  assert.deepEqual(ok, { tags: [{ name: 'release-1', number: 1, commit: A }] });
  const bad = readReleaseTags({ remote: 'origin', git: () => ({ status: 128, stdout: '', stderr: 'fatal: could not read from remote repository\n' }) });
  assert.match(bad.problem, /git ls-remote --tags origin failed: fatal: could not read/);
  assert.equal(releaseRemote({}), 'origin');
  assert.equal(releaseRemote({ SPIRALITY_RELEASE_REMOTE: '/tmp/x.git' }), '/tmp/x.git');
});

test('newestReleaseReader answers the newest tag on the remote, keeps it a while, reads fresh when asked, and says why a read failed (SP-275)', async () => {
  let t = 0;
  const calls = [];
  let answer = { stdout: `${A}\trefs/tags/release-1\n${B}\trefs/tags/release-2\n` };
  const run = async (cmd, args, opts) => {
    calls.push([cmd, args, opts.cwd]);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const read = newestReleaseReader({ run, cwd: '/repo', remote: 'origin', ttlMs: 1000, failTtlMs: 100, now: () => t });
  assert.deepEqual(await read(), { newest: { name: 'release-2', number: 2, commit: B }, problem: null });
  assert.deepEqual(calls, [['git', ['ls-remote', '--tags', 'origin', 'refs/tags/release-*'], '/repo']]);
  answer = { stdout: `${A}\trefs/tags/release-3\n` };
  assert.equal((await read()).newest.name, 'release-2', 'kept inside the time');
  assert.equal((await read({ fresh: true })).newest.name, 'release-3', 'fresh skips the kept answer');
  assert.equal(calls.length, 2);
  answer = { stdout: '' };
  t = 2000;
  assert.deepEqual(await read(), { newest: null, problem: null }, 'no release cut yet');
  answer = Object.assign(new Error('Command failed'), { stderr: 'fatal: unable to access\n' });
  t = 4000;
  const bad = await read();
  assert.equal(bad.newest, null);
  assert.match(bad.problem, /git ls-remote --tags origin failed: fatal: unable to access/);
  answer = { stdout: `${A}\trefs/tags/release-4\n` };
  t = 4050;
  assert.ok((await read()).problem, 'a failure is kept a short while');
  t = 4200;
  assert.equal((await read()).newest.name, 'release-4', 'and then read again');
});
