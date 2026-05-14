import type { EngineClient } from "@rustra/types";

export type RkyvV2Native = {
  invokeRkyvV2(payload: ArrayBuffer): ArrayBuffer;
};

export type RkyvV2Codec<I, O> = {
  commandId: number;
  encode(args: I): ArrayBuffer;
  decode(buf: ArrayBuffer): { ok: boolean; result?: O; error?: string };
};

export function createRkyvV2Engine(
  native: RkyvV2Native,
  registry: Map<string, RkyvV2Codec<any, any>>,
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

// ── rkyv v2 fixed-offset layout ──
// Verified by Rust test: test_cmd_request_wire_format
//
// CmdRequest (24 bytes, always fixed):
//   offset  0-7:  command_id (u16 LE + 6B padding to i64 align)
//   offset  8-15: a (i64 LE)
//   offset 16-23: b (i64 LE)
//
// RkyvResponse (32 bytes, always fixed):
//   offset  0-7:  ok (bool + 7B padding)
//   offset  8-15: value (i64 LE)
//   offset 16-31: error (Option<String>, 16B for None)

const REQ_SIZE = 24;
const REQ_CMD_OFFSET = 0;
const REQ_A_OFFSET = 8;
const REQ_B_OFFSET = 16;

const RESP_OK_OFFSET = 0;
const RESP_VALUE_OFFSET = 8;

function parseResponse(buf: ArrayBuffer): { ok: boolean; result?: { value: number }; error?: string } {
  if (buf.byteLength < 16) return { ok: false, error: "response too short" };
  const u8 = new Uint8Array(buf);
  const view = new DataView(buf);

  const ok = u8[RESP_OK_OFFSET] === 1;
  if (!ok) {
    return { ok: false, error: "rkyv v2 invoke failed" };
  }

  const lo = view.getInt32(RESP_VALUE_OFFSET, true);
  return { ok: true, result: { value: lo } };
}

// ── Codec registry ──

export const COMMAND_IDS = {
  addNumbers: 1,
} as const;

export const addNumbersCodec: RkyvV2Codec<
  { a: number; b: number },
  { value: number }
> = {
  commandId: COMMAND_IDS.addNumbers,

  encode(args: { a: number; b: number }): ArrayBuffer {
    const buf = new ArrayBuffer(REQ_SIZE);
    const view = new DataView(buf);
    view.setUint16(REQ_CMD_OFFSET, this.commandId, true);
    // Hermes doesn't support setBigInt64, use two setInt32 for i64
    view.setInt32(REQ_A_OFFSET, args.a, true);
    view.setInt32(REQ_A_OFFSET + 4, args.a >= 0 ? 0 : -1, true);
    view.setInt32(REQ_B_OFFSET, args.b, true);
    view.setInt32(REQ_B_OFFSET + 4, args.b >= 0 ? 0 : -1, true);
    return buf;
  },

  decode: parseResponse,
};

export const rkyvV2Registry = new Map<string, RkyvV2Codec<any, any>>([
  ["addNumbers", addNumbersCodec],
]);
