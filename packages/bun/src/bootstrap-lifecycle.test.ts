import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { suffix } from 'bun:ffi';
import { configure, ensureConfigured } from '@rustra/types';
import { createBunBootstrap, createBunFfiEngine } from './index.js';
const options = {
  library: resolve(import.meta.dir, `../../../target/debug/librustra_calculator_example.${suffix}`),
  frameCodecs: new Map(),
};
const clean = () => configure({ invoke: async <T>() => null as T });

test(
  'Bun pending ready is invalidated when reload closes its generation',
  { skip: !existsSync(options.library) },
  async () => {
    clean();
    const b = createBunBootstrap(options);
    await b.ready();
    const pending = b.ready();
    const rejected = assert.rejects(pending, /superseded/);
    const reloading = b.reload();
    await Promise.all([reloading, rejected]);
    const engine = await b.ready();
    assert.doesNotThrow(() => engine.refreshLiveSchema());
    b.dispose();
  },
);

test('Bun disposal before ready releases its registration', () => {
  clean();
  const first = createBunBootstrap(options);
  first.dispose();
  const second = createBunBootstrap(options);
  second.dispose();
});

test(
  'Bun disposal removes the ready engine and cached public methods reject safely',
  { skip: !existsSync(options.library) },
  async () => {
    clean();
    const b = createBunBootstrap(options);
    const engine = await b.ready();
    const lookup = engine.refreshLiveSchema;
    b.dispose();
    b.dispose();
    await assert.rejects(ensureConfigured(), /not configured/i);
    assert.throws(() => lookup(), /disposed/);
    await assert.rejects(engine.invoke('missing'), /disposed/);
    await assert.rejects(engine.invokeBatch([]), /disposed/);
    await assert.rejects(b.ready(), /disposed/);
  },
);

test(
  'Bun direct runtime close invalidates engine metadata and empty batch calls',
  { skip: !existsSync(options.library) },
  async () => {
    const runtime = await createBunFfiEngine(options);
    runtime.close();
    runtime.close();
    assert.throws(() => runtime.engine.refreshLiveSchema(), /disposed/);
    await assert.rejects(runtime.engine.invokeBatch([]), /disposed/);
  },
);

test(
  'Bun disposal at initialization microtasks cannot reinstall a closed engine',
  { skip: !existsSync(options.library) },
  async () => {
    for (let ticks = 0; ticks < 12; ticks++) {
      clean();
      const b = createBunBootstrap(options);
      const pending = b.ready().catch(() => undefined);
      for (let i = 0; i < ticks; i++) await Promise.resolve();
      b.dispose();
      await pending;
      await assert.rejects(ensureConfigured(), /not configured/i);
    }
  },
);

test(
  'Bun overlapping reloads share one reload operation',
  { skip: !existsSync(options.library) },
  async () => {
    clean();
    const b = createBunBootstrap(options);
    await b.ready();
    const first = b.reload();
    const second = b.reload();
    assert.equal(first, second);
    await first;
    b.dispose();
  },
);
