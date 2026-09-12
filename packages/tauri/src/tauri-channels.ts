import { createChannelFrameDecoder } from './tauri-channel-frames.js';
import {
  debugRustra,
  RustraCommandError,
  RustraErrorCode,
  type RustraDebugEvent,
  type RustraErrorCodeValue,
} from '@rustra/types';
import type { TauriInvoke, TauriListen } from './index.js';
import { requireTauriInvoke, requireTauriIpcChannel } from './tauri-globals.js';

/** A callback-bound IPC transport. dispose must release its JavaScript callback. */
export type TauriIpcChannel = { value: unknown; dispose(): void };
export type TauriChannelIo = {
  invoke?: TauriInvoke;
  /** Advanced transport injection; defaults to __TAURI__.core.Channel. */
  createIpcChannel?: (onMessage: (payload: unknown) => void) => TauriIpcChannel;
  /** @deprecated Channel frames no longer use app-wide events. */
  listen?: TauriListen;
};
export type RustraTauriChannel = {
  readonly handle: number;
  /** Suppress future callbacks and release the native handle; idempotent. */
  close(): Promise<boolean>;
};
export type RustraTauriBytesChannel = RustraTauriChannel;

/** Event name for trusted Rust host helpers, not JS-issued IPC channels. */
export function rustraChannelEventChannel(handle: number): string {
  return `rustra://channel/${handle}`;
}
/** Bytes event name for trusted Rust host helpers. */
export function rustraChannelBytesEventChannel(handle: number): string {
  return `rustra://channel-bytes/${handle}`;
}

async function createOwnedChannel(
  callback: (payload: unknown, handle: number) => void,
  io: TauriChannelIo,
  command: string,
  code: RustraErrorCodeValue,
): Promise<RustraTauriChannel> {
  const invoke = io.invoke ?? requireTauriInvoke(code);
  let closed = false;
  let handle = 0;
  const frames = createChannelFrameDecoder((bytes) => {
    if (closed) return;
    callback(
      command === 'rustra_channel_create_bytes'
        ? bytes
        : JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
      handle,
    );
  });
  const onMessage = (payload: unknown) => {
    if (closed) return;
    try {
      frames.accept(payload);
    } catch (error) {
      try {
        debugRustra({
          kind: 'tauri.bytes_payload_error',
          command,
          error: String(error),
        } as unknown as RustraDebugEvent);
      } catch {
        /* Keep diagnostics isolated. */
      }
    }
  };
  const transport = io.createIpcChannel?.(onMessage) ?? requireTauriIpcChannel(onMessage, code);
  const dispose = () => {
    closed = true;
    frames.dispose();
    transport.dispose();
  };
  try {
    const raw = (await invoke(command, { onMessage: transport.value })) as {
      handle?: unknown;
      transport?: unknown;
    };
    handle = typeof raw?.handle === 'number' ? raw.handle : 0;
    if (!Number.isSafeInteger(handle) || handle < 1 || handle > 0xffffffff) {
      throw new RustraCommandError(
        RustraErrorCode.ChannelUnavailable,
        `${command} returned an invalid u32 handle`,
      );
    }
    // An older native host ignores onMessage and would silently broadcast. Fail
    // before returning a handle and release the old host's allocation.
    if (raw.transport !== 'ipc-channel-chunks-v1') {
      await Promise.resolve(invoke('rustra_channel_drop', { handle })).catch(() => {});
      throw new RustraCommandError(
        RustraErrorCode.ChannelUnavailable,
        'Native Tauri channel protocol is incompatible; rebuild Rust and update @rustra/tauri together',
      );
    }
  } catch (error) {
    try {
      dispose();
    } catch {
      /* Preserve the original IPC failure. */
    }
    throw error;
  }
  let closing: Promise<boolean> | undefined;
  return {
    handle,
    close() {
      if (closing) return closing;
      closed = true;
      frames.dispose();
      closing = (async () => {
        try {
          return (await invoke('rustra_channel_drop', { handle })) === true;
        } finally {
          transport.dispose();
        }
      })();
      return closing;
    },
  };
}

/**
 * Create a channel bound to the invoking WebView's IPC callback. Other WebViews
 * cannot subscribe through event.listen or close its handle. Native navigation,
 * WebView destruction, and app shutdown release ownership. Update Rust and JS
 * together; old event-based hosts fail the protocol check.
 */
export async function createChannel(
  callback: (payload: unknown) => void,
  io: TauriChannelIo = {},
): Promise<RustraTauriChannel> {
  // IPC delivers already-decoded JSON, including strings. Parsing strings again
  // would corrupt values such as the JSON string "42" into the number 42.
  return createOwnedChannel(
    callback,
    io,
    'rustra_channel_create',
    RustraErrorCode.TransportUnavailable,
  );
}

/** Like createChannel, using Tauri raw IPC bytes and a Uint8Array callback. */
export async function createChannelBytes(
  callback: (payload: Uint8Array) => void,
  io: TauriChannelIo = {},
): Promise<RustraTauriBytesChannel> {
  return createOwnedChannel(
    (payload, handle) => {
      const bytes =
        payload instanceof Uint8Array
          ? payload
          : payload instanceof ArrayBuffer
            ? new Uint8Array(payload)
            : Array.isArray(payload) &&
                payload.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
              ? Uint8Array.from(payload)
              : null;
      if (bytes) {
        callback(bytes);
        return;
      }
      try {
        debugRustra({
          kind: 'tauri.bytes_payload_error',
          command: rustraChannelBytesEventChannel(handle),
          error: 'unexpected bytes channel payload',
        } as unknown as RustraDebugEvent);
      } catch {
        /* Diagnostics must not escape channel delivery. */
      }
    },
    io,
    'rustra_channel_create_bytes',
    RustraErrorCode.ChannelUnavailable,
  );
}

// ── 코드젠 계약 정합(컴파일 타임 고정) ──────────────────────
// 코드젠 채널 표면은 `ChannelHandle = number` 마커(wire plain u32)다.
// createChannel 결과의 handle 이 그 자리를 채우는지 타입 레벨 고정.

type GeneratedChannelHandle = number;
const _channelHandleFitsGenerated: GeneratedChannelHandle = ({} as RustraTauriChannel).handle;
void _channelHandleFitsGenerated;
