import type { EngineClient } from "@rustra/types";

export type HybridNative = {
  invokeHybrid(payload: ArrayBuffer): ArrayBuffer;
};

export type HybridCodec<I, O> = {
  encode(args: I): ArrayBuffer;
  decode(buf: ArrayBuffer): { ok: boolean; result?: O; error?: string };
};

export function createHybridEngine(
  native: HybridNative,
  registry: Map<string, HybridCodec<any, any>>,
): EngineClient {
  return {
    invoke<T>(command: string, args?: unknown): Promise<T> {
      const codec = registry.get(command);
      if (!codec) {
        throw new Error(`Hybrid: no codec for "${command}"`);
      }
      const payload = codec.encode(args);
      const resultBytes = native.invokeHybrid(payload);
      const response = codec.decode(resultBytes);
      if (!response.ok) {
        throw new Error(response.error ?? "Rustra hybrid invoke failed");
      }
      return Promise.resolve(response.result as T);
    },
  };
}

// ── LEB128 varint + zigzag (postcard format for requests) ──

function encodeVarint(value: number): number[] {
  const bytes: number[] = [];
  let v = value >>> 0;
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v & 0x7f);
  return bytes;
}

function zigzag(n: number): number {
  return n >= 0 ? n * 2 : (-n) * 2 - 1;
}

function encodeVarintString(str: string): number[] {
  const len = str.length;
  const bytes: number[] = [...encodeVarint(len)];
  for (let i = 0; i < len; i++) bytes.push(str.charCodeAt(i));
  return bytes;
}

// ── rkyv fixed-offset response parsing ──
// ArchivedRkyvResponse layout:
//   offset 0: ok (1 byte + 7 padding)
//   offset 8: value (i64 LE, 8 bytes)
//   offset 16+: error (Option<String>, 16 bytes for None)

const RESP_OK_OFFSET = 0;
const RESP_VALUE_OFFSET = 8;

function parseRkyvResponse(buf: ArrayBuffer): { ok: boolean; result?: { value: number }; error?: string } {
  if (buf.byteLength < 16) return { ok: false, error: "response too short" };
  const u8 = new Uint8Array(buf);
  const view = new DataView(buf);

  const ok = u8[RESP_OK_OFFSET] === 1;
  if (!ok) {
    return { ok: false, error: "hybrid invoke failed" };
  }

  const lo = view.getInt32(RESP_VALUE_OFFSET, true);
  return { ok: true, result: { value: lo } };
}

// ── Codec: postcard encode → rkyv decode ──

export const addNumbersCodec: HybridCodec<
  { a: number; b: number },
  { value: number }
> = {
  encode(args: { a: number; b: number }): ArrayBuffer {
    const header = encodeVarintString("addNumbers");
    const aBytes = encodeVarint(zigzag(args.a));
    const bBytes = encodeVarint(zigzag(args.b));
    const total = header.length + aBytes.length + bBytes.length;
    const buf = new ArrayBuffer(total);
    const u8 = new Uint8Array(buf);
    let off = 0;
    u8.set(header, off); off += header.length;
    u8.set(aBytes, off); off += aBytes.length;
    u8.set(bBytes, off);
    return buf;
  },

  decode: parseRkyvResponse,
};

export const hybridRegistry = new Map<string, HybridCodec<any, any>>([
  ["addNumbers", addNumbersCodec],
]);
