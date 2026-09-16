import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const python = path.join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const expected = "d985ddd07dca08864a28337726f5b7d91b6426bebc7327f0e9b21cf9ff1cc937";
const weights = path.join(root, "data/models/talknet.model");
const hash = async file => createHash("sha256").update(await readFile(file)).digest("hex");
const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: root, stdio: "inherit" });
  child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error("Local speaker setup failed.")));
});
try {
  await run(process.execPath, [path.join(root, "scripts/setup-focus.mjs")]);
  if (process.platform === "linux") await run(python, ["-m", "pip", "install", "torch==2.8.0", "--index-url", "https://download.pytorch.org/whl/cpu"]);
  await run(python, ["-m", "pip", "install", "--disable-pip-version-check", "-r", path.join(root, "requirements-speaker.txt")]);
  await mkdir(path.dirname(weights), { recursive: true });
  if (await hash(weights).catch(() => "") !== expected) {
    const temporary = `${weights}.download`;
    try {
      await run(python, ["-m", "gdown", "1J-PDWDAkYCdT8T2Nxn3Q_-iOHH_t-9YP", "-O", temporary]);
      if (await hash(temporary) !== expected) throw new Error("The downloaded TalkNet model did not match its expected checksum.");
      await rename(temporary, weights);
    } finally { await rm(temporary, { force: true }); }
  }
  await run(python, [path.join(root, "scripts/active_speaker.py"), "--check", weights]);
  console.log("Free local active-speaker framing is ready. No account or API calls are needed.");
} catch (error) { console.error(error.message); process.exitCode = 1; }
