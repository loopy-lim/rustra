import type { EngineClient } from "@rustra/types";

export type JsonNative = {
  invoke(payload: ArrayBuffer): ArrayBuffer;
};

export function createJsonEngine(native: JsonNative): EngineClient {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  return {
    invoke<T>(command: string, args?: unknown): Promise<T> {
      const json = JSON.stringify({ command, args });
      const payload = encoder.encode(json);
      const resultBytes = native.invoke(payload.buffer);
      const resultJson = decoder.decode(resultBytes);
      const response = JSON.parse(resultJson) as {
        ok: boolean;
        result?: T;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(response.error ?? "Rustra invoke failed");
      }
      return Promise.resolve(response.result as T);
    },
  };
}
