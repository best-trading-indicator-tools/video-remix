import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findPython } from "./setup-python.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const python = path.join(
  root,
  ".venv",
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
);
function run(command, args, quiet = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: quiet ? "ignore" : "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error("Local face-framing setup failed.")),
    );
  });
}
try {
  try {
    await access(python);
  } catch {
    const selected = await findPython(run);
    await run(selected.command, [...selected.args, "-m", "venv", path.join(root, ".venv")]);
  }
  await run(python, [
    "-m",
    "pip",
    "install",
    "--disable-pip-version-check",
    "-r",
    path.join(root, "requirements-focus.txt"),
  ]);
  await run(python, [path.join(root, "scripts/speaker_focus.py"), "--check"]);
  console.log(
    "Local face framing is ready. The small YuNet model is bundled; no API key is needed.",
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
