/** @rustra/bun — Bun JSON transport and FFI adapter. */
export type {
  EngineClient,
  BootstrapState,
  RustraError,
  RkyvV2Codec,
  RkyvV2Native,
  RkyvV2EngineOptions,
  InvokeOptions,
  RkyvV2Engine,
  EngineSupports,
} from '@rustra/types';
export {
  RustraCommandError,
  configure,
  configureLazy,
  disposedBootstrapError,
  ensureConfigured,
  invoke,
  createRkyvV2Engine,
  createJsonEngine,
} from '@rustra/types';
import { createJsonEngine } from '@rustra/types';
import { BUN_ENGINE_SUPPORTS } from './bun-ffi.js';
export { BUN_ENGINE_SUPPORTS, BUN_RKYV_V2_ENGINE_SUPPORTS } from './bun-ffi.js';

export type BunInvokeTransport = {
  invoke(command: string, args?: unknown): Promise<unknown> | unknown;
};

export function createBunEngine(transport: BunInvokeTransport) {
  return createJsonEngine((command, args) => transport.invoke(command, args), undefined, {
    ...BUN_ENGINE_SUPPORTS,
  });
}

export type { BunFfiEngineOptions, BunFfiRuntime } from './bun-ffi-library.js';
export { createBunFfiEngine, createBunBootstrap } from './bun-ffi.js';
export type { BunBootstrap } from './bun-ffi.js';
export type { BunEventBridge, BunEventBridgeOptions, BunEventDrainSource } from './bun-events.js';
export { createBunEventBridge } from './bun-events.js';
export type {
  BunEventSubscription,
  BunEventSubscriptionOptions,
} from './bun-event-subscription.js';
export { createBunEventSubscription } from './bun-event-subscription.js';
