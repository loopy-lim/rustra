import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  RustraCommandError,
  debugRustra,
  isRustraDebugEnabled,
  parseRustraErrorString,
  type RustraDebugEvent,
  type RkyvV2Codec,
} from '@rustra/types';
import type { NodeInvokeTransport } from './node-core.js';

type LoopResponseFrame = {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
  events?: Array<{ name: string; payload: unknown }>;
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
};

/**
 * 바이너리 모드 코덱 표면 — generated `rkyvV2Registry` 를 그대로 넘긴다.
 * `encodeInto` 재사용 버퍼로 요청을 조립하고 `decode` 로 응답 프레임을
 * 파싱한다(둘 다 rkyv V2 프레임 계약 — [cmd_id u16][postcard] 요청,
 * [ok u8][pad][len][body] 응답).
 */
export type NodeLoopBinaryCodecs = Map<string, RkyvV2Codec<unknown, unknown>>;

/** 이벤트 drain 예약 커맨드 id — loop-stdio 의 BINARY_DRAIN_EVENTS_CMD 와 짝. */
const BINARY_DRAIN_EVENTS_CMD = 0xfffe;

/** 이벤트 **푸시** 프레임 예약 cmd id — loop-stdio 의 BINARY_PUSH_EVENTS_CMD 와 짝.
 * 응답 프레임의 첫 u16 LE 는 ok|pad(ok는 0/1)라 이 값과 절대 충돌하지 않는다. */
const BINARY_PUSH_EVENTS_CMD = 0xfffd;

/** 푸시 프레임 본문(JSON) 뒤의 `{name, payload, seq}` — payload 는 문자열 JSON. */
export type NodePushEventFrame = { name: string; payload: string; seq: number };

/**
 * stdout 바이너리 프레임 1개를 분기한다 — 0xfffd 면 푸시 리스너 브로드캐스트,
 * 그 외(응답)면 `onResponse` 로 위임. 순수 함수로 추출해 프레임 경로를
 * 스폰 없이 단위 검증할 수 있다(node-loop.test.ts).
 *
 * 응답 프레임은 rkyv V2 셰이프 `[ok u8][pad 3][len u32][body]` — 첫 u16 LE
 * (ok|pad)가 0xfffd(ok는 0/1)가 될 수 없다는 와이어 사실이 판별 근거다.
 * 푸시 본문의 JSON 파싱 실패는 조용히 건너뛴다(폴링 drain 파싱과 동일 정책 —
 * 프로토콜 오염 한 프레임이 transport 전체를 죽이지 않는다).
 */
export function demultiplexBinaryFrame(options: {
  cmd: number;
  body: Uint8Array;
  onPush: (event: NodePushEventFrame) => void;
  onResponse: (frame: Uint8Array) => void;
}): void {
  if (options.cmd === BINARY_PUSH_EVENTS_CMD) {
    try {
      const json = frameDecoder.decode(options.body.subarray(2));
      const parsed = JSON.parse(json) as Partial<NodePushEventFrame>;
      if (typeof parsed.name === 'string' && typeof parsed.seq === 'number') {
        options.onPush({
          name: parsed.name,
          // payload 는 문자열 JSON — 파싱 책임은 구독자(2-모드 dispatch)에 있다.
          payload: typeof parsed.payload === 'string' ? parsed.payload : '',
          seq: parsed.seq,
        });
      }
    } catch {
      // 비정상 푸시 프레임 — 조용히 건너뛴다.
    }
    return;
  }
  options.onResponse(options.body);
}

/** 프레임 본문 JSON 디코더 — 모듈 상수(호출당 TextDecoder 할당 제거). */
const frameDecoder = new TextDecoder();

/** 비 NDJSON 라인 링 버퍼 크기 — exit 시 대기 요청 에러에 첨부할 최근 줄 수. */
export const UNPARSED_LINES_CAPACITY = 32;

/**
 * 라인 1줄의 보존 상한(문자) — 멀티 MB 비 JSON 라인도 버퍼와 exit 메시지에
 * 온전히 살지 않도록 절단한다(stderr 꼬리 상한과 대칭). 보장은
 * `UNPARSED_LINES_CAPACITY` 줄 × 이 상한으로 이중 경계다.
 */
export const UNPARSED_LINE_MAX_CHARS = 4_096;

/** debug 모드에서 보존할 stderr 꼬리 상한(문자) — 무한 stderr 도 메모리 상한 유지. */
const STDERR_TAIL_CHARS = 8_192;

/** transport 인스턴스별 unparsed 라인 진단 상태 — 링 버퍼와 1회 warn 플래그. */
export type UnparsedLineState = { buffer: string[]; warned: boolean };

/**
 * NDJSON 파싱 실패 라인 1점의 처리 — 진단 관측 지점을 순수 함수로 추출해 스폰
 * 없이 단위 검증한다(node-loop.test.ts, demultiplexBinaryFrame 추출과 동일 취지).
 * 상태는 호출측(transport 인스턴스 클로저)이 소유하고 이 함수가 in-place 로
 * 갱신한다 — 라이프사이클은 transport 생성/재스폰을 따른다.
 *
 * - debug 모드(`RUSTRA_DEBUG`)면 `kind: 'ndjson.unparsed'` debug 이벤트를 싱크로
 *   내고 stderr 에 **최초 1회만** warn 한다(로그 스팸 방지 — 워닝 규약은
 *   node-events 의 `parsePushPayload` 와 동일 톤).
 * - 비 debug 모드면 최근 `UNPARSED_LINES_CAPACITY` 줄을 ring 으로 보존한다(각
 *   줄은 `UNPARSED_LINE_MAX_CHARS` 로 절단) — 프로세스가 exit 할 때 대기 중
 *   요청의 에러 메시지에 첨부해, 사용자가 맨몸의 "exited" 오류 대신 자식이
 *   실제로 출력한 것을 보게 한다. 보존량은 줄 수와 줄 길이 이중으로 경계된다.
 */
export function recordUnparsedLine(line: string, state: UnparsedLineState): void {
  if (isRustraDebugEnabled()) {
    // debugRustra 는 이벤트 백을 pass-through(spread) 하므로 계약 밖 필드도 싱크에
    // 도달한다 — kind/line 을 읽기 편한 진단 어휘로 그대로 실어 보낸다.
    debugRustra({ kind: 'ndjson.unparsed', line } as unknown as RustraDebugEvent);
    if (!state.warned) {
      state.warned = true;
      console.warn(
        'Rustra: runtime stdout line was not valid NDJSON; continuing (first occurrence only).',
      );
    }
    return;
  }
  state.buffer.push(line.slice(0, UNPARSED_LINE_MAX_CHARS));
  if (state.buffer.length > UNPARSED_LINES_CAPACITY) {
    state.buffer.splice(0, state.buffer.length - UNPARSED_LINES_CAPACITY);
  }
}

/**
 * exit 시 대기 요청의 에러 메시지 조립 — 원문 계약 메시지를 접두로 유지하고
 * 보존된 unparsed 줄(및 debug 모드의 stderr 꼬리)이 있으면 덧붙인다. 기존
 * "exited before responding" 메시지를 단정하는 테스트·호출측이 있으므로 접두
 * 보존이 계약이다. 첨부가 비면 원문 그대로(기존 동작과 비트 동일).
 */
export function attachExitContext(
  message: string,
  unparsed: readonly string[],
  stderrTail?: string,
): string {
  const parts: string[] = [];
  if (unparsed.length > 0) {
    parts.push(`recent unparsed stdout lines:\n${unparsed.map((line) => `  ${line}`).join('\n')}`);
  }
  if (stderrTail) {
    parts.push(`stderr:\n${stderrTail}`);
  }
  return parts.length === 0 ? message : `${message}\n${parts.join('\n')}`;
}

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
  let binQueue: Array<{
    resolve: (frame: Uint8Array) => void;
    reject: (error: RustraCommandError) => void;
  }> = [];
  /** 수신 누적 버퍼 — 미처리 [len][frame] 바이트열. concat 결과와 청크 채택을
   * 모두 담으므로 ArrayBufferLike 로 넓힌다. */
  let binLenBuf: Buffer<ArrayBufferLike> = Buffer.allocUnsafe(0);
  let binChunks: Buffer[] = [];
  /** 0xfffd 푸시 프레임 구독자 — onPushEvent 로 등록, 반환 해지 함수로 탈퇴. */
  const pushListeners = new Set<(event: NodePushEventFrame) => void>();

  const nameToCodec = (command: string) => binaryCodecs?.get(command);

  /** 요청 프레임 [len u32 LE][rkyv V2 요청] 조립 — encodeInto 재사용 버퍼 우선. */
  const encodeBinaryRequest = (codec: RkyvV2Codec<unknown, unknown>, args: unknown): Buffer => {
    const encoded = codec.encodeInto ? codec.encodeInto(args) : codec.encode(args);
    const bytes =
      encoded instanceof Uint8Array
        ? encoded
        : Uint8Array.from(encoded instanceof ArrayBuffer ? new Uint8Array(encoded) : encoded);
    const prefix = Buffer.allocUnsafe(4);
    prefix.writeUInt32LE(bytes.byteLength, 0);
    return Buffer.concat([prefix, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)]);
  };

  /** 누적 수신 버퍼 — [len][frame][len][frame]… 이 붙어 들어온다. */
  const drainBinaryFrames = (): void => {
    // 남은 청크를 단일 버퍼로 합친다. 통상 케이스(빈 prefix + 단일 청크)는
    // concat 없이 청크를 그대로 채택해 복사를 건너뛴다.
    if (binChunks.length === 1 && binLenBuf.length === 0) {
      binLenBuf = binChunks[0]!;
      binChunks = [];
    } else if (binChunks.length > 0) {
      binLenBuf = Buffer.concat([binLenBuf, ...binChunks]);
      binChunks = [];
    }
    while (binLenBuf.length >= 4) {
      const len = binLenBuf.readUInt32LE(0);
      if (binLenBuf.length < 4 + len) break; // 프레임 불완전 — 다음 청크 대기.
      const frame = binLenBuf.subarray(4, 4 + len);
      binLenBuf = binLenBuf.subarray(4 + len);
      const bytes = new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
      // cmd id 분기 — 0xfffd(푸시)는 binQueue 에서 소비하지 않는다. 구분 없이
      // shift 하던 구조와 달리, 응답을 기다리는 waiter가 없는 푸시 프레임이
      // 와도 유실되지 않고 리스너로 브로드캐스트된다.
      const cmd = frame.length >= 2 ? frame.readUInt16LE(0) : -1;
      demultiplexBinaryFrame({
        cmd,
        body: bytes,
        onPush: (event) => {
          for (const listener of [...pushListeners]) {
            try {
              listener(event);
            } catch (error) {
              // 리스너 예외가 stdout 리더를 죽이지 않는다(폴링 루프와 동일 정책).
              console.error(`Rustra: push listener for "${event.name}" threw:`, error);
            }
          }
        },
        onResponse: (response) => {
          const waiter = binQueue.shift();
          // waiter 없는 응답(프로세스 종료 경합 등)은 드랍 — 기존 계약 유지.
          if (waiter) waiter.resolve(response);
        },
      });
    }
  };

  const binaryWrite = (payload: Buffer): Promise<Uint8Array> =>
    new Promise((resolve, reject) => {
      let proc: ChildProcessWithoutNullStreams;
      try {
        proc = ensureProcess();
      } catch (error) {
        reject(error as RustraCommandError);
        return;
      }
      binQueue.push({ resolve, reject });
      proc.stdin.write(payload, (error) => {
        if (error) {
          const index = binQueue.findIndex((entry) => entry.resolve === resolve);
          if (index >= 0) binQueue.splice(index, 1);
          reject(new RustraCommandError('transport.error', `write failed: ${String(error)}`, true));
        }
      });
    });

  const invokeBinary = async (command: string, args: unknown): Promise<unknown> => {
    if (command === '__drainEvents') {
      const drain = Buffer.allocUnsafe(6);
      drain.writeUInt32LE(2, 0);
      drain.writeUInt16LE(BINARY_DRAIN_EVENTS_CMD, 4);
      const frame = await binaryWrite(drain);
      // 응답 본문: [ok u8][pad 3][len u32 @4][json @8]
      if (frame[0] !== 1) throw new RustraCommandError('invoke.failed', 'event drain failed');
      const jsonLen = frame[4]! | (frame[5]! << 8) | (frame[6]! << 16) | (frame[7]! << 24);
      return JSON.parse(frameDecoder.decode(frame.subarray(8, 8 + jsonLen))) as unknown;
    }
    const codec = nameToCodec(command);
    if (!codec) {
      throw new RustraCommandError(
        'command.not_found',
        `binary loop transport has no codec for "${command}"`,
      );
    }
    const frame = await binaryWrite(encodeBinaryRequest(codec, args));
    // decode 는 동기 완료 계약이므로 뷰를 그대로 넘긴다 — 왕복당 프레임 사본
    // (buffer.slice) 하나를 제거한다(bun caller-buffer 와 동일 계약).
    const outcome = codec.decode(frame);
    if (!outcome.ok) {
      const e = outcome.error ?? { code: 'invoke.failed', message: 'invoke failed' };
      throw parseRustraErrorString(`${e.code}: ${e.message}`);
    }
    return outcome.result;
  };

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
        if (chunk.length > 0) binChunks.push(chunk);
        drainBinaryFrames();
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
      for (const waiter of binQueue) waiter.reject(error);
      binQueue = [];
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
    const result = frame as LoopResponseFrame & { binary?: boolean; events?: string };
    if (result.ok && result.binary === true) mode = 'binary';
    pushCapable = result.ok && result.binary === true && result.events === 'push';
  };

  // Lazy 프로세스는 첫 invoke 에서 spawn 되지만, 바이너리 모드 협상은 그 앞에
  // 1회 수행되어야 한다 — transport 생성 시 즉시 spawn+handshake (persistent
  // 전제이므로 생성 비용은 warm-up 에 흡수된다). handshake 실패 시 transport
  // 생성은 성공으로 두고 첫 invoke 에서 오류를 전파한다(스폰 실패 = 기존
  // transport.error 계약).
  const handshakeSettled: Promise<void> = binaryCodecs
    ? handshake().catch(() => {})
    : Promise.resolve();

  return {
    invoke(command, args) {
      if (mode === 'binary') return invokeBinary(command, args);
      if (binaryCodecs) {
        // 핸드셰이크가 아직 정착하지 않은 첫 호출 — 정착을 기다린 뒤 재분기.
        return handshakeSettled.then(() => {
          if (mode === 'binary') return invokeBinary(command, args);
          return write({ command, args: args ?? {} }).then((frame) => frame.result);
        });
      }
      return write({ command, args: args ?? {} }).then((frame) => frame.result);
    },
    async drainEvents() {
      if (mode === 'binary') {
        return (await invokeBinary('__drainEvents', {})) as Array<{
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
    ready() {
      return handshakeSettled;
    },
    onPushEvent(handler) {
      pushListeners.add(handler);
      return () => {
        pushListeners.delete(handler);
      };
    },
    async drain(timeoutMs = 5_000) {
      // pending(NDJSON id 상관) + binQueue(바이너리 프레임 대기) = in-flight 전체.
      const settle = (): boolean => pending.size === 0 && binQueue.length === 0;
      if (settle()) return;
      const deadline = Date.now() + timeoutMs;
      while (!settle()) {
        if (Date.now() > deadline) {
          console.error(
            `[node] drain timeout after ${timeoutMs}ms with ${
              pending.size + binQueue.length
            } in-flight invocation(s); proceeding anyway`,
          );
          return;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
    },
  };
}
