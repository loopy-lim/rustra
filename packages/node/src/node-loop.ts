import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  RustraCommandError,
  isRustraDebugEnabled,
  parseRustraErrorString,
  RustraErrorCode,
} from '@rustra/types';
import type { HandshakeFrame, LoopResponseFrame, NodeLoopTransport } from './node-loop-contract.js';
export type { NodeLoopTransport } from './node-loop-contract.js';
import type { NodeLoopBinaryCodecs } from './node-binary-framing.js';
import { createBinaryLoopSession } from './node-binary-session.js';
import {
  STDERR_TAIL_CHARS,
  attachExitContext,
  recordUnparsedLine,
  type UnparsedLineState,
} from './node-ndjson-diagnostics.js';

// 분리 모듈 표면 재수출 — 기존 공개 API(index.ts 의 export *)와 테스트
// (node-loop.test.ts) 가 './node-loop.js' 경로에서 import 하던 계약을 그대로
// 유지한다. 바이너리 프레이밍은 node-binary-framing.ts, NDJSON 진단은
// node-ndjson-diagnostics.ts 로 이사했다.
export {
  demultiplexBinaryFrame,
  type NodeChannelBytesFrame,
  type NodeChannelFrame,
  type NodeLoopBinaryCodecs,
  type NodePushEventFrame,
} from './node-binary-framing.js';
export {
  UNPARSED_LINES_CAPACITY,
  UNPARSED_LINE_MAX_CHARS,
  attachExitContext,
  recordUnparsedLine,
  type UnparsedLineState,
} from './node-ndjson-diagnostics.js';

/** Persistent transport for Rust loop-stdio runtimes. */
export function createNodeLoopTransport(options: {
  command: string;
  args?: string[];
  spawnOptions?: Parameters<typeof spawn>[2];
  /** 제공 시 __hello 핸드셰이크로 바이너리 모드 전환. 미제공 시 레거시 NDJSON. */
  codecs?: NodeLoopBinaryCodecs;
}): NodeLoopTransport {
  const binaryCodecs = options.codecs;
  let child: ChildProcessWithoutNullStreams | null = null;
  let disposed = false;
  const pending = new Map<
    number,
    {
      resolve: (frame: LoopResponseFrame) => void;
      reject: (error: RustraCommandError) => void;
      handshake: boolean;
    }
  >();
  let nextId = 1;
  let stdoutBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let handshakeSettled: Promise<void> | undefined;
  // ── NDJSON 실패 라인·stderr 진단 상태 (transport 인스턴스 라이프사이클) ──
  const unparsed: UnparsedLineState = { buffer: [], warned: false };
  /** debug 모드에서만 수집 — 비 debug 는 기존대로 폐기(성능 무영향). */
  let stderrTail: string | undefined;
  // ── 바이너리 모드 상태 ──
  let mode: 'ndjson' | 'binary' = 'ndjson';
  /** 런타임이 events:"push" 핸드셰이크를 수용했는지 — handshake 정착 후 확정.
   * true 면 0xfffd 푸시 프레임이 stdout 으로 흐른다. */
  let pushCapable = false;
  /** 런타임이 channelBytes capability 를 에코했는지 — handshake 정착 후 확정.
   * true 면 0xfffb 모드 바이트 발급(→ 0xfff9 프레임) 경로가 있다. */
  let channelBytesCapable = false;
  /** 바이너리 모드 세션 — 응답 대기 큐(binQueue)·프레임 디멀티플렉싱 배선·
   * 0xfffd/0xfffc/0xfff9 리스너 구독 표면을 소유한다(node-binary-session).
   * stdin 확보(스폰)는 ensureProcess 로 콜백한다 — 프로세스 라이프사이클은
   * 이 transport 가 계속 소유한다. */
  const session = createBinaryLoopSession({
    codecs: binaryCodecs,
    acquireStdin: () => ensureProcess(),
  });

  const ensureProcess = (): ChildProcessWithoutNullStreams => {
    if (disposed)
      throw new RustraCommandError('transport.unavailable', 'Node loop transport was disposed');
    if (child) {
      if (child.exitCode === null && child.signalCode === null) return child;
      throw new RustraCommandError(
        'transport.error',
        'runtime process is closing; retry after its output streams close',
        true,
      );
    }
    // 프로세스 라이프마다 진단 상태를 새로 시작한다 — 죽어가는 프로세스의 늦은
    // stdout/stderr 데이터가 exit 핸들러의 소비·clear 이후 도착해 재스폰된
    // 프로세스의 exit 에 오속(stale) 첨부되는 것을, 반대 방향(dispose→재스폰이
    // 새 라인을 지우는 것)과 함께 스폰 경계에서 양쪽 다 차단한다. exit 핸들러의
    // clear 는 정상 도착한 보존분을 처리하고, 이 스폰 경계 clear 는 'exit' 이
    // stdio 닫힘보다 먼저 온다(Node 문서)는 지연 데이터 창까지 막는 이중 잠금이다.
    unparsed.buffer.length = 0;
    stderrTail = undefined;
    stdoutBuffer = Buffer.alloc(0);
    mode = 'ndjson';
    pushCapable = false;
    channelBytesCapable = false;
    handshakeSettled = undefined;
    session.resetReader();
    const proc = spawn(options.command, options.args ?? [], options.spawnOptions ?? {});
    child = proc as ChildProcessWithoutNullStreams;
    if (!proc.stdout || !proc.stderr || !proc.stdin) {
      child = null;
      proc.on('error', () => {});
      proc.kill();
      throw new RustraCommandError('transport.error', 'stdio unavailable', true);
    }
    proc.stdout.on('data', (chunk: Buffer) => {
      if (child !== proc) return;
      if (mode === 'binary') {
        session.onChunk(chunk);
        return;
      }
      stdoutBuffer = stdoutBuffer.length ? Buffer.concat([stdoutBuffer, chunk]) : chunk;
      let newline: number;
      while ((newline = stdoutBuffer.indexOf(10)) >= 0) {
        const line = stdoutBuffer.subarray(0, newline).toString('utf8').trim();
        stdoutBuffer = stdoutBuffer.subarray(newline + 1);
        if (!line) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line) as unknown;
        } catch {
          // 비 NDJSON 라인 — 정상 응답 흐름은 그대로 유지하고 진단만 남긴다
          // (debug: 싱크 이벤트+1회 warn / 비 debug: 링 버퍼 보존).
          recordUnparsedLine(line, unparsed);
          continue;
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          fail(
            new RustraCommandError(
              'invoke.malformed',
              'Runtime returned a non-object JSON response',
            ),
          );
          proc.kill();
          return;
        }
        const frame = parsed as LoopResponseFrame;
        if (typeof frame.id !== 'number') {
          recordUnparsedLine(line, unparsed);
          continue;
        }
        const waiter = pending.get(frame.id);
        if (!waiter) continue;
        pending.delete(frame.id);
        if (typeof frame.ok !== 'boolean') {
          waiter.reject(
            new RustraCommandError(
              'invoke.malformed',
              'Runtime response is missing a boolean ok field',
            ),
          );
          continue;
        }
        if (waiter.handshake && frame.ok) {
          const hello = frame as HandshakeFrame;
          mode = hello.binary === true ? 'binary' : 'ndjson';
          pushCapable = mode === 'binary' && hello.events === 'push';
          channelBytesCapable = mode === 'binary' && hello.channelBytes === true;
        }
        if (frame.ok) waiter.resolve(frame);
        else if (frame.error == null || typeof frame.error === 'string')
          waiter.reject(parseRustraErrorString(frame.error ?? 'invoke failed'));
        else
          waiter.reject(
            new RustraCommandError('invoke.malformed', 'Runtime error field must be a string'),
          );
        if (mode === 'binary') {
          if (stdoutBuffer.length) session.onChunk(stdoutBuffer);
          stdoutBuffer = Buffer.alloc(0);
          break;
        }
      }
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      if (child !== proc) return;
      // debug 모드에서만 수집한다 — 비 debug 는 드레인만(기존 계약, 성능 무영향).
      // 상한(STDERR_TAIL_CHARS) 이후는 앞쪽부터 탈락시켜 최근 꼬리만 유지한다.
      if (!isRustraDebugEnabled()) return;
      stderrTail = ((stderrTail ?? '') + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS);
    });
    const fail = (error: RustraCommandError) => {
      if (child !== proc) return;
      child = null;
      handshakeSettled = undefined;
      mode = 'ndjson';
      pushCapable = false;
      channelBytesCapable = false;
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
      session.rejectAll(error);
      stdoutBuffer = Buffer.alloc(0);
      unparsed.buffer.length = 0;
      stderrTail = undefined;
    };
    proc.on('error', (error) => {
      fail(new RustraCommandError('transport.error', `spawn failed: ${String(error)}`, true));
    });
    proc.stdin.on('error', (error) => {
      fail(new RustraCommandError('transport.error', `write failed: ${String(error)}`, true));
      proc.kill();
    });
    proc.on('close', () => {
      const error = new RustraCommandError(
        'transport.error',
        attachExitContext('runtime process exited before responding', unparsed.buffer, stderrTail),
        true,
      );
      fail(error);
    });
    return child;
  };

  const write = (payload: Record<string, unknown>): Promise<LoopResponseFrame> =>
    new Promise((resolve, reject) => {
      let proc: ChildProcessWithoutNullStreams;
      try {
        proc = ensureProcess();
      } catch (error) {
        reject(error);
        return;
      }
      const id = nextId++;
      pending.set(id, { resolve, reject, handshake: payload.command === '__hello' });
      proc.stdin.write(`${JSON.stringify({ id, ...payload })}\n`, (error) => {
        if (error) {
          pending.delete(id);
          reject(new RustraCommandError('transport.error', `write failed: ${String(error)}`, true));
        }
      });
    });

  const handshake = async (): Promise<void> => {
    // codecs 가 주어지면 첫 줄로 __hello 를 보내 capability 를 협상한다.
    // 응답에 binary:true 가 없으면(구 런타임) NDJSON 을 유지한다.
    // events:"push" 를 함께 요청하고 — 런타임이 수용하면(events:"push" 에코)
    // 0xfffd 푸시 프레임이 stdout 으로 흐른다. 미수용(구 런타임, 필드 무시)이면
    // 푸시 프레임이 절대 오지 않으므로 기존 폴링이 그대로 동작한다.
    const frame = await write({ command: '__hello', args: {}, events: 'push' });
    const result = frame as HandshakeFrame;
    if (result.ok && result.binary === true) mode = 'binary';
    pushCapable = result.ok && result.binary === true && result.events === 'push';
    // 바이너리 채널 capability — 구 런타임은 이 필드가 없다(undefined → false).
    // 필드가 없는데 모드 바이트를 보내면 구 런타임이 JSON 채널을 파버리므로,
    // createNodeBytesChannel 은 이 플래그로 프레임 전송 자체를 차단한다.
    channelBytesCapable = result.ok && result.binary === true && result.channelBytes === true;
  };

  // Lazy 프로세스는 첫 invoke 에서 spawn 되지만, 바이너리 모드 협상은 그 앞에
  // 1회 수행되어야 한다 — transport 생성 시 즉시 spawn+handshake (persistent
  // 전제이므로 생성 비용은 warm-up 에 흡수된다). handshake 실패 시 transport
  // 생성은 성공으로 두고 첫 invoke 에서 오류를 전파한다(스폰 실패 = 기존
  // transport.error 계약).
  const prepare = (): Promise<void> => {
    if (disposed)
      return Promise.reject(
        new RustraCommandError('transport.unavailable', 'Node loop transport was disposed'),
      );
    if (!binaryCodecs) return Promise.resolve();
    try {
      ensureProcess();
    } catch (error) {
      return Promise.reject(error);
    }
    if (!handshakeSettled) {
      handshakeSettled = handshake();
      // Negotiation begins eagerly; ready/invoke still receive its rejection.
      void handshakeSettled.catch(() => {});
    }
    return handshakeSettled;
  };
  if (binaryCodecs) void prepare().catch(() => {});

  const isChannelCommand = (name: string): boolean =>
    name === '__createChannel' || name === '__createChannelBytes' || name === '__dropChannel';

  return {
    invoke(command, args) {
      if (disposed) return prepare();
      // 채널은 바이너리 모드 전용 — 콜백 함수 값은 NDJSON 라인으로 전송 불가.
      // 조용한 command.not_found 대신 명확한 계약 에러로 loud-fail 한다.
      if (!binaryCodecs && isChannelCommand(command)) {
        return Promise.reject(
          new RustraCommandError(
            RustraErrorCode.ChannelUnavailable,
            'channels require binary mode: create the transport with codecs (createNodeLoopTransport({ command, codecs })) so the __hello handshake negotiates binary framing',
          ),
        );
      }
      if (binaryCodecs) {
        // 핸드셰이크가 아직 정착하지 않은 첫 호출 — 정착을 기다린 뒤 재분기.
        return prepare().then(() => {
          if (mode === 'binary') return session.invoke(command, args);
          if (isChannelCommand(command)) {
            // 정착 후에도 NDJSON 구 런타임 — 위와 동일 loud-fail(능력 부재).
            return Promise.reject(
              new RustraCommandError(
                RustraErrorCode.ChannelUnavailable,
                'runtime stayed on legacy NDJSON (no binary capability) — channels are unavailable on this runtime',
              ),
            );
          }
          return write({ command, args: args === undefined ? {} : args }).then(
            (frame) => frame.result,
          );
        });
      }
      return write({ command, args: args === undefined ? {} : args }).then((frame) => frame.result);
    },
    async drainEvents() {
      await prepare();
      if (mode === 'binary') {
        return (await session.invoke('__drainEvents', {})) as Array<{
          name: string;
          payload: unknown;
        }>;
      }
      return (await write({ command: '__drainEvents', args: {} })).events ?? [];
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const error = new RustraCommandError(
        'transport.unavailable',
        'Node loop transport was disposed',
      );
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
      session.rejectAll(error);
      if (child && child.exitCode === null) {
        child.stdin.end();
        child.kill();
      }
      child = null;
    },
    get pid() {
      return child?.pid ?? null;
    },
    get mode() {
      return mode;
    },
    get pushCapable() {
      return pushCapable;
    },
    get channelBytesCapable() {
      return channelBytesCapable;
    },
    ready() {
      return prepare();
    },
    onPushEvent(handler) {
      return session.onPushEvent(handler);
    },
    onChannelFrame(handler) {
      return session.onChannelFrame(handler);
    },
    onChannelBytesFrame(handler) {
      return session.onChannelBytesFrame(handler);
    },
    async drain(timeoutMs = 5_000) {
      // pending(NDJSON id 상관) + session.inFlight(바이너리 프레임 대기) =
      // in-flight 전체.
      const settle = (): boolean => pending.size === 0 && session.inFlight === 0;
      if (settle()) return;
      const deadline = Date.now() + timeoutMs;
      while (!settle()) {
        if (Date.now() > deadline) {
          console.error(
            `[node] drain timeout after ${timeoutMs}ms with ${
              pending.size + session.inFlight
            } in-flight invocation(s); proceeding anyway`,
          );
          return;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
    },
  };
}
