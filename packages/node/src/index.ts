/**
 * @rustra/node — Node.js용 rustra 엔진 어댑터
 *
 * `@rustra/types`의 글로벌 invoke + Node napi-rs 전용 엔진을 제공합니다.
 *
 * @example
 * ```ts
 * import { configure } from '@rustra/types';
 * import { createRkyvV2Engine } from '@rustra/node';
 * import { rkyvV2Registry } from './generated/rkyv-registry.js';
 *
 * configure(createRkyvV2Engine(nativeAddon, rkyvV2Registry));
 *
 * // 이후 어디서든
 * const result = await addNumbers({ a: 42, b: 58 });
 * ```
 */

export type {
  EngineClient,
  RustraError,
  RkyvV2Codec,
  RkyvV2Native,
  InvokeOptions,
} from '@rustra/types';
export {
  RustraCommandError,
  configure,
  configureLazy,
  ensureConfigured,
  invoke,
  createRkyvV2Engine,
} from '@rustra/types';
import {
  configureLazy,
  ensureConfigured,
  RustraErrorCode,
  RustraCommandError,
  parseRustraErrorString,
  type EngineClient,
  type InvokeOptions,
} from '@rustra/types';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Node.js transport가 구현해야 하는 인터페이스입니다.
 */
export type NodeInvokeTransport = {
  invoke(command: string, args?: unknown): Promise<unknown> | unknown;
};

/**
 * napi-rs 등 JSON transport로 EngineClient을 생성합니다.
 */
export function createNodeEngine(transport: NodeInvokeTransport) {
  return {
    async invoke<T>(command: string, args?: unknown, options?: InvokeOptions): Promise<T> {
      // signal 정책(전 어댑터 공통): abort 된 signal 만 cancelled 로 거부하고,
      // 미abort signal 은 정상 실행한다. 이 엔진은 취소를 전파할 수 없는 JSON
      // transport 위에서 동작하므로 실행 중 abort 는 결과를 무시할 뿐이다(얕은
      // 취소). useCommand 처럼 항상 signal 을 전달하는 호출부와의 호환을 위해
      // signal 존재 자체를 에러로 삼지 않는다 — 매트릭스(docs/compatibility-matrix.md) 참고.
      if (options?.signal?.aborted) {
        throw new RustraCommandError(
          'cancelled',
          `invoke("${command}") aborted before dispatch`,
          true,
        );
      }
      try {
        return (await transport.invoke(command, args)) as T;
      } catch (e: unknown) {
        if (typeof e === 'object' && e !== null && 'code' in e && 'message' in e) {
          const err = e as { code: string; message: string };
          throw new RustraCommandError(err.code, err.message);
        }
        // napi/rust 와이어 — reason 이 RustraError JSON 또는 "code: message"
        // Display 문자열인 경우 parseRustraErrorString 이 code/retryable 을
        // 복원한다(unknown 래핑 방지).
        if (e instanceof Error) {
          throw parseRustraErrorString(e.message);
        }
        throw new RustraCommandError('unknown', String(e));
      }
    },
  };
}

// ── createNodeProcessTransport — "5분 온보딩" 완결 ──────────
//
// Rust 실행 파일의 `<bin> invoke` stdio 프로토콜(calculator 예제 패턴)을 그대로
// 쓰는 영구 서브프로세스 transport:
//   request:  stdin  ← {"command": "...", "args": {...}}\n  (한 줄당 한 요청)
//   response: stdout → {"ok": true, "result": ...}\n
//
// 호출당 프로세스를 띄우는 spawnSync 패턴(~수십 ms)과 달리 프로세스를 재사용해
// 호출당 오버헤드를 파이프 왕복으로 줄인다. Rust 측 예제 main.rs 의
// run_invoke_stdio 는 요청 하나만 읽고 종료하므로, 이 transport 는 호출마다
// 프로세스를 재시작하는 lazy-respawn 전략을 쓴다 — 프로토콜 자체는 향후
// 루프형 런타임이 나와도 동일한 프레임 그대로 호환된다.

export type NodeProcessTransportOptions = {
  /** Rust 실행 파일 경로 (예: `target/release/my-app`). */
  command: string;
  /** 실행 파일에 넘길 인자 — 기본 `['invoke']`. */
  args?: string[];
  /** `spawn` 옵션 (cwd/env 등). */
  spawnOptions?: Parameters<typeof spawn>[2];
};

export type NodeProcessTransport = NodeInvokeTransport & {
  /** 서브프로세스를 지금 종료시킨다. 다음 invoke 는 새 프로세스로 재시작한다. */
  dispose(): void;
  /** 현재 프로세스 PID — 미실행 중이면 null. */
  readonly pid: number | null;
};

type ResponseFrame = { ok: true; result: unknown } | { ok: false; error?: string };

/**
 * stdio JSON 프로토콜 Rust 실행 파일로 통하는 transport를 생성한다.
 *
 * @example
 * ```ts
 * import { createNodeProcessTransport } from '@rustra/node';
 * const transport = createNodeProcessTransport({
 *   command: 'target/release/my-app',
 * });
 * const engine = createNodeEngine(transport);
 * ```
 */
export function createNodeProcessTransport(
  options: NodeProcessTransportOptions,
): NodeProcessTransport {
  const argv = options.args ?? ['invoke'];
  let child: ChildProcessWithoutNullStreams | null = null;
  // invoke 직후 프로세스가 응답하고 종료하는 프로토콜이므로, 매 호출마다
  // fresh 프로세스에서 요청을 쓰고 응답을 모두 읽는다(respawn-on-invoke).
  const invokeOnce = (command: string, args?: unknown): Promise<unknown> => {
    return new Promise((resolve, reject) => {
      let settled = false;
      const proc = spawn(options.command, argv, options.spawnOptions ?? {});
      child = proc as ChildProcessWithoutNullStreams;
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      if (!proc.stdout || !proc.stderr) {
        reject(new RustraCommandError('transport.error', 'stdio unavailable', true));
        return;
      }
      proc.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      proc.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      proc.on('error', (err) => {
        if (settled) return;
        settled = true;
        reject(new RustraCommandError('transport.error', `spawn failed: ${String(err)}`, true));
      });
      proc.on('close', (code) => {
        if (settled) return;
        settled = true;
        const text = Buffer.concat(stdout).toString('utf8').trim();
        if (text.length === 0) {
          const errText = Buffer.concat(stderr).toString('utf8').trim();
          reject(
            new RustraCommandError(
              'transport.error',
              errText || `runtime exited with code ${code}`,
              true,
            ),
          );
          return;
        }
        try {
          const frame = JSON.parse(text) as ResponseFrame;
          if (frame.ok) resolve(frame.result);
          else reject(new RustraCommandError('invoke.failed', frame.error ?? 'invoke failed'));
        } catch {
          reject(
            new RustraCommandError(
              'transport.error',
              `invalid response frame: ${text.slice(0, 200)}`,
            ),
          );
        }
      });
      if (!proc.stdin) {
        reject(new RustraCommandError('transport.error', 'stdin unavailable', true));
        return;
      }
      const request = JSON.stringify({ command, args: args ?? {} });
      proc.stdin.write(request);
      proc.stdin.end();
    });
  };

  return {
    invoke(command: string, args?: unknown) {
      return invokeOnce(command, args);
    },
    dispose() {
      if (child && child.exitCode === null) {
        child.kill();
      }
      child = null;
    },
    get pid() {
      return child?.pid ?? null;
    },
  };
}

export type NodeBootstrapOptions = {
  /** Explicit runtime binary. `RUSTRA_NODE_BINARY` has higher priority. */
  command?: string;
  /** Codegen-provided release/debug candidates used when no override is set. */
  commandCandidates?: readonly string[];
  /** Cargo binary name used for bounded ancestor discovery after transpilation. */
  binaryName?: string;
  /** Runtime arguments. Defaults to the standard one-shot `invoke` protocol. */
  args?: string[];
  spawnOptions?: Parameters<typeof spawn>[2];
};

export type NodeBootstrap = {
  ready(): Promise<EngineClient>;
  dispose(): void;
};

function resolveNodeRuntime(options: NodeBootstrapOptions): string {
  const explicit = process.env.RUSTRA_NODE_BINARY ?? options.command;
  if (explicit) return explicit;
  const candidates = [...(options.commandCandidates ?? [])];
  if (options.binaryName) {
    const executable = options.binaryName + (process.platform === 'win32' ? '.exe' : '');
    let current = resolve(process.cwd());
    while (true) {
      candidates.push(resolve(current, 'target', 'release', executable));
      candidates.push(resolve(current, 'target', 'debug', executable));
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  const inferred = candidates.find((candidate) => existsSync(candidate));
  if (inferred) return inferred;
  throw new RustraCommandError(
    RustraErrorCode.TransportUnavailable,
    'No Rustra Node runtime was found. Build the inferred Cargo binary, or set RUSTRA_NODE_BINARY to its absolute path.',
  );
}

/**
 * Installs a lazy Node process engine. Generated `node.ts` supplies portable
 * Cargo target candidates, so application code only imports generated commands.
 */
export function createNodeBootstrap(options: NodeBootstrapOptions = {}): NodeBootstrap {
  let transport: NodeProcessTransport | undefined;
  configureLazy(() => {
    transport = createNodeProcessTransport({
      command: resolveNodeRuntime(options),
      args: options.args,
      spawnOptions: options.spawnOptions,
    });
    return createNodeEngine(transport);
  });
  return {
    ready: ensureConfigured,
    dispose() {
      transport?.dispose();
      transport = undefined;
    },
  };
}

// ── createNodeLoopTransport — persistent 프로세스 + NDJSON 라인 프레이밍 ──
//
// lazy-respawn(`createNodeProcessTransport`)은 호출마다 프로세스를 재시작해
// 부팅/초기화 비용을 매 invoke 에 지불한다. 이 transport 는 루프형 stdio
// 런타임(examples/calculator 의 `loop-stdio` bin 참고)과 짝을 이뤄 프로세스를
// 띄워 두고 요청 id 로 응답을 상관한다 — 호출당 비용이 파이프 왕복으로
// 수렴한다. stderr 의 로그 라인은 stdout 프레임 파싱을 오염시키지 않는다
// (별도 스트림). 응답 순서를 전제로 하지 않고 wire 의 id 자체로 상관한다.
// 현재 참조 런타임은 순차 처리하지만, 비동기 핸들러/worker 도입 뒤에도 같은
// transport 계약을 유지하고 write 실패가 다른 동시 호출을 제거하지 않게 한다.

type LoopResponseFrame = {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
  events?: Array<{ name: string; payload: unknown }>;
};

export type NodeLoopTransport = NodeInvokeTransport & {
  /** 대기 중인 Rust → JS 이벤트를 drain 한다 (루프 런타임 `__drainEvents`). */
  drainEvents(): Promise<Array<{ name: string; payload: unknown }>>;
  /** 프로세스를 종료한다. 이후 invoke 는 새 프로세스를 띄운다. */
  dispose(): void;
  /** 현재 프로세스 PID — 미실행 중이면 null. */
  readonly pid: number | null;
};

/**
 * 루프형 stdio 런타임으로 통하는 persistent transport 를 생성한다.
 *
 * Rust 측은 표준 프로토콜(한 줄 JSON 요청 → 한 줄 JSON 응답, `id` 상관)을
 * 구현해야 한다 — `examples/calculator/src/bin/loop-stdio.rs` 가 참조 구현이다.
 *
 * @example
 * ```ts
 * import { createNodeLoopTransport } from '@rustra/node';
 * const transport = createNodeLoopTransport({
 *   command: 'target/release/my-app',
 *   args: [], // 루프 런타임은 보통 서브커맨드 없이 실행된다
 * });
 * const engine = createNodeEngine(transport);
 * ```
 */
export function createNodeLoopTransport(options: {
  command: string;
  args?: string[];
  spawnOptions?: Parameters<typeof spawn>[2];
}): NodeLoopTransport {
  let child: ChildProcessWithoutNullStreams | null = null;
  const pending = new Map<
    number,
    {
      resolve: (frame: LoopResponseFrame) => void;
      reject: (e: RustraCommandError) => void;
    }
  >();
  let nextId = 1;
  let stdoutBuffer = '';

  const ensureProcess = (): ChildProcessWithoutNullStreams => {
    if (child && child.exitCode === null) {
      return child;
    }
    const proc = spawn(options.command, options.args ?? [], options.spawnOptions ?? {});
    child = proc as ChildProcessWithoutNullStreams;
    if (!proc.stdout || !proc.stderr) {
      // stdio 파이프 구성은 spawnOptions 로 바뀔 수 없다(기본 파이프) — 방어적 검사.
      child = null;
      throw new RustraCommandError('transport.error', 'stdio unavailable', true);
    }
    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8');
      // NDJSON — 완결된 라인만 프레임으로 파싱한다(부분 라인은 버퍼 유지).
      let newline: number;
      while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (!line) continue;
        let frame: LoopResponseFrame;
        try {
          frame = JSON.parse(line) as LoopResponseFrame;
        } catch {
          // 로그/기타 출력이 섞인 경우 — 해당 라인은 건너뛴다(프레임이 아니면
          // 대기열 소비 없이 무시해도 id 상관이 어긋나지 않는다).
          continue;
        }
        const waiter = pending.get(frame.id);
        if (!waiter) continue;
        pending.delete(frame.id);
        if (frame.ok) {
          waiter.resolve(frame);
        } else {
          waiter.reject(parseRustraErrorString(frame.error ?? 'invoke failed'));
        }
      }
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      // 진단 로그 — 프레임 스트림이 아니므로 무시한다(필요시 사용자가 직접
      // spawnOptions.stdio 파이핑으로 수집).
      void chunk;
    });
    proc.on('exit', () => {
      // 프로세스 종료 시 대기 중 호출을 모두 거부 — JS 프라미스 hang 방지.
      const err = new RustraCommandError(
        'transport.error',
        'runtime process exited before responding',
        true,
      );
      for (const w of pending.values()) w.reject(err);
      pending.clear();
    });
    return child;
  };

  const writeRequest = (payload: Record<string, unknown>): Promise<LoopResponseFrame> => {
    return new Promise((resolve, reject) => {
      let proc: ChildProcessWithoutNullStreams;
      try {
        proc = ensureProcess();
      } catch (e) {
        reject(new RustraCommandError('transport.error', `spawn failed: ${String(e)}`, true));
        return;
      }
      const id = nextId++;
      pending.set(id, { resolve, reject });
      const line = JSON.stringify({ id, ...payload }) + '\n';
      proc.stdin.write(line, (err) => {
        if (err) {
          pending.delete(id);
          reject(new RustraCommandError('transport.error', `write failed: ${String(err)}`, true));
        }
      });
    });
  };

  return {
    invoke(command: string, args?: unknown) {
      return writeRequest({ command, args: args ?? {} }).then((frame) => frame.result);
    },
    async drainEvents() {
      const frame = await writeRequest({ command: '__drainEvents', args: {} });
      return frame.events ?? [];
    },
    dispose() {
      if (child && child.exitCode === null) {
        child.stdin.end();
        child.kill();
      }
      child = null;
    },
    get pid() {
      return child?.pid ?? null;
    },
  };
}
