import { createFrameEngine as createBaseEngine } from '@rustra/types';
import type { EngineClient, RustraNative } from '@rustra/types';
import { GENERATED_CONTRACT_HASH, SCHEMA_VERSION } from '../../../calculator/generated/contract';
import { frameRegistry } from '../../../calculator/generated/frame-registry';

export { frameRegistry };

export const createFrameEngine = (
  native: RustraNative,
  registry: Map<string, import('@rustra/types').FrameCodec<any, any>> = frameRegistry,
): EngineClient =>
  createBaseEngine(native, registry, {
    contractHash: GENERATED_CONTRACT_HASH,
    schemaVersion: SCHEMA_VERSION,
  });
