import { ComplexCodecError } from './complex-codec-types.js';
import { utf8Decode } from './complex-codec-wire.js';

export class Reader {
  private offset = 0;

  constructor(
    private readonly bytes: Uint8Array,
    private readonly maxCollectionLength: number,
  ) {}

  get position(): number {
    return this.offset;
  }

  get remaining(): number {
    return this.bytes.length - this.offset;
  }

  byte(): number {
    this.need(1);
    return this.bytes[this.offset++];
  }

  need(length: number): void {
    if (!Number.isSafeInteger(length) || length < 0 || this.remaining < length) {
      throw new ComplexCodecError('truncated complex payload');
    }
  }

  raw(length: number): Uint8Array {
    this.need(length);
    const result = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return result;
  }

  varint(): bigint {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      const byte = this.byte();
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value;
    }
    throw new ComplexCodecError('varint is too long');
  }

  zigzag(): bigint {
    const value = this.varint();
    return (value >> 1n) ^ -(value & 1n);
  }

  length(): number {
    const value = this.varint();
    if (value > BigInt(this.maxCollectionLength) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ComplexCodecError(`collection length exceeds ${this.maxCollectionLength}`);
    }
    return Number(value);
  }

  string(): string {
    return utf8Decode(this.raw(this.length()));
  }
}
