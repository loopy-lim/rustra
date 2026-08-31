// JS wrapper for the RustraWasmSpike native module.
import { NativeModules, Platform } from 'react-native';

type BytesHexResult = { hex: string; ms: number };

type SwapResult = {
  engineVersion: number;
  contractHash: string;
  instantiateMs: number;
  path: string;
};

type RustraWasmSpikeModuleType = {
  loadBundledEngine(): Promise<{
    engineVersion: number;
    contractHash: string;
    instantiateMs: number;
    path: string;
  }>;
  reloadWasm(newPath: string): Promise<{
    engineVersion: number;
    contractHash: string;
    instantiateMs: number;
    path: string;
  }>;
  /** iOS: re-instantiate from Documents/engine_v2.wasm (adb/simctl-pushed). */
  reloadWasmFromDocuments?(): Promise<SwapResult>;
  /** Android: re-instantiate from filesDir/engine_v2.wasm (adb-pushed). */
  reloadWasmFromAppFiles?(): Promise<SwapResult>;
  evalCommandWasm(bytes: number[]): Promise<BytesHexResult>;
  evalCommandNative(bytes: number[]): Promise<BytesHexResult>;
  makeEnvelope(
    command: string,
    argsJson: string,
  ): Promise<{ hex: string; bytes: number[] }>;
};

const NativeRustraWasmSpike = NativeModules.RustraWasmSpikeModule as
  RustraWasmSpikeModuleType | undefined;

export const spikeAvailable = Boolean(NativeRustraWasmSpike);

/** Envelope built natively (single source of truth for byte construction). */
export async function makeEnvelope(
  command: string,
  argsJson: string,
): Promise<number[]> {
  if (!NativeRustraWasmSpike)
    throw new Error('RustraWasmSpike native module unavailable');
  const { bytes } = await NativeRustraWasmSpike.makeEnvelope(command, argsJson);
  return bytes;
}

export async function loadBundledEngine() {
  if (!NativeRustraWasmSpike)
    throw new Error('RustraWasmSpike native module unavailable');
  return NativeRustraWasmSpike.loadBundledEngine();
}

export async function reloadWasm(newPath: string) {
  if (!NativeRustraWasmSpike)
    throw new Error('RustraWasmSpike native module unavailable');
  return NativeRustraWasmSpike.reloadWasm(newPath);
}

/** Platform-appropriate swap: push engine_v2.wasm first, then call this. */
export async function reloadSwappedEngine(): Promise<SwapResult> {
  if (!NativeRustraWasmSpike)
    throw new Error('RustraWasmSpike native module unavailable');
  const m = NativeRustraWasmSpike;
  if (Platform.OS === 'ios' && m.reloadWasmFromDocuments)
    return m.reloadWasmFromDocuments();
  if (Platform.OS === 'android' && m.reloadWasmFromAppFiles)
    return m.reloadWasmFromAppFiles();
  throw new Error('no swap reload method on this platform');
}

export async function evalCommandWasm(
  bytes: number[],
): Promise<BytesHexResult> {
  if (!NativeRustraWasmSpike)
    throw new Error('RustraWasmSpike native module unavailable');
  return NativeRustraWasmSpike.evalCommandWasm(bytes);
}

export async function evalCommandNative(
  bytes: number[],
): Promise<BytesHexResult> {
  if (!NativeRustraWasmSpike)
    throw new Error('RustraWasmSpike native module unavailable');
  return NativeRustraWasmSpike.evalCommandNative(bytes);
}
