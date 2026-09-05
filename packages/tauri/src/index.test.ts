import assert from 'node:assert/strict';
import test from 'node:test';
import { createTauriBootstrap, createTauriEngine, subscribeTauriEvent } from './index.js';
import { RustraCommandError, configureDebug, type RustraDebugEvent } from '@rustra/types';

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
  await subscribeEvent<typeof seen>('tick', (p) => seen.push(p), fakeListen);

  assert.equal(captured!.channel, 'rustra://tick');
  fire!('{"value":42}');
  assert.deepEqual(seen, [{ value: 42 }]);
  // 비 JSON 페이로드는 원본 문자열로 전달(조용한 드롭 방지).
  fire!('not-json');
  assert.equal(seen[1], 'not-json');
});

// ── 콜백 예외 경계 (R01) — 변환 경계와 사용자 콜백 경계는 분리된다 ──
// 결함: 콜백이 JSON.parse 와 같은 try 에 있어 콜백 throw 가 catch 로 떨어져
// 원본 문자열로 "재호출"되고, 두 번째 throw 는 Tauri 이벤트 기계로 탈출해
// 형제 리스너를 깨뜨릴 수 있었다. 계약: 변환 실패 시 원본 문자열 1회 전달은
// 단일 전달이고, 콜백 예외는 리스너 오류 정책(관측 + 삼켜서 형제 보호)으로 귀결.

/** listen 목업 — 채널 정합을 확인하고 `fire` 로 테스트가 이벤트를 발사한다.
 * 실제 Tauri 처럼 채널당 리스너 여럿을 독립 등록하며, fire 는 등록 순서대로
 * 동기 호출한다(리스너 예외를 흡수하지 않는다 — 경계 위반은 그대로 실패로). */
function mockListen(): {
  listen: (channel: string, handler: (event: { payload: string }) => void) => Promise<() => void>;
  fire: (payload: string) => void;
} {
  const handlers: Array<(event: { payload: string }) => void> = [];
  return {
    listen: async (channel, handler) => {
      assert.equal(channel, 'rustra://tick');
      handlers.push(handler);
      return () => {};
    },
    fire: (payload) => {
      for (const handler of handlers) handler({ payload });
    },
  };
}

test('subscribeEvent keeps a throwing callback inside the listener boundary (called once, error observed)', async () => {
  const { subscribeEvent } = await import('./index.js');
  const { listen, fire } = mockListen();
  const events: RustraDebugEvent[] = [];
  configureDebug((event) => events.push(event));
  try {
    let calls = 0;
    const boom = new Error('callback exploded');
    await subscribeEvent<{ value: number }>(
      'tick',
      () => {
        calls += 1;
        throw boom;
      },
      listen,
    );

    // 프로미스 자체가 resolve 해야 한다 — 콜백 예외가 구독/전달 경로를 깨지 않는다.
    fire('{"value":42}');
    assert.equal(calls, 1, 'callback must be invoked exactly once — no re-invocation');
    const listenerErrors = events.filter((event) => event.kind === 'tauri.listener_error');
    assert.equal(listenerErrors.length, 1, 'exactly one listener_error diagnostic');
    assert.equal(listenerErrors[0]!.command, 'tick');
    assert.equal(listenerErrors[0]!.error, String(boom));
  } finally {
    configureDebug(undefined);
  }
});

test('subscribeEvent delivers parsed payloads once for a normal callback', async () => {
  const { subscribeEvent } = await import('./index.js');
  const { listen, fire } = mockListen();
  const seen: unknown[] = [];
  await subscribeEvent<{ value: number }>('tick', (payload) => seen.push(payload), listen);
  fire('{"value":42}');
  assert.deepEqual(seen, [{ value: 42 }]);
});

test('subscribeEvent delivers invalid JSON as the original string exactly once', async () => {
  const { subscribeEvent } = await import('./index.js');
  const { listen, fire } = mockListen();
  const seen: unknown[] = [];
  await subscribeEvent<string>('tick', (payload) => seen.push(payload), listen);
  fire('not-json');
  assert.deepEqual(seen, ['not-json'], 'single-pass fallback delivery of the raw string');
});

test('subscribeEvent protects sibling listeners from a throwing listener', async () => {
  const { subscribeEvent } = await import('./index.js');
  const { listen, fire } = mockListen();
  const events: RustraDebugEvent[] = [];
  configureDebug((event) => events.push(event));
  try {
    // 같은 이벤트 채널에 리스너 2개 — 첫 리스너가 throw 해도 둘째는 정상 도달.
    await subscribeEvent<{ value: number }>(
      'tick',
      () => {
        throw new Error('first listener exploded');
      },
      listen,
    );
    const seen: unknown[] = [];
    await subscribeEvent<{ value: number }>('tick', (payload) => seen.push(payload), listen);

    fire('{"value":42}');
    assert.deepEqual(seen, [{ value: 42 }], 'sibling listener unaffected by the throwing one');
    assert.equal(
      events.filter((event) => event.kind === 'tauri.listener_error').length,
      1,
      'only the throwing listener is diagnosed',
    );
  } finally {
    configureDebug(undefined);
  }
});

test('subscribeEvent keeps the raw-string fallback inside the callback boundary too', async () => {
  // 폴백 전달(원본 문자열)도 콜백 호출 경로다 — 여기서 throw 하면 파서 catch 에서
  // 탈출해 무음 이스케이프(형제 중단 + 진단 0건)가 됐다. R01 계약: 모든 콜백
  // 호출 경로가 경계 안에 있다.
  const { subscribeEvent } = await import('./index.js');
  const { listen, fire } = mockListen();
  const events: RustraDebugEvent[] = [];
  configureDebug((event) => events.push(event));
  try {
    let calls = 0;
    await subscribeEvent<string>(
      'tick',
      () => {
        calls += 1;
        throw new Error('fallback listener exploded');
      },
      listen,
    );
    const seen: unknown[] = [];
    await subscribeEvent<string>('tick', (payload) => seen.push(payload), listen);

    fire('not-json');
    assert.equal(calls, 1, 'fallback delivery must also be invoked exactly once');
    assert.deepEqual(seen, ['not-json'], 'sibling listener still receives the raw string');
    const listenerErrors = events.filter((event) => event.kind === 'tauri.listener_error');
    assert.equal(listenerErrors.length, 1, 'the silent escape now produces one diagnostic');
    assert.equal(listenerErrors[0]!.command, 'tick');
  } finally {
    configureDebug(undefined);
  }
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
