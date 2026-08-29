import { decodeUtf8, encodeUtf8 } from './utf8.js';
import type { RustraError } from './errors.js';

// ── Tier 3 (JSON-in-binary) wire helpers ────────────────────
// request:  [command_id: u16 LE @0][json @2]
// success:  [ok:1 @0][pad 3B][json_len: u32 LE @4][json @8]
// error:    [ok:0 @0][pad to @8][err_len: u16 LE @8][postcard({code,message}) @10]

export function encodeTier3Request(commandId: number, args: unknown): ArrayBuffer {
  const json = encodeUtf8(JSON.stringify(args ?? {}, _jsonSetReplacer));
  const buf = new Uint8Array(2 + json.length);
  new DataView(buf.buffer).setUint16(0, commandId, true);
  buf.set(json, 2);
  return buf.buffer;
}

/**
 * JSON 경로에서 `Set`을 배열로 직렬화한다 — Rust `BTreeSet`/`HashSet`은
 * serde JSON 에서 배열로 직렬화되므로 와이어 호환을 맞춘다
 * (`Map`은 rustra 계약에 없으므로 다루지 않는다).
 */
function _jsonSetReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Set) return [...value];
  return value;
}

// postcard varint + length-prefixed string decode, local to the Tier 3 path so
// this file has no dependency on the generated codec helpers.
function _tier3DecodeString(u: Uint8Array, offset: number): { value: string; bytesRead: number } {
  let shift = 0;
  let bytesRead = 0;
  let len = 0;
  while (true) {
    const b = u[offset + bytesRead];
    len |= (b & 0x7f) << shift;
    bytesRead++;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (bytesRead > 5) throw new Error('varint too long');
  }
  len = len >>> 0;
  const start = offset + bytesRead;
  return {
    value: decodeUtf8(u, start, start + len),
    bytesRead: bytesRead + len,
  };
}

export function decodeTier3Response(bytes: ArrayBuffer): {
  ok: boolean;
  result?: unknown;
  error?: RustraError;
} {
  if (bytes.byteLength < 8) {
    return { ok: false, error: { code: 'invoke.too_short', message: 'response too short' } };
  }
  const u = new Uint8Array(bytes);
  if (u[0] === 1) {
    const len = new DataView(bytes).getUint32(4, true);
    if (bytes.byteLength < 8 + len) {
      return {
        ok: false,
        error: { code: 'invoke.too_short', message: 'response payload truncated' },
      };
    }
    const json = decodeUtf8(u, 8, 8 + len);
    try {
      return { ok: true, result: JSON.parse(json) };
    } catch (e) {
      return { ok: false, error: { code: 'invoke.malformed', message: `invalid json: ${e}` } };
    }
  }
  if (bytes.byteLength < 10) {
    return { ok: false, error: { code: 'invoke.too_short', message: 'error frame too short' } };
  }
  const errLen = new DataView(bytes).getUint16(8, true);
  let error: RustraError = { code: 'invoke.failed', message: 'invoke failed' };
  if (errLen > 0) {
    // postcard({ code: String, message: String })
    try {
      const { value: code, bytesRead: b1 } = _tier3DecodeString(u, 10);
      const { value: message } = _tier3DecodeString(u, 10 + b1);
      error = { code, message };
    } catch {
      // fallback if postcard decoding fails
    }
  }
  return { ok: false, error };
}
