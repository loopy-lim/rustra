import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  RustraCommandError,
  isRustraDebugEnabled,
  parseRustraErrorString,
  RustraErrorCode,
} from '@rustra/types';
import type { NodeInvokeTransport } from './node-core.js';
import type { NodeChannelBytesFrame, NodeLoopBinaryCodecs } from './node-binary-framing.js';
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

type LoopResponseFrame = {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
  events?: Array<{ name: string; payload: unknown }>;
};

type HandshakeFrame = LoopResponseFrame & {
  binary?: boolean;
  events?: string;
  channelBytes?: boolean;
};
export type NodeLoopTransport = NodeInvokeTransport & {
  drainEvents(): Promise<Array<{ name: string; payload: unknown }>>;
  dispose(): void;
  readonly pid: number | null;
  /** 'ndjson' = 레거시 라인 프로토콜, 'binary' = length-prefixed rkyv V2 (트랙 D). */
  readonly mode: 'ndjson' | 'binary';
  /**
   * 런타임이 `events:"push"` 핸드셰이크 capability 를 수용했는지 — ready() 정착
   * 후 읽는다. true 면 0xfffd 푸시 프레임이 stdout 으로 흐르고 onPushEvent
   * 구독이 실제 이벤트를 받는다. false 면(구 런타임, 미수용, codecs 미제공으로
   * 핸드셰이크 미실행) 푸시가 절대 오지 않으므로 구독자는 폴링을 써야 한다.
   * node-events 의 2-모드 dispatch가 이 플래그를 능력 판별 근거로 읽는다 —
   * 존재만으로는 판별할 수 없다(메서드는 능력과 무관하게 항상 노출됨).
   */
  readonly pushCapable: boolean;
  /** 프로토콜 협상(바이너리 모드 핸드셰이크) 정착을 기다린다. */
  ready(): Promise<void>;
  /**
   * 진행 중 invocation 이 모두 정착할 때까지 기다린다(최대 5초 — 초과 시 로그 후
   * 그래도 해소). reload 직전 drain 계약(A1)의 transport 측 구현.
   *
   * 옵셔널 멤버: 필수로 정의하면 이 인터페이스를 구조적으로 구현하던 외부
   * 구현체가 drain 부재로 깨진다(breaking). 호출측은 `transport.drain?.(...)` 로
   * 우아하게 폴백한다.
   */
  drain?(timeoutMs?: number): Promise<void>;
  /**
   * 0xfffd 푸시 프레임을 구독한다 — `(event) => unsubscribe`. 런타임
   * (loop-stdio)이 `events:"push"` 핸드셰이크로 싱크를 설치한 경우에만 프레임이
   * 흐른다. 메서드 존재는 능력이 아니라 0xfffd 프레임 수신 "경로"의 노출일 뿐 —
   * 실제 능력은 `pushCapable` 로 판별한다(node-events 2-모드 dispatch 계약).
   *
   * 옵셔널 멤버(drain? 과 동일 사유): 이 인터페이스를 구조적으로 구현하던
   * 외부 구현체의 브레이킹을 피한다. 호출측은 `transport.onPushEvent?.(...)`
   * 로 우아하게 폴백한다.
   *
   * payload 는 문자열 JSON — 파싱 책임은 구독자에 있다(폴링 drain 과 동일
   * 셰이프 경계).
   */
  onPushEvent?(
    handler: (event: { name: string; payload: string; seq: number }) => void,
  ): () => void;
  /**
   * 0xfffc 채널 프레임을 구독한다 — `(frame) => unsubscribe`. `createChannel`
   * 이 발급 핸들과 콜백을 잇는 데 쓴다(0.7 채널 트랙). 메서드 존재는 채널
   * "경로"의 노출이고 실제 능력은 바이너리 모드 협상에 있다 — NDJSON 모드의
   * transport 도 메서드는 갖지만 채널 프레임은 절대 오지 않는다.
   *
   * 필수 멤버 — 이 인터페이스의 실현체(createNodeLoopTransport)가 항상
   * 노출하며, 채널 프레임 demux 분기는 응답/푸시와 같은 리더 안에 있다.
   * payload 는 문자열 JSON — 파싱 책임은 채널 콜백 소유자에게 있다.
   */
  onChannelFrame(handler: (frame: { handle: number; payload: string }) => void): () => void;
  /**
   * 0xfff9 **바이너리** 채널 프레임을 구독한다 — `createNodeBytesChannel` 이
   * 발급 핸들과 콜백을 잇는 데 쓴다. JSON 채널(0xfffc)과 같은 리더 안의 demux
   * 분기를 공유하지만 payload 는 원시 바이트(Uint8Array)다.
   *
   * 옵셔널 멤버(drain?/onPushEvent? 와 동일 사유): 이 인터페이스를 구조적으로
   * 구현하던 외부 구현체의 브레이킹을 피한다. 호출측은
   * `transport.onChannelBytesFrame?.(...)` 로 우아하게 폴백한다.
   */
  onChannelBytesFrame?(handler: (frame: NodeChannelBytesFrame) => void): () => void;
  /**
   * 런타임이 `__hello` 에 `channelBytes: true` capability 를 에코했는지 —
   * ready() 정착 후 읽는다. 바이너리 채널(0xfffb 모드 `0x01` 발급 → 0xfff9
   * 프레임)은 런타임 bin 의 지원이 필요하다. false 면(구 런타임 — 모드 바이트를
   * 무시하고 JSON 채널을 파는 위상) `createNodeBytesChannel` 이
   * `channel.unavailable` 로 loud-fail 한다 — 조용한 경로 불일치 방지.
   *
   * 옵셔널 멤버(onChannelBytesFrame? 과 동일 사유). 구 런타임/구 실현체는
   * 이 필드가 undefined 이고, 호출측은 `!== true` 를 능력 부재로 읽는다.
   */
  readonly channelBytesCapable?: boolean;
};

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
  const pending = new Map<
    number,
    { resolve: (frame: LoopResponseFrame) => void; reject: (error: RustraCommandError) => void }
  >();
  let nextId = 1;
  let stdoutBuffer = '';
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
    if (child && child.exitCode === null) return child;
    // 프로세스 라이프마다 진단 상태를 새로 시작한다 — 죽어가는 프로세스의 늦은
    // stdout/stderr 데이터가 exit 핸들러의 소비·clear 이후 도착해 재스폰된
    // 프로세스의 exit 에 오속(stale) 첨부되는 것을, 반대 방향(dispose→재스폰이
    // 새 라인을 지우는 것)과 함께 스폰 경계에서 양쪽 다 차단한다. exit 핸들러의
    // clear 는 정상 도착한 보존분을 처리하고, 이 스폰 경계 clear 는 'exit' 이
    // stdio 닫힘보다 먼저 온다(Node 문서)는 지연 데이터 창까지 막는 이중 잠금이다.
    unparsed.buffer.length = 0;
    stderrTail = undefined;
    const proc = spawn(options.command, options.args ?? [], options.spawnOptions ?? {});
    child = proc as ChildProcessWithoutNullStreams;
    if (!proc.stdout || !proc.stderr) {
      child = null;
      throw new RustraCommandError('transport.error', 'stdio unavailable', true);
    }
    proc.stdout.on('data', (chunk: Buffer) => {
      if (mode === 'binary') {
        session.onChunk(chunk);
        return;
      }
      stdoutBuffer += chunk.toString('utf8');
      let newline: number;
      while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (!line) continue;
        let frame: LoopResponseFrame;
        try {
          frame = JSON.parse(line) as LoopResponseFrame;
        } catch {
          // 비 NDJSON 라인 — 정상 응답 흐름은 그대로 유지하고 진단만 남긴다
          // (debug: 싱크 이벤트+1회 warn / 비 debug: 링 버퍼 보존).
          recordUnparsedLine(line, unparsed);
          continue;
        }
        const waiter = pending.get(frame.id);
        if (!waiter) continue;
        pending.delete(frame.id);
        if (frame.ok) waiter.resolve(frame);
        else waiter.reject(parseRustraErrorString(frame.error ?? 'invoke failed'));
      }
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      // debug 모드에서만 수집한다 — 비 debug 는 드레인만(기존 계약, 성능 무영향).
      // 상한(STDERR_TAIL_CHARS) 이후는 앞쪽부터 탈락시켜 최근 꼬리만 유지한다.
      if (!isRustraDebugEnabled()) return;
      stderrTail = ((stderrTail ?? '') + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS);
    });
    proc.on('exit', () => {
      const error = new RustraCommandError(
        'transport.error',
        attachExitContext('runtime process exited before responding', unparsed.buffer, stderrTail),
        true,
      );
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
      session.rejectAll(error);
      // 보존분은 이번 exit 의 에러 메시지로 소비됐다 — 다음 라이프(재스폰)의
      // exit 에 전 라이프 맥락을 오속 첨부하지 않도록 지운다.
      unparsed.buffer.length = 0;
      stderrTail = undefined;
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
      pending.set(id, { resolve, reject });
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
  const handshakeSettled: Promise<void> = binaryCodecs
    ? handshake().catch(() => {})
    : Promise.resolve();

  const isChannelCommand = (name: string): boolean =>
    name === '__createChannel' || name === '__createChannelBytes' || name === '__dropChannel';

  return {
    invoke(command, args) {
      if (mode === 'binary') return session.invoke(command, args);
      // 채널은 바이너리 모드 전용 — 콜백 함수 값은 NDJSON 라인으로 전송 불가.
      // 조용한 command.not_found 대신 명확한 계약 에러로 loud-fail 한다.
      if (isChannelCommand(command)) {
        return Promise.reject(
          new RustraCommandError(
            RustraErrorCode.ChannelUnavailable,
            'channels require binary mode: create the transport with codecs (createNodeLoopTransport({ command, codecs })) so the __hello handshake negotiates binary framing',
          ),
        );
      }
      if (binaryCodecs) {
        // 핸드셰이크가 아직 정착하지 않은 첫 호출 — 정착을 기다린 뒤 재분기.
        return handshakeSettled.then(() => {
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
          return write({ command, args: args ?? {} }).then((frame) => frame.result);
        });
      }
      return write({ command, args: args ?? {} }).then((frame) => frame.result);
    },
    async drainEvents() {
      if (mode === 'binary') {
        return (await session.invoke('__drainEvents', {})) as Array<{
          name: string;
          payload: unknown;
        }>;
      }
      return (await write({ command: '__drainEvents', args: {} })).events ?? [];
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
      return handshakeSettled;
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
