import { RustraCommandError, RustraErrorCode, type RustraErrorCodeValue } from '@rustra/types';
import type { TauriInvoke, TauriListen } from './index.js';
import type { TauriIpcChannel } from './tauri-channels.js';

// payload 는 `unknown` 이다 — index.ts 의 TauriListen 이 문서화한 것과 동일
// 이유(R03): 실제 WebView 경계는 이미 해석된 값을 주고(채널 프레임의 JSON
// 경로는 객체, 바이너리 경로는 숫자 배열), 목/레거시 transport 는 문자열을
// 준다. 좁히지 않고 각 경로의 핸들러에서 값의 형태로 정규화한다.
type TauriGlobal = {
  __TAURI_INTERNALS__?: { unregisterCallback?: (id: number) => void };
  __TAURI__?: {
    core?: {
      invoke?: TauriInvoke;
      Channel?: new (onMessage: (payload: unknown) => void) => {
        id: number;
        onmessage: (payload: unknown) => void;
      };
    };
    event?: { listen?: TauriListen };
  };
};

function tauriGlobal(): TauriGlobal {
  return globalThis as TauriGlobal;
}

// JSON 경로(createChannel)는 전송 부재를 transport.unavailable 로 알린다.
// 바이너리 경로(createChannelBytes)는 RN 참조 계약(createBytesChannel)에
// 맞춰 channel.unavailable 로 알린다 — 가드 구조는 동일하고 코드만 다르므로
// 헬퍼가 코드를 받는다.
export function requireTauriInvoke(
  code: RustraErrorCodeValue = RustraErrorCode.TransportUnavailable,
  api = 'createChannel()',
): TauriInvoke {
  const invoke = tauriGlobal().__TAURI__?.core?.invoke;
  if (typeof invoke !== 'function') {
    throw new RustraCommandError(
      code,
      `Tauri IPC was not found. Enable app.withGlobalTauri, or pass { invoke } to ${api}.`,
    );
  }
  return invoke.bind(tauriGlobal().__TAURI__!.core);
}

export function requireTauriListen(
  code: RustraErrorCodeValue = RustraErrorCode.TransportUnavailable,
): TauriListen {
  const listen = tauriGlobal().__TAURI__?.event?.listen;
  if (typeof listen !== 'function') {
    throw new RustraCommandError(
      code,
      'Tauri event.listen was not found. Enable app.withGlobalTauri, or pass a listen function.',
    );
  }
  return listen.bind(tauriGlobal().__TAURI__!.event);
}

/** Tauri Channel has no public close method. Match its own callback cleanup,
 * including failed creation (where no Rust Channel exists to send an end frame).
 * Kept at this one platform boundary and checked before allocating a callback.
 */
export function requireTauriIpcChannel(
  onMessage: (payload: unknown) => void,
  code: RustraErrorCodeValue,
): TauriIpcChannel {
  const Channel = tauriGlobal().__TAURI__?.core?.Channel;
  const internals = tauriGlobal().__TAURI_INTERNALS__;
  const unregister = internals?.unregisterCallback;
  if (typeof Channel !== 'function' || typeof unregister !== 'function') {
    throw new RustraCommandError(
      code,
      'Tauri core.Channel and callback cleanup are required. Enable app.withGlobalTauri, or pass createIpcChannel.',
    );
  }
  // 감사(2026-09-13) 항목 2 — @tauri-apps/api 2.4 까지는 Channel 생성자가 콜백
  // 인자를 선언하지 않는다(compiled `constructor()`, Channel.length === 0). 그래서
  // new Channel(onMessage) 의 콜백이 조용히 버려지고 채널 메시지가 끝까지
  // 도달하지 않는다. 2.5 부터 compiled `constructor(onmessage)` (기본값 없음 →
  // length 1, latest 2.11.1 까지 동일)라 arity 가 정확히 변별한다. 이 저장소에는
  // api 가 설치되지 않아(onmessage 후행 할당 듀얼 패스의 양버전 신뢰성 검증 불가)
  // 콜백을 넘기는 호출에서는 조용한 실패 대신 loud-fail 한다. 콜백 없이 구식
  // 스타일로 Channel 을 다루는 경로는 기존 동작을 그대로 유지한다.
  if (typeof onMessage === 'function' && Channel.length === 0) {
    throw new RustraCommandError(
      code,
      'The installed @tauri-apps/api is too old for callback-style channels: its Channel constructor ignores the onMessage callback (requires @tauri-apps/api 2.5+), so channel messages would silently never arrive. Upgrade @tauri-apps/api and rebuild the app: bun add @tauri-apps/api@^2.5.0 (or npm install @tauri-apps/api@^2.5.0).',
    );
  }
  const channel = new Channel(onMessage);
  let disposed = false;
  return {
    value: channel,
    dispose() {
      if (disposed) return;
      disposed = true;
      channel.onmessage = () => {};
      unregister.call(internals, channel.id);
    },
  };
}
