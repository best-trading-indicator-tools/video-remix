import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { REPOSITORY, validateRelease, validateAssets } from '../desktop/release-utils.mjs';

const manifest = validateRelease(JSON.parse(await readFile('desktop/release.json', 'utf8')), JSON.parse(await readFile('package.json', 'utf8')).version);
const sha = process.env.GITHUB_SHA;
const token = process.env.GH_TOKEN;
if (!/^[a-f0-9]{40}$/.test(sha ?? '') || !token || process.env.GITHUB_REF !== 'refs/heads/main' || process.env.GITHUB_REPOSITORY !== REPOSITORY)
  throw new Error('Publish from the main-branch workflow in the official repository.');
const directory = process.argv[2] || 'release-installers';
const names = validateAssets(await readdir(directory), manifest.version);
const hashes = new Map();
for (const name of names) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path.join(directory, name))) hash.update(chunk);
  hashes.set(name, hash.digest('hex'));
}
await writeFile(path.join(directory, 'SHA256SUMS.txt'), [...hashes].map(([name, hash]) => `${hash}  ${name}`).join('\n') + '\n');
hashes.set('SHA256SUMS.txt', createHash('sha256').update(await readFile(path.join(directory, 'SHA256SUMS.txt'))).digest('hex'));

const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Remix-Studio-release' };
async function api(route, options = {}) {
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}${route}`, { ...options,
    headers: { ...headers, 'Content-Type': 'application/json', ...options.headers }, signal: AbortSignal.timeout(30_000), redirect: 'error' });
  if (!response.ok) throw new Error(`GitHub ${options.method || 'GET'} ${route}: ${response.status}`);
  return response.status === 204 ? null : response.json();
}
// A tag already pointing elsewhere must never be moved or silently reused.
const tagResponse = await fetch(`https://api.github.com/repos/${REPOSITORY}/git/ref/tags/${manifest.tag}`, { headers, signal: AbortSignal.timeout(30_000), redirect: 'error' });
if (tagResponse.ok) {
  const tag = await tagResponse.json();
  if (tag.object.type !== 'commit' || tag.object.sha !== sha) throw new Error('The release tag already identifies a different commit. Prepare a new version.');
} else if (tagResponse.status !== 404) throw new Error(`Cannot check release tag: ${tagResponse.status}`);

// Authenticated listing includes drafts, unlike the public tag endpoint.
let release;
for (let page = 1; page <= 10; page++) {
  const releases = await api(`/releases?per_page=100&page=${page}`);
  release = releases.find(item => item.tag_name === manifest.tag);
  if (release || releases.length < 100) break;
}
if (release && release.target_commitish !== sha) throw new Error('Existing release belongs to a different commit.');
if (release && !release.draft) {
  if (![...hashes.keys()].every(name => release.assets.some(asset => asset.name === name && asset.state === 'uploaded' && asset.size > 0 && asset.digest?.startsWith('sha256:'))))
    throw new Error('Published release is incomplete; do not replace public binaries. Prepare a new version.');
  console.log(`${manifest.tag} is already public. Leaving its installers unchanged.`);
  process.exit(0);
}
const body = `${manifest.notes.map(note => `- ${note}`).join('\n')}\n\nDownload the installer for your computer: Mac Apple Silicon (.dmg), Windows x64 (.exe), or Linux x64 (.AppImage / .deb).\n\nQuit Remix Studio before replacing the app. Your workspace, API settings and downloaded models remain on this computer.\n\nPreview installers are unsigned and not Apple-notarized. Intel Mac and native Windows ARM installers are not included.\n\nAll three packaged runtimes passed import/render smoke checks. SHA256SUMS.txt lists installer checksums.\n\n[Desktop setup and update instructions](https://github.com/${REPOSITORY}/blob/${manifest.tag}/docs/desktop.md)\n`;
const payload = { tag_name: manifest.tag, target_commitish: sha, name: `Remix Studio ${manifest.version}`, body, draft: true, prerelease: manifest.prerelease };
release = release ? await api(`/releases/${release.id}`, { method: 'PATCH', body: JSON.stringify(payload) })
  : await api('/releases', { method: 'POST', body: JSON.stringify(payload) });
// A failed upload stays draft. Reruns replace only this unpublished draft's assets.
for (const asset of release.assets) await api(`/releases/assets/${asset.id}`, { method: 'DELETE' });
for (const [name] of hashes) {
  const file = path.join(directory, name);
  const response = await fetch(`https://uploads.github.com/repos/${REPOSITORY}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String((await stat(file)).size) },
    body: createReadStream(file), duplex: 'half', signal: AbortSignal.timeout(10 * 60_000), redirect: 'error',
  });
  if (!response.ok) throw new Error(`Upload failed for ${name}: ${response.status}. Release remains draft.`);
}
const verified = await api(`/releases/${release.id}`);
if (verified.assets.length !== hashes.size || !verified.assets.every(asset => asset.state === 'uploaded' && asset.size > 0 && asset.digest === `sha256:${hashes.get(asset.name)}`))
  throw new Error('Uploaded checksums do not match. Release remains draft.');
const published = await api(`/releases/${release.id}`, { method: 'PATCH', body: JSON.stringify({ draft: false, make_latest: manifest.prerelease ? 'false' : 'true' }) });
console.log(`Published ${published.html_url}`);
