import { test, mock } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { GENERATED_CONTRACT_HASH } from '../generated/contract.js';
import schema from '../generated/schema.json';

// Host integration only. These injected native methods are never performance receipts.
const modules: { RustraBridge?: { install(): boolean } } = {};
mock.module('react-native', () => ({ NativeModules: modules }));
const bridge = await import('../modules/rustra-bridge/src/index.js');
mock.module('@rustra/generated-react-native', () => bridge);

test('generated native installer fails clearly when autolinking or installation is missing', async () => {
  delete modules.RustraBridge;
  await assert.rejects(bridge.installRustraJSI(), /not linked/);
  modules.RustraBridge = { install: () => false };
  await assert.rejects(bridge.installRustraJSI(), /reported failure/);
});

test('native collector uses both native routes and allows only one receipt per runtime', async () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = {
    native: globals.__rustraNative,
    hermes: globals.HermesInternal,
    dev: globals.__DEV__,
  };
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const pack = (value: unknown) => encoder.encode(JSON.stringify(value)).buffer as ArrayBuffer;
  let jsonCalls = 0;
  let bytesCalls = 0;
  const transform = (command: string, bytes: Uint8Array) =>
    Array.from(command === 'gzipCompress' ? gzipSync(bytes) : gunzipSync(bytes));
  globals.__rustraNative = {
    invokeFrame: () => {
      throw new Error('buffer benchmark must not fall back to Frame');
    },
    getSchema: () => pack(schema),
    getContractHash: () => encoder.encode(GENERATED_CONTRACT_HASH).buffer,
    getCodecCapabilities: () => 8,
    invoke: (request: ArrayBuffer) => {
      jsonCalls++;
      const { command, args } = JSON.parse(decoder.decode(request));
      return pack({ ok: true, result: { data: transform(command, Uint8Array.from(args.data)) } });
    },
    invokeTypedBuffer: (id: number, bytes: Uint8Array) => {
      bytesCalls++;
      const command = schema.commands.find((entry) => entry.commandId === id)?.name;
      assert.ok(command);
      return { data: Uint8Array.from(transform(command, bytes)) };
    },
  };
  modules.RustraBridge = { install: () => true };
  globals.HermesInternal = {};
  globals.__DEV__ = false;
  const { runNativeBenchmark } = await import('./native-benchmark.js');
  const options = {
    launchId: 'host-integration-fixture',
    order: 'json-bytes' as const,
    iterations: 20,
    warmup: 1,
    payloadSizes: [1024],
    sha256: (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex'),
    metadata: {
      platform: 'ios' as const,
      target: 'simulator' as const,
      device: 'mock-fixture',
      osVersion: 'test',
      runtime: 'hermes' as const,
      runtimeVersion: 'test',
      reactNativeVersion: 'test',
      buildMode: 'release' as const,
      sourceRevision: '1'.repeat(40),
      sourceSha256: '2'.repeat(64),
      nativeSha256: '3'.repeat(64),
      bundleSha256: '4'.repeat(64),
      contractHash: GENERATED_CONTRACT_HASH,
    },
  };
  try {
    const receipt = await runNativeBenchmark(options);
    assert.equal(receipt.lanes.length, 4);
    assert.equal(jsonCalls, 44);
    assert.equal(bytesCalls, 42);
    await assert.rejects(runNativeBenchmark(options), /Restart the native app/);
  } finally {
    globals.__rustraNative = previous.native;
    globals.HermesInternal = previous.hermes;
    globals.__DEV__ = previous.dev;
    mock.restore();
  }
});
