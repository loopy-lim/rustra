import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { RustraCommandError, parseRustraErrorString, type RkyvV2Codec } from '@rustra/types';
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
   * 흐른다. 푸시가 없는 런타임(구 바이너리, 미요청)에서는 조용히 아무것도
   * 오지 않는다 — 능력 확인은 drain 응답/핸드셰이크 capability 계약(2-모드
   * dispatch, node-events.ts)이 담당한다.
   *
   * 옵셔널 멤버(drain? 과 동일 사유): 이 인터페이스를 구조적으로 구현하던
   * 외부 구현체의 브레이킹을 피한다. 호출측은 `transport.addPushListener?.(...)`
   * 로 우아하게 폴백한다.
   *
   * payload 는 문자열 JSON — 파싱 책임은 구독자에 있다(폴링 drain 과 동일
   * 셰이프 경계).
   */
  addPushListener?(
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
      const json = new TextDecoder().decode(options.body.subarray(2));
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

/** drainEvents JSON 응답 디코더 — 모듈 상수(호출당 TextDecoder 할당 제거). */
const drainDecoder = new TextDecoder();

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
  // ── 바이너리 모드 상태 ──
  let mode: 'ndjson' | 'binary' = 'ndjson';
  let binQueue: Array<{
    resolve: (frame: Uint8Array) => void;
    reject: (error: RustraCommandError) => void;
  }> = [];
  /** 수신 누적 버퍼 — 미처리 [len][frame] 바이트열. concat 결과와 청크 채택을
   * 모두 담으므로 ArrayBufferLike 로 넓힌다. */
  let binLenBuf: Buffer<ArrayBufferLike> = Buffer.allocUnsafe(0);
  let binChunks: Buffer[] = [];
  /** 0xfffd 푸시 프레임 구독자 — addPushListener 로 등록, 반환 해지 함수로 탈퇴. */
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
      return JSON.parse(drainDecoder.decode(frame.subarray(8, 8 + jsonLen))) as unknown;
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
          continue;
        }
        const waiter = pending.get(frame.id);
        if (!waiter) continue;
        pending.delete(frame.id);
        if (frame.ok) waiter.resolve(frame);
        else waiter.reject(parseRustraErrorString(frame.error ?? 'invoke failed'));
      }
    });
    proc.stderr.on('data', () => {});
    proc.on('exit', () => {
      const error = new RustraCommandError(
        'transport.error',
        'runtime process exited before responding',
        true,
      );
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
      for (const waiter of binQueue) waiter.reject(error);
      binQueue = [];
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
    const frame = await write({ command: '__hello', args: {} });
    const result = frame as LoopResponseFrame & { binary?: boolean };
    if (result.ok && result.binary === true) mode = 'binary';
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
    ready() {
      return handshakeSettled;
    },
    addPushListener(handler) {
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
