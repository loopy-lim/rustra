/** @rustra/node — Node.js transport and generated-engine adapters. */
export type {
  EngineClient,
  EngineSupports,
  RustraError,
  FrameCodec,
  FrameNative,
  InvokeOptions,
  EngineClientWithBatch,
} from '@rustra/types';
export {
  RustraCommandError,
  configure,
  configureLazy,
  disposedBootstrapError,
  ensureConfigured,
  invoke,
  createFrameEngine,
} from '@rustra/types';
export * from './node-core.js';
export * from './node-bootstrap.js';
export * from './node-loop.js';
export { subscribeEvent, type NodeEventTransport } from './node-events.js';
export type {
  NodeEventSubscription,
  NodeEventSubscriptionOptions,
} from './node-event-subscription.js';
export { createNodeEventSubscription } from './node-event-subscription.js';
export type {
  NodeChannel,
  NodeChannelCallback,
  NodeBytesChannel,
  NodeBytesChannelCallback,
} from './node-channels.js';
export { createNodeChannel, createNodeBytesChannel } from './node-channels.js';
