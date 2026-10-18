import { rustra_mobile_init, rustra_ffi_invoke_json_into_len } from '../scriptc/scriptc-ffi.js';

// scriptc 네이티브 기준 벤치 — bun-ffi-bench.ts (Bun 호스트) 와 동일 워크로드.
// addNumbers {a:20,b:22} 를 rustra_ffi_invoke_json_into_len caller-buffer 왕복으로
// 돌려 ns/op 을 낸다. raw(FFI 경계 + 실패 검사만)와 end-to-end(디코드+파싱+결과
// 읽기까지)를 나눠 재는 이유는 FFI 비용과 페이로드 처리 비용을 분리하기 위해서다.
// 반복 수는 시간 예산 방식(팔마다 ~0.8s 이상)으로 자동 조정한다.
rustra_mobile_init();

const input = JSON.stringify({ command: 'addNumbers', args: { a: 20, b: 22 } });
const outputBuffer = new Uint8Array(4096);
const decoder = new TextDecoder();
// u64 반환(bigint) 비교용 상수를 루프 밖으로 — 매 반복 BigInt 생성은 벤치 결함이다.
const capBig = BigInt(outputBuffer.length);

// scriptc 네이티브 런타임의 시계 — performance.now 가 있으면 쓰고(부동소수 ms),
// 없으면 Date.now 로 떨어진다(정밀도 1ms — 예산을 0.8s 로 키워 상쇄).
const nowMs: () => number =
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? () => performance.now()
    : () => Date.now();

function rawRun(iters: number): number {
  const start = nowMs();
  for (let i = 0; i < iters; i++) {
    const written = rustra_ffi_invoke_json_into_len(input, outputBuffer);
    if (written <= 0n || written > capBig) {
      throw new Error(`implausible response length: ${written}`);
    }
  }
  return nowMs() - start;
}

function e2eRun(iters: number): number {
  const start = nowMs();
  let last = 0;
  for (let i = 0; i < iters; i++) {
    const written = rustra_ffi_invoke_json_into_len(input, outputBuffer);
    if (written <= 0n || written > capBig) {
      throw new Error(`implausible response length: ${written}`);
    }
    const response = JSON.parse(decoder.decode(outputBuffer.subarray(0, Number(written))));
    const result = response.result ?? response;
    last = result.value;
  }
  if (last !== 42) throw new Error(`expected 42, got ${last}`);
  return nowMs() - start;
}

function measure(name: string, run: (iters: number) => number): void {
  run(20_000); // 워밍업 — 캐시·분기예측 안정화
  let iters = 50_000;
  let elapsed = run(iters);
  while (elapsed < 800) {
    iters *= 4;
    elapsed = run(iters);
  }
  elapsed = run(iters); // 최종 반복 수에서 확인 패스 — 이 값을 보고한다
  const nsPerOp = (elapsed * 1e6) / iters;
  console.log(`${name}: ${nsPerOp.toFixed(1)} ns/op (${iters} iters, ${elapsed.toFixed(0)} ms)`);
}

measure('[scriptc] raw', rawRun);
measure('[scriptc] e2e', e2eRun);
