/**
 * Streaming 예제 Node 앱 — 실제 Rust 프로세스와 이벤트를 주고받는 end-to-end 데모.
 *
 * `@rustra/node` 의 `createNodeLoopTransport` + `subscribeEvent` 로 이벤트를
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
import { createNodeLoopTransport, subscribeEvent } from '@rustra/node';
import { configure } from '@rustra/types';
import { createNodeEngine } from '@rustra/node';
import { startJob } from '../generated/commands.js';

const RUST_BIN = 'target/debug/rustra-streaming-invoke';

interface ProgressPayload {
  jobId: string;
  step: number;
  total: number;
}
interface DonePayload {
  jobId: string;
  steps: number;
}

const transport = createNodeLoopTransport({ command: RUST_BIN, args: ['--serve'] });
await transport.ready();
console.log(
  `[streaming] transport ready — mode=${transport.mode} pushCapable=${transport.pushCapable} (폴링 폴백 경로)`,
);

configure(
  createNodeEngine({
    invoke: (command, args) => transport.invoke(command, args),
  }),
);

// ── 시나리오 ───────────────────────────────────────────────────
const TOTAL = 5;
const DELAY_MS = 120;

let settleDone!: () => void;
const done = new Promise<void>((resolve) => {
  settleDone = resolve;
});
const timeout = setTimeout(() => {
  console.error('[streaming] timeout waiting for job.done');
  transport.dispose();
  process.exit(1);
}, 10_000);

let ticks = 0;
const unsubscribeTick = subscribeEvent(transport, 'progress.tick', (payload) => {
  const { step, total } = payload as ProgressPayload;
  ticks += 1;
  console.log(
    `[streaming] tick ${String(step).padStart(2)}/${total} ${'▓'.repeat(step)}${'░'.repeat(total - step)}`,
  );
});
const unsubscribeDone = subscribeEvent(transport, 'job.done', (payload) => {
  const { steps } = payload as DonePayload;
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
  transport.dispose();
  throw new Error(`expected ${TOTAL} ticks, got ${ticks}`);
}
console.log(`[streaming] PASS — ${ticks}/${TOTAL} ticks received via subscribeEvent`);
unsubscribeTick();
unsubscribeDone();
transport.dispose();
process.exit(0);
