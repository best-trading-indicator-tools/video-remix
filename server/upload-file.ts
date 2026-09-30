import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

export class UnsafeUploadError extends Error {
  constructor() { super("The saved upload is no longer an ordinary file. Cancel it and import the video again."); }
}

/** Validate before and after opening: Windows does not provide O_NOFOLLOW. */
export async function openRegularUpload(filePath: string, platform = process.platform) {
  const before = await lstat(filePath, { bigint: true });
  if (!before.isFile()) throw new UnsafeUploadError();
  const handle = await open(filePath, constants.O_RDWR | (platform === "win32" ? 0 : constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    const after = await lstat(filePath, { bigint: true });
    // Windows path and handle stats can disagree on volume IDs. Compare volume
    // IDs between the two path stats, and exact file IDs across all three stats.
    if (!opened.isFile() || !after.isFile() || before.ino !== opened.ino || after.ino !== opened.ino ||
      before.dev !== after.dev || (platform !== "win32" && before.dev !== opened.dev)) throw new UnsafeUploadError();
    return handle;
  } catch (error) { await handle.close(); throw error; }
}
