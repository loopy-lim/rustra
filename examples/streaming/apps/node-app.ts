/**
 * Streaming 예제 Node 앱 — 실제 Rust 프로세스와 이벤트를 주고받는 end-to-end 데모.
 *
 * 생성 node 엔트리의 `subscribeEvent` 로 이벤트를
 * 받는다 — 앱은 수동 `__drainEvents` 폴링을 쓰지 않는다. 이 데몬은 라인 JSON
 * 프로토콜(구 런타임)이라 푸시 핸드셰이크(`events:"push"`)가 없고, 따라서
 * subscribeEvent 의 **폴링 폴백** 경로로 흐른다(2-모드 dispatch — 푸시 가능한
 * loop-stdio 런타임에선 0xfffd 푸시 프레임으로 자동 승격).
 *
 * 흐름:
 * 1. 구독 먼저 — `progress.tick`/`job.done` 을 subscribeEvent 로 걸고
 * 2. `startJob` invoke → Rust 백그라운드 스레드가 진행률 이벤트 발행
 * 3. 폴링 폴백 루프가 이벤트를 콜백으로 전달하고, `job.done` 에 종료
 *
 * 실행: cargo build -p rustra-streaming-example && \
 *       bun examples/streaming/apps/node-app.ts
 */
import { rustra, startJob, subscribeEvent } from '../generated/node.js';
import { onRustraEvent } from '../generated/events.js';

await rustra.ready();
console.log('[streaming] generated runtime ready (polling event delivery)');

// ── 시나리오 ───────────────────────────────────────────────────
const TOTAL = 5;
const DELAY_MS = 120;

let settleDone!: () => void;
const done = new Promise<void>((resolve) => {
  settleDone = resolve;
});
const timeout = setTimeout(() => {
  console.error('[streaming] timeout waiting for job.done');
  rustra.dispose();
  process.exit(1);
}, 10_000);

let ticks = 0;
const unsubscribeTick = await onRustraEvent(subscribeEvent, 'progress.tick', (payload) => {
  const step = Number(payload.step);
  const total = Number(payload.total);
  ticks += 1;
  console.log(
    `[streaming] tick ${String(step).padStart(2)}/${total} ${'▓'.repeat(step)}${'░'.repeat(total - step)}`,
  );
});
const unsubscribeDone = await onRustraEvent(subscribeEvent, 'job.done', ({ steps }) => {
  console.log(`[streaming] done: ${steps} steps`);
  settleDone();
});

console.log(`[streaming] startJob(job-1, ${TOTAL} steps)`);
const start = await startJob({ jobId: 'job-1', totalSteps: TOTAL, stepDelayMs: DELAY_MS });
if (!start.accepted) throw new Error('job not accepted');

await done;
clearTimeout(timeout);
if (ticks !== TOTAL) {
  unsubscribeTick();
  unsubscribeDone();
  rustra.dispose();
  throw new Error(`expected ${TOTAL} ticks, got ${ticks}`);
}
console.log(`[streaming] PASS — ${ticks}/${TOTAL} ticks received via subscribeEvent`);
unsubscribeTick();
unsubscribeDone();
rustra.dispose();
process.exit(0);
