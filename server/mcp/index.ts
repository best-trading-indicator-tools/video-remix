import path from 'node:path';
import { createHash } from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { RemixApi } from './api.js';
import { DraftStore } from './drafts.js';
import { RemixMcpService } from './service.js';
import { createRemixMcpServer } from './server.js';

const api = new RemixApi(process.env.REMIX_API_URL ?? `http://127.0.0.1:${process.env.PORT || '8787'}`);
const workspace = createHash('sha256').update(api.baseUrl).digest('hex').slice(0, 16);
const directory = process.env.REMIX_MCP_DATA_DIR || path.join(process.env.DATA_DIR || 'data', 'mcp');
const drafts = new DraftStore(path.resolve(directory, `drafts-${workspace}.sqlite`));
const server = createRemixMcpServer(new RemixMcpService(api, drafts));
let closed = false;
const close = () => { if (!closed) { closed = true; drafts.close(); } };
server.server.onclose = close;
process.once('exit', close);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void server.close().finally(close); });
await server.connect(new StdioServerTransport());
