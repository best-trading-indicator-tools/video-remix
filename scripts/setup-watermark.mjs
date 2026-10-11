import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { findPython } from "./setup-python.mjs";
import { withSetupLock } from "./setup-lock.mjs";

const root = process.env.REMIX_RUNTIME_DIR || path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const python = path.join(root, ".venv-watermark", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const model = JSON.parse(await readFile(path.join(root, "scripts/lama-model.json"), "utf8"));
const destination = path.join(root, "scripts/models", model.filename);
const report = phase => console.log(JSON.stringify({ lamaSetup: phase }));
async function matches(file) {
  try {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest("hex") === model.sha256;
  } catch { return false; }
}
function run(command, args, quiet = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, windowsHide: true, stdio: quiet ? "ignore" : "inherit" });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error("Local LaMa setup failed.")));
  });
}
async function install() {
  // A forced cancellation can leave only an incomplete, uniquely named download.
  await mkdir(path.dirname(destination), { recursive: true });
  for (const name of await readdir(path.dirname(destination))) {
    if (name.startsWith(`${model.filename}.`) && name.endsWith('.tmp'))
      await rm(path.join(path.dirname(destination), name), { force: true });
  }
  report("Checking local LaMa");
  // Reuse healthy installs offline, including installations made before automatic setup.
  if (process.argv.includes('--ensure')) {
    try {
      await run(python, ["scripts/lama_inpaint.py", "--check"], true);
      await markReady();
      return;
    } catch { /* Repair missing packages, Python or corrupt/partial weights below. */ }
  }
  await rm(path.join(root, 'ready-watermark.json'), { force: true });
  report("Preparing Python for local LaMa");
  try { await run(python, ['-c', 'import sys; assert (3, 10) <= sys.version_info[:2] < (3, 14)'], true); }
  catch {
    // Only this tool's disposable environment is replaced; existing model downloads stay.
    await rm(path.join(root, '.venv-watermark'), { recursive: true, force: true });
    if (process.env.REMIX_DESKTOP === '1') {
      // The desktop bundles uv and sets a private managed-Python directory.
      await run('uv', ['venv', '--python', '3.12', '--seed', path.join(root, '.venv-watermark')]);
    } else {
      let selected;
      try { selected = await findPython(run); }
      catch (error) {
        try { await run('uv', ['--version'], true); } catch { throw error; }
      }
      if (selected) await run(selected.command, [...selected.args, "-m", "venv", path.join(root, ".venv-watermark")]);
      else await run('uv', ['venv', '--python', '3.12', '--seed', path.join(root, '.venv-watermark')]);
    }
  }
  await run(python, ['-c', `import platform, struct, sys
assert (3, 10) <= sys.version_info[:2] < (3, 14), 'Use Python 3.10-3.13 (3.12 recommended). Recreate .venv-watermark if necessary.'
assert struct.calcsize('P') == 8, 'Watermark removal requires 64-bit Python.'
if sys.platform == 'darwin':
    assert platform.machine() == 'arm64', 'This PyTorch release requires an Apple Silicon Mac and native ARM Python. Intel Macs are not supported by this installer.'
    assert int(platform.mac_ver()[0].split('.')[0]) >= 14, 'Watermark removal requires macOS 14 or newer.'
`]);
  report("Installing local LaMa dependencies — first setup can take several minutes");
  // Older bundled pip versions reject normalized package names in the PyTorch index.
  await run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--upgrade', 'pip==25.3']);
  // CPU wheels avoid downloading NVIDIA libraries on machines without CUDA.
  // Keep a matching CUDA installation when the user has explicitly installed it.
  let torchInstalled = false;
  try { await run(python, ['-c', "import torch; assert torch.__version__.split('+')[0] == '2.14.1'"], true); torchInstalled = true; } catch { /* Install below. */ }
  if (process.platform !== "darwin" && !torchInstalled) await run(python, ["-m", "pip", "install", "--disable-pip-version-check", "--only-binary=:all:",
    "torch==2.14.1", "--index-url", "https://download.pytorch.org/whl/cpu"]);
  await run(python, ["-m", "pip", "install", "--disable-pip-version-check", "--only-binary=:all:", "-r", "requirements-watermark.txt"]);
  if (!await matches(destination)) {
    report("Downloading the free LaMa model (196 MiB) — videos stay on this computer");
    await mkdir(path.dirname(destination), { recursive: true });
    const partial = `${destination}.${randomUUID()}.tmp`;
    try {
      const response = await fetch(model.url, { signal: AbortSignal.timeout(10 * 60_000) });
      if (!response.ok || !response.body) throw new Error(`Model download failed: HTTP ${response.status}`);
      let received = 0, lastPercent = 0;
      const total = Number(response.headers.get('content-length'));
      const stream = Readable.fromWeb(response.body);
      stream.on('data', chunk => {
        received += chunk.length;
        const percent = total > 0 ? Math.min(100, Math.floor(received / total * 100)) : -1;
        if (percent >= lastPercent + 5 || percent === 100 && lastPercent !== 100) { lastPercent = percent; report(`Downloading the free LaMa model — ${percent}%`); }
      });
      await pipeline(stream, createWriteStream(partial, { flags: "wx" }));
      if (!await matches(partial)) throw new Error("LaMa model integrity check failed. Run setup again.");
      await rename(partial, destination);
    } finally { await rm(partial, { force: true }); }
  }
  report("Verifying local LaMa");
  await run(python, ["scripts/lama_inpaint.py", "--check"]);
  await markReady();
  console.log("Local LaMa watermark removal is ready. No API key or credits needed. License: scripts/models/LICENSE-LAMA.txt");
}
async function markReady() {
  await writeFile(path.join(root, 'ready-watermark.json'), JSON.stringify({ checkedAt: new Date().toISOString() }));
  report('Local LaMa is ready');
}
try {
  await withSetupLock(path.join(root, '.watermark-setup-lock'), install, () => report('Waiting for local LaMa installation'));
} catch (error) { console.error(error.message); process.exitCode = 1; }
