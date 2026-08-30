import { afterEach, describe, expect, test } from 'bun:test';
import { dumpWire, isRustraDebugEnabled, resetDebugEnvForTests, shouldDumpWire } from './debug.js';

describe('RUSTRA_DEBUG env parsing', () => {
  afterEach(() => {
    resetDebugEnvForTests();
  });

  test('accepts 1/true/verbose case-insensitively', () => {
    // 게이트는 모듈 레벨 메모이즈 — 앞선 파일이 남긴 캐시를 무효화하고 시작.
    resetDebugEnvForTests();
    process.env.RUSTRA_DEBUG = '1';
    expect(isRustraDebugEnabled()).toBe(true);
    process.env.RUSTRA_DEBUG = 'TRUE';
    expect(isRustraDebugEnabled()).toBe(true);
    process.env.RUSTRA_DEBUG = 'Verbose';
    expect(isRustraDebugEnabled()).toBe(true);
  });

  test('rejects other values and absence', () => {
    process.env.RUSTRA_DEBUG = 'wire';
    expect(isRustraDebugEnabled()).toBe(false);
    process.env.RUSTRA_DEBUG = '0';
    expect(isRustraDebugEnabled()).toBe(false);
    delete process.env.RUSTRA_DEBUG;
    expect(isRustraDebugEnabled()).toBe(false);
  });
});

describe('dumpWire', () => {
  afterEach(() => {
    resetDebugEnvForTests();
  });

  test('dumps direction + hex to stderr when enabled', () => {
    process.env.RUSTRA_DEBUG = '1';
    const chunks: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      dumpWire('request', new Uint8Array([0x00, 0x01, 0xff]).buffer);
    } finally {
      process.stderr.write = originalWrite;
    }
    const output = chunks.join('');
    expect(output).toContain('[rustra:wire]');
    expect(output).toContain('request');
    expect(output).toContain('0001ff');
  });

  test('is silent when RUSTRA_DEBUG is unset (pipe-safe)', () => {
    delete process.env.RUSTRA_DEBUG;
    const chunks: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      dumpWire('response', new Uint8Array([1]).buffer);
    } finally {
      process.stderr.write = originalWrite;
    }
    expect(chunks.join('')).toBe('');
  });

  test('memoized dump gate picks up env changes only after reset invalidation', () => {
    // shouldDumpWire 는 모듈 레벨 메모이즈 — env 를 나중에 바꿔도 캐시가 살아
    // 있으면 반영하지 않고, resetDebugEnvForTests 가 무효화해야 보인다.
    delete process.env.RUSTRA_DEBUG;
    resetDebugEnvForTests(); // 캐시를 'unset' 상태로 확정.
    expect(shouldDumpWire()).toBe(false);

    process.env.RUSTRA_DEBUG = '1';
    expect(shouldDumpWire()).toBe(false); // 캐시가 무효화되기 전엔 스테일 값.

    resetDebugEnvForTests(); // env 정리 + 캐시 무효화.
    process.env.RUSTRA_DEBUG = '1';
    expect(shouldDumpWire()).toBe(true); // 무효화 후에는 새 env 를 읽는다.
  });
});
