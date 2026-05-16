import { NativeModules } from 'react-native';

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
};

declare global {
  // eslint-disable-next-line no-var
  var __rustraNative: RustraNative | undefined;
}

export async function installRustraJSI(): Promise<void> {
  const module = NativeModules.RustraJSI;
  if (!module) {
    throw new Error(
      'RustraJSI native module not found. Make sure the native module is linked.',
    );
  }
  await module.install();

  if (!globalThis.__rustraNative) {
    throw new Error(
      'RustraJSI.install() completed but __rustraNative was not set on globalThis.',
    );
  }
}

export function getRustraNative(): RustraNative {
  const native = globalThis.__rustraNative;
  if (!native) {
    throw new Error(
      'RustraJSI native module not installed. Call installRustraJSI() first.',
    );
  }
  return native;
}
