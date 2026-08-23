/**
 * Streaming 예제 Node 앱 — 실제 Rust 프로세스와 이벤트를 주고받는 end-to-end 데모.
 *
 * Rust 를 `--serve` 라인 데몬으로 띄운다 — 같은 프로세스가 유지되므로 전역
 * 이벤트 버스의 상태(startJob 이 발행한 이벤트)가 폴링에 그대로 보인다.
 *
 * 흐름:
 * 1. `startJob` invoke → Rust 백그라운드 스레드가 진행률 이벤트 발행
 * 2. 폴링 루프가 `__drainEvents` 로 이벤트를 끌어와 콘솔에 스트리밍
 * 3. `job.done` 이벤트를 받으면 종료
 *
 * 실행: cargo build -p rustra-streaming-example && \
 *       bunx tsc -p examples/streaming/tsconfig.json && \
 *       node dist-ts/examples/streaming/apps/node-app.js
 */
import { spawn } from 'node:child_process';
import { startJob } from '../generated/commands.js';
import { configure } from '@rustra/types';
import { createNodeEngine } from '@rustra/node';

const RUST_BIN = 'target/debug/rustra-streaming-invoke';

interface RustraEventFrame {
  name: string;
  payload: { jobId: string; step?: number; total?: number; steps?: number };
  seq: number;
}

// ── 라인 데몬 프로토콜 ─────────────────────────────────────────
const child = spawn(RUST_BIN, ['--serve'], { stdio: ['pipe', 'pipe', 'inherit'] });
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let nextId = 1;

let buffer = '';
child.stdout.on('data', (chunk: Buffer) => {
  buffer += chunk.toString('utf8');
  let newline: number;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const response = JSON.parse(line) as {
      id: number;
      ok: boolean;
      result?: unknown;
      error?: string;
    };
    const waiter = pending.get(response.id);
    if (!waiter) continue;
    pending.delete(response.id);
    if (response.ok) waiter.resolve(response.result);
    else waiter.reject(new Error(response.error ?? 'invoke failed'));
  }
});

function invokeRust(command: string, args?: unknown): Promise<unknown> {
  const id = nextId++;
  const payload = JSON.stringify({ id, command, args }) + '\n';
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(payload);
  });
}

const engine = createNodeEngine({
  invoke(command, args) {
    return invokeRust(command, args);
  },
});
configure(engine);

// ── 시나리오 ───────────────────────────────────────────────────
const TOTAL = 5;
const DELAY_MS = 120;

console.log(`[streaming] startJob(job-1, ${TOTAL} steps)`);
const start = await startJob({ jobId: 'job-1', totalSteps: TOTAL, stepDelayMs: DELAY_MS });
if (!start.accepted) throw new Error('job not accepted');

const received: RustraEventFrame[] = [];
const deadline = Date.now() + 10_000;
while (Date.now() < deadline) {
  const events = (await invokeRust('__drainEvents')) as RustraEventFrame[];
  for (const e of events) {
    if (e.name === 'progress.tick') {
      const step = e.payload.step ?? 0;
      console.log(
        `[streaming] tick ${String(step).padStart(2)}/${TOTAL} (seq=${e.seq}) ${'▓'.repeat(step)}${'░'.repeat(TOTAL - step)}`,
      );
    }
    if (e.name === 'job.done') {
      console.log(`[streaming] done: ${e.payload.steps} steps`);
    }
    received.push(e);
    if (e.name === 'job.done') {
      const ticks = received.filter((r) => r.name === 'progress.tick').length;
      if (ticks !== TOTAL) {
        throw new Error(`expected ${TOTAL} ticks, got ${ticks}`);
      }
      console.log(`[streaming] PASS — ${ticks}/${TOTAL} ticks received, seq 0..${e.seq}`);
      child.kill();
      process.exit(0);
    }
  }
  await new Promise((r) => setTimeout(r, 40));
}

throw new Error('timeout waiting for job.done');
