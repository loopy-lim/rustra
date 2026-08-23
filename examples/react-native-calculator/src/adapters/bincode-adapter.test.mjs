import { describe, expect, test } from 'bun:test';
import { addNumbersCodec, createBincodeEngine } from './bincode-adapter.ts';

describe('bincode v2 standard wire compatibility', () => {
  test('encodes the Rust addNumbers request fixture', () => {
    const bytes = new Uint8Array(addNumbersCodec.encode({ a: 42, b: 58 }));
    expect([...bytes]).toEqual([0x0a, ...new TextEncoder().encode('addNumbers'), 0x54, 0x74]);
  });

  test('uses bincode marker varints beyond the inline range', () => {
    const bytes = new Uint8Array(addNumbersCodec.encode({ a: 127, b: 128 }));
    expect([...bytes.slice(-6)]).toEqual([0xfb, 0xfe, 0x00, 0xfb, 0x00, 0x01]);
  });

  test('decodes the Rust success response fixture without LEB128 truncation', () => {
    const response = Uint8Array.from([0x01, 0xc8, 0x00]).buffer;
    expect(addNumbersCodec.decode(response)).toEqual({ ok: true, result: { value: 100 } });
  });

  test('surfaces the Rust error response message', () => {
    const response = Uint8Array.from([
      0x00,
      0x00,
      0x01,
      0x0a,
      ...new TextEncoder().encode('test error'),
    ]).buffer;
    expect(addNumbersCodec.decode(response)).toEqual({
      ok: false,
      error: { code: 'invoke.failed', message: 'test error' },
    });
  });

  test('engine returns the correctly decoded result', async () => {
    const native = {
      invokeBincode: () => Uint8Array.from([0x01, 0xc8, 0x00]).buffer,
    };
    const engine = createBincodeEngine(native, new Map([['addNumbers', addNumbersCodec]]));
    await expect(engine.invoke('addNumbers', { a: 42, b: 58 })).resolves.toEqual({ value: 100 });
  });
});
