import {
  createJsonEngine,
  parseRustraErrorString,
  RustraCommandError,
  type EngineClientWithBatch,
  type EngineSupports,
} from '@rustra/types';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

/**
 * Node JSON 엔진의 기술적 지표(A02) — compatibility-matrix.md 의 Node 열 셀을
 * 그대로 옮긴 것: in-flight 취소는 얕은 취소, 배치는 per-entry 폴백, 이벤트는
 * 0xfffd 푸시(폴링 폴백), 채널 소스 없음, timeoutMs 레이스 있음.
 */
export const NODE_ENGINE_SUPPORTS: EngineSupports = {
  cancellation: 'shallow',
  batch: 'per-entry',
  events: 'push',
  channels: false,
  timeoutPreemption: true,
};

export type NodeInvokeTransport = {
  invoke(command: string, args?: unknown): Promise<unknown> | unknown;
};

export function createNodeEngine(transport: NodeInvokeTransport) {
  return createJsonEngine((command, args) => transport.invoke(command, args), undefined, {
    ...NODE_ENGINE_SUPPORTS,
  });
}

export type NodeProcessTransportOptions = {
  command: string;
  args?: string[];
  spawnOptions?: Parameters<typeof spawn>[2];
};

export type NodeProcessTransport = NodeInvokeTransport & {
  getContractHash(): Promise<string>;
  dispose(): void;
  readonly pid: number | null;
};

type ResponseFrame = { ok: true; result: unknown } | { ok: false; error?: string };

/** One-shot stdio JSON transport for a Rust generator/invoke binary. */
export function createNodeProcessTransport(
  options: NodeProcessTransportOptions,
): NodeProcessTransport {
  const argv = options.args ?? ['invoke'];
  let child: ChildProcessWithoutNullStreams | null = null;
  const invokeOnce = (command: string, args?: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
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
        if (!text) {
          const detail = Buffer.concat(stderr).toString('utf8').trim();
          reject(
            new RustraCommandError(
              'transport.error',
              detail || `runtime exited with code ${code}`,
              true,
            ),
          );
          return;
        }
        try {
          const frame = JSON.parse(text) as ResponseFrame;
          if (frame.ok) resolve(frame.result);
          else reject(parseRustraErrorString(frame.error ?? 'invoke failed'));
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
      proc.stdin.write(JSON.stringify({ command, args: args ?? {} }));
      proc.stdin.end();
    });

  return {
    invoke: invokeOnce,
    async getContractHash() {
      const value = await invokeOnce('__rustra_contract');
      if (typeof value !== 'string' || !value)
        throw new RustraCommandError(
          'contract.unenforceable',
          'Node runtime contract endpoint returned an invalid hash',
        );
      return value;
    },
    dispose() {
      if (child && child.exitCode === null) child.kill();
      child = null;
    },
    get pid() {
      return child?.pid ?? null;
    },
  };
}

export type NodeBootstrapOptions = {
  command?: string;
  commandCandidates?: readonly string[];
  binaryName?: string;
  args?: string[];
  spawnOptions?: Parameters<typeof spawn>[2];
  contractHash?: string;
  /**
   * (A05) reload 직전 drain 연결 — 루프 호스트가 자기 transport 의
   * `drain(timeoutMs)` 을 reload 에 연결하는 훅. 기본 5초(`NodeLoopTransport`
   * drain 계약과 동일)로 호출되고, 타임아웃 후에도 reload 는 진행한다.
   * 훅이 없으면 기존 동작(원샷 transport — dispose 시 얕은 취소) 그대로.
   */
  onReloadDrain?: (timeoutMs: number) => void | Promise<void>;
};
export type NodeBootstrap = {
  /**
   * bootstrap 수명 상태(A05) — 'initializing' | 'ready' | 'disposed'.
   * dispose 는 멱등이고 dispose 후 ready 는 loud-fail 한다.
   */
  readonly state: 'initializing' | 'ready' | 'disposed';
  ready(): Promise<EngineClientWithBatch>;
  dispose(): void;
  /**
   * Dev-loop reload hook target (Task A1): disposes the current child,
   * re-spawns and re-readies over the same runtime resolution. The one-shot
   * process transport has no drain — in-flight invocations reject on
   * re-dispose (shallow cancel). Loop-based hosts that need graceful settle
   * use `NodeLoopTransport.drain` explicitly before reload. A rebuilt binary
   * is picked up because the image is read at spawn time.
   */
  reload(): Promise<void>;
};
