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
  let binLenBuf = Buffer.allocUnsafe(0);
  let binChunks: Buffer[] = [];
  let binNeed = 0;

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

  const drainBinaryFrames = (): void => {
    for (;;) {
      if (binNeed === 0) {
        if (binLenBuf.length < 4) {
          if (binChunks.length > 0) {
            binLenBuf = Buffer.concat([binLenBuf, ...binChunks]);
            binChunks = [];
          }
          if (binLenBuf.length < 4) return;
        }
        binNeed = binLenBuf.readUInt32LE(0);
        binLenBuf = binLenBuf.subarray(4);
      }
      // 프레임 본문 수집 — 청크를 직접 소비해 불필요한 복사를 줄인다.
      while (binNeed > 0 && binChunks.length > 0) {
        const head = binChunks[0];
        if (head.length <= binNeed) {
          binLenBuf = Buffer.concat([binLenBuf, head]);
          binChunks.shift();
          binNeed -= head.length;
        } else {
          binLenBuf = Buffer.concat([binLenBuf, head.subarray(0, binNeed)]);
          binChunks[0] = head.subarray(binNeed);
          binNeed = 0;
        }
      }
      if (binNeed > 0 || binLenBuf.length < binNeed) {
        if (binNeed > 0) return;
      }
      const frame = binLenBuf;
      binLenBuf = Buffer.allocUnsafe(0);
      binNeed = 0;
      const waiter = binQueue.shift();
      if (waiter) waiter.resolve(new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength));
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
      return JSON.parse(new TextDecoder().decode(frame.subarray(8, 8 + jsonLen))) as unknown;
    }
    const codec = nameToCodec(command);
    if (!codec) {
      throw new RustraCommandError(
        'command.not_found',
        `binary loop transport has no codec for "${command}"`,
      );
    }
    const frame = await binaryWrite(encodeBinaryRequest(codec, args));
    const outcome = codec.decode(
      frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) as ArrayBuffer,
    );
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
        frame.ok
          ? waiter.resolve(frame)
          : waiter.reject(parseRustraErrorString(frame.error ?? 'invoke failed'));
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
  };
}
