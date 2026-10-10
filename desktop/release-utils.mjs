export const REPOSITORY = 'best-trading-indicator-tools/video-remix';
export const RELEASES_URL = `https://github.com/${REPOSITORY}/releases`;

export function parseVersion(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-preview\.([1-9]\d*))?$/.exec(value ?? '');
  if (!match) return null;
  const parts = match.slice(1, 4).map(Number);
  const preview = match[4] ? Number(match[4]) : null;
  return [...parts, preview ?? 0].every(Number.isSafeInteger) ? { parts, preview } : null;
}

export function compareVersions(left, right) {
  const a = parseVersion(left), b = parseVersion(right);
  if (!a || !b) throw new Error('Use a version such as 1.2.0-preview.1 or 1.2.0.');
  for (let index = 0; index < 3; index++) if (a.parts[index] !== b.parts[index]) return Math.sign(a.parts[index] - b.parts[index]);
  if (a.preview === b.preview) return 0;
  if (a.preview === null) return 1;
  if (b.preview === null) return -1;
  return Math.sign(a.preview - b.preview);
}

export function installerNames(version) {
  if (!parseVersion(version)) throw new Error('Invalid desktop version.');
  return ['mac-arm64.dmg', 'mac-arm64.zip', 'win-x64.exe', 'linux-x86_64.AppImage', 'linux-amd64.deb']
    .map(suffix => `Remix-Studio-${version}-${suffix}`);
}

export function validateRelease(manifest, packageVersion) {
  if (!parseVersion(manifest?.version) || manifest.version !== packageVersion) throw new Error('Release and package versions must match.');
  if (!Array.isArray(manifest.notes) || !manifest.notes.length || manifest.notes.some(note => typeof note !== 'string' || !note.trim() || note.length > 1000))
    throw new Error('Add at least one concrete release note (at most 1000 characters each).');
  return { ...manifest, tag: `v${manifest.version}`, prerelease: parseVersion(manifest.version).preview !== null };
}

export function validateAssets(names, version) {
  const expected = installerNames(version);
  if (expected.some(name => !names.includes(name)) || names.some(name => !expected.includes(name) && name !== 'SHA256SUMS.txt'))
    throw new Error('Release needs exactly the five installers for this version.');
  return expected;
}
