import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { SubscriberMap, parseJsonPayload, type EventCallback } from './bun-event-subscribers.js';
import type { BunEventBridge } from './bun-events.js';

const requireFfi = createRequire(import.meta.url);
type Hub = ReturnType<typeof createHub>;
const hubs = new Map<string, Hub>();

/** One native sink per loaded library, shared by independently owned bridge leases. */
export function createBunFfiEventBridge(libraryPath: string): BunEventBridge {
  const key = realpathSync(libraryPath);
  let hub = hubs.get(key);
  if (!hub) {
    hub = createHub(key);
    hubs.set(key, hub);
  }
  const shared = hub;
  shared.acquire();
  const subscriptions = new Set<() => void>();
  let disposed = false;
  return {
    subscribeEvent(name, callback) {
      if (disposed) throw new Error('Bun event bridge was disposed');
      // A unique wrapper gives each subscription its own identity, including same callbacks.
      const listener: EventCallback = (payload) => callback(payload);
      const detach = shared.subscribe(name, listener);
      let active = true;
      const unsubscribe = () => {
        if (!active) return;
        active = false;
        subscriptions.delete(unsubscribe);
        detach();
      };
      subscriptions.add(unsubscribe);
      return unsubscribe;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const unsubscribe of [...subscriptions]) unsubscribe();
      shared.release();
    },
  };
}

function createHub(key: string) {
  // Resolve Bun only when invoked, preserving Node-safe package imports.
  const { dlopen, FFIType, JSCallback } = requireFfi('bun:ffi') as typeof import('bun:ffi');
  const library = dlopen(key, {
    rustra_ffi_event_sink_register: { args: ['ptr', 'ptr'], returns: FFIType.void },
    rustra_ffi_event_sink_unregister: { args: [], returns: FFIType.void },
  });
  const subscribers = new SubscriberMap();
  let callback: InstanceType<typeof JSCallback> | undefined;
  let leases = 0;
  let callbackDepth = 0;
  let cleanupScheduled = false;
  let closed = false;
  const cleanup = () => {
    if (closed || callbackDepth || !subscribers.isEmpty()) return;
    if (callback) {
      library.symbols.rustra_ffi_event_sink_unregister();
      callback.close();
      callback = undefined;
    }
    if (leases === 0) {
      closed = true;
      library.close();
      hubs.delete(key);
    }
  };
  const requestCleanup = () => {
    if (callbackDepth === 0) {
      cleanup();
      return;
    }
    if (cleanupScheduled) return;
    cleanupScheduled = true;
    // Native unregister waits for in-flight callbacks; never invoke it in that callback.
    queueMicrotask(() => {
      cleanupScheduled = false;
      cleanup();
    });
  };
  const register = () => {
    if (callback) return;
    callback = new JSCallback(
      (_userData: unknown, name: string, payloadJson: string) => {
        callbackDepth++;
        try {
          subscribers.dispatch(name, parseJsonPayload(payloadJson, name));
        } finally {
          callbackDepth--;
        }
      },
      { args: ['ptr', 'cstring', 'cstring'], returns: 'void' },
    );
    library.symbols.rustra_ffi_event_sink_register(callback.ptr, null);
  };
  return {
    acquire() {
      leases++;
    },
    release() {
      leases--;
      requestCleanup();
    },
    subscribe(name: string, listener: EventCallback) {
      register();
      subscribers.add(name, listener);
      return () => {
        subscribers.remove(name, listener);
        requestCleanup();
      };
    },
  };
}
