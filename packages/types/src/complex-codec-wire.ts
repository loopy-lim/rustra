import { ComplexCodecError } from './complex-codec-types.js';

export function utf8Encode(value: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value);
  const bytes = unescape(encodeURIComponent(value));
  const output = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) output[i] = bytes.charCodeAt(i);
  return output;
}

export function utf8Decode(value: Uint8Array): string {
  if (typeof TextDecoder !== 'undefined')
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  try {
    return decodeURIComponent(escape(binary));
  } catch {
    throw new ComplexCodecError('invalid UTF-8 string');
  }
}

export function sortedKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value).sort(compareUtf8);
}

export function compareUtf8(left: string, right: string): number {
  const a = utf8Encode(left);
  const b = utf8Encode(right);
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

export class Writer {
  private readonly parts: Uint8Array[] = [];
  private length = 0;

  constructor(private readonly maxPayloadBytes: number) {}

  push(bytes: Uint8Array): void {
    if (this.length + bytes.length > this.maxPayloadBytes) {
      throw new ComplexCodecError(`payload exceeds ${this.maxPayloadBytes} bytes`);
    }
    this.parts.push(bytes);
    this.length += bytes.length;
  }

  byte(value: number): void {
    this.push(new Uint8Array([value]));
  }

  varint(value: bigint): void {
    if (value < 0n) throw new ComplexCodecError('varint cannot be negative');
    const bytes: number[] = [];
    do {
      let next = Number(value & 0x7fn);
      value >>= 7n;
      if (value !== 0n) next |= 0x80;
      bytes.push(next);
    } while (value !== 0n);
    this.push(new Uint8Array(bytes));
  }

  zigzag(value: bigint): void {
    this.varint(value >= 0n ? value * 2n : -value * 2n - 1n);
  }

  string(value: string): void {
    const bytes = utf8Encode(value);
    this.varint(BigInt(bytes.length));
    this.push(bytes);
  }

  finish(): ArrayBuffer {
    const output = new Uint8Array(this.length);
    let offset = 0;
    for (const part of this.parts) {
      output.set(part, offset);
      offset += part.length;
    }
    return output.buffer;
  }
}
