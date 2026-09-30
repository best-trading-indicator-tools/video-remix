import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execFileSync } from "node:child_process";
const revision = (() => { try { return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { encoding: "utf8", timeout: 1000 }).trim(); } catch { return "unknown"; } })();
export default defineConfig({
  define: { __APP_REVISION__: JSON.stringify(revision) },
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
});
