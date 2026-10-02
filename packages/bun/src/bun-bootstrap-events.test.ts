import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { suffix } from 'bun:ffi';
import { configure, ensureConfigured, type FrameCodec } from '@rustra/types';
import { createBunBootstrap } from './index.js';

test('bootstrap subscriptions use the selected compatible library and receive the first event', async () => {
  configure({ invoke: async <T>() => null as T });
  const root = mkdtempSync(join(tmpdir(), 'rustra-bun-pairing-'));
  const broken = join(root, `broken.${suffix}`);
  writeFileSync(broken, 'not a native library');
  const library = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../target/debug',
    `librustra_calculator_example.${suffix}`,
  );
  const codec: FrameCodec<unknown, unknown> = {
    commandId: 11,
    encode() {
      return Uint8Array.of(11, 0, 0, 0).buffer;
    },
    decode() {
      return { ok: true, result: { emitted: 1 } };
    },
  };
  const bootstrap = createBunBootstrap({
    libraryCandidates: [broken, library],
    frameCodecs: new Map([['emitDemo', codec]]),
  });
  const events: unknown[] = [];
  try {
    bootstrap.subscribeEvent('demo.done', (payload) => events.push(payload));
    const engine = await bootstrap.ready();
    await engine.invoke('emitDemo');
    assert.deepEqual(events, [{ emitted: 1 }]);
    bootstrap.dispose();
    assert.throws(() => bootstrap.subscribeEvent('demo.done', () => {}), /disposed/);
  } finally {
    bootstrap.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a subscription after lazy generated initialization receives an immediate native emit', async () => {
  configure({ invoke: async <T>() => null as T });
  const bootstrap = createBunBootstrap({
    library: resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../target/debug',
      `librustra_calculator_example.${suffix}`,
    ),
    frameCodecs: new Map([
      [
        'emitDemo',
        {
          commandId: 11,
          encode: () => Uint8Array.of(11, 0, 0, 0).buffer,
          decode: () => ({ ok: true, result: { emitted: 1 } }),
        },
      ],
    ]),
  });
  const events: unknown[] = [];
  try {
    const engine = await ensureConfigured();
    bootstrap.subscribeEvent('demo.done', (payload) => events.push(payload));
    await engine.invoke('emitDemo');
    assert.deepEqual(events, [{ emitted: 1 }]);
  } finally {
    bootstrap.dispose();
  }
});
