import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-ignore Plain JS also runs inside Electron's main process.
import { findUpdate, createUpdateChecker } from '../desktop/updates.mjs';
// @ts-ignore Shared with release automation.
import { installerNames, RELEASES_URL } from '../desktop/release-utils.mjs';

const release = (version: string, overrides = {}) => ({ tag_name: `v${version}`, draft: false,
  published_at: '2026-10-10T12:00:00Z', prerelease: version.includes('-preview.'), html_url: `${RELEASES_URL}/tag/v${version}`,
  assets: [...installerNames(version), 'SHA256SUMS.txt'].map(name => ({ name, state: 'uploaded', size: 100 })), ...overrides });

test('desktop updates select the highest version, respect preview channels and never downgrade', () => {
  const releases = [release('1.2.0-preview.2'), release('1.1.1'), release('1.2.0-preview.10'), release('1.1.0')];
  assert.equal(findUpdate(releases, '1.1.0-preview.1', 'darwin', 'arm64').version, '1.2.0-preview.10');
  assert.equal(findUpdate(releases, '1.1.0', 'win32', 'x64').version, '1.1.1');
  assert.equal(findUpdate(releases, '1.2.0', 'linux', 'x64'), null);
  assert.equal(findUpdate([release('1.2.0')], '1.2.0-preview.10', 'linux', 'x64').version, '1.2.0');
});

test('desktop updates ignore drafts, partial uploads, unrelated URLs and unsupported architectures', () => {
  const incomplete = release('2.0.0', { assets: [{ name: 'SHA256SUMS.txt', state: 'uploaded', size: 100 }] });
  const candidates = [incomplete, release('3.0.0', { draft: true }), release('4.0.0', { published_at: null }),
    release('5.0.0', { html_url: 'https://example.com/untrusted' }), release('6.0.0', { prerelease: true }),
    release('7.0.0', { assets: installerNames('7.0.0').map(name => ({ name, state: 'uploaded', size: 100 })) }),
    release('1.2.0')];
  assert.equal(findUpdate(candidates, '1.1.0', 'darwin', 'arm64').version, '1.2.0');
  assert.equal(findUpdate(candidates, '1.1.0', 'darwin', 'x64'), null);
  assert.equal(findUpdate(candidates, '1.1.0', 'win32', 'arm64'), null);
  assert.throws(() => findUpdate({}, '1.1.0', 'win32', 'x64'), /Invalid release/);
});

test('update checks coalesce, throttle manual retries and retain a found release during outages', async () => {
  let time = 1_000_000, calls = 0, fail = false;
  const checker = createUpdateChecker({ currentVersion: '1.1.0', platform: 'win32', arch: 'x64', now: () => time,
    fetchReleases: async () => { calls++; if (fail) throw new Error('Offline'); return [release('1.2.0')]; } });
  const first = checker.check();
  assert.equal(checker.getState().status, 'checking');
  assert.equal(checker.check(true), first);
  assert.equal((await first).status, 'available');
  await checker.check(true); assert.equal(calls, 1);
  time += 30_001; fail = true;
  const offline = await checker.check(true);
  assert.equal(offline.status, 'error'); assert.equal(offline.release.version, '1.2.0');
  assert.match(offline.error, /internet connection/);
  time += 30_001; fail = false;
  assert.equal((await checker.check(true)).status, 'available');
  await checker.check(); assert.equal(calls, 3);
  time += 6 * 60 * 60 * 1000;
  await checker.check(); assert.equal(calls, 4);
});

test('synchronous network failures do not leave the checker permanently busy', async () => {
  let time = 0, calls = 0;
  const checker = createUpdateChecker({ currentVersion: '1.1.0', now: () => time,
    fetchReleases: () => { calls++; throw new Error('Offline'); } });
  assert.equal((await checker.check()).status, 'error');
  time = 31_000; await checker.check(true); assert.equal(calls, 2);
});
