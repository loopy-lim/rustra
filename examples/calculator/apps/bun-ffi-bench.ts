// Bun 호스트 기준 벤치 — scriptc-bench.ts (scriptc 네이티브) 와 동일 워크로드.
// 세 팔: (1) rustra_ffi_invoke_json_into_len caller-buffer 왕복 raw(FFI 경계만),
// (2) 같은 호출 + TextDecoder/JSON.parse 까지(end-to-end) — scriptc 앱과 동일 루프,
// (3) 생성된 typed addNumbers(postcard frame 경로 — Bun 클라이언트의 실제 프로덕션
// 진입). 시간 예산 방식(팔마다 ~0.8s 이상)으로 반복 수를 자동 조정해 ns/op 을 낸다.
import { dlopen, FFIType } from 'bun:ffi';
import { join } from 'node:path';
import { addNumbers, rustra } from '../generated/bun.js';

const repoRoot = join(import.meta.dir, '..', '..', '..');
const library = join(repoRoot, 'target', 'release', 'librustra_calculator_example.dylib');
const { symbols } = dlopen(library, {
  rustra_mobile_init: { args: [], returns: FFIType.void },
  rustra_ffi_invoke_json_into_len: {
    args: [FFIType.ptr, 'usize' as const, FFIType.ptr, 'usize' as const],
    returns: 'usize' as const,
  },
});
symbols.rustra_mobile_init();

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const inputBytes = encoder.encode(
  JSON.stringify({ command: 'addNumbers', args: { a: 20, b: 22 } }),
);
const outputBuffer = new Uint8Array(4096);

function rawRun(iters: number): number {
  const start = performance.now();
  for (let i = 0; i < iters; i++) {
    const written = symbols.rustra_ffi_invoke_json_into_len(
      inputBytes,
      inputBytes.length,
      outputBuffer,
      outputBuffer.length,
    );
    if (written <= 0 || written > outputBuffer.length) {
      throw new Error(`implausible response length: ${written}`);
    }
  }
  return performance.now() - start;
}

function e2eRun(iters: number): number {
  const start = performance.now();
  let last = 0;
  for (let i = 0; i < iters; i++) {
    const written = symbols.rustra_ffi_invoke_json_into_len(
      inputBytes,
      inputBytes.length,
      outputBuffer,
      outputBuffer.length,
    );
    if (written <= 0 || written > outputBuffer.length) {
      throw new Error(`implausible response length: ${written}`);
    }
    const response = JSON.parse(decoder.decode(outputBuffer.subarray(0, Number(written))));
    const result = response.result ?? response;
    last = result.value;
  }
  if (last !== 42) throw new Error(`expected 42, got ${last}`);
  return performance.now() - start;
}

async function typedRun(iters: number): Promise<number> {
  const start = performance.now();
  let last: number | bigint = 0; // fast-path가 i32/i64를 number|bigint로 노출한다
  for (let i = 0; i < iters; i++) {
    const result = await addNumbers({ a: 20, b: 22 });
    last = result.value;
  }
  if (last !== 42) throw new Error(`expected 42, got ${last}`);
  return performance.now() - start;
}

async function measure(
  name: string,
  run: (iters: number) => number | Promise<number>,
): Promise<void> {
  await run(20_000); // 워밍업 — 캐시·분기예측 안정화
  let iters = 50_000;
  let elapsed = await run(iters);
  while (elapsed < 800) {
    iters *= 4;
    elapsed = await run(iters);
  }
  elapsed = await run(iters); // 최종 반복 수에서 확인 패스 — 이 값을 보고한다
  const nsPerOp = (elapsed * 1e6) / iters;
  console.log(`${name}: ${nsPerOp.toFixed(1)} ns/op (${iters} iters, ${elapsed.toFixed(0)} ms)`);
}

await measure('[bun] raw', rawRun);
await measure('[bun] e2e', e2eRun);
await measure('[bun] typed', typedRun);
rustra.dispose();
