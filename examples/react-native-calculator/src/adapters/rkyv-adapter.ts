import type { EngineClient } from "@rustra/types";

export type RkyvNative = {
  invokeRkyv(payload: ArrayBuffer): ArrayBuffer;
};

// rkyv 0.8 fixed-offset layout for RkyvRequest { command: String, a: i64, b: i64 }
// [string_content (10B)] [padding (6B)] [meta (4B)] [rel_offset (4B)] [a: i64 LE (8B)] [b: i64 LE (8B)]
const RKYV_REQUEST_SIZE = 40;
const RKYV_A_OFFSET = 24;
const RKYV_B_OFFSET = 32;

// Pre-built rkyv request header for "addNumbers" (bytes 0-23 are constant)
const RKYV_ADDNUMBERS_HEADER = new Uint8Array([
  // String content: "addNumbers"
  0x61, 0x64, 0x64, 0x4e, 0x75, 0x6d, 0x62, 0x65, 0x72, 0x73,
  // Padding to 16-byte boundary
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  // String metadata (length encoding)
  0x8a, 0x00, 0x00, 0x00,
  // Relative offset (-16)
  0xf0, 0xff, 0xff, 0xff,
]);

// rkyv response: ArchivedRkyvResponse { ok: bool, value: i64, error: Option<String> }
// Layout: [ok: 1B + 7B padding] [value: i64 LE 8B] [error: 16B]
const RKYV_RESP_OK_OFFSET = 0;
const RKYV_RESP_VALUE_OFFSET = 8;

export function createRkyvEngine(native: RkyvNative): EngineClient {
  return {
    invoke<T>(command: string, args?: unknown): Promise<T> {
      // Only addNumbers supported for now (codegen would generate per-command)
      if (command !== "addNumbers") {
        throw new Error(`Rkyv: unsupported command "${command}"`);
      }
      const { a, b } = args as { a: number; b: number };

      const buf = new ArrayBuffer(RKYV_REQUEST_SIZE);
      const u8 = new Uint8Array(buf);
      u8.set(RKYV_ADDNUMBERS_HEADER, 0);

      // Write a and b as i64 LE at fixed offsets
      const view = new DataView(buf);
      // Hermes doesn't support setBigInt64, use two int32 writes
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
    throw new Error("Rkyv: invoke failed");
  }

  // Read i64 LE as two int32 (Hermes-safe)
  const lo = view.getInt32(RKYV_RESP_VALUE_OFFSET, true);
  const _hi = view.getInt32(RKYV_RESP_VALUE_OFFSET + 4, true);
  // For values that fit in 32 bits, lo is sufficient
  return { value: lo };
}
