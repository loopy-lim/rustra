import type { EngineClient, RkyvV2Codec } from "@rustra/types";
import { rkyvV2Registry as generatedRegistry } from "../../calculator/generated/rkyv-registry.js";

export type RkyvV2Native = {
  invokeRkyvV2(payload: ArrayBuffer): ArrayBuffer;
};

export { type RkyvV2Codec };

export function createRkyvV2Engine(
  native: RkyvV2Native,
  registry: Map<string, RkyvV2Codec<any, any>> = generatedRegistry,
): EngineClient {
  return {
    invoke<T>(command: string, args?: unknown): Promise<T> {
      const codec = registry.get(command);
      if (!codec) {
        throw new Error(`RkyvV2: no codec for "${command}"`);
      }
      const payload = codec.encode(args);
      const resultBytes = native.invokeRkyvV2(payload);
      const response = codec.decode(resultBytes);
      if (!response.ok) {
        throw new Error(response.error ?? "Rustra rkyv v2 invoke failed");
      }
      return Promise.resolve(response.result as T);
    },
  };
}

export { generatedRegistry as rkyvV2Registry };
