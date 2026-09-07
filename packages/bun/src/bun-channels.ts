/**
 * @rustra/bun 채널 브릿지 — `rustra_ffi_channel_create/send/drop` FFI 의 첫
 * JS 소비자다. RN JSI(`createChannel`/`dropChannel` host function)와 동일한
 * Rust 채널 코어(`channels.rs` ChannelHost)를 Bun FFI 로 소비한다.
 *
 * ### 스레드 계약 (이벤트 브릿지와 동일)
 *
 * `JSCallback`은 의도적으로 `threadsafe: false`다 — Bun 1.4의 threadsafe
 * 콜백은 인자 마샬링이 불안정하다(1.4.0 실증, bun-events.ts 모듈 JSDoc).
 * 따라서 콜백은 JS 스레드에서만 와야 하고, 이는 **동기 FFI invoke 체인 안에서
 * `ChannelHandle::send` 하는 핸들러**가 전제다. Rust 백그라운드 스레드(async
 * 핸들러)에서 send 하는 채널은 이 브릿지로 받을 수 없다 — 이벤트와 달리 채널에는
 * 버스 폴링 폴백이 없다(채널은 버스에 적재되지 않고 발급자 클로저를 직접
 * 호출한다, channels_host.rs). 백그라운드 send 가 필요하면 Node 루프 호스트의
 * 푸시 프레임 설계(0.7 후보)를 기다려야 한다.
 *
 * ### quiescence (drop-대기) 계약
 *
 * `rustra_ffi_channel_drop`은 in-flight 콜백이 모두 반환할 때까지 **블록**한다.
 * 콜백 안에서 자기 채널을 drop하면 교착이므로 금지(ffi_channel.rs Safety 문서).
 * JS close도 마찬가지로 콜백 안에서 호출하지 않는다.
 */

import { RustraCommandError, RustraErrorCode } from '@rustra/types';
import { bunLibraryCandidates, type BunLibraryOptions } from './bun-ffi-library.js';

export type BunChannelCallback = (payload: unknown) => void;

export type BunChannel = {
  /** 커맨드 인자로 통과시키는 채널 핸들(wire는 plain u32). */
  readonly handle: number;
  /** 채널을 해제한다 — `rustra_ffi_channel_drop`. 이후 send는 false. */
  close(): boolean;
};

/**
 * Bun 채널 브릿지를 만든다. `createChannel(callback)` 호출마다 FFI 채널을
 * 발급하고 트램폴린 콜백을 핸들→JS 콜백으로 분배한다.
 *
 * @param options.library — cdylib 경로(미지정 시 `bunLibraryCandidates` 해상,
 * `RUSTRA_BUN_LIBRARY` 오버라이드 포함 — 부트스트랩과 동일 우선순위).
 */
export async function createBunChannelBridge(
  options: BunLibraryOptions = {},
): Promise<(callback: BunChannelCallback) => BunChannel> {
  const candidates = bunLibraryCandidates(options);
  const libraryPath = candidates[0];
  if (!libraryPath) {
    throw new RustraCommandError(
      RustraErrorCode.TransportUnavailable,
      'No compatible Rustra Bun cdylib was found for channel creation. Build the inferred Cargo library, or set RUSTRA_BUN_LIBRARY to its absolute path.',
    );
  }

  const { dlopen, FFIType, JSCallback } = (await import('bun:ffi')) as typeof import('bun:ffi');
  // dlopen 을 try 밖 한 식으로 호출한다 — ReturnType<typeof dlopen> 로 타입을
  // 짜면 제네릭이 constraint 로 고정돼 심볼 인자 타입이 never 로 무너진다
  // (bun-events.ts 가 const 추론을 쓰는 것과 같은 이유).
  const openLibrary = (): ReturnType<
    typeof dlopen<{
      rustra_ffi_channel_create: { args: ['ptr', 'ptr']; returns: typeof FFIType.u32 };
      rustra_ffi_channel_drop: { args: ['u32']; returns: typeof FFIType.i32 };
    }>
  > =>
    dlopen(libraryPath, {
      rustra_ffi_channel_create: { args: ['ptr', 'ptr'], returns: FFIType.u32 },
      rustra_ffi_channel_drop: { args: ['u32'], returns: FFIType.i32 },
    });
  let lib;
  try {
    lib = openLibrary();
  } catch (error) {
    // dlopen 원시 에러를 transport 계약으로 정규화(bun-events 폴백과 동일 분류) —
    // 원인은 cause 로 보존한다.
    throw new RustraCommandError(
      RustraErrorCode.TransportUnavailable,
      `Failed to dlopen the Rustra cdylib for channel creation: ${libraryPath}`,
      false,
      error,
    );
  }
  const channelCreate = lib.symbols.rustra_ffi_channel_create;
  const channelDrop = lib.symbols.rustra_ffi_channel_drop;

  // 트램폴린 1개 + 핸들→JS 콜백 테이블. Rust가 콜백 두 번째 인자로 발급 핸들을
  // 되돌려주므로(ffi_channel.rs) 채널마다 JSCallback을 만들 필요가 없다.
  const listeners = new Map<number, BunChannelCallback>();
  const callback = new JSCallback(
    (_userData: unknown, handle: number, payloadJson: string) => {
      const listener = listeners.get(handle);
      if (!listener) return;
      let payload: unknown;
      try {
        payload = payloadJson === '' ? null : JSON.parse(payloadJson);
      } catch {
        payload = payloadJson; // 비 JSON — 조용한 드롭 방지(Tauri/Node 동일 관용).
      }
      try {
        listener(payload);
      } catch (error) {
        // JS 콜백 예외 격리 — C 트램폴린 경계에서 예외가 새는 걸 방지한다.
        console.error('Rustra: channel callback threw:', error);
      }
    },
    // threadsafe:false — JS 스레드(동기 FFI invoke 체인)에서만 호출 전제.
    { args: ['ptr', 'u32', 'cstring'], returns: 'void' },
  );

  return (channelCallback: BunChannelCallback): BunChannel => {
    // FFI 심볼 반환값은 bun:ffi 타입상 unknown — 경계에서 1회 좁힌다.
    const rawHandle = channelCreate(callback.ptr, null) as unknown;
    const handle = Number(rawHandle);
    if (!Number.isSafeInteger(handle) || handle < 1) {
      throw new RustraCommandError(
        RustraErrorCode.ChannelUnavailable,
        'rustra_ffi_channel_create returned an invalid handle; channel space may be exhausted',
      );
    }
    listeners.set(handle, channelCallback);
    return {
      handle,
      close(): boolean {
        if (!listeners.has(handle)) return false; // double-close 무해.
        listeners.delete(handle);
        // drop은 in-flight 콜백 종료까지 블록한다(quiescence 계약) — 콜백 안에서
        // 호출 금지. 리스너를 먼저 지우므로 그 사이 도착 프레임은 무시된다.
        return channelDrop(handle) === 1;
      },
    };
  };
}

// ── 코드젠 계약 정합(컴파일 타임 고정) ──────────────────────
// 채널 콜백 시그니처와 { handle, close() } 반환 구조가 RN 계약과 동형임을
// 타입 레벨에서 고정한다(Tauri tauri-channels.ts와 동일 패턴).

type GeneratedChannelHandle = number;
const _channelHandleFitsGenerated: GeneratedChannelHandle = ({} as BunChannel).handle;
void _channelHandleFitsGenerated;
