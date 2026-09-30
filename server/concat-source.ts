import { link } from "node:fs/promises";

/** Only call with an already validated, absolute local media path. */
export function concatFile(filePath: string, platform = process.platform): string {
  if (/[\r\n\0]/u.test(filePath)) throw new Error("Rename this video without line breaks before exporting.");
  // Explicit file: avoids treating Windows drive letters as protocol names.
  // Concat directives have their own quoting; no shell is involved.
  const filename = platform === "win32" ? filePath.replaceAll("\\", "/") : filePath;
  return `'file:${filename.replaceAll("'", "'\\''")}'`;
}

export async function prepareConcatSource(input: string, alias: string, name: string): Promise<{ file: string; safe: string; linked: boolean }> {
  try {
    // Hard links need no Windows Developer Mode and never copy large videos.
    await link(input, alias);
    return { file: name, safe: "1", linked: true };
  } catch (error) {
    if (!["EXDEV", "EPERM", "EACCES", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes((error as NodeJS.ErrnoException).code || "")) throw error;
    // Cross-volume/network inputs use the validated original directly. Only
    // this server-authored concat list allows absolute paths; protocols remain restricted.
    return { file: concatFile(input), safe: "0", linked: false };
  }
}
