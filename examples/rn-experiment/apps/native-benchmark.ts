// Import this entry from an installed RN release app that links modules/rustra-bridge.
import { createReactNativeEngine } from '@rustra/react-native';
import { decodeUtf8, parseLiveSchemaDocument } from '@rustra/types';
import { rustra } from '../generated/react-native.js';
import { GENERATED_CONTRACT_HASH } from '../generated/contract.js';
import { getRustraNative } from '../modules/rustra-bridge/src/index.js';
import {
  asBytes,
  collectBenchmark,
  type BenchmarkOptions,
  type BenchmarkReceipt,
  type GzipCommand,
} from './benchmark.js';

const runtimeInstanceId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
let consumed = false;

/** One receipt per JS runtime; collecting five receipts requires five app launches. */
export async function runNativeBenchmark(
  options: Omit<BenchmarkOptions, 'runtimeInstanceId'>,
): Promise<BenchmarkReceipt> {
  if (consumed)
    throw new Error('Restart the native app before collecting another independent receipt');
  if (
    !(globalThis as Record<string, unknown>).HermesInternal ||
    (globalThis as Record<string, unknown>).__DEV__ !== false
  ) {
    throw new Error(
      'The native benchmark requires a release Hermes app; host mocks and debug builds are not performance evidence',
    );
  }
  consumed = true;
  try {
    await rustra.ready();
    const native = getRustraNative();
    if (
      typeof native.invokeTypedBuffer !== 'function' ||
      typeof native.getCodecCapabilities !== 'function'
    ) {
      throw new Error(
        'The installed native module does not support the bytes route; rebuild the native app',
      );
    }
    const installedHash = native.getContractHash && decodeUtf8(native.getContractHash());
    if (
      installedHash !== GENERATED_CONTRACT_HASH ||
      options.metadata.contractHash !== installedHash
    ) {
      throw new Error('Receipt, generated contract and installed native contract must match');
    }
    const schema = parseLiveSchemaDocument(native);
    const ids = new Map<GzipCommand, number>();
    for (const command of ['gzipCompress', 'gzipDecompress'] as const) {
      const id = schema.commands.get(command)?.commandId;
      if (id === undefined || (native.getCodecCapabilities(id) & 8) === 0) {
        throw new Error(`${command} does not advertise the native buffer route`);
      }
      ids.set(command, id);
    }
    const json = createReactNativeEngine(native);
    return await collectBenchmark(
      {
        json: async (command, bytes) =>
          asBytes(
            (await json.invoke<{ data: unknown }>(command, { data: Array.from(bytes) })).data,
          ),
        bytes: (command, bytes) => {
          const result = native.invokeTypedBuffer!(ids.get(command)!, bytes) as { data?: unknown };
          return asBytes(result.data);
        },
      },
      { ...options, runtimeInstanceId },
    );
  } finally {
    rustra.dispose();
  }
}
