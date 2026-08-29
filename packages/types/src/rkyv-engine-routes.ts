import { CODEC_BUFFER, CODEC_POSITIONAL, CODEC_RAW, isNativeByteBuffer } from './global.js';
import type { GeneratedBytesRoute, GeneratedFieldsRoute } from './global.js';
import type { RkyvRouteRuntime, RkyvEngineContext } from './rkyv-engine-context.js';

export function createRkyvRouteRuntime(
  context: RkyvEngineContext,
  dispatchById: <T>(commandId: number, command: string, args?: unknown) => T,
): RkyvRouteRuntime {
  const { native } = context;
  const {
    hasBufferPath,
    hasByIdPath,
    hasRawPath,
    hasPositionalPath,
    getStaticCommandName,
    getStaticCommandCapabilities,
    ensureStaticIds,
  } = context.capabilities;
  const resolveGeneratedFieldsRoute = (
    commandId: number,
    command: string,
    fieldCount: 1 | 2 | 3,
  ): GeneratedFieldsRoute | undefined => {
    if (getStaticCommandName(commandId) !== command) return undefined;
    const capabilities = getStaticCommandCapabilities(commandId);

    let fallback: GeneratedFieldsRoute | undefined;
    if (hasPositionalPath && (capabilities & CODEC_POSITIONAL) !== 0) {
      fallback =
        fieldCount === 1
          ? (_args, field0) => native.invokeTypedPos!(commandId, field0)
          : fieldCount === 2
            ? (_args, field0, field1) => native.invokeTypedPos!(commandId, field0, field1)
            : (_args, field0, field1, field2) =>
                native.invokeTypedPos!(commandId, field0, field1, field2);
    } else if (hasByIdPath) {
      fallback = (args) => native.invokeTypedById!(commandId, args);
    }

    if (hasRawPath && (capabilities & CODEC_RAW) !== 0) {
      if (!fallback) {
        return fieldCount === 1
          ? (_args, field0) => native.invokeTypedRaw!(commandId, field0)
          : fieldCount === 2
            ? (_args, field0, field1) => native.invokeTypedRaw!(commandId, field0, field1)
            : (_args, field0, field1, field2) =>
                native.invokeTypedRaw!(commandId, field0, field1, field2);
      }
      const rawFallback = fallback;
      return fieldCount === 1
        ? (args, field0) => {
            const result = native.invokeTypedRaw!(commandId, field0);
            return typeof result === 'number' && Number.isNaN(result)
              ? rawFallback(args, field0)
              : result;
          }
        : fieldCount === 2
          ? (args, field0, field1) => {
              const result = native.invokeTypedRaw!(commandId, field0, field1);
              return typeof result === 'number' && Number.isNaN(result)
                ? rawFallback(args, field0, field1)
                : result;
            }
          : (args, field0, field1, field2) => {
              const result = native.invokeTypedRaw!(commandId, field0, field1, field2);
              return typeof result === 'number' && Number.isNaN(result)
                ? rawFallback(args, field0, field1, field2)
                : result;
            };
    }
    return fallback;
  };

  const resolveGeneratedBytesRoute = (
    commandId: number,
    command: string,
  ): GeneratedBytesRoute | undefined => {
    if (getStaticCommandName(commandId) !== command) return undefined;
    const capabilities = getStaticCommandCapabilities(commandId);
    const fallback = resolveGeneratedFieldsRoute(commandId, command, 1);
    if (!hasBufferPath || (capabilities & CODEC_BUFFER) === 0) return fallback;
    return (args, value) =>
      isNativeByteBuffer(value)
        ? native.invokeTypedBuffer!(commandId, value)
        : fallback
          ? fallback(args, value)
          : dispatchById(commandId, command, args);
  };

  ensureStaticIds();
  return { resolveGeneratedFieldsRoute, resolveGeneratedBytesRoute };
}
