import { isRetryableCode, RustraCommandError } from './errors.js';
import { CODEC_RAW, CODEC_POSITIONAL } from './global.js';
import { decodeTier3Response, encodeTier3Request } from './json-wire.js';
import { traceWire } from './debug.js';
import { tier2Outcome, payloadTooLargeError } from './frame-engine-contract.js';
import { createDynamicCodecRuntime } from './frame-engine-dynamic-codec.js';
import type { FrameDispatchRuntime, FrameEngineContext } from './frame-engine-context.js';
import type { FrameCodec } from './public.js';

export function createFrameDispatchRuntime(context: FrameEngineContext): FrameDispatchRuntime {
  const { native, registry, schema, payloadLimit } = context;
  const dynamicCodecs = createDynamicCodecRuntime(schema);
  const {
    hasTypedPath,
    hasByIdPath,
    hasRawPath,
    hasPositionalPath,
    ensureStaticIds,
    getStaticCommandCapabilities,
    isVerifiedStaticId,
  } = context.capabilities;
  // 신호 없는 기본 3-티어 dispatch (T1 리팩터링 — 로직은 기존 그대로).
  // Keep encoding capacity and the last exact transport length separately.
  // A busy slot stays leased through decode; synchronous reentry uses a temporary
  // slot so neither encoding nor native callbacks can overwrite the active frame.
  const encodeIntoBuffers = new Map<
    string,
    { busy: boolean; encoded?: Uint8Array; transport?: Uint8Array }
  >();
  const roundTrip = <T>(
    command: string,
    encoded: ArrayBuffer,
    codec: FrameCodec<unknown, unknown>,
  ): T => {
    // (T3) 네이티브 왕복 전에 크기 검사 — 초과면 invokeFrame 를 부르지 않는다.
    const tooLarge = payloadTooLargeError(encoded.byteLength, payloadLimit);
    if (tooLarge) throw tooLarge;
    traceWire('request', command, encoded);
    const resultBytes = native.invokeFrame(encoded);
    traceWire('response', command, resultBytes);
    // Reject (do not throw) so the declared Promise<T> contract holds and
    // callers can use .catch() / await-try-consistently for command errors.
    const outcome = tier2Outcome<T>(codec, resultBytes);
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  };
  const dispatch = <T>(command: string, args?: unknown): T => {
    // 1순위: C++ fast path (RN JSI). 정적 명령만. JS 측 인코딩이 없어
    // maxPayloadBytes 검사를 건너뛴다 — 네이티브 한도가 그대로 적용된다.
    // byId 진입이 가능하면 JSI 1회 + u16 디스패치 (P0-3).
    if (hasTypedPath) {
      const cmdId = ensureStaticIds()?.get(command);
      if (cmdId !== undefined) {
        if (hasByIdPath) {
          return native.invokeTypedById!(cmdId, args) as T;
        }
        return native.invokeTyped!(command, args) as T;
      }
    }
    // 2순위: JS codec (Node/Bun/Tauri 또는 typed 누락 시). 정적 명령.
    const codec = registry.get(command);
    if (codec) {
      if (!codec.encodeInto) return roundTrip<T>(command, codec.encode(args), codec);
      let slot = encodeIntoBuffers.get(command);
      if (!slot) {
        slot = { busy: false };
        encodeIntoBuffers.set(command, slot);
      } else if (slot.busy) {
        slot = { busy: false };
      }
      slot.busy = true;
      try {
        const written = codec.encodeInto(args, slot.encoded);
        slot.encoded = written;
        let encoded = written.buffer as ArrayBuffer;
        if (written.byteOffset !== 0 || written.byteLength !== written.buffer.byteLength) {
          // invokeFrame accepts an exact ArrayBuffer, not a view into spare capacity.
          // Stable lengths reuse this copy target; only length changes allocate.
          if (slot.transport?.byteLength !== written.byteLength) {
            slot.transport = new Uint8Array(written.byteLength);
          }
          slot.transport.set(written);
          encoded = slot.transport.buffer as ArrayBuffer;
        }
        return roundTrip<T>(command, encoded, codec);
      } finally {
        slot.busy = false;
      }
    }
    // 3순위: 동적 명령 → live schema 의 commandId 사용. (T2-3) Rust registry 의
    // 3-way 판정을 미러해 binary 코덱(postcard → complex)이 가능한 스키마는
    // binary 로, 둘 다 거부하는 스키마만 Tier 3(JSON-in-binary) 로 보낸다.
    // getSchema 미노출 네이티브에서 cached lookup은 undefined 를
    // 돌려주므로 기존 command.not_found 계약이 그대로 유지된다.
    // (T0-3) 세대 게이트는 lookupCachedLiveSchemaEntry 내부에서 1회 흡수된다.
    const entry = schema.lookupCachedLiveSchemaEntry(command);
    if (!entry) {
      throw new RustraCommandError(
        'command.not_found',
        `Frame: no codec and not in live schema for "${command}"`,
      );
    }
    const dynamicCodec = dynamicCodecs.lookupBinaryCodec(entry);
    if (dynamicCodec) {
      // tier 2(정적 코덱)와 동일한 왕복 계약 — encode/검사/invoke/decode.
      return roundTrip<T>(command, dynamicCodec.encode(args), dynamicCodec);
    }
    const tier3Request = encodeTier3Request(
      entry.commandId,
      args,
      (entry.inputSchema as { type?: unknown } | undefined)?.type === 'null',
    );
    // (T3) tier 2 와 동일한 사전 검사 — 네이티브 호출 전에 조기 실패.
    const tooLarge = payloadTooLargeError(tier3Request.byteLength, payloadLimit);
    if (tooLarge) throw tooLarge;
    traceWire('request', command, tier3Request);
    const tier3Response = native.invokeFrame(tier3Request);
    traceWire('response', command, tier3Response);
    const resp = decodeTier3Response(tier3Response);
    if (!resp.ok) {
      const e = resp.error ?? { code: 'invoke.failed', message: 'Frame (tier3) invoke failed' };
      throw new RustraCommandError(e.code, e.message, e.retryable ?? isRetryableCode(e.code));
    }
    return (
      (entry.outputSchema as { type?: unknown } | undefined)?.type === 'null'
        ? undefined
        : resp.result
    ) as T;
  };

  // 공개 EngineClient는 항상 Promise를 반환하지만 RN JSI/Node/Bun의 기본
  // dispatch는 동기다. 단 한 번만 Promise로 승격해 async dispatch가 만들던
  // 불필요한 Promise/microtask를 제거하고, 동기 throw는 rejected Promise로
  // 바꿔 기존 호출 계약을 유지한다.
  const dispatchPromise = <T>(command: string, args?: unknown): Promise<T> => {
    try {
      return Promise.resolve(dispatch<T>(command, args));
    } catch (error) {
      return Promise.reject(error);
    }
  };

  const dispatchById = <T>(commandId: number, command: string, args?: unknown): T => {
    if (hasByIdPath && isVerifiedStaticId(commandId, command)) {
      return native.invokeTypedById!(commandId, args) as T;
    }
    return dispatch<T>(command, args);
  };

  const dispatchGeneratedFields = <T>(
    commandId: number,
    command: string,
    args: unknown,
    fieldCount: 1 | 2 | 3,
    field0: unknown,
    field1?: unknown,
    field2?: unknown,
  ): T => {
    if (isVerifiedStaticId(commandId, command)) {
      const capabilities = getStaticCommandCapabilities(commandId);
      if (hasRawPath && (capabilities & CODEC_RAW) !== 0) {
        let result: unknown;
        if (fieldCount === 1) result = native.invokeTypedRaw!(commandId, field0);
        else if (fieldCount === 2) result = native.invokeTypedRaw!(commandId, field0, field1);
        else result = native.invokeTypedRaw!(commandId, field0, field1, field2);
        // New hosts return the declared output shape. NaN is the defensive
        // fallback marker used when the Rust registry cannot service raw even
        // though generated metadata advertised it.
        if (!(typeof result === 'number' && Number.isNaN(result))) return result as T;
      }
      if (hasPositionalPath && (capabilities & CODEC_POSITIONAL) !== 0) {
        if (fieldCount === 1) return native.invokeTypedPos!(commandId, field0) as T;
        if (fieldCount === 2) return native.invokeTypedPos!(commandId, field0, field1) as T;
        return native.invokeTypedPos!(commandId, field0, field1, field2) as T;
      }
    }
    return dispatchById<T>(commandId, command, args);
  };

  const dispatchPromiseById = <T>(
    commandId: number,
    command: string,
    args?: unknown,
  ): Promise<T> => {
    try {
      return Promise.resolve(dispatchById<T>(commandId, command, args));
    } catch (error) {
      return Promise.reject(error);
    }
  };

  return {
    dispatch,
    dispatchPromise,
    dispatchById,
    dispatchPromiseById,
    dispatchGeneratedFields,
  };
}
