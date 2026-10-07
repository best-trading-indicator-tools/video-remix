// Stable absolute-path launcher for GUI clients whose working directory/PATH differ.
import { fileURLToPath } from 'node:url';
import { access } from 'node:fs/promises';
const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
try { process.loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const entry = new URL('../dist-server/server/mcp/index.js', import.meta.url);
try { await access(entry); }
catch {
  console.error('Build Remix Studio first: run npm install and npm run build in the video-remixer folder.');
  process.exit(1);
}
await import(entry.href);
