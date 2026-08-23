import type { EngineClient, RustraNative } from '@rustra/types';
import { decodeUtf8, encodeUtf8, exactArrayBuffer } from '../utf8';

export function createJsonEngine(native: RustraNative): EngineClient {
  return {
    invoke<T>(command: string, args?: unknown): Promise<T> {
      const json = JSON.stringify({ command, args });
      const resultBytes = native.invoke(exactArrayBuffer(encodeUtf8(json)));
      const resultJson = decodeUtf8(resultBytes);
      const response = JSON.parse(resultJson) as {
        ok: boolean;
        result?: T;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(response.error ?? 'Rustra invoke failed');
      }
      return Promise.resolve(response.result as T);
    },
  };
}
