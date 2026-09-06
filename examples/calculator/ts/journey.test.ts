// A17 — 한 흐름 여정 통합 테스트 (Node loop-stdio 실호스트).
//
// 기존 7개 테스트는 각 계약을 조각으로 검증한다(cross-wire: 코덱, payload:
// 프레임 가드, node 패키지 e2e: 푸시 단독). 이 파일은 조각을 **한 흐름**으로
// 엮는다 — 실제 `target/debug/loop-stdio` 자식 프로세스 위에서:
//
//   invoke 성공 → 이벤트 구독+수신 → 장기 작업 진행 이벤트 → 취소 →
//   구독 해제 → 오류 복구 → dispose
//
// 구독은 공개 계약 표면(`subscribeEvent`)으로, 잔여 emit 관측은 transport
// 수준 `onPushEvent`(브로드캐스트 — 구독자 전달과 독립)로 나눠 붙인다.
//
// 취소는 얕은 취소 계약(compatibility-matrix "shallow cancellation")이다:
// JS 프라미스만 `cancelled`(retryable)로 거부하고 Rust 핸들러는 끝까지
// 실행된다. 따라서 단정은 "Rust 가 멈췄다"가 아니라 "JS 관측이 계약대로"다.
// 취소된 호출의 잔여 emit 은 demo.done(마지막 emit) 도착으로 정착을 판정한다 —
// emit 순서상 progress.tick 전부가 demo.done 보다 앞서므로, 그 도착은 잔여
// 진행 이벤트의 소진을 보증한다.
//
// 실행: `bun run test:ts:node` (cargo build -p rustra-calculator-example 사전
// 필요 — test:ts:bun/test:runtime:* 과 동일 전제). CI 는 typescript 잡의
// test:compat 체인에서 실행한다. bun test 러너 아래에서는 스킵한다 — Bun 1.4
// 러너가 node:child_process posix_spawn 을 깨뜨린다(packages/node e2e와 동일
// 판정, transport-bench.test.ts 의 runningUnderBunTest 와 동일 관례).

import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CancelledError, RustraCommandError } from '@rustra/types';
import { createNodeEngine, createNodeLoopTransport, subscribeEvent } from '@rustra/node';
// 같은 dist-ts 트리의 generated registry — codecs 주입으로 바이너리 모드 +
// events:"push" 핸드셰이크가 협상된다(node 패키지 e2e와 동일 패턴).
import { rkyvV2Registry } from '../generated/rkyv-registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// dist-ts/examples/calculator/ts → 저장소 루트 — transport-bench.test.ts 와 동일
// 루트 탐색(Cargo.toml+package.json 이 함께 있는 디렉터리).
const ROOT = (() => {
  let cur = __dirname;
  while (cur !== dirname(cur)) {
    if (existsSync(resolve(cur, 'Cargo.toml')) && existsSync(resolve(cur, 'package.json')))
      return cur;
    cur = dirname(cur);
  }
  return resolve(__dirname, '..', '..', '..');
})();

// bun test 러너 감지 — Bun 전역은 bun test/bun run 에만 존재하고 node --test
// 에는 없다(transport-bench.test.ts 와 동일 판정). 실호스트 여정은 Node 산물
// 경로(test:ts:node)가 담당한다.
const bunGlobal = (globalThis as Record<string, unknown>).Bun as
  { spawnSync?: unknown } | undefined;
const runningUnderBunTest = bunGlobal !== undefined && typeof bunGlobal.spawnSync === 'function';

const journeyName =
  'calculator journey: invoke → events → progress → cancel → unsubscribe → recovery → dispose';
const journeyTest: typeof test = runningUnderBunTest
  ? (((name: string, _fn?: never) => test.skip(name, () => {})) as typeof test)
  : test;

journeyTest(journeyName, { timeout: 30_000 }, async () => {
  const transport = createNodeLoopTransport({
    command: resolve(ROOT, 'target/debug/loop-stdio'),
    args: [],
    codecs: rkyvV2Registry as never,
  });
  const engine = createNodeEngine(transport);

  try {
    // ── 1. invoke 성공 — 바이너리 rkyv V2 왕복 ──────────────────
    const added = await engine.invoke<{ value: number }>('addNumbers', { a: 20, b: 22 });
    assert.equal(added.value, 42);

    // ── 2. 이벤트 구독 — 푸시 핸드셰이크 수용 + 공개 subscribeEvent ──
    await transport.ready();
    assert.equal(transport.pushCapable, true, 'loop-stdio must accept the push capability');
    /** progress.tick 콜백 도착분 — subscribeEvent 가 파싱해 준 객체. */
    const ticks: Array<{ step: number; total: number }> = [];
    let settleProgress: (() => void) | null = null;
    const progressSettled = new Promise<void>((resolveSettled) => {
      settleProgress = resolveSettled;
    });
    const unsubscribeTick = subscribeEvent(transport, 'progress.tick', (payload) => {
      ticks.push(payload as { step: number; total: number });
      if (ticks.length >= 3) settleProgress?.();
    });
    // 잔여 emit 정착 관찰자 — transport 수준 브로드캐스트(onPushEvent)는
    // subscribeEvent 구독/해지와 독립으로 모든 0xfffd 프레임을 본다. 판정
    // 전용이며 콜백 전달 계약의 단정 대상이 아니다.
    let residualDone: { emitted: number } | null = null;
    let settleResidual: (() => void) | null = null;
    const residualSettled = new Promise<void>((resolveSettled) => {
      settleResidual = resolveSettled;
    });
    let demoDoneCount = 0;
    const detachObserver = transport.onPushEvent!((event) => {
      if (event.name === 'demo.done') {
        demoDoneCount += 1;
        const parsed = JSON.parse(event.payload) as { emitted: number };
        if (demoDoneCount === 1) {
          // 첫 demo.done = 3단계 emitDemo(ticks:3) 의 것 — 여정 단계 3 판정.
          assert.deepEqual(parsed, { emitted: 4 });
        } else {
          // 두 번째 demo.done = 취소된 emitDemo(ticks:5) 의 잔여 완료.
          residualDone = parsed;
          settleResidual?.();
        }
      }
    });

    // ── 3. 장기 작업 진행 이벤트 — emitDemo 가 같은 왕복 안에서 발행 ──
    const emitted = await engine.invoke<{ emitted: number }>('emitDemo', {
      ticks: 3,
      stepDelayMs: 10,
    });
    assert.equal(emitted.emitted, 4, 'emitted = ticks + 1 (demo.done 포함)');
    await progressSettled;
    assert.deepEqual(
      ticks.map((t) => t.step),
      [1, 2, 3],
    );

    // ── 4. 취소 — 얕은 취소 계약 (실호스트) ─────────────────────
    // ticks:5 × stepDelayMs:250 ≈ 1.25s 의 Rust 실행을 걸고 100ms 뒤 abort.
    // JS 프라미스는 즉시 `cancelled`(retryable)로 거부된다 — Rust 핸들러는
    // 멈추지 않는다(얕은 취소). Rust 종료 단정은 하지 않는다; 잔여 emit 은
    // demo.done 도착으로 정착 판정한다(아래).
    const cancelController = new AbortController();
    const cancelledCall = engine
      .invoke<{ emitted: number }>(
        'emitDemo',
        { ticks: 5, stepDelayMs: 250 },
        { signal: cancelController.signal },
      )
      .then(
        () => 'resolved' as const,
        (error: unknown) => {
          assert.ok(error instanceof CancelledError, 'shallow cancel must be a CancelledError');
          assert.ok(
            error instanceof RustraCommandError && error.code === 'cancelled',
            `cancel code must be 'cancelled', got ${String(error)}`,
          );
          assert.equal(
            (error as RustraCommandError).retryable,
            true,
            'cancelled must be retryable',
          );
          return 'cancelled' as const;
        },
      );
    setTimeout(() => cancelController.abort(), 100);
    assert.equal(await cancelledCall, 'cancelled');

    // ── 5. 구독 해제 — 해지 후 신규 emit 은 리스너에 도달하지 않는다 ──
    unsubscribeTick();
    // (잔여 emit 소진 대기는 unsubscribe **뒤에** 둔다 — 취소→구독해제 순서가
    // 여정 계약이다. progress.tick 리스너는 이미 해지됐으므로 잔여 tick 은
    // 콜백에 도달하지 않고, 관찰자의 demo.done 정착만 남는다.)
    await residualSettled;
    assert.deepEqual(
      residualDone,
      { emitted: 6 },
      'cancelled invocation still completes on the Rust side (shallow cancel)',
    );
    const ticksAfterUnsubscribe = ticks.length;
    const freshDone = await engine.invoke<{ emitted: number }>('emitDemo', {
      ticks: 1,
      stepDelayMs: 0,
    });
    assert.equal(freshDone.emitted, 2, 'fresh emit still completes after unsubscribe');
    // 신규 emit 의 demo.done 응답이 이미 왕복으로 도착했으므로(같은 stdout 에서
    // tick 프레임이 먼저 흘렀어야 함), 이 시점 tick 미증가는 "해지된 리스너로
    // 전달 없음"의 부정 단정이 된다.
    assert.equal(
      ticks.length,
      ticksAfterUnsubscribe,
      'unsubscribed listener must not receive fresh progress events',
    );
    detachObserver();

    // ── 6. 오류 복구 — 에러 프레임 후 같은 호스트가 계속 응답한다 ──
    await assert.rejects(
      () => engine.invoke('divide', { a: 1, b: 0 }),
      (error: unknown) =>
        error instanceof RustraCommandError && error.code === 'math.divide_by_zero',
    );
    const recovered = await engine.invoke<{ value: number }>('addNumbers', { a: 1, b: 2 });
    assert.equal(recovered.value, 3, 'host serves fresh commands after an error frame');
  } finally {
    // ── 7. dispose — 자식 프로세스 종료 ─────────────────────────
    transport.dispose();
    assert.equal(transport.pid, null, 'dispose tears down the spawned runtime');
  }
});
