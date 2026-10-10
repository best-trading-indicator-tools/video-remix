import { cleanupTemporaryFiles } from "./temporary-cleanup.js";
import { createApp } from "./app.js";
import { config, paths } from "./config.js";
import { cleanupExpired, pumpQueue, stopQueue } from "./queue.js";
import { initStore, state } from "./store.js";
import { stopIntelligence } from "./intelligence.js";
import { initMediaImports, stopMediaImports } from "./media-imports.js";
await initStore();
await initMediaImports();
let maintaining = false;
async function maintainWorkspace() {
  if (maintaining) return;
  maintaining = true;
  try {
    await cleanupExpired();
    await cleanupTemporaryFiles({ analysis: paths.analysis, work: paths.work, protectedJobIds: () => new Set(state.jobs.map(job => job.id)) });
  } finally { maintaining = false; }
}
await maintainWorkspace();
const app = createApp();
const server = app.listen(config.port, config.host, () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  console.log(
    `Remix Studio is ready at http://${config.host === "0.0.0.0" ? "localhost" : config.host}:${port}`,
  );
  pumpQueue();
  process.send?.({ type: "ready", port });
});
server.requestTimeout = 30 * 60 * 1000;
server.on("error", (error) => {
  console.error("Unable to start Remix Studio:", error.message);
  process.exitCode = 1;
});
const cleanup = setInterval(
  () => {
    void maintainWorkspace().catch((error) =>
      console.error("Cleanup failed:", error),
    );
  },
  15 * 60 * 1000,
);
cleanup.unref();
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(cleanup);
  server.close();
  await stopMediaImports();
  await stopQueue();
  stopIntelligence();
  server.closeAllConnections();
  if (process.connected) process.disconnect?.();
}
process.on("message", message => { if ((message as { type?: string })?.type === "shutdown") void shutdown(); });
process.on("SIGTERM", () => {
  void shutdown();
});
process.on("SIGINT", () => {
  void shutdown();
});
