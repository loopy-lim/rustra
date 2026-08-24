import { createRkyvV2Engine as createBaseEngine } from '@rustra/types';
import type { EngineClient, RustraNative } from '@rustra/types';
import { GENERATED_CONTRACT_HASH, SCHEMA_VERSION } from '../../../calculator/generated/contract';
import { rkyvV2Registry } from '../../../calculator/generated/rkyv-registry';

export { rkyvV2Registry };

export const createRkyvV2Engine = (
  native: RustraNative,
  registry: Map<string, import('@rustra/types').RkyvV2Codec<any, any>> = rkyvV2Registry,
): EngineClient =>
  createBaseEngine(native, registry, {
    contractHash: GENERATED_CONTRACT_HASH,
    schemaVersion: SCHEMA_VERSION,
  });
