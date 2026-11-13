import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isReleaseName, nextRelease, OWN_PROJECT_RELEASE, parseReleaseTags, readReleaseTags, releaseName, releaseNumber, releaseRemote, rollBackTarget,
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
