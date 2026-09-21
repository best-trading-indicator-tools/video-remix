import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const environment = path.join(root, ".venv-imports");
const python = path.join(environment, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
function run(binary, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: root, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`${binary} exited with code ${code}.`)));
  });
}
try {
  try { await access(python); }
  catch { await run(process.env.PYTHON_BIN || "python3", ["-m", "venv", environment]); }
  await run(python, ["-m", "pip", "install", "--upgrade", "--disable-pip-version-check", "-r", "requirements-imports.txt"]);
  console.log("Video link imports are ready. Run this command again to update platform support.");
} catch (error) {
  console.error(`Link import setup failed: ${error.message}\nInstall Python 3.10 or newer, or set PYTHON_BIN to its executable.`);
  process.exitCode = 1;
}
