import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const python = path.join(root, '.venv-upscale', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const child = spawn(python, ['scripts/upscale_video.py', '--check', ...process.argv.slice(2)], { cwd: root, stdio: 'inherit' });
child.once('error', () => { console.error('Run npm run setup:upscale first.'); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
