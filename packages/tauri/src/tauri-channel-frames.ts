/** Tauri raw IPC packets stay below its app-wide fetch-queue threshold. */
export const MAX_CHANNEL_FRAME_BYTES = 16 * 1024 * 1024;
const HEADER_BYTES = 8;
const MAX_PACKET_BYTES = 968;

export function createChannelFrameDecoder(onFrame: (bytes: Uint8Array) => void) {
  let pending: Uint8Array | undefined;
  let offset = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reset = () => {
    pending = undefined;
    offset = 0;
    clearTimeout(timer);
    timer = undefined;
  };
  return {
    dispose: reset,
    accept(payload: unknown): void {
      const packet =
        payload instanceof Uint8Array
          ? payload
          : payload instanceof ArrayBuffer
            ? new Uint8Array(payload)
            : undefined;
      if (!packet || packet.byteLength < HEADER_BYTES || packet.byteLength > MAX_PACKET_BYTES) {
        reset();
        throw new Error('invalid Tauri channel packet');
      }
      const header = new DataView(packet.buffer, packet.byteOffset, HEADER_BYTES);
      const total = header.getUint32(0, true);
      const at = header.getUint32(4, true);
      const body = packet.subarray(HEADER_BYTES);
      if (
        total > MAX_CHANNEL_FRAME_BYTES ||
        at > total ||
        body.length > total - at ||
        (!body.length && total !== 0)
      ) {
        reset();
        throw new Error('invalid Tauri channel frame length');
      }
      if (at === 0) {
        reset();
        pending = new Uint8Array(total);
        timer = setTimeout(reset, 30_000);
        // Node test/SSR transports must not keep a process alive.
        if (typeof timer === 'object' && 'unref' in timer) timer.unref();
      }
      if (!pending || pending.length !== total || offset !== at) {
        reset();
        throw new Error('out-of-order Tauri channel packet');
      }
      pending.set(body, offset);
      offset += body.length;
      if (offset === total) {
        const complete = pending;
        reset();
        onFrame(complete);
      }
    },
  };
}
