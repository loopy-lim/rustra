import { RustraCommandError } from '@rustra/types';
import { getRustraNative } from './react-native-core.js';

export type RustraEventNative = {
  onEvent?(name: string, callback: (payloadJson: string) => void): void;
  offEvent?(name: string): void;
};
export type RustraChannelNative = {
  createChannel?(callback: (payloadJson: string) => void): number;
  dropChannel?(handle: number): boolean;
};

export function createChannel(
  callback: (payload: unknown) => void,
  native: RustraChannelNative = getRustraNative(),
): { readonly handle: number; close(): boolean } {
  if (typeof native.createChannel !== 'function' || typeof native.dropChannel !== 'function') {
    throw new RustraCommandError(
      'channel.unavailable',
      'native module must expose createChannel() and dropChannel(); channel support is unavailable',
    );
  }
  let closed = false;
  const handle = native.createChannel((payloadJson) => {
    if (closed) return;
    try {
      callback(JSON.parse(payloadJson));
    } catch {
      callback(null);
    }
  });
  if (!Number.isSafeInteger(handle) || handle < 0)
    throw new RustraCommandError(
      'channel.unavailable',
      'native createChannel() returned an invalid handle; expected a non-negative safe integer',
    );
  return { handle, close: () => (closed ? false : ((closed = true), native.dropChannel!(handle))) };
}

const nativeListeners = new WeakMap<
  RustraEventNative,
  Map<string, Set<(payload: unknown) => void>>
>();
type SubscribeOptions = { allowMissingNative?: boolean };

export function subscribeEvent(
  name: string,
  cb: (payload: unknown) => void,
  options?: SubscribeOptions,
): () => void;
/** @deprecated Pass `(name, callback)`; this overload remains for 0.x compatibility. */
export function subscribeEvent(
  native: RustraEventNative,
  name: string,
  cb: (payload: unknown) => void,
  options?: SubscribeOptions,
): () => void;
export function subscribeEvent(
  nativeOrName: RustraEventNative | string,
  nameOrCallback: string | ((payload: unknown) => void),
  callbackOrOptions?: ((payload: unknown) => void) | SubscribeOptions,
  legacyOptions: SubscribeOptions = {},
): () => void {
  const canonical = typeof nativeOrName === 'string';
  const native = canonical ? getRustraNative() : nativeOrName;
  const name = canonical ? nativeOrName : (nameOrCallback as string);
  const callback = (canonical ? nameOrCallback : callbackOrOptions) as (payload: unknown) => void;
  const options = (canonical ? callbackOrOptions : legacyOptions) as SubscribeOptions;
  if (typeof native.onEvent !== 'function') {
    if (options.allowMissingNative) return () => {};
    throw new RustraCommandError(
      'event.unavailable',
      'native module does not expose onEvent(); event subscription is unavailable',
    );
  }
  let events = nativeListeners.get(native);
  if (!events) nativeListeners.set(native, (events = new Map()));
  let listeners = events.get(name);
  if (!listeners) {
    events.set(name, (listeners = new Set()));
    native.onEvent(name, (json) => {
      let payload: unknown = null;
      try {
        if (json) payload = JSON.parse(json);
      } catch {
        /* malformed payload stays null */
      }
      for (const listener of events?.get(name) ?? []) {
        try {
          listener(payload);
        } catch (error) {
          console.error(`Rustra: event listener for "${name}" threw:`, error);
        }
      }
    });
  }
  listeners.add(callback);
  return () => {
    const current = events?.get(name);
    if (!current) return;
    current.delete(callback);
    if (current.size === 0) {
      events?.delete(name);
      native.offEvent?.(name);
    }
  };
}
