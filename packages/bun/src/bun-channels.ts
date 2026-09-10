/**
 * @rustra/bun 채널 브릿지 — `rustra_ffi_channel_create/send/drop` FFI 의 첫
 * JS 소비자다. RN JSI(`createChannel`/`dropChannel` host function)와 동일한
 * Rust 채널 코어(`channels.rs` ChannelHost)를 Bun FFI 로 소비한다.
 *
 * 바이너리 경로(`createBunChannelBytesBridge`)는 `rustra_ffi_channel_create_bytes`
 * 로 발급하는 RN `createBytesChannel` 의 쌍둥이다 — 콜백이 rkyv V2 프레임 등
 * 임의 바이트(Uint8Array)를 받고, 한 핸들은 JSON/바이너리 정확히 한 경로로만
 * 동작한다(ffi_channel.rs — 어긋난 경로 send 는 조용히 0).
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
import type { Pointer } from 'bun:ffi';
import { bunLibraryCandidates, type BunLibraryOptions } from './bun-ffi-library.js';

export type BunChannelCallback = (payload: unknown) => void;
export type BunChannelBytesCallback = (payload: Uint8Array) => void;

export type BunChannel = {
  /** 커맨드 인자로 통과시키는 채널 핸들(wire는 plain u32). */
  readonly handle: number;
  /** 채널을 해제한다 — `rustra_ffi_channel_drop`. 이후 send는 false. */
  close(): boolean;
};

function resolveChannelLibrary(options: BunLibraryOptions, notFoundMessage: string): string {
  const libraryPath = bunLibraryCandidates(options)[0];
  if (!libraryPath) {
    throw new RustraCommandError(RustraErrorCode.TransportUnavailable, notFoundMessage);
  }
  return libraryPath;
}

function openChannelLibrary<T>(open: () => T, toError: (error: unknown) => RustraCommandError): T {
  try {
    return open();
  } catch (error) {
    throw toError(error);
  }
}

function deliverChannelFrame<L>(
  listeners: Map<number, L>,
  handle: number,
  deliver: (listener: L) => void,
): void {
  const listener = listeners.get(handle);
  if (!listener) return;
  try {
    deliver(listener);
  } catch (error) {
    // JS 콜백 예외 격리 — C 트램폴린 경계에서 예외가 새는 걸 방지한다.
    console.error('Rustra: channel callback threw:', error);
  }
}

function issueBunChannel<L>(
  listeners: Map<number, L>,
  callback: L,
  create: () => unknown,
  drop: (handle: number) => number,
  invalidHandleMessage: string,
): BunChannel {
  // FFI 심볼 반환값은 bun:ffi 타입상 unknown — 경계에서 1회 좁힌다.
  const rawHandle = create() as unknown;
  const handle = Number(rawHandle);
  if (!Number.isSafeInteger(handle) || handle < 1) {
    throw new RustraCommandError(RustraErrorCode.ChannelUnavailable, invalidHandleMessage);
  }
  listeners.set(handle, callback);
  return {
    handle,
    close(): boolean {
      if (!listeners.has(handle)) return false; // double-close 무해.
      listeners.delete(handle);
      // drop은 in-flight 콜백 종료까지 블록한다(quiescence 계약) — 콜백 안에서
      // 호출 금지. 리스너를 먼저 지우므로 그 사이 도착 프레임은 무시된다.
      return drop(handle) === 1;
    },
  };
}

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
  const libraryPath = resolveChannelLibrary(
    options,
    'No compatible Rustra Bun cdylib was found for channel creation. Build the inferred Cargo library, or set RUSTRA_BUN_LIBRARY to its absolute path.',
  );

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
  const lib = openChannelLibrary(
    openLibrary,
    (error) =>
      // dlopen 원시 에러를 transport 계약으로 정규화(bun-events 폴백과 동일 분류) —
      // 원인은 cause 로 보존한다.
      new RustraCommandError(
        RustraErrorCode.TransportUnavailable,
        `Failed to dlopen the Rustra cdylib for channel creation: ${libraryPath}`,
        false,
        error,
      ),
  );
  const channelCreate = lib.symbols.rustra_ffi_channel_create;
  const channelDrop = lib.symbols.rustra_ffi_channel_drop;

  // 트램폴린 1개 + 핸들→JS 콜백 테이블. Rust가 콜백 두 번째 인자로 발급 핸들을
  // 되돌려주므로(ffi_channel.rs) 채널마다 JSCallback을 만들 필요가 없다.
  const listeners = new Map<number, BunChannelCallback>();
  const callback = new JSCallback(
    (_userData: unknown, handle: number, payloadJson: string) => {
      deliverChannelFrame(listeners, handle, (listener) => {
        let payload: unknown;
        try {
          payload = payloadJson === '' ? null : JSON.parse(payloadJson);
        } catch {
          payload = payloadJson; // 비 JSON — 조용한 드롭 방지(Tauri/Node 동일 관용).
        }
        listener(payload);
      });
    },
    // threadsafe:false — JS 스레드(동기 FFI invoke 체인)에서만 호출 전제.
    { args: ['ptr', 'u32', 'cstring'], returns: 'void' },
  );

  return (channelCallback: BunChannelCallback): BunChannel =>
    issueBunChannel(
      listeners,
      channelCallback,
      () => channelCreate(callback.ptr, null),
      channelDrop,
      'rustra_ffi_channel_create returned an invalid handle; channel space may be exhausted',
    );
}

/**
 * Bun 바이너리 채널 브릿지를 만든다 — RN `createBytesChannel` 의 FFI 쌍둥.
 * `rustra_ffi_channel_create_bytes` 로 발급하고, 콜백은 `Uint8Array` 페이로드를
 * 받는다(rkyv V2 프레임 등 임의 바이트). 한 핸들은 한 경로(JSON xor bytes)로만
 * 동작하고, drop 은 JSON 경로와 같은 `rustra_ffi_channel_drop` 을 공유한다.
 *
 * 네이티브(여기서는 cdylib)가 바이너리 경로를 노출하지 않으면 RN 과 동일하게
 * `channel.unavailable` 로 loud-fail 한다 — 바이트 심볼 없는 구 cdylib 이 그
 * 사례다. 스레드/quiescence 계약은 JSON 브릿지와 동일(모듈 JSDoc).
 *
 * @param options.library — cdylib 경로(미지정 시 `bunLibraryCandidates` 해상,
 * `RUSTRA_BUN_LIBRARY` 오버라이드 포함 — JSON 브릿지와 동일 우선순위).
 */
export async function createBunChannelBytesBridge(
  options: BunLibraryOptions = {},
): Promise<(callback: BunChannelBytesCallback) => BunChannel> {
  const libraryPath = resolveChannelLibrary(
    options,
    'No compatible Rustra Bun cdylib was found for binary channel creation. Build the inferred Cargo library, or set RUSTRA_BUN_LIBRARY to its absolute path.',
  );

  const { dlopen, FFIType, JSCallback, toArrayBuffer } =
    (await import('bun:ffi')) as typeof import('bun:ffi');
  // dlopen 을 try 밖 한 식으로 호출한다 — JSON 브릿지와 같은 제네릭 고정 관례.
  const openLibrary = (): ReturnType<
    typeof dlopen<{
      rustra_ffi_channel_create_bytes: { args: ['ptr', 'ptr']; returns: typeof FFIType.u32 };
      rustra_ffi_channel_drop: { args: ['u32']; returns: typeof FFIType.i32 };
    }>
  > =>
    dlopen(libraryPath, {
      rustra_ffi_channel_create_bytes: { args: ['ptr', 'ptr'], returns: FFIType.u32 },
      rustra_ffi_channel_drop: { args: ['u32'], returns: FFIType.i32 },
    });
  const lib = openChannelLibrary(openLibrary, (error) => {
    // loud-fail 두 갈래(RN createBytesChannel 패리티): (1) cdylib 이 열리지만
    // bytes 심볼이 없으면 `channel.unavailable` — 구 빌드. (2) dlopen 자체가
    // 실패하면 JSON 브릿지와 동일한 transport 계약 분류. 같은 dylib 의 2회
    // dlopen 은 로드 비용 없이 심볼 노출만 확장한다(bun-events.ts 실증).
    let opensWithoutBytesPath = false;
    try {
      dlopen(libraryPath, {
        rustra_ffi_channel_drop: { args: ['u32'], returns: FFIType.i32 },
      }).close();
      opensWithoutBytesPath = true;
    } catch {
      /* dlopen 자체 실패 — 심볼 결핍이 아니다. */
    }
    if (opensWithoutBytesPath) {
      return new RustraCommandError(
        RustraErrorCode.ChannelUnavailable,
        `The Rustra cdylib does not expose rustra_ffi_channel_create_bytes; binary channel support is unavailable: ${libraryPath}`,
        false,
        error,
      );
    }
    return new RustraCommandError(
      RustraErrorCode.TransportUnavailable,
      `Failed to dlopen the Rustra cdylib for binary channel creation: ${libraryPath}`,
      false,
      error,
    );
  });
  const channelCreateBytes = lib.symbols.rustra_ffi_channel_create_bytes;
  const channelDrop = lib.symbols.rustra_ffi_channel_drop;

  // 트램폴린 1개 + 핸들→JS 콜백 테이블 — JSON 브릿지와 동일 구조(핸들은 콜백
  // 두 번째 인자로 되돌아온다). user_data 는 null(브릿지가 상태를 Map 소유).
  const listeners = new Map<number, BunChannelBytesCallback>();
  const callback = new JSCallback(
    (
      _userData: unknown,
      handle: number,
      payloadPtr: Pointer | number | bigint,
      payloadLen: number | bigint,
    ) => {
      deliverChannelFrame(listeners, handle, (listener) => {
        // 페이로드는 콜백 반환 전까지만 유효하다(ffi_channel.rs) — C 포인터에서
        // JS 힙으로 복사한 뒤 전달한다. toArrayBuffer 는 C 메모리의 zero-copy
        // 뷰이므로 slice() 로 실제 복사를 만든다. usize 인자는 bigint 로 마샬링된다.
        const length = Number(payloadLen);
        let payload: Uint8Array;
        try {
          payload =
            length > 0
              ? new Uint8Array(toArrayBuffer(payloadPtr, 0, length)).slice()
              : new Uint8Array(0);
        } catch (error) {
          // 복사 실패 프레임은 격리 — C 트램폴린 경계로 예외이 새는 걸 방지한다.
          console.error('Rustra: binary channel payload copy failed:', error);
          return;
        }
        listener(payload);
      });
    },
    // threadsafe:false — JS 스레드(동기 FFI invoke 체인)에서만 호출 전제.
    { args: ['ptr', 'u32', 'ptr', 'usize'], returns: 'void' },
  );

  return (channelCallback: BunChannelBytesCallback): BunChannel =>
    issueBunChannel(
      listeners,
      channelCallback,
      () => channelCreateBytes(callback.ptr, null),
      channelDrop,
      'rustra_ffi_channel_create_bytes returned an invalid handle; channel space may be exhausted',
    );
}

// ── 코드젠 계약 정합(컴파일 타임 고정) ──────────────────────
// 채널 콜백 시그니처와 { handle, close() } 반환 구조가 RN 계약과 동형임을
// 타입 레벨에서 고정한다(Tauri tauri-channels.ts와 동일 패턴).

type GeneratedChannelHandle = number;
const _channelHandleFitsGenerated: GeneratedChannelHandle = ({} as BunChannel).handle;
void _channelHandleFitsGenerated;
