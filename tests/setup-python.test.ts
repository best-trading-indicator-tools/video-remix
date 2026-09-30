import assert from "node:assert/strict";
import { test } from "node:test";
import { findPython } from "../scripts/setup-python.mjs";

test("Windows setup uses a versioned py launcher when python3 is unavailable", async () => {
  const selected = await findPython(async (command: string, args: string[]) => {
    if (command !== "py" || args[0] !== "-3.12") throw new Error("Interpreter not installed");
    assert.match(args.at(-1)!, /< \(3, 14\)/u);
  }, { platform: "win32", pythonBin: undefined });
  assert.deepEqual(selected, { command: "py", args: ["-3.12"] });
});

test("Windows setup falls back to python.exe on PATH when the launcher is missing", async () => {
  const selected = await findPython(async (command: string) => {
    if (command !== "python") throw new Error("Not installed");
  }, { platform: "win32", pythonBin: undefined });
  assert.deepEqual(selected, { command: "python", args: [] });
});

test("setup checks each interpreter version and preserves explicit executable paths with spaces", async () => {
  const executable = "C:\\Program Files\\Python312\\python.exe";
  const calls: string[] = [];
  await assert.rejects(findPython(async (command: string) => {
    calls.push(command); throw new Error("Unsupported Python version");
  }, { platform: "win32", pythonBin: executable }), /Install Python 3.10–3.13/u);
  assert.deepEqual(calls, [executable]);
  assert.deepEqual(await findPython(async (command: string, args: string[]) => {
    assert.equal(command, executable);
    assert.equal(args[0], "-c");
    assert.doesNotMatch(args[1]!, / < /u);
  }, { pythonBin: executable, maxMinor: null }), { command: executable, args: [] });
});

test("Unix setup retains versioned python3 discovery and can find Python 3.13", async () => {
  assert.deepEqual(await findPython(async (command: string) => {
    if (command !== "python3.13") throw new Error("Not installed");
  }, { platform: "linux", pythonBin: undefined }), { command: "python3.13", args: [] });
});
