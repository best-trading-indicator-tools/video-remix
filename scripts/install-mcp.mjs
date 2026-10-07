import { execFileSync } from 'node:child_process';
import { access, copyFile, mkdir, readFile, writeFile, chmod, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
await access(path.join(root, 'dist-server/server/mcp/index.js')).catch(() => { throw new Error('Run npm run build before installing the local MCP.'); });
const name = 'remix-studio', command = process.execPath, args = [path.join(root, 'scripts/mcp.mjs')];
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const exists = async filename => { try { await access(filename); return true; } catch { return false; } };
const backup = async filename => { if (await exists(filename)) { const destination = `${filename}.before-remix-mcp-${stamp}.bak`; await copyFile(filename, destination); await chmod(destination, 0o600); } };
const which = executable => { try { return execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [executable], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\r?\n/u)[0]; } catch { return null; } };
const same = value => value?.command === command && JSON.stringify(value.args) === JSON.stringify(args);
let installed = 0;
const codex = which('codex');
if (codex) {
  let existing;
  try { existing = JSON.parse(execFileSync(codex, ['mcp', 'get', name, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).transport; } catch { /* Not registered. */ }
  if (existing && !same(existing)) throw new Error('Codex already has another remix-studio MCP. Preserve that entry before choosing a different name.');
  const filename = path.join(process.env.CODEX_HOME || path.join(homedir(), '.codex'), 'config.toml');
  let config = await exists(filename) ? await readFile(filename, 'utf8') : '';
  if (!existing && /^\[mcp_servers\.(?:remix-studio|"remix-studio")\]/mu.test(config))
    throw new Error('Could not read the existing Codex remix-studio entry. Preserve it and check the client configuration.');
  await backup(filename);
  // Codex's add command normalizes unrelated tables. Write only our table to preserve their exact settings.
  if (!existing) config += `\n\n[mcp_servers.remix-studio]\ncommand = ${JSON.stringify(command)}\nargs = [${args.map(value => JSON.stringify(value)).join(', ')}]\n`;
  const updated = config.replace(/(\[mcp_servers\.(?:remix-studio|"remix-studio")\]\r?\n)([\s\S]*?)(?=\n\[|$)/u, (_all, header, body) =>
    `${header}${body.replace(/^tool_timeout_sec\s*=.*(?:\r?\n|$)/gmu, '').trimEnd()}\ntool_timeout_sec = 180\n`);
  if (!existing || updated !== config) { await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, updated, { mode: 0o600 }); }
  console.log('Configured Codex: remix-studio'); installed++;
}
const claude = which('claude');
if (claude) {
  const filename = path.join(homedir(), '.claude.json');
  const config = await exists(filename) ? JSON.parse(await readFile(filename, 'utf8')) : {};
  const existing = config.mcpServers?.[name];
  if (existing && !same(existing)) throw new Error('Claude Code already has another remix-studio MCP. Preserve that entry before choosing a different name.');
  if (!existing) {
    await backup(filename);
    execFileSync(claude, ['mcp', 'add', '--scope', 'user', '--transport', 'stdio', name, '--', command, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  }
  console.log('Configured Claude Code: remix-studio'); installed++;
}
const desktopDirectory = process.platform === 'darwin' ? path.join(homedir(), 'Library/Application Support/Claude')
  : process.platform === 'win32' && process.env.APPDATA ? path.join(process.env.APPDATA, 'Claude') : undefined;
if (desktopDirectory && (await exists(desktopDirectory) || process.platform === 'darwin' && await exists('/Applications/Claude.app'))) {
  const filename = path.join(desktopDirectory, 'claude_desktop_config.json');
  const config = await exists(filename) ? JSON.parse(await readFile(filename, 'utf8')) : {};
  const existing = config.mcpServers?.[name];
  if (existing && !same(existing)) throw new Error('Claude Desktop already has another remix-studio MCP. Preserve that entry before choosing a different name.');
  if (!existing) {
    await mkdir(desktopDirectory, { recursive: true }); await backup(filename);
    config.mcpServers = { ...config.mcpServers, [name]: { command, args } };
    const temporary = `${filename}.remix-${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 }); await rename(temporary, filename);
  }
  console.log('Configured Claude Desktop: remix-studio'); installed++;
}
if (!installed) console.log(`No installed clients found. Add a stdio server named ${name} using command ${command} and argument ${args[0]}.`);
else console.log('Start Remix Studio, then restart your MCP client or open a new session to load the tools. Existing client settings were preserved.');
