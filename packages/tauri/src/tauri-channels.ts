import { RustraCommandError, RustraErrorCode } from '@rustra/types';
import type { TauriInvoke } from './index.js';

type TauriGlobal = {
  __TAURI__?: {
    core?: { invoke?: TauriInvoke };
    event?: { listen?: TauriListenType };
  };
};

type TauriListenType = (
  event: string,
  handler: (event: { payload: string }) => void,
) => Promise<() => void>;

function tauriGlobal(): TauriGlobal {
  return globalThis as TauriGlobal;
}

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
  listen?: (event: string, handler: (event: { payload: string }) => void) => Promise<() => void>;
};

function requireTauriInvoke(): TauriInvoke {
  const invoke = tauriGlobal().__TAURI__?.core?.invoke;
  if (typeof invoke !== 'function') {
    throw new RustraCommandError(
      RustraErrorCode.TransportUnavailable,
      'Tauri IPC was not found. Enable app.withGlobalTauri, or pass { invoke } to createChannel().',
    );
  }
  return invoke.bind(tauriGlobal().__TAURI__!.core);
}

function requireTauriListen(): TauriListenType {
  const listen = tauriGlobal().__TAURI__?.event?.listen;
  if (typeof listen !== 'function') {
    throw new RustraCommandError(
      RustraErrorCode.TransportUnavailable,
      'Tauri event.listen was not found. Enable app.withGlobalTauri, or pass a listen function.',
    );
  }
  return listen.bind(tauriGlobal().__TAURI__!.event);
}

/**
 * 채널 이벤트 채널명 — Rust `CHANNEL_EVENT_PREFIX` 와 동일 규칙
 * (`rustra://channel/{handle}`). 핸들은 숫자라 sanitize 불필요.
 */
export function rustraChannelEventChannel(handle: number): string {
  return `rustra://channel/${handle}`;
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
  const raw = (await invoke('rustra_channel_create')) as { handle?: unknown };
  // IPC 경계의 unknown — 발급 검증에서 1회 좁힌다.
  const handle = Number(raw?.handle);
  if (!Number.isSafeInteger(handle) || handle < 1) {
    throw new RustraCommandError(
      RustraErrorCode.ChannelUnavailable,
      'rustra_channel_create returned an invalid handle; expected a positive safe integer',
    );
  }

  let unlisten: () => void;
  let closed = false;
  try {
    const listen = io.listen ?? requireTauriListen();
    unlisten = await listen(rustraChannelEventChannel(handle), (event) => {
      if (closed) return;
      // Rust sender 가 JSON 문자열을 그대로 emit 한다 — 파싱 1회 복원.
      // 파싱 실패 시 원본 문자열 전달(조용한 드롭 방지 — subscribeEvent 동일).
      try {
        callback(JSON.parse(event.payload));
      } catch {
        callback(event.payload);
      }
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

// ── 코드젠 계약 정합(컴파일 타임 고정) ──────────────────────
// 코드젠 채널 표면은 `ChannelHandle = number` 마커(wire plain u32)다.
// createChannel 결과의 handle 이 그 자리를 채우는지 타입 레벨 고정.

type GeneratedChannelHandle = number;
const _channelHandleFitsGenerated: GeneratedChannelHandle = ({} as RustraTauriChannel).handle;
void _channelHandleFitsGenerated;
