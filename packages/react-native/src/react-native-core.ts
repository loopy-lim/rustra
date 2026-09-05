import type {
  BatchEntry,
  EngineClient as EngineClientType,
  InvokeOptions,
  RkyvV2Engine,
  RkyvV2EngineOptions,
  RkyvV2SchemaNative,
  RustraNative,
} from '@rustra/types';
import {
  CancelledError,
  configureLazy,
  createRkyvV2Engine,
  decodeUtf8,
  encodeUtf8,
  ensureConfigured,
  exactArrayBuffer,
  invokeWithTimeout,
  parseRustraErrorString,
  raceAbort,
} from '@rustra/types';

export type ReactNativeEngine = EngineClientType & {
  invokeBatch<T>(entries: BatchEntry[]): Promise<T[]>;
};
export type RustraJSINative = RkyvV2SchemaNative & {
  invoke(payload: ArrayBuffer): ArrayBuffer;
  onEvent?(name: string, callback: (payloadJson: string) => void): void;
  offEvent?(name: string): void;
  drainEvents?(): number;
  createChannel?(callback: (payloadJson: string) => void): number;
  dropChannel?(handle: number): boolean;
};

export function createReactNativeEngine(native: {
  invoke(payload: ArrayBuffer): ArrayBuffer;
}): ReactNativeEngine {
  const transport: EngineClientType = {
    invoke<T>(command: string, args?: unknown, options?: InvokeOptions): Promise<T> {
      if (options?.signal?.aborted) {
        return Promise.reject(new CancelledError(`invoke("${command}") aborted before dispatch`));
      }
      try {
        const payload = exactArrayBuffer(encodeUtf8(JSON.stringify({ command, args })));
        const response = JSON.parse(decodeUtf8(native.invoke(payload))) as {
          ok: boolean;
          result?: T;
          error?: string;
        };
        if (!response.ok) return Promise.reject(parseRustraErrorString(response.error));
        const result = Promise.resolve(response.result as T);
        return options?.signal ? raceAbort(result, options.signal, command) : result;
      } catch (error) {
        return Promise.reject(error);
      }
    },
  };
  return {
    invoke<T>(command: string, args?: unknown, options?: InvokeOptions) {
      return invokeWithTimeout<T>(transport, command, args, options);
    },
    invokeBatch<T>(entries: BatchEntry[]) {
      return Promise.all(
        entries.map((entry) =>
          invokeWithTimeout<T>(transport, entry.command, entry.args, entry.options),
        ),
      );
    },
  };
}

export type FastEngineOptions = {
  rkyvV2Codecs: Map<string, import('@rustra/types').RkyvV2Codec<unknown, unknown>>;
} & RkyvV2EngineOptions;
export type RustraBootstrapOptions = FastEngineOptions & {
  install(): Promise<void>;
  getNative(): RustraJSINative;
};
export type RustraBootstrap = { ready(): Promise<RkyvV2Engine> };

export function createRustraBootstrap(options: RustraBootstrapOptions): RustraBootstrap {
  configureLazy(async () => {
    try {
      await options.install();
      return createFastEngine(options.getNative(), options);
    } catch (error) {
      throw new Error(
        `[rustra:bootstrap] Native setup failed: ${error instanceof Error ? error.message : String(error)}. Rebuild the native app after checking autolinking, generated codecs, and Rust FFI symbols.`,
        { cause: error },
      );
    }
  });
  return { ready: () => ensureConfigured() as Promise<RkyvV2Engine> };
}

export function getRustraNative(): RustraJSINative & RustraNative {
  const native = (globalThis as Record<string, unknown>).__rustraNative;
  if (!native) {
    throw new Error(
      'JSI native module not installed. Call installRustraJSI() from your native module first. ' +
        'Expo Go cannot load JSI; rebuild the native app after checking autolinking, the Rust static archive, ' +
        'and required extern "C" FFI symbols. A JavaScript reload cannot repair native drift.',
    );
  }
  return native as RustraJSINative & RustraNative;
}

export function createFastEngine(
  native: RustraJSINative,
  options: FastEngineOptions,
): RkyvV2Engine {
  const engineOptions = {
    contractHash: options.contractHash,
    onContractMismatch: options.onContractMismatch,
    schemaVersion: options.schemaVersion,
    onSchemaStale: options.onSchemaStale,
    maxPayloadBytes: options.maxPayloadBytes,
  } satisfies RkyvV2EngineOptions;
  return createRkyvV2Engine(native, options.rkyvV2Codecs, engineOptions);
}
