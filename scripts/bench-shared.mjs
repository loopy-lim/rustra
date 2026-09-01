/**
 * 벤치 스크립트 공유 헬퍼 — receipts 가 스크립트 간 비교 가능하도록
 * 옵션 파싱/포맷/프레임 조립/라이브러리 로딩을 한 곳에 모은다(동일 알고리즘 사본 방지).
 */
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

export const BENCH_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const benchRequire = createRequire(import.meta.url);

/** 양의 정수 옵션 파싱 — iterations/warmup 계열의 단일 규약. */
export function numericOption(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function hexToBytes(hex) {
  const u = new Uint8Array(hex.length / 2);
  for (let i = 0; i < u.length; i++) u[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return u;
}

/** Wrap a postcard body in an ok response frame ([ok=1][7 pad][body]). */
export function framed(body) {
  const response = new Uint8Array(8 + body.length);
  response[0] = 1;
  response.set(body, 8);
  return response;
}

export function fmtNs(ns) {
  if (ns >= 1_000_000) return `${(ns / 1_000_000).toFixed(2)}ms`;
  if (ns >= 1_000) return `${(ns / 1_000).toFixed(2)}us`;
  return `${ns.toFixed(0)}ns`;
}

export function fmtOps(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n.toFixed(0)}`;
}

export function percentile(sorted, pct) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((pct / 100) * sorted.length));
  return sorted[index];
}

export function bar(value, max, width = 35) {
  const filled = Math.max(0, Math.min(width, Math.round((value / max) * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

/**
 * calculator 예제 dylib 을 release-우선으로 탐색한다(suffix: bun:ffi 의 플랫폼
 * 확장자). 찾지 못하면 null — 호출처가 스크립트별로 폴백/에러를 결정한다.
 */
export function findCalculatorDylib(suffix) {
  const candidates = [
    { dir: 'release', label: '' },
    { dir: 'debug', label: ' (debug)' },
  ];
  return (
    candidates
      .map((c) => ({
        ...c,
        path: join(BENCH_ROOT, `target/${c.dir}/librustra_calculator_example.${suffix}`),
      }))
      .find((c) => existsSync(c.path)) ?? null
  );
}

/** calculator-napi 애드온을 로드한다(없으면 throw). */
export function loadCalculatorNapi() {
  const napiPath = join(
    BENCH_ROOT,
    `examples/calculator-napi/calculator-napi.${process.platform}-${process.arch}.node`,
  );
  return benchRequire(napiPath);
}
