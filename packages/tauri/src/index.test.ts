import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createTauriBootstrap,
  createTauriEngine,
  subscribeEvent,
  subscribeTauriEvent,
} from './index.js';
import { RustraCommandError } from '@rustra/types';

test('createTauriEngine routes invoke through rustra_dispatch', async () => {
  const calls: Array<{ command: string; args: unknown }> = [];
  const engine = createTauriEngine({
    async invoke(command, args) {
      calls.push({ command, args });
      return { value: 42 };
    },
  });

  const result = await engine.invoke<{ value: number }>('addNumbers', { a: 20, b: 22 });
  assert.deepEqual(result, { value: 42 });
  assert.deepEqual(calls, [
    { command: 'rustra_dispatch', args: { command: 'addNumbers', args: { a: 20, b: 22 } } },
  ]);
});

test('createTauriEngine applies timeoutMs and shallow abort to pending transports', async () => {
  const engine = createTauriEngine({
    invoke: () => new Promise<never>(() => {}),
  });

  await assert.rejects(
    engine.invoke('slow', undefined, { timeoutMs: 10 }),
    (err: unknown) => err instanceof RustraCommandError && err.code === 'transport.timeout',
  );

  const controller = new AbortController();
  const pending = engine.invoke('cancel-me', undefined, { signal: controller.signal });
  controller.abort();
  await assert.rejects(
    pending,
    (err: unknown) => err instanceof RustraCommandError && err.code === 'cancelled',
  );
});

test('createTauriEngine exposes Promise-based invokeBatch with stable order', async () => {
  const engine = createTauriEngine({
    async invoke(_command, args) {
      return (args as { command: string }).command === 'first' ? 1 : 2;
    },
  });
  const out = await engine.invokeBatch<number>([{ command: 'first' }, { command: 'second' }]);
  assert.deepEqual(out, [1, 2]);
});

test('createTauriEngine normalizes undefined args to empty object', async () => {
  const calls: Array<{ command: string; args: unknown }> = [];
  const engine = createTauriEngine({
    async invoke(command, args) {
      calls.push({ command, args });
      return {};
    },
  });

  await engine.invoke('noArgs');
  assert.deepEqual(calls, [{ command: 'rustra_dispatch', args: { command: 'noArgs', args: {} } }]);
});

test('createTauriEngine discovers the Tauri global without manual transport wiring', async () => {
  const root = globalThis as typeof globalThis & { __TAURI__?: unknown };
  const previous = root.__TAURI__;
  const calls: Array<{ command: string; args: unknown }> = [];
  root.__TAURI__ = {
    core: {
      async invoke(command: string, args: unknown) {
        calls.push({ command, args });
        return { value: 42 };
      },
    },
  };
  try {
    const result = await createTauriEngine().invoke<{ value: number }>('addNumbers', {
      a: 20,
      b: 22,
    });
    assert.deepEqual(result, { value: 42 });
    assert.equal(calls[0]?.command, 'rustra_dispatch');
  } finally {
    root.__TAURI__ = previous;
  }
});

test('createTauriBootstrap delays global discovery until the first command', async () => {
  const root = globalThis as typeof globalThis & { __TAURI__?: unknown };
  const previous = root.__TAURI__;
  delete root.__TAURI__;
  const bootstrap = createTauriBootstrap();
  root.__TAURI__ = {
    core: { invoke: async () => ({ ready: true }) },
  };
  try {
    const engine = await bootstrap.ready();
    assert.deepEqual(await engine.invoke('ping'), { ready: true });
  } finally {
    root.__TAURI__ = previous;
  }
});

test('createTauriEngine wraps RustraError-shaped rejects into RustraCommandError', async () => {
  const engine = createTauriEngine({
    async invoke() {
      throw { code: 'transport.timeout', message: 'request timed out', retryable: true };
    },
  });

  await assert.rejects(
    () => engine.invoke('cmd'),
    (err: unknown) => {
      if (!(err instanceof RustraCommandError)) return false;
      assert.equal(err.code, 'transport.timeout');
      assert.equal(err.message, 'request timed out');
      assert.equal(err.retryable, true);
      return true;
    },
  );
});

test('createTauriEngine wraps non-Error throws as unknown, Error messages via parser', async () => {
  // 문자열 throw 는 그대로 unknown 래핑 — Error 가 아니면 파서를 타지 않는다.
  const engine = createTauriEngine({
    async invoke() {
      throw 'transport died';
    },
  });

  await assert.rejects(
    () => engine.invoke('cmd'),
    (err: unknown) => {
      if (!(err instanceof RustraCommandError)) return false;
      assert.equal(err.code, 'unknown');
      return true;
    },
  );
});

// ── Rust 와이어 에러 — Error.message 의 RustraError JSON/Display 복원 ──

test('createTauriEngine parses RustraError JSON message from wire Error', async () => {
  // Rust 가 RustraError 를 JSON 직렬화해 Error 로 던지는 경우 code/retryable 을
  // 보존한다(unknown 래핑 금지 — @rustra/node 와 동일 파이프라인).
  const engine = createTauriEngine({
    async invoke() {
      throw new Error('{"code":"command.not_found","message":"command not found: nope"}');
    },
  });

  await assert.rejects(
    () => engine.invoke('nope'),
    (err: unknown) => {
      if (!(err instanceof RustraCommandError)) return false;
      assert.equal(err.code, 'command.not_found');
      assert.equal(err.retryable, false);
      return true;
    },
  );
});

test('createTauriEngine parses Display-style "code: message" Error message', async () => {
  const engine = createTauriEngine({
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

test('rustraEventChannel sanitizes and prefixes like Rust event_channel', async () => {
  const { rustraEventChannel } = await import('./index.js');
  assert.equal(rustraEventChannel('progress.tick'), 'rustra://progress_tick');
  assert.equal(rustraEventChannel('llm.stream-token'), 'rustra://llm_stream-token');
  assert.equal(rustraEventChannel('a b/c'), 'rustra://a_b/c');
});

test('subscribeEvent parses JSON payloads and falls back to raw string', async () => {
  const { subscribeEvent } = await import('./index.js');
  let captured: { channel: string } | null = null;
  let fire: ((payload: string) => void) | null = null;
  const fakeListen = async (channel: string, handler: (e: { payload: string }) => void) => {
    captured = { channel };
    fire = (payload: string) => handler({ payload });
    return () => {};
  };

  const seen: unknown[] = [];
  await subscribeEvent<typeof seen>(fakeListen, 'tick', (p) => seen.push(p));

  assert.equal(captured!.channel, 'rustra://tick');
  fire!('{"value":42}');
  assert.deepEqual(seen, [{ value: 42 }]);
  // 비 JSON 페이로드는 원본 문자열로 전달(조용한 드롭 방지).
  fire!('not-json');
  assert.equal(seen[1], 'not-json');
});

test('subscribeEvent also accepts the canonical name-first shape', async () => {
  let subscribed = '';
  const fakeListen = async (channel: string, handler: (e: { payload: string }) => void) => {
    subscribed = channel;
    handler({ payload: JSON.stringify({ value: 7 }) });
    return () => {};
  };
  const received: unknown[] = [];
  await subscribeEvent('calc.tick', (payload) => received.push(payload), fakeListen);
  assert.equal(subscribed, 'rustra://calc_tick');
  assert.deepEqual(received, [{ value: 7 }]);
});

test('subscribeTauriEvent discovers the global listen API', async () => {
  const root = globalThis as typeof globalThis & { __TAURI__?: unknown };
  const previous = root.__TAURI__;
  let channel = '';
  root.__TAURI__ = {
    event: {
      async listen(name: string, handler: (event: { payload: string }) => void) {
        channel = name;
        handler({ payload: '{"value":42}' });
        return () => {};
      },
    },
  };
  try {
    let payload: unknown;
    await subscribeTauriEvent('calc.tick', (value) => {
      payload = value;
    });
    assert.equal(channel, 'rustra://calc_tick');
    assert.deepEqual(payload, { value: 42 });
  } finally {
    root.__TAURI__ = previous;
  }
});
