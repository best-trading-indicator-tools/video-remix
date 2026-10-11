import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';

/** Coordinate the desktop wizard, engine and CLI; recover after a killed installer. */
export async function withSetupLock(directory, work, waiting = () => {}) {
  const owner = path.join(directory, 'owner');
  const old = async file => {
    try { return Date.now() - (await stat(file)).birthtimeMs > 10_000; }
    catch { return false; }
  };
  const stale = async () => {
    try {
      const pid = Number(await readFile(owner, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid <= 0) return old(directory);
      try { process.kill(pid, 0); return false; }
      catch (error) { return error.code === 'ESRCH'; }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // The winner may still be writing its PID.
      return old(directory);
    }
  };
  const deadline = Date.now() + 30 * 60_000;
  let reported = false;
  for (;;) {
    try { await mkdir(directory); break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (!reported) { waiting(); reported = true; }
    if (await stale()) {
      // Only one waiter can reclaim this directory, and it checks the owner again.
      const reap = path.join(directory, 'reap');
      try {
        await mkdir(reap);
        if (await stale()) await rm(directory, { recursive: true, force: true });
        else await rm(reap, { recursive: true, force: true });
      } catch (error) {
        if (!['EEXIST', 'ENOENT'].includes(error.code)) throw error;
        // Recover if a previous waiter was killed while reclaiming the dead lock.
        if (error.code === 'EEXIST' && await old(reap)) await rm(reap, { recursive: true, force: true });
      }
    }
    if (Date.now() >= deadline) throw new Error('Another LaMa installation is still running. Wait for it to finish, then retry.');
    await setTimeout(500);
  }
  try { await writeFile(owner, String(process.pid)); return await work(); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
