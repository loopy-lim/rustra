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
export { RustraCommandError, configure, invoke, createRkyvV2Engine } from '@rustra/types';
import { RustraCommandError, parseRustraErrorString, type InvokeOptions } from '@rustra/types';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

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
      // (의미론 마감) signal 을 조용히 무시하지 않는다 — 이 엔진은 취소를
      // 전파할 수 없는 JSON transport 위에서 동작하므로, 요청 시점에 명시적으로
      // 거부한다. 호환성 매트릭스(docs/compatibility-matrix.md) 참고.
      if (options?.signal) {
        if (options.signal.aborted) {
          throw new RustraCommandError(
            'cancelled',
            `invoke("${command}") aborted before dispatch`,
            true,
          );
        }
        throw new RustraCommandError(
          'cancel.unsupported',
          `invoke("${command}"): this JSON transport does not support AbortSignal — ` +
            `use createRkyvV2Engine with a native module that exposes invokeAsync/invokeCancel`,
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
  // 직전 응답 후 남은 stdout 버퍼 — invokeRespawn 이 한 번에 다 읹는다.
  let pending = '';
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
      pending = '';
      return invokeOnce(command, args);
    },
    dispose() {
      if (child && child.exitCode === null) {
        child.kill();
      }
      child = null;
      pending = '';
    },
    get pid() {
      return child?.pid ?? null;
    },
  };
}
