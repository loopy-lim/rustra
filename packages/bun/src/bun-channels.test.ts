import assert from 'node:assert/strict';
import { test, expect } from 'bun:test';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dlopen, FFIType, suffix } from 'bun:ffi';
import { createBunChannelBridge } from './bun-channels.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const dylib = resolve(repoRoot, `target/release/librustra_calculator_example.${suffix}`);
const dylibReady = existsSync(dylib);

/**
 * 실 dylib 통합 스모크 — rustra_ffi_channel_create/drop 의 첫 JS 소비 계약.
 *
 * 채널 프레임은 JS 스레드에서 와야 한다(threadsafe:false 스레드 계약). send 는
 * Rust 핸들러 스레드에서 일어나므로, 이 테스트는 JS→Rust 역방향 검증만 한다:
 * (1) 발급된 핸들로 `rustra_ffi_channel_send` 를 JS 스레드에서 직접 호출하면
 * 콜백이 도달하고, (2) drop 후 send 는 false 이고 콜백이 도달하지 않는다.
 * (Rust→JS 왕복은 examples/calculator 의 channelDemo 커맨드가 동기 핸들러로
 * send 하는 것으로 node 루프/FFI invoke 체인에서 실증한다.)
 */
test('bun channel bridge: create delivers frames, close stops delivery (real cdylib)', async () => {
  if (!dylibReady) {
    console.warn(
      'skipping: build the calculator cdylib first (cargo build --release -p rustra-calculator-example)',
    );
    return;
  }
  const createChannel = await createBunChannelBridge({ library: dylib });
  const received: unknown[] = [];
  const channel = createChannel((payload) => received.push(payload));
  expect(channel.handle).toBeInteger();
  expect(channel.handle).toBeGreaterThan(0);

  // Rust 가 send 하는 것과 동일한 코어 경로를 FFI 로 직접 흘린다.
  const lib = dlopen(dylib, {
    rustra_ffi_channel_send: { args: [FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
  });
  const channelSend = lib.symbols.rustra_ffi_channel_send;

  // JSCallback 은 JS 턴으로 마샬링되므로 send 후 마이크로태스크를 양보한다.
  const delivered = channelSend(channel.handle, Buffer.from('{"step":1}\0'));
  await Bun.sleep(5);
  expect(delivered).toBe(1);
  assert.deepEqual(received, [{ step: 1 }]);

  // close → drop. 이후 send 는 0(만료)이고 콜백에 도달하지 않는다.
  assert.equal(channel.close(), true);
  assert.equal(channel.close(), false, 'double close is a no-op');
  const afterClose = channelSend(channel.handle, Buffer.from('{"step":2}\0'));
  await Bun.sleep(5);
  expect(afterClose).toBe(0);
  assert.deepEqual(received, [{ step: 1 }], 'no frame after close');
});

test('bun channel bridge: JS callback exceptions are isolated between frames', async () => {
  if (!dylibReady) return;
  const createChannel = await createBunChannelBridge({ library: dylib });
  const lib = dlopen(dylib, {
    rustra_ffi_channel_send: { args: [FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
  });
  const channelSend = lib.symbols.rustra_ffi_channel_send;

  const received: unknown[] = [];
  let throwOnFirst = true;
  const channel = createChannel((payload) => {
    if (throwOnFirst) {
      throwOnFirst = false;
      throw new Error('first frame handler boom');
    }
    received.push(payload);
  });

  channelSend(channel.handle, Buffer.from('{"n":1}\0'));
  await Bun.sleep(5);
  channelSend(channel.handle, Buffer.from('{"n":2}\0'));
  await Bun.sleep(5);
  assert.deepEqual(received, [{ n: 2 }], 'listener survived its own exception');
  channel.close();
});

test('bun channel bridge: non-JSON payload falls back to the raw string', async () => {
  if (!dylibReady) return;
  const createChannel = await createBunChannelBridge({ library: dylib });
  const lib = dlopen(dylib, {
    rustra_ffi_channel_send: { args: [FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
  });
  const channelSend = lib.symbols.rustra_ffi_channel_send;

  const received: unknown[] = [];
  const channel = createChannel((payload) => received.push(payload));
  channelSend(channel.handle, Buffer.from('not-json\0'));
  await Bun.sleep(5);
  assert.equal(received[0], 'not-json');
  channel.close();
});

test('bun channel bridge: throws TransportUnavailable when no library resolves', async () => {
  await expect(createBunChannelBridge({ library: '/nonexistent/librustra.dylib' })).rejects.toThrow(
    'channel',
  );
});

// ── helpers ──────────────────────────────────────────────────
