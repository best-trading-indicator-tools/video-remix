import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { DeepSeekBalanceService, installDeepSeekBalanceRoutes } from "../server/deepseek-balance.js";

const payload = (currency = 'USD', total = '12.3456') => ({ is_available: true,
  balance_infos: [{ currency, total_balance: total, granted_balance: '2.0000', topped_up_balance: '10.3456' }] });

test("balance uses the fixed authenticated endpoint, coalesces requests and isolates key changes", async () => {
  let key = 'first-private-key', calls = 0;
  const service = new DeepSeekBalanceService(() => key, async (url, init) => {
    calls++;
    assert.equal(String(url), 'https://api.deepseek.com/user/balance');
    assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${key}`);
    assert.equal(init?.redirect, 'error');
    return Response.json(payload());
  });
  const results = await Promise.all([service.get(), service.get(), service.get(true)]);
  assert.equal(calls, 1);
  assert.deepEqual(results[0]?.balance?.balances, [{ currency: 'USD', total: '12.3456', granted: '2.0000', toppedUp: '10.3456' }]);
  await service.get(); assert.equal(calls, 1);
  key = 'replacement-private-key'; await service.get(); assert.equal(calls, 2);
  assert.ok(!JSON.stringify(results).includes('private-key'));
  key = ''; assert.deepEqual(await service.get(), { configured: false }); assert.equal(calls, 2);
});

test("balance preserves currency and zero, and reports safe failures instead of invented dollars", async () => {
  const cny = new DeepSeekBalanceService(() => 'private', async () => Response.json(payload('CNY', '0.00')));
  assert.equal((await cny.get()).balance?.balances[0]?.currency, 'CNY');
  assert.equal((await cny.get()).balance?.balances[0]?.total, '0.00');
  for (const reply of [Response.json({ error: 'provider-private-key' }, { status: 401 }), Response.json(payload('EUR')),
    Response.json({ ...payload(), balance_infos: [] }), new Response('x'.repeat(9_000)), Response.json(payload('USD', 'NaN'))]) {
    const service = new DeepSeekBalanceService(() => 'private-key', async () => reply);
    const result = await service.get();
    assert.equal(result.configured, true); assert.ok(result.error); assert.equal(result.balance, undefined);
    assert.ok(!JSON.stringify(result).includes('private-key'));
  }
  const timeout = new DeepSeekBalanceService(() => 'private', async () => new Promise<Response>(() => {}), 10);
  // A referenced timer keeps this synthetic no-socket test alive until its deadline.
  const keepAlive = setTimeout(() => {}, 1000);
  try { assert.match((await timeout.get()).error!, /timed out/); } finally { clearTimeout(keepAlive); }
});

test("the app balance endpoint returns only safe balance data and prevents HTTP caching", async () => {
  const app = express(); installDeepSeekBalanceRoutes(app, new DeepSeekBalanceService(() => 'private', async () => Response.json(payload())));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as {port:number}).port}/api/deepseek/balance?refresh=1`);
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const data = await response.json(); assert.equal(data.balance.balances[0].total, '12.3456');
    assert.ok(!JSON.stringify(data).includes('private'));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
