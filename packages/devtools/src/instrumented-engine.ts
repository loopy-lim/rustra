import type { BatchEntry, EngineClient, InvokeOptions } from '@rustra/types';
import { errorSummary, snapshot } from './devtools-snapshot.js';
import type {
  CommandStat,
  DevtoolsLog,
  DevtoolsReport,
  InstrumentedEngine,
  InstrumentedEngineOptions,
} from './devtools-types.js';

export function createInstrumentedEngine(
  inner: EngineClient,
  options: InstrumentedEngineOptions = {},
): InstrumentedEngine {
  const stats = new Map<string, CommandStat>();
  const slowest: Array<{ command: string; ms: number }> = [];
  const logs: DevtoolsLog[] = [];
  let totalCalls = 0;
  const batches = { count: 0, entries: 0, errors: 0, totalMs: 0 };
  const now = () =>
    typeof globalThis.performance?.now === 'function' ? performance.now() : Date.now();
  const statFor = (command: string) => {
    let stat = stats.get(command);
    if (!stat) {
      stat = { count: 0, errors: 0, totalMs: 0 };
      stats.set(command, stat);
    }
    return stat;
  };
  const recordSlow = (command: string, ms: number) => {
    slowest.push({ command, ms });
    slowest.sort((a, b) => b.ms - a.ms);
    if (slowest.length > 10) slowest.pop();
  };
  const recordLog = (entry: DevtoolsLog) => {
    logs.push(entry);
    const maxEntries = options.maxLogEntries ?? 100;
    if (logs.length > maxEntries) logs.splice(0, logs.length - maxEntries);
    options.onLog?.(entry);
  };
  const payload = (value: unknown) => (options.capturePayload ? snapshot(value) : undefined);
  // (M8) 실패 프레임 포렌식 — 에러가 응답 프레임 바이트를 싣고 있으면(tier2
  // 디코드 실패 정규화의 RustraCommandError.frameBytes) hex 절단(앞 256B)과
  // 전체 길이를 실패 로그에만 남긴다. duck-typing 으로 읽어 구 @rustra/types 와
  //도 그대로 동작한다(필드가 없으면 아무것도 남지 않는다).
  const frameForensics = (
    error: unknown,
  ): Pick<DevtoolsLog, 'frameBytesHex' | 'frameByteLength'> => {
    const bytes =
      typeof error === 'object' &&
      error !== null &&
      (error as { frameBytes?: unknown }).frameBytes instanceof Uint8Array
        ? (error as { frameBytes: Uint8Array }).frameBytes
        : undefined;
    if (bytes === undefined) return {};
    return {
      frameBytesHex: Array.from(bytes.subarray(0, 256), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join(''),
      frameByteLength: bytes.byteLength,
    };
  };
  const finish = (command: string, start: number, failed: boolean) => {
    const ms = now() - start;
    const stat = statFor(command);
    stat.count += 1;
    if (failed) stat.errors += 1;
    stat.totalMs += ms;
    totalCalls += 1;
    recordSlow(command, ms);
    return ms;
  };
  const recordCall = async <T>(
    kind: 'invoke' | 'invokeById',
    command: string,
    args: unknown,
    call: () => Promise<T>,
  ): Promise<T> => {
    const start = now();
    let failed = false;
    try {
      const result = await call();
      recordLog({
        kind,
        command,
        durationMs: now() - start,
        ok: true,
        payload: payload(args),
        result: payload(result),
      });
      return result;
    } catch (error) {
      failed = true;
      recordLog({
        kind,
        command,
        durationMs: now() - start,
        ok: false,
        payload: payload(args),
        error: errorSummary(error),
        ...frameForensics(error),
      });
      throw error;
    } finally {
      finish(command, start, failed);
    }
  };
  const engine: InstrumentedEngine = {
    async invoke<T>(command: string, args?: unknown, invokeOptions?: InvokeOptions): Promise<T> {
      return recordCall('invoke', command, args, () =>
        inner.invoke<T>(command, args, invokeOptions),
      );
    },
    report(): DevtoolsReport {
      const commandStats: DevtoolsReport['commandStats'] = {};
      for (const [name, stat] of stats) {
        commandStats[name] = { ...stat, avgMs: stat.count ? stat.totalMs / stat.count : 0 };
      }
      return {
        totalCalls,
        commandStats,
        batchStats: { ...batches, avgMs: batches.count ? batches.totalMs / batches.count : 0 },
        slowest: [...slowest],
        logs: [...logs],
      };
    },
  };
  if (inner.invokeById) {
    engine.invokeById = async <T>(
      id: number,
      command: string,
      args?: unknown,
      invokeOptions?: InvokeOptions,
    ) =>
      recordCall('invokeById', command, args, () =>
        inner.invokeById!<T>(id, command, args, invokeOptions),
      );
  }
  if (inner.invokeBatch) {
    engine.invokeBatch = async <T>(entries: BatchEntry[]) => {
      const start = now();
      const command = `batch(${entries.length})`;
      try {
        const result = await inner.invokeBatch!<T>(entries);
        recordLog({
          kind: 'batch',
          command,
          durationMs: now() - start,
          ok: true,
          payload: payload(entries),
          result: payload(result),
        });
        return result;
      } catch (error) {
        batches.errors += 1;
        recordLog({
          kind: 'batch',
          command,
          durationMs: now() - start,
          ok: false,
          payload: payload(entries),
          error: errorSummary(error),
          ...frameForensics(error),
        });
        throw error;
      } finally {
        const ms = now() - start;
        batches.count += 1;
        batches.entries += entries.length;
        batches.totalMs += ms;
        totalCalls += entries.length;
        for (const entry of entries) {
          const stat = statFor(entry.command);
          stat.count += 1;
          stat.totalMs += ms / entries.length;
        }
        recordSlow(command, ms);
      }
    };
  }
  return engine;
}
