import { encode, decode } from "@msgpack/msgpack";
import type { EngineClient, RustraNative } from "@rustra/types";

export function createMsgpackEngine(native: RustraNative): EngineClient {
  return {
    invoke<T>(command: string, args?: unknown): Promise<T> {
      const payload = encode({ command, args });
      const resultBytes = native.invokeMsgpack(
        payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength),
      );
      const response = decode(new Uint8Array(resultBytes)) as {
        ok: boolean;
        result?: T;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(response.error ?? "Rustra msgpack invoke failed");
      }
      return Promise.resolve(response.result as T);
    },
  };
}
