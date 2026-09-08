import assert from 'node:assert/strict';
import { test, expect } from 'bun:test';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dlopen, FFIType, suffix } from 'bun:ffi';
import { RustraCommandError } from '@rustra/types';
import { createBunChannelBridge, createBunChannelBytesBridge } from './bun-channels.js';

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

// ── 바이너리 채널 브릿지 — rustra_ffi_channel_create_bytes 패리티 ──────────
//
// RN createBytesChannel 과 동일한 JS 계약({ handle, close() } + Uint8Array
// 페이로드)을 검증한다. (1) JS 스레드에서 직접 send_bytes 하는 역방향,
// (2) 생성된 rkyv 레지스트리의 channelDemoBytes 로 Rust→JS 왕복 — 동기 핸들러가
// FFI invoke 체인(JS 스레드) 안에서 send 하는 것이 threadsafe:false 계약의
// 전제 경로 그 자체다, (3) 경로 배타성(한 핸들은 JSON xor bytes), (4) loud-fail
// 분류(라이브러리 없음/rustra 아님 → transport, bytes 심볼 없음 → channel).

test('bun bytes channel bridge: create delivers copied frames, close stops delivery (real cdylib)', async () => {
  if (!dylibReady) {
    console.warn(
      'skipping: build the calculator cdylib first (cargo build --release -p rustra-calculator-example)',
    );
    return;
  }
  const createBytesChannel = await createBunChannelBytesBridge({ library: dylib });
  const received: Uint8Array[] = [];
  const channel = createBytesChannel((payload) => received.push(payload));
  expect(channel.handle).toBeInteger();
  expect(channel.handle).toBeGreaterThan(0);

  const channelSendBytes = openBytesSend(dylib);

  // 8바이트 LE u64 프레임 — channelDemoBytes 핸들러가 흘리는 프레임과 동일 형태.
  const frame = Buffer.alloc(8);
  frame.writeBigUInt64LE(42n);
  const delivered = channelSendBytes(channel.handle, frame, BigInt(frame.byteLength));
  await Bun.sleep(5);
  expect(delivered).toBe(1);
  assert.ok(received[0] instanceof Uint8Array, 'payload is a Uint8Array');
  assert.equal(received[0].byteLength, 8);
  assert.equal(readLeU64(received[0]), 42n);

  // 복사 계약 — 페이로드는 콜백 반환 전 JS 힙으로 복사된다. 이후 원본 버퍼를
  // 변조해도 수신 프레임은 불변이다(payload 는 콜백 동안만 유효, ffi_channel.rs).
  frame.writeBigUInt64LE(99n);
  assert.equal(readLeU64(received[0]), 42n, 'received frame is an owned copy');

  // 길이 0 프레임 — 빈 Uint8Array 로 전달한다(브릿지 가드).
  assert.equal(channelSendBytes(channel.handle, Buffer.alloc(1), 0n), 1);
  await Bun.sleep(5);
  assert.equal(received[1]?.byteLength, 0, 'zero-length frame delivers an empty Uint8Array');

  // close → drop. 이후 send_bytes 는 0(만료)이고 콜백에 도달하지 않는다.
  assert.equal(channel.close(), true);
  assert.equal(channel.close(), false, 'double close is a no-op');
  assert.equal(channelSendBytes(channel.handle, frame, BigInt(frame.byteLength)), 0);
  await Bun.sleep(5);
  assert.equal(received.length, 2, 'no frame after close');
});

test('bun bytes channel bridge: JS callback exceptions are isolated between frames', async () => {
  if (!dylibReady) return;
  const createBytesChannel = await createBunChannelBytesBridge({ library: dylib });
  const channelSendBytes = openBytesSend(dylib);

  const received: Uint8Array[] = [];
  let throwOnFirst = true;
  const channel = createBytesChannel((payload) => {
    if (throwOnFirst) {
      throwOnFirst = false;
      throw new Error('first bytes frame handler boom');
    }
    received.push(payload);
  });

  const frame = Buffer.alloc(8);
  frame.writeBigUInt64LE(1n);
  channelSendBytes(channel.handle, frame, BigInt(8));
  await Bun.sleep(5);
  frame.writeBigUInt64LE(2n);
  channelSendBytes(channel.handle, frame, BigInt(8));
  await Bun.sleep(5);
  assert.equal(received.length, 1, 'listener survived its own exception');
  assert.equal(readLeU64(received[0]), 2n);
  channel.close();
});

test('bun bytes channel bridge: channelDemoBytes round-trips LE u64 frames through the rkyv registry (real cdylib)', async () => {
  if (!dylibReady) return;
  const { createBunFfiEngine } = await import('./index.js');
  // 생성된 레지스트리를 그대로 코덱 소스로 쓴다(node e2e 의 channelDemo 왕복과
  // 동일한 증거를 bytes 경로로 — channelDemoBytesCodec 는 cmd_id=31).
  const { rkyvV2Registry } = await import(
    resolve(repoRoot, 'examples/calculator/generated/rkyv-registry.ts')
  );
  const runtime = await createBunFfiEngine({ library: dylib, rkyvV2Codecs: rkyvV2Registry });
  try {
    const createBytesChannel = await createBunChannelBytesBridge({ library: dylib });
    const frames: Uint8Array[] = [];
    const channel = createBytesChannel((payload) => frames.push(payload));
    expect(channel.handle).toBeInteger();
    expect(channel.handle).toBeGreaterThan(0);

    // channelDemoBytes 는 동기 핸들러 안에서 8바이트 LE u64(step+1) 프레임을
    // send_bytes 한다 — FFI invoke 체인(JS 스레드) 안의 send 다. 실증상 콜백은
    // invoke 해결 전 도달하지만, 마이크로태스크 마샬링 여유를 두고 정착을 기다린다.
    const result = await runtime.engine.invoke<{ sent: number; droppedSends: number }>(
      'channelDemoBytes',
      { channel: channel.handle, ticks: 3 },
    );
    assert.deepEqual(result, { sent: 3, droppedSends: 0 });
    for (let i = 0; i < 100 && frames.length < 3; i += 1) await Bun.sleep(5);
    assert.equal(frames.length, 3, 'all 3 binary frames must reach the callback');
    assert.deepEqual(
      frames.map((frame) => Number(readLeU64(frame))),
      [1, 2, 3],
      'frames are the step counter as LE u64',
    );

    // close — 이후 send 는 droppedSends 로 보고되고 콜백에 도달하지 않는다.
    assert.equal(channel.close(), true);
    const after = await runtime.engine.invoke<{ sent: number; droppedSends: number }>(
      'channelDemoBytes',
      { channel: channel.handle, ticks: 1 },
    );
    assert.deepEqual(after, { sent: 0, droppedSends: 1 }, 'stale send is dropped, not delivered');
    assert.equal(frames.length, 3, 'no frames after close');
  } finally {
    runtime.close();
  }
});

test('bun bytes channel bridge: one handle serves exactly one path (JSON xor bytes)', async () => {
  if (!dylibReady) return;
  const createChannel = await createBunChannelBridge({ library: dylib });
  const createBytesChannel = await createBunChannelBytesBridge({ library: dylib });
  const lib = dlopen(dylib, {
    rustra_ffi_channel_send: { args: [FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    rustra_ffi_channel_send_bytes: {
      args: [FFIType.u32, FFIType.ptr, 'usize' as const],
      returns: FFIType.i32,
    },
  });
  const jsonChannel = createChannel(() => {});
  const bytesChannel = createBytesChannel(() => {});
  const frame = Buffer.alloc(8);
  frame.writeBigUInt64LE(7n);

  // 어긋난 경로의 send 는 조용히 0(ffi_channel.rs — 한 핸들, 한 경로).
  assert.equal(
    lib.symbols.rustra_ffi_channel_send_bytes(jsonChannel.handle, frame, BigInt(8)),
    0,
    'bytes send on a JSON handle is dropped',
  );
  assert.equal(
    lib.symbols.rustra_ffi_channel_send(bytesChannel.handle, Buffer.from('{"a":1}\0')),
    0,
    'JSON send on a bytes handle is dropped',
  );
  // 각자의 경로로는 도달한다.
  assert.equal(
    lib.symbols.rustra_ffi_channel_send(jsonChannel.handle, Buffer.from('{"a":1}\0')),
    1,
  );
  assert.equal(lib.symbols.rustra_ffi_channel_send_bytes(bytesChannel.handle, frame, BigInt(8)), 1);
  jsonChannel.close();
  bytesChannel.close();
});

test('bun bytes channel bridge: throws TransportUnavailable when no library resolves', async () => {
  await expect(
    createBunChannelBytesBridge({ library: '/nonexistent/librustra.dylib' }),
  ).rejects.toThrow('channel');
});

test('bun bytes channel bridge: a non-Rustra dylib classifies as transport failure, not channel.unavailable', async () => {
  const foreign =
    process.platform === 'darwin' ? '/usr/lib/libz.1.dylib' : '/lib/x86_64-linux-gnu/libz.so.1';
  if (!existsSync(foreign)) return; // 플랫폼 기본 라이브러리 경로가 없으면 스킵.
  const error = await createBunChannelBytesBridge({ library: foreign }).then(
    () => null,
    (thrown: unknown) => thrown,
  );
  assert.ok(
    error instanceof RustraCommandError,
    'bridge loud-fails instead of returning a factory',
  );
  assert.equal(error.code, 'transport.unavailable');
});

// ── helpers ──────────────────────────────────────────────────

/** rustra_ffi_channel_send_bytes 심볼만 노출한 dlopen — 역방향 검증용. */
function openBytesSend(library: string) {
  return dlopen(library, {
    rustra_ffi_channel_send_bytes: {
      args: [FFIType.u32, FFIType.ptr, 'usize' as const],
      returns: FFIType.i32,
    },
  }).symbols.rustra_ffi_channel_send_bytes;
}

/** Uint8Array 프레임을 LE u64 로 읽는다(channelDemoBytes 스텝 카운터 인코딩). */
function readLeU64(frame: Uint8Array): bigint {
  return new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getBigUint64(0, true);
}
