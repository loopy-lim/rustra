/**
 * loop-stdio 바이너리 와이어 프로토콜 — [len u32 LE] 프레임 경계 누적·분할,
 * 예약 cmd id(0xfffd 푸시 / 0xfffc JSON 채널 / 0xfff9 바이트 채널) 프레임
 * 디멀티플렉싱, rkyv V2 요청 인코딩과 예약 커맨드(0xfffe drain / 0xfffb 발급 /
 * 0xfffa 해제) 요청·응답 조립을 담는다. 프로세스 스폰·대기 큐·리스너 수명 등
 * transport 상태는 node-loop.ts / node-binary-session.ts 가 소유하고, 이 모듈은
 * 프로세스 의존성 없는 순수 함수·클로저만 갖는다(node-loop.test.ts 가 스폰 없이
 * 단위 검증하는 경로 그대로).
 */
import type { RkyvV2Codec } from '@rustra/types';

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

/** 채널 **푸시** 프레임 예약 cmd id — loop-stdio 의 BINARY_CHANNEL_PUSH_CMD 와 짝.
 * 본문은 1줄 JSON `{"handle": u32, "payload": <문자열 JSON>}`(이벤트 푸시와 동일
 * "cmd id 로 시작하는 프레임" 와이어). */
const BINARY_CHANNEL_PUSH_CMD = 0xfffc;

/** 채널 **바이너리 푸시** 프레임 예약 cmd id — loop-stdio bin 의
 * BINARY_CHANNEL_PUSH_BYTES_CMD 와 짝. 본문은 `[handle u32 LE][payload bytes]` —
 * JSON 래핑 없이 바이트 그대로며 페이로드 길이 접두가 없다(프레임 래퍼[len]이
 * 이미 경계를 제공한다). 한 핸들은 생성 시점의 한 경로로만 동작한다(JSON xor
 * bytes — 코어 ChannelHost 계약). */
const BINARY_CHANNEL_PUSH_BYTES_CMD = 0xfff9;

/** 채널 **발급** 예약 cmd id — loop-stdio 의 BINARY_CHANNEL_CREATE_CMD 와 짝.
 * 본문 없는 요청, 응답 본문은 JSON `{"handle": u32}`(Tauri rustra_channel_create
 * 와 동일 페이로드). */
const BINARY_CHANNEL_CREATE_CMD = 0xfffb;

/** 채널 **해제** 예약 cmd id — loop-stdio 의 BINARY_CHANNEL_DROP_CMD 와 짝.
 * 본문은 postcard varint u32 핸들, 응답은 ok 플래그만(핸들이 살아있었으면 1). */
const BINARY_CHANNEL_DROP_CMD = 0xfffa;

/** 푸시 프레임 본문(JSON) 뒤의 `{name, payload, seq}` — payload 는 문자열 JSON. */
export type NodePushEventFrame = { name: string; payload: string; seq: number };

/** 채널 푸시 프레임 본문 — handle 은 발급 핸들, payload 는 문자열 JSON. */
export type NodeChannelFrame = { handle: number; payload: string };

/** 바이너리 채널 푸시 프레임 본문 — handle 은 발급 핸들, payload 는 원시 바이트
 * (rkyv V2 프레임 등 — JSON 파싱 경로를 거치지 않는다). payload 는 수신 누적
 * 버퍼의 뷰다 — 사용자 코드로 내보내는 경계(createNodeBytesChannel)에서
 * 복사한다. */
export type NodeChannelBytesFrame = { handle: number; payload: Uint8Array };

/** 프레임 본문 JSON 디코더 — 모듈 상수(호출당 TextDecoder 할당 제거). */
const frameDecoder = new TextDecoder();

/**
 * stdout 바이너리 프레임 1개를 분기한다 — 0xfffd 면 푸시 리스너 브로드캐스트,
 * 0xfffc 면 채널 리스너 브로드캐스트, 0xfff9 면 바이너리 채널 리스너
 * 브로드캐스트, 그 외(응답)면 `onResponse` 로 위임. 순수 함수로 추출해 프레임
 * 경로를 스폰 없이 단위 검증할 수 있다 (node-loop.test.ts).
 *
 * 응답 프레임은 rkyv V2 셰이프 `[ok u8][pad 3][len u32][body]` — 첫 u16 LE
 * (ok|pad)가 0xfffd/0xfffc/0xfff9(ok는 0/1)가 될 수 없다는 와이어 사실이 판별
 * 근거다. 푸시/채널 본문의 JSON 파싱 실패는 조용히 건너뛴다(폴링 drain 파싱과
 * 동일 정책 — 프로토콜 오염 한 프레임이 transport 전체를 죽이지 않는다).
 * 0xfff9 본문은 JSON 이 아니므로 파싱이 없다 — 최소 길이(핸들 4B) 미만만
 * 조용히 건너뛴다.
 *
 * `onChannelBytes` 는 옵셔널 — 구 형태 호출(분기 없음)과의 호환을 유지한다.
 */
export function demultiplexBinaryFrame(options: {
  cmd: number;
  body: Uint8Array;
  onPush: (event: NodePushEventFrame) => void;
  onChannel: (frame: NodeChannelFrame) => void;
  onChannelBytes?: (frame: NodeChannelBytesFrame) => void;
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
  if (options.cmd === BINARY_CHANNEL_PUSH_CMD) {
    try {
      const json = frameDecoder.decode(options.body.subarray(2));
      const parsed = JSON.parse(json) as Partial<NodeChannelFrame>;
      if (typeof parsed.handle === 'number' && Number.isSafeInteger(parsed.handle)) {
        options.onChannel({
          handle: parsed.handle,
          // payload 는 문자열 JSON — 파싱 책임은 채널 콜백 소유자에게 있다.
          payload: typeof parsed.payload === 'string' ? parsed.payload : '',
        });
      }
    } catch {
      // 비정상 채널 프레임 — 조용히 건너뛴다(푸시와 동일 정책).
    }
    return;
  }
  if (options.cmd === BINARY_CHANNEL_PUSH_BYTES_CMD) {
    // 본문 [handle u32 LE][payload bytes] — 최소 6바이트(cmd 2 + 핸들 4) 못
    // 미치면 조용히 건너뛴다(JSON 파싱이 없어 실패 모드가 이것뿐이다).
    if (options.body.length >= 6 && options.onChannelBytes) {
      const handle =
        (options.body[2]! |
          (options.body[3]! << 8) |
          (options.body[4]! << 16) |
          (options.body[5]! << 24)) >>>
        0;
      options.onChannelBytes({ handle, payload: options.body.subarray(6) });
    }
    return;
  }
  options.onResponse(options.body);
}

/**
 * 수신 누적 버퍼 팩토리 — stdout 로 `[len][frame][len][frame]…` 이 붙어 들어오는
 * 청크를 온전한 프레임으로 나눠 `onFrame(cmd, body)` 로 내보낸다. 불완전한
 * 꼬리는 다음 청크까지 버퍼링하고, 상태(누적 버퍼·청크 큐)는 반환 클로저가
 * 소유한다 — 라이프사이클은 호출측 transport 인스턴스를 따른다.
 */
export function createBinaryFrameAccumulator(
  onFrame: (cmd: number, body: Uint8Array) => void,
): (chunk: Buffer) => void {
  /** 수신 누적 버퍼 — 미처리 [len][frame] 바이트열. concat 결과와 청크 채택을
   * 모두 담으므로 ArrayBufferLike 로 넓힌다. */
  let binLenBuf: Buffer<ArrayBufferLike> = Buffer.allocUnsafe(0);
  let binChunks: Buffer[] = [];
  const drain = (): void => {
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
      onFrame(frame.length >= 2 ? frame.readUInt16LE(0) : -1, bytes);
    }
  };
  return (chunk: Buffer): void => {
    if (chunk.length > 0) binChunks.push(chunk);
    drain();
  };
}

/** 요청 프레임 [len u32 LE][rkyv V2 요청] 조립 — encodeInto 재사용 버퍼 우선. */
export function encodeBinaryRequest(codec: RkyvV2Codec<unknown, unknown>, args: unknown): Buffer {
  const encoded = codec.encodeInto ? codec.encodeInto(args) : codec.encode(args);
  const bytes =
    encoded instanceof Uint8Array
      ? encoded
      : Uint8Array.from(encoded instanceof ArrayBuffer ? new Uint8Array(encoded) : encoded);
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32LE(bytes.byteLength, 0);
  return Buffer.concat([prefix, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)]);
}

/** 이벤트 drain 예약 요청 프레임 — 본문 없는 [len=2][0xfffe]. */
export function encodeDrainEventsRequest(): Buffer {
  const drain = Buffer.allocUnsafe(6);
  drain.writeUInt32LE(2, 0);
  drain.writeUInt16LE(BINARY_DRAIN_EVENTS_CMD, 4);
  return drain;
}

/**
 * 채널 발급 예약 요청 프레임 — 0xfffb. 바이너리 경로는 본문에 모드 플래그
 * 0x01 을 붙인다(JSON 경로는 본문 없음 — 기존 와이어와 바이트 동일). 응답
 * 본문은 두 경로 모두 {"handle": u32} JSON (셰이프 공유).
 */
export function encodeChannelCreateRequest(wantsBytes: boolean): Buffer {
  const request = Buffer.allocUnsafe(wantsBytes ? 7 : 6);
  request.writeUInt32LE(request.length - 4, 0);
  request.writeUInt16LE(BINARY_CHANNEL_CREATE_CMD, 4);
  if (wantsBytes) request[6] = 1; // CHANNEL_CREATE_MODE_BYTES
  return request;
}

/** 채널 해제 예약 요청 프레임 — 본문은 postcard varint u32 핸들(LEB128, 채널은
 * 1 이상). 응답은 ok 플래그만(핸들이 살아있었으면 1). */
export function encodeChannelDropRequest(handle: number): Buffer {
  let value = handle;
  const varint: number[] = [];
  do {
    let byte = value % 128;
    value = Math.floor(value / 128);
    if (value > 0) byte |= 0x80;
    varint.push(byte);
  } while (value > 0);
  const request = Buffer.allocUnsafe(6 + varint.length);
  request.writeUInt32LE(2 + varint.length, 0);
  request.writeUInt16LE(BINARY_CHANNEL_DROP_CMD, 4);
  Buffer.from(varint).copy(request, 6);
  return request;
}

/** 응답 프레임 `[ok u8][pad 3][len u32][body]` 의 ok 플래그 — 1 이면 성공. */
export function readBinaryResponseOk(frame: Uint8Array): boolean {
  return frame[0] === 1;
}

/** 응답 프레임 본문 JSON 파싱 — `[len u32 @4][json @8]` 경계를 따른다. 파싱
 * 실패(SyntaxError)는 호출측 invoke 계약으로 그대로 전파된다(기존 동작). */
export function parseBinaryResponseJson(frame: Uint8Array): unknown {
  const jsonLen = frame[4]! | (frame[5]! << 8) | (frame[6]! << 16) | (frame[7]! << 24);
  return JSON.parse(frameDecoder.decode(frame.subarray(8, 8 + jsonLen)));
}
