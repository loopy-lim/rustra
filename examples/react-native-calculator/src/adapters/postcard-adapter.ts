import type { EngineClient, RustraNative, RkyvV2Codec } from '@rustra/types';

export type PostcardCodec<I, O> = RkyvV2Codec<I, O>;

export function createPostcardEngine(
  native: RustraNative,
  registry: Map<string, RkyvV2Codec<any, any>>,
): EngineClient {
  return {
    invoke<T>(command: string, args?: unknown): Promise<T> {
      const codec = registry.get(command);
      if (!codec) {
        throw new Error(`Postcard: no codec for "${command}"`);
      }
      const payload = codec.encode(args);
      const resultBytes = native.invokePostcard(payload);
      const response = codec.decode(resultBytes);
      if (!response.ok) {
        throw new Error(response.error ?? 'Rustra postcard invoke failed');
      }
      return Promise.resolve(response.result as T);
    },
  };
}

// ── LEB128 varint + zigzag (postcard standard wire format) ──

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
  return n >= 0 ? n * 2 : -n * 2 - 1;
}

function decodeVarint(bytes: Uint8Array, offset: number): [number, number] {
  let value = 0;
  let shift = 0;
  let i = offset;
  while (bytes[i] & 0x80) {
    value |= (bytes[i] & 0x7f) << shift;
    shift += 7;
    i++;
  }
  value |= bytes[i] << shift;
  i++;
  return [value, i];
}

function unzigzag(n: number): number {
  return (n >>> 1) ^ -(n & 1);
}

function encodeVarintString(str: string): number[] {
  const len = str.length;
  const bytes: number[] = [...encodeVarint(len)];
  for (let i = 0; i < len; i++) bytes.push(str.charCodeAt(i));
  return bytes;
}

// ── Codecs ────────────────────────────────────────────────

export const addNumbersCodec: PostcardCodec<{ a: number; b: number }, { value: number }> = {
  commandId: 1,
  encode(args: { a: number; b: number }): ArrayBuffer {
    const header = encodeVarintString('addNumbers');
    const aBytes = encodeVarint(zigzag(args.a));
    const bBytes = encodeVarint(zigzag(args.b));
    const total = header.length + aBytes.length + bBytes.length;
    const buf = new ArrayBuffer(total);
    const u8 = new Uint8Array(buf);
    let off = 0;
    u8.set(header, off);
    off += header.length;
    u8.set(aBytes, off);
    off += aBytes.length;
    u8.set(bBytes, off);
    return buf;
  },

  decode(buf: ArrayBuffer): { ok: boolean; result?: { value: number }; error?: string } {
    if (buf.byteLength < 2) return { ok: false, error: 'response too short' };
    const u8 = new Uint8Array(buf);
    const ok = u8[0] === 1;
    if (!ok) {
      return { ok: false, error: 'postcard error' };
    }
    const [raw, _] = decodeVarint(u8, 1);
    const value = unzigzag(raw);
    return { ok: true, result: { value } };
  },
};

export const postcardRegistry = new Map<string, PostcardCodec<any, any>>([
  ['addNumbers', addNumbersCodec],
]);
