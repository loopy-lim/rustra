import { describe, expect, test } from 'bun:test';
import { decodeUtf8, encodeUtf8, exactArrayBuffer } from './utf8.ts';

describe('Hermes-safe UTF-8 helpers', () => {
  test('round-trips Korean and emoji and returns an exact native buffer', () => {
    const input = '사용자 🚀 Rustra';
    const bytes = encodeUtf8(input);
    expect(decodeUtf8(bytes)).toBe(input);
    expect(exactArrayBuffer(bytes).byteLength).toBe(bytes.byteLength);
  });
});
