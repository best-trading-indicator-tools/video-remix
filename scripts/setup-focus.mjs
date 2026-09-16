import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
    let selected;
    for (const choice of process.env.PYTHON_BIN
      ? [process.env.PYTHON_BIN]
      : ["python3.12", "python3.11", "python3.10", "python3"]) {
      try {
        await run(
          choice,
          ["-c", "import sys; assert (3,10) <= sys.version_info[:2] < (3,14)"],
          true,
        );
        selected = choice;
        break;
      } catch {
        /* Try the next installed interpreter. */
      }
    }
    if (!selected)
      throw new Error("Install Python 3.10–3.13, then run setup:focus again.");
    await run(selected, ["-m", "venv", path.join(root, ".venv")]);
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
