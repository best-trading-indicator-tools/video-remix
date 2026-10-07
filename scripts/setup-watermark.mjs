import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { findPython } from "./setup-python.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const python = path.join(root, ".venv-watermark", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const model = JSON.parse(await readFile(path.join(root, "scripts/lama-model.json"), "utf8"));
const destination = path.join(root, "scripts/models", model.filename);
async function matches(file) {
  try {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest("hex") === model.sha256;
  } catch { return false; }
}
function run(command, args, quiet = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: quiet ? "ignore" : "inherit" });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error("Local LaMa setup failed.")));
  });
}
try {
  try { await access(python); }
  catch {
    const selected = await findPython(run);
    await run(selected.command, [...selected.args, "-m", "venv", path.join(root, ".venv-watermark")]);
  }
  // CPU wheels avoid downloading NVIDIA libraries on machines without CUDA.
  if (process.platform !== "darwin") await run(python, ["-m", "pip", "install", "--disable-pip-version-check",
    "torch==2.14.1", "--index-url", "https://download.pytorch.org/whl/cpu"]);
  await run(python, ["-m", "pip", "install", "--disable-pip-version-check", "-r", "requirements-watermark.txt"]);
  if (!await matches(destination)) {
    console.log("Downloading the free LaMa model (196 MiB). Videos stay on this computer.");
    await mkdir(path.dirname(destination), { recursive: true });
    const partial = `${destination}.${randomUUID()}.tmp`;
    try {
      const response = await fetch(model.url, { signal: AbortSignal.timeout(10 * 60_000) });
      if (!response.ok || !response.body) throw new Error(`Model download failed: HTTP ${response.status}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { flags: "wx" }));
      if (!await matches(partial)) throw new Error("LaMa model integrity check failed. Run setup again.");
      await rename(partial, destination);
    } finally { await rm(partial, { force: true }); }
  }
  await run(python, ["scripts/lama_inpaint.py", "--check"]);
  console.log("Local LaMa watermark removal is ready. No API key or credits needed. License: scripts/models/LICENSE-LAMA.txt");
} catch (error) { console.error(error.message); process.exitCode = 1; }
