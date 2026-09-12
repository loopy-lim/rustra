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
