import assert from 'node:assert/strict';
import test from 'node:test';
import { createNodeEngine } from './index.js';
import { RustraCommandError } from '@rustra/types';

test('createNodeEngine routes invoke to transport', async () => {
  const calls: Array<{ command: string; args: unknown }> = [];
  const engine = createNodeEngine({
    async invoke(command, args) {
      calls.push({ command, args });
      return { value: 42 };
    },
  });

  const result = await engine.invoke<{ value: number }>('addNumbers', { a: 20, b: 22 });
  assert.deepEqual(result, { value: 42 });
  assert.deepEqual(calls, [{ command: 'addNumbers', args: { a: 20, b: 22 } }]);
});

test('createNodeEngine wraps RustraError-shaped rejects into RustraCommandError', async () => {
  const engine = createNodeEngine({
    async invoke() {
      throw { code: 'command.not_found', message: 'unknown command' };
    },
  });

  await assert.rejects(
    () => engine.invoke('missing'),
    (err: unknown) => {
      if (!(err instanceof RustraCommandError)) return false;
      assert.equal(err.code, 'command.not_found');
      assert.equal(err.message, 'unknown command');
      return true;
    },
  );
});

test('createNodeEngine wraps unknown errors into RustraCommandError', async () => {
  const engine = createNodeEngine({
    async invoke() {
      throw 'something broke';
    },
  });

  await assert.rejects(
    () => engine.invoke('cmd'),
    (err: unknown) => {
      if (!(err instanceof RustraCommandError)) return false;
      assert.equal(err.code, 'unknown');
      assert.equal(err.message, 'something broke');
      return true;
    },
  );
});

// ── napi 와이어 에러 — Error.message 의 RustraError JSON/Display 복원 ──

test('createNodeEngine parses RustraError JSON message from napi Error', async () => {
  // napi transport 는 Rust 의 RustraError 를 Error.reason(JSON 직렬화)로 던진다.
  // engine 은 이를 파싱해 code/retryable 을 보존해야 한다(unknown 래핑 금지).
  const engine = createNodeEngine({
    async invoke() {
      throw new Error('{"code":"command.not_found","message":"command not found: nope"}');
    },
  });

  await assert.rejects(
    () => engine.invoke('nope'),
    (err: unknown) => {
      if (!(err instanceof RustraCommandError)) return false;
      assert.equal(err.code, 'command.not_found');
      assert.equal(err.message, 'command not found: nope');
      assert.equal(err.retryable, false);
      return true;
    },
  );
});

test('createNodeEngine parses Display-style "code: message" Error message', async () => {
  // Display 평탄화("code: message") 경로도 동일하게 code 를 복원한다.
  const engine = createNodeEngine({
    async invoke() {
      throw new Error('command.not_found: nope');
    },
  });

  await assert.rejects(
    () => engine.invoke('nope'),
    (err: unknown) => {
      if (!(err instanceof RustraCommandError)) return false;
      assert.equal(err.code, 'command.not_found');
      assert.equal(err.message, 'nope');
      return true;
    },
  );
});

// ── createNodeProcessTransport — subprocess stdio 프로토콜 ──

import { createNodeProcessTransport } from './index.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

// 저장소 루트 기준 절대경로 — 테스트는 packages/node/dist 에서 실행된다.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
// Bun 1.4 coverage instrumentation currently makes node:child_process spawn fail
// with EBADF. The normal Bun suite still runs these real-process tests; only the
// coverage-only pass skips them until the upstream runner issue is fixed.
const processTest = process.env.RUSTRA_BUN_COVERAGE === '1' ? test.skip : test;

processTest(
  'createNodeProcessTransport invokes a real Rust runtime over stdio',
  { timeout: 30_000 },
  async () => {
    // calculator 예제 바이너리가 stdio JSON 프로토콜로 응답하는지 실제 검증.
    const transport = createNodeProcessTransport({
      command: resolve(repoRoot, 'target/debug/rustra-calculator-example'),
      args: ['invoke'],
    });
    const result = (await transport.invoke('addNumbers', { a: 20, b: 22 })) as {
      value: number;
    };
    assert.equal(result.value, 42);
    transport.dispose();
  },
);

processTest('createNodeProcessTransport surfaces spawn failures as transport.error', async () => {
  const transport = createNodeProcessTransport({
    command: './definitely-not-a-real-binary',
  });
  await assert.rejects(transport.invoke('addNumbers', {}) as Promise<unknown>, (err: unknown) => {
    if (!(err instanceof RustraCommandError)) return false;
    assert.equal(err.code, 'transport.error');
    return true;
  });
});

processTest('createNodeLoopTransport keeps a persistent process and correlates by id', async () => {
  const { createNodeLoopTransport } = await import('./index.js');
  const bin = join(repoRoot, 'target', 'debug', 'loop-stdio');
  const transport = createNodeLoopTransport({ command: bin, args: [] });
  try {
    // 첫 invoke 후 프로세스가 살아 있다(lazy spawn).
    const a = (await transport.invoke('addNumbers', { a: 20, b: 22 })) as { value: number };
    const pid1 = transport.pid;
    assert.ok(pid1, 'process spawned lazily on first invoke');

    // 이후 호출이 같은 프로세스에서 처리된다(persistent 증명).
    const b = (await transport.invoke('greet', { name: 'loop' })) as { message: string };
    assert.equal(a.value, 42);
    assert.equal(b.message, 'Hello, loop!');
    assert.equal(transport.pid, pid1, 'process is reused, not respawned');

    // 이벤트 drain (특수 명령 경유) — 실제 비어 있지 않은 top-level `events`
    // 프레임을 읽어 result와 혼동하지 않는지 검증한다.
    const emitted = (await transport.invoke('emitDemo', {
      ticks: 2,
      stepDelayMs: 0,
    })) as { emitted: number };
    assert.equal(emitted.emitted, 3);
    const events = await transport.drainEvents();
    assert.deepEqual(events, [
      { name: 'progress.tick', payload: { step: 1, total: 2 } },
      { name: 'progress.tick', payload: { step: 2, total: 2 } },
      { name: 'demo.done', payload: { emitted: 3 } },
    ]);

    // 존재하지 않는 명령 — id 상관 에러 전파.
    await assert.rejects(
      () => transport.invoke('nope') as Promise<unknown>,
      (err: unknown) => err instanceof RustraCommandError && err.code === 'command.not_found',
    );
  } finally {
    transport.dispose();
    assert.equal(transport.pid, null);
  }
});
