const encoder = typeof TextEncoder === 'undefined' ? undefined : new TextEncoder();
const decoder = typeof TextDecoder === 'undefined' ? undefined : new TextDecoder();

export function encodeUtf8(input: string): Uint8Array {
  if (encoder) return encoder.encode(input);
  const escaped = encodeURIComponent(input);
  const bytes = new Uint8Array(escaped.length);
  let cursor = 0;
  for (let index = 0; index < escaped.length; index += 1) {
    if (escaped[index] === '%') {
      bytes[cursor++] = Number.parseInt(escaped.slice(index + 1, index + 3), 16);
      index += 2;
    } else bytes[cursor++] = escaped.charCodeAt(index);
  }
  return bytes.subarray(0, cursor);
}

export function decodeUtf8(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (decoder) return decoder.decode(bytes);
  let escaped = '';
  for (const byte of bytes) escaped += `%${byte.toString(16).padStart(2, '0')}`;
  return decodeURIComponent(escaped);
}

export function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer;
  }
  return bytes.slice().buffer as ArrayBuffer;
}
