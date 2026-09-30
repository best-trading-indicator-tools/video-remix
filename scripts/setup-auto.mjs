import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findPython } from "./setup-python.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
let model = process.env.WHISPER_MODEL || "small";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--model" && args[i + 1]) model = args[++i];
  else if (args[i] === "--help") {
    console.log(
      "Usage: npm run setup:auto -- [--model small|tiny|base|medium]\nCreates .venv, installs CPU transcription, and downloads the selected model.",
    );
    process.exit(0);
  } else throw new Error(`Unknown or incomplete argument: ${args[i]}`);
}
const python = path.join(
  root,
  ".venv",
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
);
const cache = path.resolve(
  root,
  process.env.WHISPER_CACHE_DIR ||
    path.join(process.env.DATA_DIR || "data", "models"),
);

function run(command, commandArgs, quiet = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: root,
      stdio: quiet ? "ignore" : "inherit",
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `${command} ${commandArgs[0]} failed (${signal || code}).`,
            ),
          ),
    );
  });
}
async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
try {
  console.log("Preparing private local transcription in .venv…");
  if (!(await exists(python))) {
    const selected = await findPython(run);
    await run(selected.command, [...selected.args, "-m", "venv", path.join(root, ".venv")]);
  }
  let uv = false;
  try {
    await run("uv", ["--version"], true);
    uv = true;
  } catch {
    /* pip is available inside the virtual environment. */
  }
  if (uv)
    await run("uv", [
      "pip",
      "install",
      "--python",
      python,
      "-r",
      path.join(root, "requirements-auto.txt"),
    ]);
  else
    await run(python, [
      "-m",
      "pip",
      "install",
      "--disable-pip-version-check",
      "-r",
      path.join(root, "requirements-auto.txt"),
    ]);
  console.log(
    `Downloading and checking the ${model} speech model. This first download can take a few minutes…`,
  );
  await run(python, [
    path.join(root, "scripts", "transcribe.py"),
    "--download",
    "--model",
    model,
    "--cache-dir",
    cache,
  ]);
  console.log(`Local transcription is ready. Model: ${model}. Cache: ${cache}`);
  if (model !== "small" && process.env.WHISPER_MODEL !== model)
    console.log(`Start the app with WHISPER_MODEL=${model} to use this model.`);
} catch (error) {
  console.error(`Local transcription setup failed: ${error.message}`);
  process.exitCode = 1;
}
