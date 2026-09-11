/**
 * loop-stdio 바이너리 모드 세션 — transport 인스턴스가 협상한 바이너리 모드의
 * 런타임 상태를 소유한다: 응답 대기 큐(binQueue), 0xfffd/0xfffc/0xfff9 프레임
 * 리스너 구독 표면, stdout 청크 → 프레임 경계 누적(node-binary-framing) →
 * 디멀티플렉스 배선, 그리고 예약 커맨드 포함 invoke 왕복. 프로세스 스폰은
 * `acquireStdin` 콜백으로 transport(node-loop.ts 의 ensureProcess) 에 되돌린다
 * — 프로세스 라이프사이클과 NDJSON 경로는 transport 가 계속 소유한다.
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { RustraCommandError, parseRustraErrorString, RustraErrorCode } from '@rustra/types';
import {
  createBinaryFrameAccumulator,
  demultiplexBinaryFrame,
  encodeBinaryRequest,
  encodeChannelCreateRequest,
  encodeChannelDropRequest,
  encodeDrainEventsRequest,
  parseBinaryResponseJson,
  readBinaryResponseOk,
  type NodeChannelBytesFrame,
  type NodeChannelFrame,
  type NodeLoopBinaryCodecs,
  type NodePushEventFrame,
} from './node-binary-framing.js';

/** 바이너리 모드 세션 표면 — node-loop transport 가 위임하는 호출부. */
export type BinaryLoopSession = {
  /** 바이너리 invoke 왕복 — 예약 커맨드(__drainEvents/__createChannel…) 와
   * 코덱 등록 커맨드 모두 이 경로로 간다. */
  invoke(command: string, args: unknown): Promise<unknown>;
  /** stdout 바이너리 청크 공급 — 프레임 경계 누적 후 디멀티플렉스한다. */
  onChunk(chunk: Buffer): void;
  /** 프로세스 exit 시 대기 중 binQueue 전체를 같은 에러로 해소(기존 계약). */
  rejectAll(error: RustraCommandError): void;
  /** 진행 중 바이너리 invocation 수 — drain(timeout) 정착 판정 근거. */
  readonly inFlight: number;
  /** 0xfffd 푸시 프레임 구독자 — onPushEvent 로 등록, 반환 함수로 탈퇴. */
  onPushEvent(handler: (event: NodePushEventFrame) => void): () => void;
  /** 0xfffc 채널 프레임 구독자 — onChannelFrame 로 등록(핸들↔콜백 배선). */
  onChannelFrame(handler: (frame: NodeChannelFrame) => void): () => void;
  /** 0xfff9 바이너리 채널 프레임 구독자 — onChannelBytesFrame 로 등록. */
  onChannelBytesFrame(handler: (frame: NodeChannelBytesFrame) => void): () => void;
};

/** 바이너리 모드 세션 생성 — 상태는 반환 객체 클로저가 소유한다. */
export function createBinaryLoopSession(options: {
  /** 커맨드명 → Frame 코덱 표면(createNodeLoopTransport 의 codecs). */
  codecs?: NodeLoopBinaryCodecs;
  /** stdin 소유 프로세스 확보 — transport 의 ensureProcess(스폰 실패 시 throw). */
  acquireStdin(): ChildProcessWithoutNullStreams;
}): BinaryLoopSession {
  let binQueue: Array<{
    resolve: (frame: Uint8Array) => void;
    reject: (error: RustraCommandError) => void;
  }> = [];
  /** 0xfffd 푸시 프레임 구독자 — onPushEvent 로 등록, 반환 해지 함수로 탈퇴. */
  const pushListeners = new Set<(event: NodePushEventFrame) => void>();
  /** 0xfffc 채널 프레임 구독자 — onChannelFrame 로 등록(발급 핸들↔콜백 배선). */
  const channelListeners = new Set<(frame: NodeChannelFrame) => void>();
  /** 0xfff9 바이너리 채널 프레임 구독자 — onChannelBytesFrame 로 등록. */
  const bytesChannelListeners = new Set<(frame: NodeChannelBytesFrame) => void>();

  /** stdout 바이너리 청크 → 프레임 경계 누적 → cmd id 디스패치. cmd id 분기 —
   * 0xfffd(푸시)는 binQueue 에서 소비하지 않는다. 구분 없이 shift 하던 구조와
   * 달리, 응답을 기다리는 waiter가 없는 푸시 프레임이 와도 유실되지 않고
   * 리스너로 브로드캐스트된다. */
  const onChunk = createBinaryFrameAccumulator((cmd, body) => {
    demultiplexBinaryFrame({
      cmd,
      body,
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
      onChannel: (frame) => {
        for (const listener of [...channelListeners]) {
          try {
            listener(frame);
          } catch (error) {
            // 채널 콜백 예외도 stdout 리더를 죽이지 않는다(폴링과 동일 정책).
            console.error(`Rustra: channel listener for handle ${frame.handle} threw:`, error);
          }
        }
      },
      onChannelBytes: (frame) => {
        for (const listener of [...bytesChannelListeners]) {
          try {
            listener(frame);
          } catch (error) {
            // 바이너리 채널 콜백 예외도 동일 격리(푸시/JSON 채널과 동일 정책).
            console.error(
              `Rustra: bytes channel listener for handle ${frame.handle} threw:`,
              error,
            );
          }
        }
      },
      onResponse: (response) => {
        const waiter = binQueue.shift();
        // waiter 없는 응답(프로세스 종료 경합 등)은 드랍 — 기존 계약 유지.
        if (waiter) waiter.resolve(response);
      },
    });
  });

  const binaryWrite = (payload: Buffer): Promise<Uint8Array> =>
    new Promise((resolve, reject) => {
      let proc: ChildProcessWithoutNullStreams;
      try {
        proc = options.acquireStdin();
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
      const frame = await binaryWrite(encodeDrainEventsRequest());
      // 응답 본문: [ok u8][pad 3][len u32 @4][json @8]
      if (!readBinaryResponseOk(frame)) {
        throw new RustraCommandError('invoke.failed', 'event drain failed');
      }
      return parseBinaryResponseJson(frame);
    }
    if (command === '__createChannel' || command === '__createChannelBytes') {
      const wantsBytes = command === '__createChannelBytes';
      const frame = await binaryWrite(encodeChannelCreateRequest(wantsBytes));
      if (!readBinaryResponseOk(frame)) {
        throw new RustraCommandError(
          RustraErrorCode.ChannelUnavailable,
          wantsBytes
            ? 'binary channel creation failed; the runtime rejected the mode byte or the handle space is exhausted'
            : 'channel creation failed; handle space may be exhausted',
        );
      }
      const parsed = parseBinaryResponseJson(frame) as { handle?: unknown };
      if (!Number.isSafeInteger(parsed.handle) || (parsed.handle as number) < 1) {
        throw new RustraCommandError(
          RustraErrorCode.ChannelUnavailable,
          `loop-stdio returned an invalid ${command} handle; expected a positive safe integer`,
        );
      }
      return { handle: parsed.handle };
    }
    if (command === '__dropChannel') {
      // 채널 해제 — 본문은 postcard varint u32 핸들(LEB128, 채널은 1 이상).
      const handle = (args as { handle?: unknown })?.handle;
      if (!Number.isSafeInteger(handle) || (handle as number) < 1) {
        throw new RustraCommandError(
          RustraErrorCode.ChannelUnavailable,
          '__dropChannel requires a positive integer handle',
        );
      }
      // 응답은 ok 플래그만 — 핸들이 살아있었으면 1, 이미 만료면 0.
      return readBinaryResponseOk(await binaryWrite(encodeChannelDropRequest(handle as number)));
    }
    const codec = options.codecs?.get(command);
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

  return {
    invoke: invokeBinary,
    onChunk,
    rejectAll(error) {
      for (const waiter of binQueue) waiter.reject(error);
      binQueue = [];
    },
    get inFlight() {
      return binQueue.length;
    },
    onPushEvent(handler) {
      pushListeners.add(handler);
      return () => {
        pushListeners.delete(handler);
      };
    },
    onChannelFrame(handler) {
      channelListeners.add(handler);
      return () => {
        channelListeners.delete(handler);
      };
    },
    onChannelBytesFrame(handler) {
      bytesChannelListeners.add(handler);
      return () => {
        bytesChannelListeners.delete(handler);
      };
    },
  };
}
