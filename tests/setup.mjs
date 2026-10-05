import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Run before any application import, including static imports in test files.
// Every test process gets its own default workspace and no personal API keys.
const directory = mkdtempSync(path.join(tmpdir(), 'remix-test-workspace-'));
process.env.DATA_DIR = directory;
for (const key of ['DEEPSEEK_API_KEY', 'PIXABAY_API_KEY', 'PEXELS_API_KEY', 'POSTIZ_API_KEY']) process.env[key] = '';
process.on('exit', () => {
  try { rmSync(directory, { recursive: true, force: true }); }
  catch { /* Windows may retain a handle until the test process has fully exited. */ }
});
