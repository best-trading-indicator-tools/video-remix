import { compareVersions, parseVersion, RELEASES_URL, REPOSITORY } from './release-utils.mjs';

export function findUpdate(releases, currentVersion, platform, arch) {
  const current = parseVersion(currentVersion);
  if (!current || !Array.isArray(releases)) throw new Error('Invalid release information.');
  const suffix = platform === 'darwin' && arch === 'arm64' ? 'mac-arm64.dmg'
    : platform === 'win32' && arch === 'x64' ? 'win-x64.exe'
    : platform === 'linux' && arch === 'x64' ? 'linux-x86_64.AppImage' : null;
  if (!suffix) return null;
  const candidates = releases.flatMap(release => {
    if (release.draft || !release.published_at || typeof release.tag_name !== 'string') return [];
    const version = release.tag_name.startsWith('v') ? release.tag_name.slice(1) : '';
    const parsed = parseVersion(version);
    if (!parsed || compareVersions(version, currentVersion) <= 0) return [];
    if (current.preview === null && (parsed.preview !== null || release.prerelease)) return [];
    if (Boolean(release.prerelease) !== (parsed.preview !== null)) return [];
    const url = `${RELEASES_URL}/tag/v${version}`;
    if (release.html_url !== url) return [];
    const required = [`Remix-Studio-${version}-${suffix}`, 'SHA256SUMS.txt'];
    if (!required.every(name => release.assets?.some(asset => asset.name === name && asset.state === 'uploaded' && asset.size > 0))) return [];
    return [{ version, url, prerelease: parsed.preview !== null }];
  });
  return candidates.sort((a, b) => compareVersions(b.version, a.version))[0] ?? null;
}

export function createUpdateChecker({ currentVersion, platform = process.platform, arch = process.arch, fetchReleases, now = Date.now, onChange = () => {} }) {
  let state = { currentVersion, status: 'idle', release: null, checkedAt: null, error: '' };
  let pending, attemptedAt = null;
  const publish = patch => { state = { ...state, ...patch }; onChange(state); };
  const getState = () => ({ ...state });
  const check = (manual = false) => {
    if (pending) return pending;
    if (attemptedAt !== null && now() - attemptedAt < (manual ? 30_000 : 6 * 60 * 60 * 1000)) return Promise.resolve(getState());
    attemptedAt = now();
    publish({ status: 'checking', error: '' });
    pending = (async () => {
      try {
        const releases = await Promise.resolve().then(fetchReleases);
        const release = findUpdate(releases, currentVersion, platform, arch);
        publish({ release, status: release ? 'available' : 'current', checkedAt: new Date(now()).toISOString() });
      } catch {
        publish({ status: 'error', error: 'Could not check for updates. Check your internet connection and try again shortly.' });
      } finally { pending = undefined; }
      return getState();
    })();
    return pending;
  };
  return { getState, check };
}

export async function fetchPublishedReleases() {
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/releases?per_page=100`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Remix-Studio-update-check' },
    signal: AbortSignal.timeout(10_000), redirect: 'error',
  });
  if (!response.ok) throw new Error('Release service unavailable.');
  return response.json();
}
