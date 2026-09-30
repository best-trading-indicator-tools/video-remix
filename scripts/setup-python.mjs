/** Find a supported interpreter without relying on Unix-only executable names. */
export async function findPython(run, {
  platform = process.platform, pythonBin = process.env.PYTHON_BIN, maxMinor = 13,
} = {}) {
  const versions = [12, 13, 11, 10];
  const choices = pythonBin ? [{ command: pythonBin, args: [] }]
    : platform === "win32"
      ? [...versions.map(minor => ({ command: "py", args: [`-3.${minor}`] })),
        { command: "python", args: [] }, { command: "python3", args: [] }]
      : [...versions.map(minor => ({ command: `python3.${minor}`, args: [] })),
        { command: "python3", args: [] }, { command: "python", args: [] }];
  const check = `import sys; assert (3, 10) <= sys.version_info[:2]${maxMinor === null ? "" : ` < (3, ${maxMinor + 1})`}`;
  for (const choice of choices) {
    try {
      await run(choice.command, [...choice.args, "-c", check], true);
      return choice;
    } catch { /* Try the next installed interpreter. */ }
  }
  throw new Error(`Install Python ${maxMinor === null ? "3.10 or newer" : `3.10–3.${maxMinor}`}, or set PYTHON_BIN to its executable, then run setup again.`);
}
