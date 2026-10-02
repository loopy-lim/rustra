import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

test('Node can import Bun JSON adapters and receives actionable diagnostics for FFI setup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rustra-bun-node-diagnostics-'));
  try {
    // Bundle the current source, keeping the native module lazy. This test does
    // not depend on a previously built dist or on a native library artifact.
    const result = await Bun.build({
      entrypoints: [fileURLToPath(new URL('../src/index.ts', import.meta.url))],
      target: 'node',
      format: 'esm',
      external: ['bun:ffi'],
    });
    assert.ok(result.success, result.logs.map(String).join('\n'));
    const adapter = join(root, 'adapter.mjs');
    writeFileSync(adapter, await result.outputs[0]!.text());
    const script = `
      import assert from 'node:assert/strict';
      import {createBunFfiEngine,createBunBootstrap,createBunEngine,RustraCommandError} from ${JSON.stringify(pathToFileURL(adapter).href)};
      assert.equal(await createBunEngine({invoke:()=>42}).invoke('ping'),42);
      const options={library:'/missing-rustra.dylib',frameCodecs:new Map()};
      const check=error=>{
        assert.ok(error instanceof RustraCommandError);
        assert.equal(error.code,'transport.unavailable');
        assert.match(error.message,/Bun runtime/);
        assert.match(error.message,/@rustra\\/node/);
        assert.ok(error.cause instanceof Error);
        return true;
      };
      await assert.rejects(createBunFfiEngine(options),check);
      const bootstrap=createBunBootstrap(options);
      try {await assert.rejects(bootstrap.ready(),check);} finally {bootstrap.dispose();}
    `;
    const child = spawnSync('node', ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 3_000,
    });
    assert.equal(child.status, 0, child.stderr || String(child.error));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
