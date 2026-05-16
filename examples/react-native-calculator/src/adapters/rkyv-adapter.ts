import type { EngineClient, RustraNative } from '@rustra/types';

const RKYV_REQUEST_SIZE = 40;
const RKYV_A_OFFSET = 24;
const RKYV_B_OFFSET = 32;

const RKYV_ADDNUMBERS_HEADER = new Uint8Array([
  0x61, 0x64, 0x64, 0x4e, 0x75, 0x6d, 0x62, 0x65, 0x72, 0x73, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x8a, 0x00, 0x00, 0x00, 0xf0, 0xff, 0xff, 0xff,
]);

const RKYV_RESP_OK_OFFSET = 0;
const RKYV_RESP_VALUE_OFFSET = 8;

export function createRkyvEngine(native: RustraNative): EngineClient {
  return {
    invoke<T>(command: string, args?: unknown): Promise<T> {
      if (command !== 'addNumbers') {
        throw new Error(`Rkyv: unsupported command "${command}"`);
      }
      const { a, b } = args as { a: number; b: number };

      const buf = new ArrayBuffer(RKYV_REQUEST_SIZE);
      const u8 = new Uint8Array(buf);
      u8.set(RKYV_ADDNUMBERS_HEADER, 0);

      const view = new DataView(buf);
      view.setInt32(RKYV_A_OFFSET, a, true);
      view.setInt32(RKYV_A_OFFSET + 4, a >= 0 ? 0 : -1, true);
      view.setInt32(RKYV_B_OFFSET, b, true);
      view.setInt32(RKYV_B_OFFSET + 4, b >= 0 ? 0 : -1, true);

      const resultBytes = native.invokeRkyv(buf);
      return Promise.resolve(parseRkyvResponse(resultBytes) as T);
    },
  };
}

function parseRkyvResponse(buf: ArrayBuffer): { value: number } {
  const u8 = new Uint8Array(buf);
  const view = new DataView(buf);

  const ok = u8[RKYV_RESP_OK_OFFSET] === 1;
  if (!ok) {
    throw new Error('Rkyv: invoke failed');
  }

  const lo = view.getInt32(RKYV_RESP_VALUE_OFFSET, true);
  return { value: lo };
}
