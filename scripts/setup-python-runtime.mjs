import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ensureManagedPython } from './python-runtime.mjs';

// npm can still install the editor when an optional Python download is unavailable.
// Explicit setup exits nonzero so CI and users can verify that Python is ready.
const optional = process.argv.includes('--optional');
if (optional && process.env.REMIX_SKIP_PYTHON_SETUP === '1') {
  console.log('Automatic Python setup skipped. Run npm run setup:python when needed.');
} else {
  try {
    if (process.env.PYTHON_BIN) {
      await promisify(execFile)(process.env.PYTHON_BIN, ['-c',
        'import sys, struct, venv, ensurepip; assert (3, 10) <= sys.version_info[:2] < (3, 14); assert struct.calcsize("P") == 8'],
      { windowsHide: true, timeout: 30_000 });
      console.log('Using the Python interpreter selected by PYTHON_BIN.');
    } else await ensureManagedPython();
  } catch (error) {
    console.error(`Python setup could not finish: ${error.message}\nCheck your connection and free disk space, then run npm run setup:python. Basic editing remains available.`);
    if (!optional) process.exitCode = 1;
  }
}
