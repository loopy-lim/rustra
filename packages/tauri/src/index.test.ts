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
  // 트랙 E2 — invokeBatch 는 이제 rustra_dispatch_batch 와이어 배치 한 번으로
  // 처리된다. mock 호스트는 Rust 계약(항목별 ok/result)을 그대로 흉내 낸다.
  const engine = createTauriEngine({
    async invoke(command, args) {
      if (command === 'rustra_dispatch_batch') {
        const requests = (args as { requests: Array<{ command: string }> }).requests;
        return requests.map((request) => ({
          ok: true,
          result: request.command === 'first' ? 1 : 2,
        }));
      }
      return {};
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

// ── 와이어 배치 — rustra_dispatch_batch 단일 횡단 (트랙 E2) ──

test('createTauriEngine routes invokeBatch through rustra_dispatch_batch', async () => {
  const calls: Array<{ command: string; args: unknown }> = [];
  let dispatchCalls = 0;
  const engine = createTauriEngine({
    invoke(command, args) {
      calls.push({ command, args });
      if (command === 'rustra_dispatch_batch') {
        dispatchCalls += 1;
        const requests = (args as { requests: Array<{ command: string }> }).requests;
        return Promise.resolve(
          requests.map((request) =>
            request.command === 'add'
              ? { ok: true, result: { value: 42 } }
              : { ok: true, result: { v: 1 } },
          ),
        );
      }
      return Promise.resolve({});
    },
  });
  const out = await engine.invokeBatch<Array<{ value: number } | { v: number }>>([
    { command: 'add', args: { a: 20, b: 22 } },
    { command: 'mul', args: { a: 2, b: 3 } },
    { command: 'add', args: { a: 1, b: 1 } },
  ]);
  assert.equal(dispatchCalls, 1, 'batch must be a single rustra_dispatch_batch crossing');
  assert.equal(calls.length, 1, 'no per-entry rustra_dispatch calls');
  assert.deepEqual(calls[0], {
    command: 'rustra_dispatch_batch',
    args: {
      requests: [
        { command: 'add', args: { a: 20, b: 22 } },
        { command: 'mul', args: { a: 2, b: 3 } },
        { command: 'add', args: { a: 1, b: 1 } },
      ],
    },
  });
  assert.deepEqual(out, [{ value: 42 }, { v: 1 }, { value: 42 }]);
});

test('createTauriEngine batch rejects with the failing entry error without failing siblings', async () => {
  // Rust 계약: 항목별 ok/error (fail-fast 아님). TS 는 실패 항목의 에러를
  // 그대로 전파한다 — Promise.all 이므로 형제 항목 성공은 관찰되지 않지만
  // 에러 객체는 실패한 항목 것임이 보장되어야 한다.
  const engine = createTauriEngine({
    async invoke(command, args) {
      if (command === 'rustra_dispatch_batch') {
        const requests = (args as { requests: Array<{ command: string }> }).requests;
        return requests.map((request) =>
          request.command === 'boom'
            ? {
                ok: false,
                error: { code: 'command.not_found', message: 'command not found: boom' },
              }
            : { ok: true, result: { value: 7 } },
        );
      }
      return {};
    },
  });
  await assert.rejects(
    engine.invokeBatch([
      { command: 'add', args: {} },
      { command: 'boom', args: {} },
    ]),
    (error: unknown) => {
      if (!(error instanceof RustraCommandError)) return false;
      assert.equal(error.code, 'command.not_found');
      assert.equal(error.message, 'command not found: boom');
      return true;
    },
  );
});

test('createTauriEngine batch normalizes undefined args to empty objects', async () => {
  const engine = createTauriEngine({
    async invoke(command, args) {
      if (command === 'rustra_dispatch_batch') {
        const requests = (args as { requests: Array<{ args: unknown }> }).requests;
        return requests.map(() => ({ ok: true, result: null }));
      }
      return {};
    },
  });
  const out = await engine.invokeBatch([{ command: 'a' }, { command: 'b', args: undefined }]);
  assert.deepEqual(out, [null, null]);
});

// ── 채널 어댑터 — invoke 발급 + listen 콜백 브릿지 ──

test('createChannel issues a handle via rustra_channel_create and listens on the handle channel', async () => {
  const { createChannel } = await import('./index.js');
  const calls: Array<{ command: string; args: unknown }> = [];
  const channels = new Set<string>();
  const fakeInvoke = async (command: string, args?: unknown) => {
    calls.push({ command, args });
    if (command === 'rustra_channel_create') return { handle: 7 };
    if (command === 'rustra_channel_drop') return true;
    throw new Error(`unexpected command: ${command}`);
  };
  const fakeListen = async (channel: string, handler: (e: { payload: string }) => void) => {
    channels.add(channel);
    (fakeInvoke as unknown as { __fire?: (p: string) => void }).__fire = (payload: string) =>
      handler({ payload });
    return () => {};
  };

  const received: unknown[] = [];
  const channel = await createChannel((p) => received.push(p), {
    invoke: fakeInvoke,
    listen: fakeListen,
  });
  assert.equal(channel.handle, 7);
  assert.deepEqual(calls, [{ command: 'rustra_channel_create', args: undefined }]);
  assert.ok(channels.has('rustra://channel/7'), 'listener bound to rustra://channel/{handle}');

  (fakeInvoke as unknown as { __fire: (p: string) => void }).__fire('{"step":1}');
  assert.deepEqual(received, [{ step: 1 }], 'payload parsed once to a typed value');
});

test('createChannel falls back to the raw string payload when JSON parsing fails', async () => {
  const { createChannel } = await import('./index.js');
  let fire: ((p: string) => void) | null = null;
  const channel = await createChannel((p) => received.push(p), {
    invoke: async () => ({ handle: 3 }),
    listen: async (_channel, handler) => {
      fire = (payload) => handler({ payload });
      return () => {};
    },
  });
  const received: unknown[] = [];
  fire!('not-json');
  assert.equal(received[0], 'not-json');
  void channel;
});

test('createChannel loud-fails on handle 0 (channel-space exhaustion)', async () => {
  const { createChannel } = await import('./index.js');
  await assert.rejects(
    createChannel(() => {}, { invoke: async () => ({ handle: 0 }) }),
    (err: unknown) => err instanceof RustraCommandError,
  );
});

test('createChannel loud-fails on invoke rejection', async () => {
  const { createChannel } = await import('./index.js');
  await assert.rejects(
    createChannel(() => {}, {
      invoke: async () => {
        throw new Error('ipc dead');
      },
    }),
    /ipc dead/,
  );
});

test('createChannel close() invokes rustra_channel_drop, unhooks the listener, ignores late frames', async () => {
  const { createChannel } = await import('./index.js');
  const calls: Array<{ command: string; args: unknown }> = [];
  let unlistened = 0;
  let fire: ((p: string) => void) | null = null;
  const received: unknown[] = [];
  const channel = await createChannel((p) => received.push(p), {
    invoke: async (command, args) => {
      calls.push({ command, args });
      if (command === 'rustra_channel_create') return { handle: 9 };
      if (command === 'rustra_channel_drop') return true;
      throw new Error('unexpected');
    },
    listen: async (_channel, handler) => {
      fire = (payload) => handler({ payload });
      return () => {
        unlistened += 1;
      };
    },
  });

  fire!('{"v":1}');
  assert.deepEqual(received, [{ v: 1 }]);
  assert.equal(await channel.close(), true);
  assert.deepEqual(
    calls.filter((c) => c.command === 'rustra_channel_drop'),
    [{ command: 'rustra_channel_drop', args: { handle: 9 } }],
  );
  assert.equal(unlistened, 1, 'listener unhooked');
  fire!('{"v":2}');
  assert.deepEqual(received, [{ v: 1 }], 'late frames ignored after close');
  assert.equal(await channel.close(), true, 'double close is idempotent');
});

test('createChannel discovers the Tauri global without explicit io', async () => {
  const { createChannel } = await import('./index.js');
  const root = globalThis as typeof globalThis & { __TAURI__?: unknown };
  const previous = root.__TAURI__;
  root.__TAURI__ = {
    core: { invoke: async (command: string) => ({ handle: 5, dropped: command === 'x' }) },
    event: {
      listen: async () => () => {},
    },
  };
  try {
    const channel = await createChannel(() => {});
    assert.equal(channel.handle, 5);
  } finally {
    root.__TAURI__ = previous;
  }
});
