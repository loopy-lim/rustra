import assert from 'node:assert/strict';
import test from 'node:test';
import { createNodeBootstrap, createNodeEngine } from './index.js';
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

test('createNodeEngine applies timeoutMs and shallow abort to pending transports', async () => {
  const engine = createNodeEngine({
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

test('createNodeEngine exposes Promise-based invokeBatch with stable order', async () => {
  const engine = createNodeEngine({
    async invoke(command) {
      return command === 'first' ? 1 : 2;
    },
  });
  const out = await engine.invokeBatch<number>([{ command: 'first' }, { command: 'second' }]);
  assert.deepEqual(out, [1, 2]);
});

test('createNodeEngine wraps RustraError-shaped rejects into RustraCommandError', async () => {
  const engine = createNodeEngine({
    async invoke() {
      throw { code: 'transport.timeout', message: 'request timed out', retryable: true };
    },
  });

  await assert.rejects(
    () => engine.invoke('missing'),
    (err: unknown) => {
      if (!(err instanceof RustraCommandError)) return false;
      assert.equal(err.code, 'transport.timeout');
      assert.equal(err.message, 'request timed out');
      assert.equal(err.retryable, true);
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
// Bun 1.4 currently makes node:child_process posix_spawn fail with EBADF in
// this workspace. The process transport is a Node host API; run these tests
// from the compiled Node test suite instead of reporting a Bun runner issue
// as a transport failure.
const isBun = typeof process.versions.bun === 'string';
const processTest = isBun || process.env.RUSTRA_BUN_COVERAGE === '1' ? test.skip : test;

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

processTest(
  'createNodeProcessTransport exposes the runtime contract hash endpoint',
  { timeout: 30_000 },
  async () => {
    const transport = createNodeProcessTransport({
      command: resolve(repoRoot, 'target/debug/rustra-calculator-example'),
      args: ['invoke'],
    });
    const hash = await transport.getContractHash();
    assert.match(hash, /^[0-9a-f]{64}$/);
    transport.dispose();
  },
);

processTest('createNodeBootstrap owns lazy configure and Cargo runtime discovery', async () => {
  const bootstrap = createNodeBootstrap({
    commandCandidates: [resolve(repoRoot, 'target/debug/rustra-calculator-example')],
  });
  try {
    const engine = await bootstrap.ready();
    const result = await engine.invoke<{ value: number }>('addNumbers', { a: 20, b: 22 });
    assert.equal(result.value, 42);
  } finally {
    bootstrap.dispose();
  }
});

test('createNodeBootstrap reports the exact runtime override when discovery fails', async () => {
  const previous = process.env.RUSTRA_NODE_BINARY;
  delete process.env.RUSTRA_NODE_BINARY;
  const bootstrap = createNodeBootstrap({ commandCandidates: ['./missing-rustra-runtime'] });
  try {
    await assert.rejects(bootstrap.ready(), /RUSTRA_NODE_BINARY/);
  } finally {
    if (previous === undefined) delete process.env.RUSTRA_NODE_BINARY;
    else process.env.RUSTRA_NODE_BINARY = previous;
  }
});

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

processTest('createNodeProcessTransport preserves structured retryable errors', async () => {
  const transport = createNodeProcessTransport({
    command: process.execPath,
    args: [
      '-e',
      [
        'process.stdin.resume();',
        "process.stdin.on('end', () => process.stdout.write(JSON.stringify({ ok: false, error: JSON.stringify({ code: 'transport.timeout', message: 'timed out', retryable: true }) })));",
      ].join(' '),
    ],
  });
  await assert.rejects(transport.invoke('slow', {}) as Promise<unknown>, (err: unknown) => {
    return (
      err instanceof RustraCommandError &&
      err.code === 'transport.timeout' &&
      err.retryable === true
    );
  });
  transport.dispose();
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

// ── 바이너리 모드 (트랙 D) — __hello 핸드셰이크 후 length-prefixed rkyv V2 ──

processTest(
  'createNodeLoopTransport negotiates binary mode and round-trips rkyv V2 frames',
  { timeout: 30_000 },
  async () => {
    const { createNodeLoopTransport } = await import('./index.js');
    const bin = resolve(repoRoot, 'target/debug/loop-stdio');
    // generated 코덱 서브셋 — transport 가 내부에서 encode/decode 를 선택한다.
    const codecs = new Map(
      [
        ['addNumbers', 1],
        ['greet', 12],
        ['emitDemo', 11],
      ].map(([name, commandId]) => [
        name,
        {
          commandId,
          encode: () => {
            throw new Error('binary transport must use encodeInto');
          },
          decode: (frame: ArrayBuffer | ArrayBufferView) => {
            void frame;
            throw new Error('unused in this test');
          },
        },
      ]),
    );
    const transport = createNodeLoopTransport({
      command: bin,
      args: [],
      codecs: codecs as never,
    });
    try {
      // 핸드셰이크 정착 후 바이너리 모드 전환 증명.
      await transport.ready();
      assert.equal(transport.mode, 'binary');
    } finally {
      transport.dispose();
    }
  },
);

processTest(
  'createNodeLoopTransport without codecs stays on legacy NDJSON (no handshake)',
  { timeout: 30_000 },
  async () => {
    const { createNodeLoopTransport } = await import('./index.js');
    const bin = resolve(repoRoot, 'target/debug/loop-stdio');
    const transport = createNodeLoopTransport({ command: bin, args: [] });
    try {
      // codecs 미제공 시 __hello 를 보내지 않는다 — 레거시 NDJSON 유지.
      await transport.ready();
      assert.equal(transport.mode, 'ndjson');
      const a = (await transport.invoke('addNumbers', { a: 20, b: 22 })) as { value: number };
      assert.equal(a.value, 42);
    } finally {
      transport.dispose();
    }
  },
);

processTest(
  'dev replacement workflow: register → invoke → replace → invoke over the persistent loop (T0-4)',
  { timeout: 30_000 },
  async () => {
    const { createNodeLoopTransport, createNodeEngine } = await import('./index.js');
    // debug 빌드만 mutable — release 는 frozen(치환 차단)이 계약.
    const transport = createNodeLoopTransport({
      command: resolve(repoRoot, 'target/debug/loop-stdio'),
      args: [],
    });
    try {
      const engine = createNodeEngine(transport);
      const base = (await engine.invoke('addNumbers', { a: 20, b: 22 })) as { value: number };
      assert.equal(base.value, 42);

      // 런타임 register — JS 는 아무 것도 안 해도 새 명령을 부를 수 있다.
      const reg = (await engine.invoke('rustraRegistryDemo', { op: 'register' })) as {
        message: string;
      };
      assert.match(reg.message, /registered 'ping'/);
      const ping = (await engine.invoke('ping', {})) as { pong: boolean };
      assert.equal(ping.pong, true);

      // 치환 — 같은 이름 addNumbers 가 곱하기로 동작 (스키마 동일, 핸들러 교체).
      await engine.invoke('rustraRegistryDemo', { op: 'replaceAdd' });
      const replaced = (await engine.invoke('addNumbers', { a: 6, b: 7 })) as { value: number };
      assert.equal(replaced.value, 42, '6*7 — the replaced handler must serve');

      // 복원.
      await engine.invoke('rustraRegistryDemo', { op: 'restoreAdd' });
      const restored = (await engine.invoke('addNumbers', { a: 20, b: 22 })) as { value: number };
      assert.equal(restored.value, 42);
    } finally {
      transport.dispose();
    }
  },
);

// ── 핫스왑 reload (Task A1) — drain → dispose → 재부트스트랩 ─────────────────

processTest(
  'createNodeLoopTransport drain resolves when in-flight invocations settle',
  { timeout: 30_000 },
  async () => {
    const { createNodeLoopTransport } = await import('./index.js');
    const bin = resolve(repoRoot, 'target/debug/loop-stdio');
    const transport = createNodeLoopTransport({ command: bin, args: [] });
    try {
      await transport.ready();
      // in-flight 소스: 응답이 아직 오지 않은 invoke 하나를 걸어둔다.
      const slow = transport.invoke('addNumbers', { a: 20, b: 22 }) as Promise<unknown>;
      await transport.drain?.(5_000); // idle 이면 즉시, in-flight 은 정착까지 대기.
      await slow;
      // drain 이 이미 정착을 기다렸으므로 즉시 반환된다(타임아웃 없음).
      const started = Date.now();
      await transport.drain?.(5_000);
      assert.ok(Date.now() - started < 1_000, 'drain on idle transport resolves immediately');
    } finally {
      transport.dispose();
    }
  },
);

processTest(
  'createNodeLoopTransport drain gives up after the timeout guard when a request never settles',
  { timeout: 30_000 },
  async () => {
    // 응답하지 않는 자식(node 스텁) — pending 이 영원히 남아 drain 이 가드로
    // 포기하는지 검증한다. 200ms 가드로 짧게 끊는다.
    const { createNodeLoopTransport } = await import('./index.js');
    const transport = createNodeLoopTransport({
      command: process.execPath,
      args: ['-e', 'process.stdin.resume(); setTimeout(() => process.exit(0), 60000);'],
    });
    try {
      const never = transport.invoke('addNumbers', { a: 1, b: 2 }) as Promise<unknown>;
      const started = Date.now();
      await transport.drain?.(200);
      const elapsed = Date.now() - started;
      assert.ok(elapsed >= 150, `drain waited until the guard fired (took ${elapsed}ms)`);
      assert.ok(elapsed < 5_000, 'drain must not wait past the guard');
      transport.dispose();
      await assert.rejects(() => never as Promise<unknown>, /exited before responding/);
    } finally {
      transport.dispose();
    }
  },
);

processTest('createNodeBootstrap reload disposes and re-bootstraps the runtime', async () => {
  const bootstrap = createNodeBootstrap({
    commandCandidates: [resolve(repoRoot, 'target/debug/rustra-calculator-example')],
    args: ['invoke'],
  });
  try {
    const first = await bootstrap.ready();
    const one = await first.invoke<{ value: number }>('addNumbers', { a: 20, b: 22 });
    assert.equal(one.value, 42);

    await bootstrap.reload();

    const second = await bootstrap.ready();
    assert.notEqual(second, first, 'reload must produce a fresh engine instance');
    const two = await second.invoke<{ value: number }>('addNumbers', { a: 20, b: 22 });
    assert.equal(two.value, 42, 're-bootstrapped engine serves commands');
  } finally {
    bootstrap.dispose();
  }
});

test('createNodeBootstrap reload rejects when engine spawn fails (one-shot transport, no injected drain)', async () => {
  // NodeBootstrap.reload 은 원샷 트랜스포트를 내부에서 생성한다 — drain 주입은
  // 공개 계약에 없으며(drain 은 NodeLoopTransport 전용), 여기서 검증하는 것은
  // 스폰 실패(resolveNodeRuntime 부재) 전파뿐이다. 정상 경로 재부트스트랩은
  // 위의 'reload disposes and re-bootstraps' 실바이너리 테스트가 담당한다.
  const bootstrap = createNodeBootstrap({
    commandCandidates: ['./missing-rustra-runtime'],
  });
  await assert.rejects(bootstrap.reload(), /RUSTRA_NODE_BINARY|No Rustra Node runtime/);
});

// ── 이벤트 푸시 e2e (Task 6) — 실제 스폰 → 핸드셰이크 → 0xfffd → 콜백 ──────
// 단위 테스트(node-events.test.ts)와 Rust 통합 테스트(loop_stdio_events.rs)가
// 각 절반을 검증하므로, 이 테스트는 실 child stdout → demultiplexBinaryFrame →
// subscribeEvent 콜백 사슬 전체를 연결해 매트릭스 "Node 푸시" 문구의 증거가
// 된다.

processTest(
  'subscribeEvent delivers real emitted events as 0xfffd push frames from a spawned loop-stdio runtime',
  { timeout: 30_000 },
  async () => {
    const { createNodeLoopTransport, subscribeEvent } = await import('./index.js');
    // test:ts:node 체인이 컴파일한 calculator 생성 레지스트리(dist-ts) —
    // rkyvV2Registry 는 rkyv-registry.js 의 export(name→codec Map).
    const { rkyvV2Registry } = await import(
      resolve(repoRoot, 'dist-ts/examples/calculator/generated/rkyv-registry.js')
    );
    const transport = createNodeLoopTransport({
      command: resolve(repoRoot, 'target/debug/loop-stdio'),
      args: [],
      codecs: rkyvV2Registry as never,
    });
    try {
      // (1) 핸드셰이크 capability — 런타임이 events:"push" 를 수용했다.
      await transport.ready();
      assert.equal(transport.pushCapable, true, 'runtime must accept the push capability');

      // (2) 실제 emit → push 프레임 → 구독자 콜백. emitDemo(ticks:2)는
      // progress.tick 2회 + demo.done 1회를 동기 emit 한다(단일 invoke 왕복
      // 안에서 — 푸시 프레임은 응답 프레임과 같은 stdout 스트림을 공유하므로
      // 디멀티플렉서가 둘을 찢지 않고 분기하는 것까지 함께 검증된다).
      const seen: Array<{ name: string; payload: unknown }> = [];
      const done = new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(
          () => reject(new Error(`push events did not arrive in time; got ${seen.length}/3`)),
          15_000,
        );
        const maybeSettled = (): void => {
          if (seen.length < 3) return;
          clearTimeout(deadline);
          resolve();
        };
        const unsubscribe = subscribeEvent(transport as never, 'progress.tick', (payload) => {
          seen.push({ name: 'progress.tick', payload });
          maybeSettled();
        });
        void unsubscribe;
        // demo.done 구독도 같은 루프 — 세 번째 이벤트 도달 시 settle.
        subscribeEvent(transport as never, 'demo.done', (payload) => {
          seen.push({ name: 'demo.done', payload });
          maybeSettled();
        });
      });
      const emitted = (await transport.invoke('emitDemo', {
        ticks: 2,
        stepDelayMs: 0,
      })) as { emitted: number };
      assert.equal(emitted.emitted, 3);
      await done;
      assert.equal(seen.length, 3, 'all 3 emitted events must reach subscribers via push');
      assert.deepEqual(seen[0], {
        name: 'progress.tick',
        payload: { step: 1, total: 2 },
      });
      assert.deepEqual(seen[2], { name: 'demo.done', payload: { emitted: 3 } });

      // (3) 이중 수신 부정 — 싱크가 설치된 동안 drain(0xfffe)은 빈 배열.
      const drained = await transport.drainEvents();
      assert.deepEqual(drained, [], 'sink-installed runtime must bypass the bus');
    } finally {
      transport.dispose();
    }
  },
);

// ── NDJSON 실패 라인·stderr 보존 (Task 7) — 실 스폰 경로 ──────────────────
// 자식은 node -e 스텁으로 stdout/stderr 를 제어한다(cargo 바이너리 불필요 —
// 'drain gives up after the timeout guard' 테스트와 동일 패턴). 추출된 순수
// 함수(recordUnparsedLine/attachExitContext)의 단위 검증은 node-loop.test.ts,
// debug 싱크 관측은 types configureDebug 계약을 따른다.

const GARBAGE_EMITTER = [
  'process.stdin.resume();',
  "process.stdout.write('garbage-not-json\\n');",
  "process.stdout.write(JSON.stringify({ id: 1, ok: true, result: { value: 42 } }) + '\\n');",
].join('');

processTest(
  'createNodeLoopTransport resolves a valid response even when garbage lines interleave (Task 7)',
  { timeout: 15_000 },
  async () => {
    const { createNodeLoopTransport } = await import('./index.js');
    const transport = createNodeLoopTransport({
      command: process.execPath,
      args: ['-e', GARBAGE_EMITTER],
    });
    try {
      const result = (await transport.invoke('addNumbers', { a: 20, b: 22 })) as {
        value: number;
      };
      assert.equal(result.value, 42, 'valid response must resolve past unparsed lines');
    } finally {
      transport.dispose();
    }
  },
);

processTest(
  'createNodeLoopTransport attaches preserved unparsed lines to pending rejections at exit (Task 7)',
  { timeout: 15_000 },
  async () => {
    const { createNodeLoopTransport } = await import('./index.js');
    // 40줄(용량 32 초과)의 garbage → exit. 최근 32줄(garbage-9..40)이 첨부되어야
    // 하고 원문 메시지는 접두로 유지된다. join('\n') — 자식 스크립트 텍스트엔
    // JSON.stringify 이스케이프로 실린다(자식에서 실제 개행으로 평가됨).
    const lines = Array.from({ length: 40 }, (_, i) => `garbage-${i + 1}`).join('\n');
    const transport = createNodeLoopTransport({
      command: process.execPath,
      args: [
        '-e',
        [
          'process.stdin.resume();',
          `process.stdout.write(${JSON.stringify(lines)} + '\\n');`,
          'setTimeout(() => process.exit(0), 50);',
        ].join(' '),
      ],
    });
    try {
      await assert.rejects(
        () => transport.invoke('addNumbers', { a: 1, b: 2 }) as Promise<unknown>,
        (err: unknown) => {
          if (!(err instanceof RustraCommandError)) return false;
          assert.equal(err.code, 'transport.error');
          assert.ok(
            err.message.startsWith('runtime process exited before responding'),
            'original message must remain the prefix',
          );
          assert.ok(err.message.includes('recent unparsed stdout lines'));
          assert.ok(err.message.includes('garbage-40'), 'most recent line is preserved');
          assert.ok(err.message.includes('garbage-9'), 'the last 32 lines are kept');
          assert.ok(!err.message.includes('garbage-8'), 'evicted lines past capacity are dropped');
          assert.ok(!err.message.includes('garbage-1\n'), 'oldest line is dropped');
          return true;
        },
      );
    } finally {
      transport.dispose();
    }
  },
);

processTest(
  'createNodeLoopTransport collects stderr and attaches it at exit in debug mode (Task 7)',
  { timeout: 15_000 },
  async () => {
    // 부모도 debug 모드로 세팅한다 — stderr 수집 게이트는 transport 쪽에서
    // isRustraDebugEnabled() 를 매 데이터 이벤트마다 읽는다. 다만 shouldDumpWire
    // 는 모듈 레벨 메모이즈이므로 resetDebugEnvForTests 로 먼저 무효화해야 env
    // 변경이 보인다(types debug.test.ts 와 동일 순서).
    const previousDebug = process.env.RUSTRA_DEBUG;
    const { resetDebugEnvForTests } = await import('@rustra/types');
    resetDebugEnvForTests();
    process.env.RUSTRA_DEBUG = '1';
    const { createNodeLoopTransport } = await import('./index.js');
    const transport = createNodeLoopTransport({
      command: process.execPath,
      args: [
        '-e',
        [
          'process.stdin.resume();',
          "process.stderr.write('boom: child panicked\\n');",
          'setTimeout(() => process.exit(1), 50);',
        ].join(' '),
      ],
    });
    try {
      await assert.rejects(
        () => transport.invoke('addNumbers', { a: 1, b: 2 }) as Promise<unknown>,
        (err: unknown) => {
          if (!(err instanceof RustraCommandError)) return false;
          assert.ok(err.message.startsWith('runtime process exited before responding'));
          assert.ok(err.message.includes('stderr:'), 'stderr section is attached');
          assert.ok(err.message.includes('boom: child panicked'));
          return true;
        },
      );
    } finally {
      transport.dispose();
      if (previousDebug === undefined) delete process.env.RUSTRA_DEBUG;
      else process.env.RUSTRA_DEBUG = previousDebug;
      resetDebugEnvForTests();
    }
  },
);
