import type { EngineClient, RustraNative, RkyvV2Codec, RustraError } from '@rustra/types';

export type BincodeCodec<I, O> = RkyvV2Codec<I, O>;

export function createBincodeEngine(
  native: RustraNative,
  registry: Map<string, RkyvV2Codec<any, any>>,
): EngineClient {
  return {
    invoke<T>(command: string, args?: unknown): Promise<T> {
      const codec = registry.get(command);
      if (!codec) {
        throw new Error(`Bincode: no codec for "${command}"`);
      }
      const payload = codec.encode(args);
      const resultBytes = native.invokeBincode(payload);
      const response = codec.decode(resultBytes);
      if (!response.ok) {
        throw new Error(response.error?.message ?? 'Rustra bincode invoke failed');
      }
      return Promise.resolve(response.result as T);
    },
  };
}

// ── bincode v2 standard() wire format utilities ──────────
// Uses bincode marker varints for lengths/integers and zigzag for signed types.

function littleEndian(value: bigint, width: number): number[] {
  const bytes: number[] = [];
  let remaining = value;
  for (let i = 0; i < width; i++) {
    bytes.push(Number(remaining & 0xffn));
    remaining >>= 8n;
  }
  return bytes;
}

function encodeVarint(value: bigint): number[] {
  if (value < 0n) throw new RangeError('bincode varint cannot encode a negative value');
  if (value < 251n) return [Number(value)];
  if (value <= 0xffffn) return [251, ...littleEndian(value, 2)];
  if (value <= 0xffff_ffffn) return [252, ...littleEndian(value, 4)];
  if (value <= 0xffff_ffff_ffff_ffffn) return [253, ...littleEndian(value, 8)];
  throw new RangeError('bincode integer exceeds the supported u64 range');
}

function zigzag(n: number): bigint {
  if (!Number.isSafeInteger(n)) throw new RangeError('bincode i64 input must be a safe integer');
  const value = BigInt(n);
  return value >= 0n ? value * 2n : -value * 2n - 1n;
}

function readLittleEndian(bytes: Uint8Array, offset: number, width: number): [bigint, number] {
  if (offset + width > bytes.length) throw new RangeError('truncated bincode integer');
  let value = 0n;
  for (let i = 0; i < width; i++) value |= BigInt(bytes[offset + i]) << BigInt(i * 8);
  return [value, offset + width];
}

function decodeVarint(bytes: Uint8Array, offset: number): [bigint, number] {
  if (offset >= bytes.length) throw new RangeError('truncated bincode varint');
  const marker = bytes[offset++];
  if (marker < 251) return [BigInt(marker), offset];
  if (marker === 251) return readLittleEndian(bytes, offset, 2);
  if (marker === 252) return readLittleEndian(bytes, offset, 4);
  if (marker === 253) return readLittleEndian(bytes, offset, 8);
  throw new RangeError(`unsupported bincode integer marker ${marker}`);
}

function unzigzag(n: bigint): number {
  const value = (n >> 1n) ^ -(n & 1n);
  const decoded = Number(value);
  if (!Number.isSafeInteger(decoded)) throw new RangeError('decoded bincode i64 is not JS-safe');
  return decoded;
}

function encodeVarintString(str: string): number[] {
  const utf8 = new TextEncoder().encode(str);
  return [...encodeVarint(BigInt(utf8.length)), ...utf8];
}

// ── Codecs (codegen would generate these) ────────────────

export const addNumbersCodec: BincodeCodec<{ a: number; b: number }, { value: number }> = {
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

  decode(buf: ArrayBuffer): { ok: boolean; result?: { value: number }; error?: RustraError } {
    try {
      if (buf.byteLength < 3) {
        return { ok: false, error: { code: 'invoke.too_short', message: 'response too short' } };
      }
      const u8 = new Uint8Array(buf);
      const ok = u8[0] === 1;
      const [raw, next] = decodeVarint(u8, 1);
      const value = unzigzag(raw);
      if (ok) return { ok: true, result: { value } };

      if (u8[next] !== 1) {
        return { ok: false, error: { code: 'invoke.failed', message: 'bincode error' } };
      }
      const [messageLength, messageOffset] = decodeVarint(u8, next + 1);
      const length = Number(messageLength);
      if (!Number.isSafeInteger(length) || messageOffset + length > u8.length) {
        throw new RangeError('truncated bincode error message');
      }
      const message = new TextDecoder().decode(u8.subarray(messageOffset, messageOffset + length));
      return { ok: false, error: { code: 'invoke.failed', message } };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'invoke.invalid_bincode',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  },
};

export const bincodeRegistry = new Map<string, BincodeCodec<any, any>>([
  ['addNumbers', addNumbersCodec],
]);
