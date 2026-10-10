import { createHash } from 'node:crypto';
import { mkdir, copyFile, readFile, writeFile, readdir, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import ffmpeg from 'ffmpeg-static';
import extractZip from 'extract-zip';
import sharp from 'sharp';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const destination = path.join(root, 'desktop/resources');
const bin = path.join(destination, 'bin');
const manifest = JSON.parse(await readFile(path.join(root, 'desktop/assets.json'), 'utf8'));
const platform = `${process.platform}-${process.arch}`;
const asset = manifest.uv[platform];
const hash = data => createHash('sha256').update(data).digest('hex');
if (!asset) throw new Error('Desktop builds support Apple Silicon, Windows x64 and Linux x64.');
await mkdir(bin, { recursive: true });
await sharp(path.join(root, 'public/favicon.svg'), { density: 1152 }).resize(1024, 1024).png().toFile(path.join(destination, 'icon.png'));
let ffmpegLicense = `${ffmpeg}.LICENSE`, ffmpegReadme = `${ffmpeg}.README`;
const probe = path.join(bin, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
const bundledFfmpeg = path.join(bin, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
if (process.platform === 'linux') {
  // The npm Linux binary omits drawtext. Use a pinned full static build instead.
  const archive = path.join(destination, 'ffmpeg-linux.tar.xz');
  let bytes;
  try { bytes = await readFile(archive); } catch { /* First build. */ }
  if (!bytes || hash(bytes) !== manifest.linuxFfmpeg.sha256) {
    const response = await fetch(manifest.linuxFfmpeg.url, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok) throw new Error('Could not download full Linux FFmpeg.');
    bytes = Buffer.from(await response.arrayBuffer());
    if (hash(bytes) !== manifest.linuxFfmpeg.sha256) throw new Error('Linux FFmpeg checksum mismatch.');
    await writeFile(archive, bytes);
  }
  execFileSync('tar', ['-xJf', archive, '-C', destination]);
  const extracted = path.join(destination, manifest.linuxFfmpeg.folder);
  for (const name of ['ffmpeg', 'ffprobe']) { await copyFile(path.join(extracted, 'bin', name), path.join(bin, name)); await chmod(path.join(bin, name), 0o755); }
  ffmpegLicense = path.join(extracted, 'LICENSE.txt');
  ffmpegReadme = path.join(destination, 'linux-ffmpeg-build.txt');
  await writeFile(ffmpegReadme, `Pinned binary: ${manifest.linuxFfmpeg.url}\nBuild scripts and dependency sources: https://github.com/BtbN/FFmpeg-Builds/tree/autobuild-2026-10-09-14-16\nFFmpeg source: https://github.com/FFmpeg/FFmpeg/commit/e0a878dd70\n`);
} else {
if (hash(await readFile(ffmpeg)) !== manifest.ffmpegSha256[platform]) throw new Error('FFmpeg checksum mismatch.');
const probeArchive = path.join(destination, 'ffprobe.gz');
let probeBytes;
try { probeBytes = await readFile(probeArchive); } catch { /* First build. */ }
if (!probeBytes || hash(probeBytes) !== manifest.ffprobeGzipSha256[platform]) {
  const response = await fetch(`https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffprobe-${platform}.gz`, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error('Could not download matching FFprobe.');
  probeBytes = Buffer.from(await response.arrayBuffer());
  if (hash(probeBytes) !== manifest.ffprobeGzipSha256[platform]) throw new Error('FFprobe checksum mismatch.');
  await writeFile(probeArchive, probeBytes);
}
await writeFile(probe, gunzipSync(probeBytes)); await chmod(probe, 0o755);
for (const [name, source] of [['ffmpeg', ffmpeg]]) {
  const target = path.join(bin, name + (process.platform === 'win32' ? '.exe' : ''));
  await copyFile(source, target); await chmod(target, 0o755);
}
}
const filters = execFileSync(bundledFfmpeg, ['-hide_banner', '-filters'], { encoding: 'utf8' });
for (const filter of ['drawtext', 'subtitles', 'scale', 'unsharp']) if (!new RegExp(`\\s${filter}\\s`).test(filters)) throw new Error(`Bundled FFmpeg lacks ${filter}.`);
execFileSync(probe, ['-version']);
const archive = path.join(destination, asset.name);
let bytes;
try { bytes = await readFile(archive); } catch { /* First build. */ }
if (!bytes || hash(bytes) !== asset.sha256) {
  const response = await fetch(`https://github.com/astral-sh/uv/releases/download/${manifest.uvVersion}/${asset.name}`, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`uv download failed (${response.status}).`);
  bytes = Buffer.from(await response.arrayBuffer());
  if (hash(bytes) !== asset.sha256) throw new Error('uv checksum mismatch.');
  await writeFile(archive, bytes);
}
const unpacked = path.join(destination, 'uv-unpacked');
await mkdir(unpacked, { recursive: true });
if (asset.name.endsWith('.zip')) await extractZip(archive, { dir: unpacked });
else execFileSync('tar', ['-xzf', archive, '-C', unpacked]);
async function find(directory, name) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === name && entry.isFile()) return path.join(directory, entry.name);
    if (entry.isDirectory()) { const result = await find(path.join(directory, entry.name), name); if (result) return result; }
  }
}
const uvName = process.platform === 'win32' ? 'uv.exe' : 'uv';
const uv = await find(unpacked, uvName);
if (!uv) throw new Error('The verified archive did not contain uv.');
await copyFile(uv, path.join(bin, uvName)); await chmod(path.join(bin, uvName), 0o755);
execFileSync(path.join(bin, uvName), ['--version']);
const licenses = path.join(destination, 'licenses'); await mkdir(licenses, { recursive: true });
for (const [source, name] of [[ffmpegLicense, 'FFmpeg-LICENSE.txt'], [ffmpegReadme, 'FFmpeg-build.txt']])
  await copyFile(source, path.join(licenses, name));
await writeFile(path.join(licenses, 'FFmpeg-configuration.txt'), execFileSync(bundledFfmpeg, ['-hide_banner', '-buildconf'], { encoding: 'utf8' }));
for (const name of ['LICENSE-APACHE', 'LICENSE-MIT']) {
  const response = await fetch(`https://raw.githubusercontent.com/astral-sh/uv/${manifest.uvVersion}/${name}`);
  if (!response.ok) throw new Error('Could not include uv license.');
  await writeFile(path.join(licenses, `uv-${name}.txt`), await response.text());
}
await writeFile(path.join(licenses, 'SOURCES.txt'), 'FFmpeg/ffprobe are separate executables. Build details and upstream source locations are in FFmpeg-build.txt.\nBinary distribution and corresponding build scripts: https://github.com/eugeneware/ffmpeg-static\nFFmpeg source: https://ffmpeg.org/download.html\nuv source: https://github.com/astral-sh/uv/tree/' + manifest.uvVersion + '\nElectron notices are included in the application distribution.\n');
console.log('Desktop media tools and managed Python installer verified.');
