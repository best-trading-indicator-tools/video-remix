import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

test('test startup isolates early imports from an inherited workspace and personal credentials', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'remix-isolation-proof-'));
  const protectedDirectory = path.join(directory, 'personal-workspace');
  await mkdir(protectedDirectory);
  await writeFile(path.join(protectedDirectory, 'sentinel'), 'Original data');
  await writeFile(path.join(directory, '.env'), `DATA_DIR=${protectedDirectory}\nDEEPSEEK_API_KEY=personal-env-key\n`);
  const configUrl = pathToFileURL(path.resolve('server/config.ts')).href;
  const storeUrl = pathToFileURL(path.resolve('server/store.ts')).href;
  const script = path.join(directory, 'probe.mjs');
  await writeFile(script, `
    import assert from 'node:assert/strict';
    import { config } from ${JSON.stringify(configUrl)};
    import { initStore, saveStore, state, closeStore } from ${JSON.stringify(storeUrl)};
    assert.notEqual(config.dataDir, ${JSON.stringify(protectedDirectory)});
    for (const key of ['DEEPSEEK_API_KEY','PIXABAY_API_KEY','PEXELS_API_KEY','POSTIZ_API_KEY']) assert.equal(process.env[key], '');
    await initStore(); state.jobs.push({id:'test-fixture'}); await saveStore(); closeStore();
    process.env.NODE_TEST_CONTEXT = 'child-v8';
    process.env.DATA_DIR = ${JSON.stringify(protectedDirectory)};
    await assert.rejects(initStore(), /before importing server modules/);
    console.log('ISOLATED:' + config.dataDir);
  `);
  try {
    const { stdout } = await promisify(execFile)(process.execPath,
      ['--import', pathToFileURL(path.resolve('tests/setup.mjs')).href, '--import', import.meta.resolve('tsx'), script],
      { cwd: directory, env: { ...process.env, DATA_DIR: protectedDirectory, DEEPSEEK_API_KEY: 'personal-shell-key', POSTIZ_API_KEY: 'personal-postiz-key' } });
    assert.deepEqual(await readdir(protectedDirectory), ['sentinel']);
    assert.equal(await readFile(path.join(protectedDirectory, 'sentinel'), 'utf8'), 'Original data');
    const isolated = stdout.match(/ISOLATED:(.+)/)?.[1]; assert.ok(isolated);
    await assert.rejects(access(isolated), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
