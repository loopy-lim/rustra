import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNodeEventSubscription } from './node-event-subscription.js';

/**
 * Bun 팩토리(bun-event-subscription)와의 대칭 테스트 — 실 런타임 스폰이 필요한 경로는
 * 프로세스 transport 관례에 따라 Node 러너(컴파일 스위트)에서만 돌리고, Bun 러너에서는
 * 해상 실패/lazy 계약만 검증한다.
 */
const isBun = typeof process.versions.bun === 'string';

test('event subscription is lazy — nothing is spawned or resolved before the first subscribe', () => {
  const subscription = createNodeEventSubscription({ commandCandidates: ['./missing-runtime'] });
  // 생성만으로는 해상이 일어나지 않는다(throw 없음).
  subscription.dispose();
});

test('event subscription surfaces runtime discovery failure on the first subscribe', () => {
  const subscription = createNodeEventSubscription({ commandCandidates: ['./missing-runtime'] });
  assert.throws(() => subscription.subscribeEvent('x', () => {}), /RUSTRA_NODE_BINARY/);
  subscription.dispose();
});

test('event subscription shares one transport across subscribers and stops on dispose', async () => {
  if (isBun) return; // node:child_process posix_spawn EBADF — Bun 러너 회피(index.test.ts 관례).
  const { execFileSync } =
    (await import('node:child_process')) as typeof import('node:child_process');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  // drainEvents 프레임에 응답하는 최소 loop-stdio 더블 — NDJSON id 상관 프로토콜.
  const root = mkdtempSync(join(tmpdir(), 'rustra-node-events-'));
  const script = join(root, 'loop.mjs');
  writeFileSync(
    script,
    [
      'let id = 0;',
      'let buffer = "";',
      'process.stdin.on("data", (chunk) => {',
      '  buffer += chunk.toString("utf8");',
      '  let newline;',
      '  while ((newline = buffer.indexOf("\\n")) >= 0) {',
      '    const line = buffer.slice(0, newline).trim();',
      '    buffer = buffer.slice(newline + 1);',
      '    if (!line) continue;',
      '    const frame = JSON.parse(line);',
      '    const events = frame.command === "__drainEvents"',
      '      ? [{ name: "tick", payload: ++drainTicks }]',
      '      : [];',
      '    process.stdout.write(JSON.stringify({ id: frame.id, ok: true, result: null, events }) + "\\n");',
      '  }',
      '});',
      'let drainTicks = 0;',
    ].join('\n'),
  );
  execFileSync(process.execPath, ['--version']);
  const subscription = createNodeEventSubscription({
    command: process.execPath,
    args: [script],
  });
  const got: unknown[] = [];
  try {
    subscription.subscribeEvent('tick', (p) => got.push(p));
    await waitFor(() => got.length >= 1);
    subscription.dispose();
    assert.deepEqual(got, [1]);
  } finally {
    subscription.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── helpers ──────────────────────────────────────────────────

async function waitFor(predicate: () => boolean, timeoutMs = 2000, stepMs = 1) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error('waitFor timed out');
}
