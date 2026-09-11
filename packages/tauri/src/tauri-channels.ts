import {
  debugRustra,
  RustraCommandError,
  RustraErrorCode,
  type RustraDebugEvent,
  type RustraErrorCodeValue,
} from '@rustra/types';
import type { TauriInvoke, TauriListen } from './index.js';
import { requireTauriInvoke, requireTauriListen } from './tauri-globals.js';

/**
 * rustra 채널 — Rust `ChannelHandle::send` 가 웹뷰로 푸시하는 역방향
 * 스트림. RN 어댑터(`packages/react-native`)와 동형 계약:
 * `{ handle, close() }`.
 */
export type RustraTauriChannel = {
  /** 커맨드 인자로 통과시키는 채널 핸들(wire 는 plain u32). */
  readonly handle: number;
  /** 채널을 해제한다 — `rustra_channel_drop` invoke + listen 해제. 이후
   * 프레임은 무시된다. double-close 는 idempotent. */
  close(): Promise<boolean>;
};

export type TauriChannelIo = {
  /** Tauri IPC invoke — 미전달 시 `globalThis.__TAURI__.core.invoke` 사용. */
  invoke?: TauriInvoke;
  /** Tauri event listen — 미전달 시 `globalThis.__TAURI__.event.listen` 사용. */
  listen?: TauriListen;
};

/**
 * 채널 이벤트 채널명 — Rust `CHANNEL_EVENT_PREFIX` 와 동일 규칙
 * (`rustra://channel/{handle}`). 핸들은 숫자라 sanitize 불필요.
 */
export function rustraChannelEventChannel(handle: number): string {
  return `rustra://channel/${handle}`;
}

/**
 * 바이트 채널 이벤트 채널명 — Rust `CHANNEL_BYTES_EVENT_PREFIX` 와 동일 규칙
 * (`rustra://channel-bytes/{handle}`). JSON 경로(`rustra://channel/`)와 이벤트가
 * 분리되어 있어 한 핸들이 두 경로를 동시에 배선하지 않는다.
 */
export function rustraChannelBytesEventChannel(handle: number): string {
  return `rustra://channel-bytes/${handle}`;
}

/** 문자열 페이로드의 1회 파싱 — 실패 시 원본 문자열을 그대로 반환한다
 * (조용한 드롭 방지, subscribeEvent R03 규칙과 동일). */
function parseJsonOrRaw(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function issueTauriChannel(
  invoke: TauriInvoke,
  createCommand: string,
  invalidHandleMessage: string,
): Promise<number> {
  // IPC 경계의 unknown — 발급 검증에서 1회 좁힌다.
  const raw = (await invoke(createCommand)) as { handle?: unknown };
  const handle = Number(raw?.handle);
  if (!Number.isSafeInteger(handle) || handle < 1) {
    throw new RustraCommandError(RustraErrorCode.ChannelUnavailable, invalidHandleMessage);
  }
  return handle;
}

async function wireTauriChannel(
  invoke: TauriInvoke,
  handle: number,
  channelName: string,
  listen: TauriListen | undefined,
  listenCode: RustraErrorCodeValue,
  onFrame: (payload: unknown) => void,
): Promise<RustraTauriChannel> {
  let unlisten: () => void;
  let closed = false;
  try {
    const resolvedListen = listen ?? requireTauriListen(listenCode);
    unlisten = await resolvedListen(channelName, (event) => {
      if (closed) return;
      onFrame(event.payload);
    });
  } catch (listenError) {
    // 정리 drop 은 절대 원래 listen 에러를 가리지 않는다 — 실패해도 무시.
    await Promise.resolve(invoke('rustra_channel_drop', { handle })).catch(() => {});
    throw listenError;
  }

  return {
    handle,
    async close(): Promise<boolean> {
      if (closed) return true;
      closed = true;
      unlisten();
      const result = (await invoke('rustra_channel_drop', { handle })) as unknown;
      return result === true;
    },
  };
}

/**
 * Tauri 어댑터의 채널을 발급한다 — Rust `ChannelHost` 에 AppHandle 캡처
 * sender(`rustra://channel/{handle}` emit)를 등록하고, 같은 채널을 listen 해
 * 콜백으로 변환한다. RN `createChannel` 과 동형 계약.
 *
 * # 근사 유니캐스트
 *
 * 채널 계약은 호출 귀속 유니캐스트지만 Tauri emit 은 브로드캐스트다 — 같은
 * 프로세스의 다른 웹뷰가 같은 채널명을 listen 하면 프레임을 관측할 수 있다.
 * 정상 흐름(단일 발급자 = 단일 listen)에서는 유니캐스트와 동일하다.
 *
 * @example
 * ```ts
 * const channel = await createChannel((payload) => console.log(payload));
 * await channelDemo(engine, { channel: channel.handle, ticks: 3 });
 * await channel.close();
 * ```
 */
export async function createChannel(
  callback: (payload: unknown) => void,
  io: TauriChannelIo = {},
): Promise<RustraTauriChannel> {
  const invoke = io.invoke ?? requireTauriInvoke();
  // 발급이 먼저다 — listen 부재는 배선 에러고 invoke 실패는 발급 에러다.
  // 발급 성공 후 listen 이 실패하면 발급된 핸들을 drop 으로 정리한다
  // (리스너 없는 채널은 프레임을 받을 수 없으므로 누수다).
  const handle = await issueTauriChannel(
    invoke,
    'rustra_channel_create',
    'rustra_channel_create returned an invalid handle; expected a positive safe integer',
  );
  return wireTauriChannel(
    invoke,
    handle,
    rustraChannelEventChannel(handle),
    io.listen,
    RustraErrorCode.TransportUnavailable,
    (payload) => {
      // Rust sender 가 JSON 문자열을 그대로 emit 한다 — 실제 WebView 경계는
      // 이미 파싱된 값으로 도착하고(R03, index.ts TauriListen 참고) 목/레거시
      // transport 는 문자열을 준다. 문자열일 때만 1회 파싱하고 실패 시 원본을
      // 전달한다(조용한 드롭 방지).
      const resolved = typeof payload === 'string' ? parseJsonOrRaw(payload) : payload;
      callback(resolved);
    },
  );
}

// ── 바이너리 채널 (Rust create_bytes_channel_for 와 짝) ──────────────

/**
 * rustra 바이너리 채널 — `createChannelBytes` 의 발급 결과. 필드 계약은
 * [`RustraTauriChannel`] 과 동일(handle + 멱등 close). JSON 경로와 다른 점은
 * 프레임 페이로드가 JSON 값이 아니라 `Uint8Array` 라는 것뿐이다(콜백
 * 시그니처에만 나타난다 — 핸들은 코드젠 `ChannelHandle = number` 에 그대로
 * 들어간다).
 */
export type RustraTauriBytesChannel = RustraTauriChannel;

/**
 * 바이트 채널 페이로드 복원 — Rust sender 가 `Vec<u8>` 를 Tauri `emit` 의
 * serde 로 내보내므로 웹뷰는 JSON 숫자 배열(`[104,101,…]`)을 받는다. 미래의
 * raw-bytes 전송 계층(Uint8Array/ArrayBuffer 직접 전달)도 그대로 수용한다.
 * 계약 밖 형태(문자열 등)는 `null` — 호출자가 관측 후 건너뛴다.
 */
function toUint8Array(payload: unknown): Uint8Array | null {
  if (payload instanceof Uint8Array) return payload;
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
  if (Array.isArray(payload)) return Uint8Array.from(payload as number[]);
  return null;
}

/** 계약 밖 바이트 페이로드의 관측 지점 — R01(tauri-events) 과 동일 방침으로
 * 예외를 삼키지 않고 재던지지도 않는다: debug 싱크로 관측하고 이 프레임만
 * 건너뛴다. 정상 배선에서는 도달 불가(Rust sender 는 항상 숫자 배열). */
function observeBytesPayloadError(handle: number, payload: unknown): void {
  try {
    debugRustra({
      kind: 'tauri.bytes_payload_error',
      command: rustraChannelBytesEventChannel(handle),
      error: `unexpected bytes channel payload (expected a number array, got ${typeof payload})`,
    } as unknown as RustraDebugEvent);
  } catch {
    // 진단 자체의 실패는 전달 경로로 탈출하지 않는다.
  }
}

/**
 * Tauri 어댑터의 바이너리 채널을 발급한다 — Rust `ChannelHost` 에 AppHandle
 * 캡처 sender(`rustra://channel-bytes/{handle}` emit)를 등록하고 같은 채널을
 * listen 해 콜백으로 변환한다. RN `createBytesChannel` 과 동형 계약: 콜백은
 * `Uint8Array` 를 받는다.
 *
 * JSON 경로(`createChannel`)와 동일한 핸들 번호 공간이지만 한 핸들은 한
 * 경로로만 동작한다(Rust 측 별도 테이블). close/drop 은 공용
 * `rustra_channel_drop` 을 쓴다 — Rust `ChannelHost::drop_channel` 이 양쪽
 * 테이블을 해제한다.
 *
 * # 와이어 인코딩 (비용 고지)
 *
 * Rust sender 가 `Vec<u8>` 를 Tauri `emit` 의 serde 로 내보내므로 웹뷰는 JSON
 * 숫자 배열을 받는다 — 최대 ~4배 와이어 부풀림 + 배열 리터럴 평가 비용(RN 의
 * ArrayBuffer 무손실 전달보다 비싸다, Rust `create_bytes_channel_for` doc
 * 참고). 어댑터는 여기서 배열을 `Uint8Array` 로 1회 복원한다.
 *
 * # 가드
 *
 * Tauri global(invoke/listen)이 없으면 `channel.unavailable` 로 loud-fail 한다
 * — RN 참조 계약(`createBytesChannel`)과 동일 코드다. JSON 경로가 쓰는
 * `transport.unavailable` 과 다르므로 주의. 발급된 핸들이 무효(0 등)여도
 * `channel.unavailable` 이다. `rustra_channel_create_bytes` 커맨드 미등록(구
 * Rust)은 invoke rejection 이 그대로 전파된다.
 *
 * @example
 * ```ts
 * const channel = await createChannelBytes((frame) => decodeFrame(frame));
 * await channelBytesDemo(engine, { channel: channel.handle });
 * await channel.close();
 * ```
 */
export async function createChannelBytes(
  callback: (payload: Uint8Array) => void,
  io: TauriChannelIo = {},
): Promise<RustraTauriBytesChannel> {
  const invoke =
    io.invoke ?? requireTauriInvoke(RustraErrorCode.ChannelUnavailable, 'createChannelBytes()');
  // 발급이 먼저다 — createChannel 과 동일 배선 순서/정리 계약.
  const handle = await issueTauriChannel(
    invoke,
    'rustra_channel_create_bytes',
    'rustra_channel_create_bytes returned an invalid handle; expected a positive safe integer',
  );
  return wireTauriChannel(
    invoke,
    handle,
    rustraChannelBytesEventChannel(handle),
    io.listen,
    RustraErrorCode.ChannelUnavailable,
    (payload) => {
      const bytes = toUint8Array(payload);
      if (bytes === null) {
        observeBytesPayloadError(handle, payload);
        return;
      }
      callback(bytes);
    },
  );
}

// ── 코드젠 계약 정합(컴파일 타임 고정) ──────────────────────
// 코드젠 채널 표면은 `ChannelHandle = number` 마커(wire plain u32)다.
// createChannel 결과의 handle 이 그 자리를 채우는지 타입 레벨 고정.

type GeneratedChannelHandle = number;
const _channelHandleFitsGenerated: GeneratedChannelHandle = ({} as RustraTauriChannel).handle;
void _channelHandleFitsGenerated;
