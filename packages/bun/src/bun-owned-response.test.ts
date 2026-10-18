import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { dlopen, FFIType, suffix } from 'bun:ffi';
import type { FrameCodec } from '@rustra/types';
import { createBunFfiEngine as candidateEngine } from './bun-ffi.js';

// Allows the same behavioral assertions to demonstrate RED against a saved adapter.
const createEngine: typeof candidateEngine = process.env.RUSTRA_BUN_OWNED_TEST_ADAPTER
  ? (await import(pathToFileURL(process.env.RUSTRA_BUN_OWNED_TEST_ADAPTER).href)).createBunFfiEngine
  : candidateEngine;

type Input = { size: number; mode?: number; failDecode?: boolean };
function registry(failDecode = false): Map<string, FrameCodec<unknown, unknown>> {
  const codec: FrameCodec<Input, Uint8Array> = {
    commandId: 1,
    encode({ size, mode = 0 }) {
      return Uint8Array.of(size & 255, (size >>> 8) & 255, (size >>> 16) & 255, mode).buffer;
    },
    decode(frame) {
      if (failDecode) throw new Error('intentional decoder failure');
      const bytes = ArrayBuffer.isView(frame)
        ? new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength)
        : new Uint8Array(frame);
      const length = new DataView(bytes.buffer, bytes.byteOffset).getUint32(4, true);
      return { ok: true, result: bytes.slice(8, 8 + length) };
    },
  };
  return new Map([['echo', codec as FrameCodec<unknown, unknown>]]);
}

for (const variant of ['owned', 'legacy', 'missing-free'] as const) {
  test(
    `Bun ${variant}: one dispatch, correct allocator, 512-byte boundary and retained results`,
    { skip: process.platform === 'win32' },
    async () => {
      const temporary = mkdtempSync(join(tmpdir(), 'rustra-bun-owned-'));
      const library = join(temporary, `fixture.${suffix}`);
      const compile = spawnSync(
        'cc',
        [
          ...(process.platform === 'darwin' ? ['-dynamiclib'] : ['-shared', '-fPIC']),
          ...(variant === 'legacy' ? [] : ['-DWITH_OWNED']),
          ...(variant === 'missing-free' ? ['-DMISSING_OWNED_FREE'] : []),
          '-O2',
          '-o',
          library,
          join(import.meta.dir, 'fixtures/owned-response.c'),
        ],
        { encoding: 'utf8' },
      );
      assert.equal(compile.status, 0, compile.stderr);
      const control = dlopen(library, {
        fixture_counter: { args: [FFIType.u32], returns: FFIType.u32 },
        fixture_reset: { args: [], returns: FFIType.void },
      });
      const runtime = await createEngine({ library, frameCodecs: registry() });
      try {
        for (const size of [511, 512, 513, 65_536, 262_144]) {
          control.symbols.fixture_reset();
          const result = await runtime.engine.invoke<Uint8Array>('echo', { size });
          assert.deepEqual(
            result,
            Uint8Array.from({ length: size - 8 }, (_, i) => (i + 8) % 251),
          );
          assert.equal(control.symbols.fixture_counter(2), 1, 'handler must run exactly once');
          assert.equal(control.symbols.fixture_counter(1), variant === 'owned' ? 1 : 0);
          assert.equal(
            control.symbols.fixture_counter(0),
            variant === 'owned' ? 0 : size > 512 ? 2 : 1,
          );
          assert.equal(
            control.symbols.fixture_counter(3),
            variant === 'owned' && size > 512 ? 1 : 0,
          );
          assert.equal(control.symbols.fixture_counter(4), 0);
          await runtime.engine.invoke('echo', { size: 16 });
          assert.equal(result[0], 8, 'later caller-buffer writes must not mutate kept results');
        }
        if (variant === 'owned') {
          control.symbols.fixture_reset();
          await assert.rejects(
            runtime.engine.invoke('echo', { size: 513, mode: 1 }),
            /exceeds capacity/,
          );
          assert.equal(control.symbols.fixture_counter(3), 0);
          control.symbols.fixture_reset();
          await assert.rejects(
            runtime.engine.invoke('echo', { size: 16, mode: 2 }),
            /invalid size/,
          );
          assert.equal(
            control.symbols.fixture_counter(3),
            1,
            'invalid owned length still releases once',
          );
          const malformed = await createEngine({ library, frameCodecs: registry(true) });
          try {
            control.symbols.fixture_reset();
            await assert.rejects(malformed.engine.invoke('echo', { size: 513 }), /decoder failure/);
            assert.equal(
              control.symbols.fixture_counter(3),
              1,
              'decode errors must not leak owned responses',
            );
          } finally {
            malformed.close();
          }
        }
      } finally {
        runtime.close();
        control.close();
        rmSync(temporary, { recursive: true, force: true });
      }
    },
  );
}
