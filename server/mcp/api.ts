export class LocalApiError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}
export class RemixApi {
  readonly baseUrl: string;
  constructor(value = 'http://127.0.0.1:8787') {
    const url = new URL(value);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
      throw new Error('REMIX_API_URL must be a local HTTP origin, for example http://127.0.0.1:8787.');
    this.baseUrl = url.origin;
  }
  async request<T = Record<string, unknown>>(route: string, body?: unknown, signal?: AbortSignal, timeoutMs = 25_000): Promise<T> {
    return this.fetchJson(route, { method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), signal }, timeoutMs);
  }
  async mutate<T = Record<string, unknown>>(route: string, method: 'PUT' | 'PATCH' | 'DELETE', body?: unknown, signal?: AbortSignal): Promise<T> {
    return this.fetchJson(route, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), signal });
  }
  /** NDJSON analysis endpoints emit progress until a final result; never buffer an unbounded stream. */
  async analysis(route: string, body: unknown, signal: AbortSignal, progress: (value: unknown) => void): Promise<unknown> {
    if (!['/api/shorts/discover', '/api/shorts/transcript'].includes(route)) return this.request(route, body, signal, 2 * 60 * 60_000);
    const response = await fetch(`${this.baseUrl}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal, redirect: 'error' });
    if (!response.ok) throw new LocalApiError((await response.json() as { error?: string }).error || 'Analysis failed', response.status);
    const reader = response.body!.getReader(), decoder = new TextDecoder();
    let pending = '', result: unknown, bytes = 0;
    const consume = (line: string) => {
      if (!line.trim()) return;
      const event = JSON.parse(line);
      if (event.type === 'error') throw new Error(event.message || 'Analysis failed');
      if (event.type === 'result') result = event.result ?? event.transcript;
      else progress(event);
    };
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > 8 * 1024 * 1024) throw new Error('Analysis response is too large.');
        pending += decoder.decode(value, { stream: true });
        let boundary: number;
        while ((boundary = pending.indexOf('\n')) >= 0) { consume(pending.slice(0, boundary)); pending = pending.slice(boundary + 1); }
      }
      consume(pending + decoder.decode());
      if (result === undefined) throw new Error('Analysis ended without a result.');
      return result;
    } finally { void reader.cancel().catch(() => {}); }
  }
  async fetchJson<T>(route: string, init: RequestInit, timeoutMs = 25_000): Promise<T> {
    if (!route.startsWith('/api/') || route.startsWith('//')) throw new Error('Only Remix Studio API routes are supported.');
    const signal = AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(timeoutMs)]);
    try {
      const response = await fetch(`${this.baseUrl}${route}`, { ...init, signal, redirect: 'error' });
      // API JSON only. Do not return rendered videos, credentials or arbitrary files through MCP.
      const reader = response.body!.getReader();
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          size += value.length;
          if (size > 8 * 1024 * 1024) throw new Error('API response is too large.');
          chunks.push(value);
        }
      } finally { void reader.cancel().catch(() => {}); }
      let data;
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new LocalApiError('Remix Studio returned an invalid response.', response.status >= 400 && response.status < 500 ? response.status : undefined); }
      if (!response.ok) throw new LocalApiError(typeof data.error === 'string' ? data.error : `Remix Studio request failed (${response.status}).`, response.status);
      return data as T;
    } catch (error) {
      if (error instanceof LocalApiError) throw error;
      if (init.signal?.aborted) throw new LocalApiError('Request cancelled. If a render was being submitted, check Exports before retrying.');
      throw new LocalApiError(`Cannot reach Remix Studio at ${this.baseUrl}, or the request timed out. Start the app with npm run dev, then try again. For a render submission, check Exports before retrying.`);
    }
  }
}
