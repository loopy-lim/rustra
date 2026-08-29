import { RustraCommandError } from './errors.js';
import { invokeCallbackWithAbort, raceAbort } from './cancel.js';
import { encodeTier3Request, decodeTier3Response } from './json-wire.js';
import { tier2Outcome, payloadTooLargeError } from './rkyv-engine-contract.js';
import type { RkyvDispatchRuntime, RkyvEngineContext } from './rkyv-engine-context.js';
import type { InvokeOptions } from './public.js';

export function createRkyvInvokeRaw(
  context: RkyvEngineContext,
  dispatch: RkyvDispatchRuntime,
): <T>(
  command: string,
  args?: unknown,
  options?: import('./public.js').InvokeOptions,
) => Promise<T> {
  const { native, registry, schema, payloadLimit } = context;
  const { hasTypedPath, ensureStaticIds } = context.capabilities;
  const { dispatchPromise } = dispatch;
  const invokeRaw = <T>(command: string, args?: unknown, options?: InvokeOptions): Promise<T> => {
    const signal = options?.signal;
    if (signal?.aborted) {
      return Promise.reject(
        new RustraCommandError('cancelled', `invoke("${command}") aborted before dispatch`, true),
      );
    }
    if (!signal) return dispatchPromise<T>(command, args);
    // 네이티브 전파 경로 (T1): JS 코덱(tier 2) 명령이고 invokeAsync +
    // invokeCancel 이 모두 노출되면 Rust 측 체크포인트까지 취소가 닿는다.
    // typed(tier 1)/tier 3 동적 경로는 invokeAsync 가 있어도 얕은 취소로
    // 폴백한다 (설계 노트: 전파는 JS 코덱 경로만).
    const codec = registry.get(command);
    // P0-3: hasStaticCodec JSI 호출 대신 엔진 생애 1회 스윕 캐시 조회.
    const onTypedPath = hasTypedPath && ensureStaticIds()?.has(command) === true;
    if (!onTypedPath && codec && native.invokeAsync && native.invokeCancel) {
      return invokeCallbackWithAbort(
        command,
        signal,
        (resolve, reject, isSettled) => {
          const encoded = codec.encode(args);
          const tooLarge = payloadTooLargeError(encoded.byteLength, payloadLimit);
          if (tooLarge) throw tooLarge;
          return native.invokeAsync!(encoded, (resp) => {
            if (isSettled()) return;
            const outcome = tier2Outcome<T>(codec, resp);
            if (outcome.ok) resolve(outcome.value);
            else reject(outcome.error);
          });
        },
        (invocationId) => native.invokeCancel!(invocationId),
      );
    }
    if (!codec && native.invokeAsync && native.invokeCancel) {
      const cmdId = hasTypedPath ? ensureStaticIds()?.get(command) : undefined;
      const entry =
        cmdId !== undefined ? { commandId: cmdId } : schema.lookupCachedLiveSchemaEntry(command);
      if (entry) {
        return invokeCallbackWithAbort(
          command,
          signal,
          (resolve, reject, isSettled) => {
            const encoded = encodeTier3Request(entry.commandId, args);
            const tooLarge = payloadTooLargeError(encoded.byteLength, payloadLimit);
            if (tooLarge) throw tooLarge;
            return native.invokeAsync!(encoded, (resp) => {
              if (isSettled()) return;
              const outcome = decodeTier3Response(resp);
              if (outcome.ok) resolve(outcome.result as T);
              else {
                const e =
                  outcome.error ??
                  ({ code: 'invoke.failed', message: 'RkyvV2 (tier3) invoke failed' } as const);
                reject(new RustraCommandError(e.code, e.message, e.retryable ?? false));
              }
            });
          },
          (invocationId) => native.invokeCancel!(invocationId),
        );
      }
    }
    return raceAbort(dispatchPromise<T>(command, args), signal, command);
  };

  return invokeRaw;
}
