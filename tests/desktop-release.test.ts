import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
// @ts-ignore Shared plain JS release code.
import { compareVersions, parseVersion, installerNames, validateRelease, validateAssets } from '../desktop/release-utils.mjs';

test('release validation rejects mismatched versions and incomplete or mixed installer sets', () => {
  assert.throws(() => validateRelease({ version: '1.2.0-preview.1', notes: ['New feature'] }, '1.1.0'), /match/);
  assert.throws(() => validateRelease({ version: '1.2.0', notes: [] }, '1.2.0'), /release note/);
  const names = installerNames('1.2.0-preview.1');
  assert.equal(validateAssets(names, '1.2.0-preview.1').length, 5);
  assert.throws(() => validateAssets(names.slice(1), '1.2.0-preview.1'), /five installers/);
  assert.throws(() => validateAssets([...names, 'Remix-Studio-1.1.0-win-x64.exe'], '1.2.0-preview.1'), /five installers/);
  assert.equal(validateRelease({ version: '1.2.0-preview.1', notes: ['Batch import'] }, '1.2.0-preview.1').prerelease, true);
});

test('version ordering is numeric and rejects ambiguous or unsafe release tags', () => {
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1);
  assert.equal(compareVersions('1.2.0-preview.10', '1.2.0-preview.2'), 1);
  assert.equal(compareVersions('1.2.0', '1.2.0-preview.10'), 1);
  for (const value of ['v1.2.0', '../1.2.0', '01.2.0', '1.2.0-preview.0', '1.2.0\n', '1.2.0-beta.1']) assert.equal(parseVersion(value), null);
});

test('preparing a feature release updates both package versions and the trigger together; invalid requests leave them untouched', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'remix-release-test-'));
  const script = path.resolve('scripts/prepare-desktop-release.mjs');
  try {
    await mkdir(path.join(directory, 'desktop'));
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'test', version: '1.1.0' }));
    await writeFile(path.join(directory, 'package-lock.json'), JSON.stringify({ version: '1.1.0', packages: { '': { version: '1.1.0' }, dependency: { version: '5.0.0' } } }));
    await promisify(execFile)(process.execPath, [script, '1.2.0-preview.1', 'Adds update notifications.'], { cwd: directory });
    const pkg = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
    const lock = JSON.parse(await readFile(path.join(directory, 'package-lock.json'), 'utf8'));
    const marker = await readFile(path.join(directory, 'desktop/release.json'), 'utf8');
    assert.equal(pkg.version, '1.2.0-preview.1'); assert.equal(lock.version, pkg.version); assert.equal(lock.packages[''].version, pkg.version);
    assert.equal(lock.packages.dependency.version, '5.0.0');
    assert.equal(JSON.parse(marker).notes[0], 'Adds update notifications.');
    await assert.rejects(promisify(execFile)(process.execPath, [script, '1.1.0', 'Older release'], { cwd: directory }));
    await assert.rejects(promisify(execFile)(process.execPath, [script, '1.3.0-preview.1'], { cwd: directory }));
    assert.equal(await readFile(path.join(directory, 'desktop/release.json'), 'utf8'), marker);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
