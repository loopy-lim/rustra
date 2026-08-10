import { NativeModules, Platform } from 'react-native';

export type RustraNative = {
  invoke(payload: ArrayBuffer): ArrayBuffer;
  invokeMsgpack(payload: ArrayBuffer): ArrayBuffer;
  invokeBincode(payload: ArrayBuffer): ArrayBuffer;
  invokePostcard(payload: ArrayBuffer): ArrayBuffer;
  invokeRkyv(payload: ArrayBuffer): ArrayBuffer;
  invokeHybrid(payload: ArrayBuffer): ArrayBuffer;
  invokeRkyvV2(payload: ArrayBuffer): ArrayBuffer;
  invokeRaw(payload: ArrayBuffer): ArrayBuffer;
  noop(payload: ArrayBuffer): ArrayBuffer;
  /** Live schema query (정적 + 동적 명령). C++ JSI 가 노출함. 동적 명령 Tier 3 fallback 에 사용. */
  getSchema?(): ArrayBuffer;
  /** B1 (RN JSI): 정적 명령 전용 C++ postcard fast path. */
  hasStaticCodec?(name: string): boolean;
  invokeTyped?(name: string, args: unknown): unknown;
  /** P0-2: 정적 명령 N 개를 단일 JSI 횡단으로 일괄 처리. */
  invokeTypedBatch?(names: string[], args: unknown[]): unknown[];
};

declare global {
  // eslint-disable-next-line no-var
  var __rustraNative: RustraNative | undefined;
}

export async function installRustraJSI(): Promise<void> {
  const module = NativeModules.RustraJSI;
  if (!module) {
    throw new Error('RustraJSI native module not found. Make sure the native module is linked.');
  }
  await module.install();

  if (!globalThis.__rustraNative) {
    throw new Error('RustraJSI.install() completed but __rustraNative was not set on globalThis.');
  }
}

export function getRustraNative(): RustraNative {
  const native = globalThis.__rustraNative;
  if (!native) {
    throw new Error('RustraJSI native module not installed. Call installRustraJSI() first.');
  }
  return native;
}
