import { statfs } from "node:fs/promises";

export class DiskSpaceUnavailableError extends Error {
  constructor() {
    super("The app could not check free space on its workspace drive. Check that the drive is connected and responsive, then retry the import.");
  }
}

/** Only the read-only probe times out. No file mutation is released early. */
export function createDiskSpaceProbe(
  read: (target: string) => Promise<{ bavail: number; bsize: number }> = target => statfs(target),
  timeoutMs = 4000,
) {
  const pending = new Map<string, Promise<{ bavail: number; bsize: number }>>();
  return async (target: string): Promise<number> => {
    let probe = pending.get(target);
    if (!probe) {
      probe = Promise.resolve().then(() => read(target));
      pending.set(target, probe);
      // Keep a hung probe shared: repeated retries must not exhaust the filesystem thread pool.
      void probe.then(() => pending.delete(target), () => pending.delete(target));
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const disk = await Promise.race([probe, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new DiskSpaceUnavailableError()), timeoutMs);
      })]);
      const free = disk.bavail * disk.bsize;
      if (!Number.isFinite(disk.bavail) || disk.bavail < 0 || !Number.isFinite(disk.bsize) || disk.bsize <= 0 || !Number.isFinite(free))
        throw new DiskSpaceUnavailableError();
      return free; // Zero is a valid result and must trigger the normal full-disk error.
    } catch {
      throw new DiskSpaceUnavailableError();
    } finally { clearTimeout(timer); }
  };
}

export const availableDiskSpace = createDiskSpaceProbe();
