import { createRkyvV2Engine as createBaseEngine } from "@rustra/types";
import type { EngineClient, RustraNative } from "@rustra/types";
import { rkyvV2Registry } from "../../../calculator/generated/rkyv-registry";

export { rkyvV2Registry };

export const createRkyvV2Engine = (
  native: RustraNative,
  registry: Map<string, import("@rustra/types").RkyvV2Codec<any, any>> = rkyvV2Registry,
): EngineClient => createBaseEngine(native, registry);
