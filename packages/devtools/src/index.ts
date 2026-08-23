/**
 * @rustra/devtools — 호출 관측성 엔진 래퍼.
 *
 * `createInstrumentedEngine` 은 어떤 `EngineClient` 든 감싸 호출 수/에러 수/누적
 * 지연을 기록한다. `report()` 로 명령별 통계(count/errors/avgMs)와 슬로우 콜
 * 타임라인(최대 10)을 조회한다. 타이밍은 단조 고해상도 `performance.now()`를
 * 우선하고, 해당 글로벌이 없는 임베디드 JS 런타임에서만 `Date.now()`로
 * 폴백한다.
 *
 * inner 엔진의 `invokeById`/`invokeBatch` 선택 기능도 그대로 전달한다. 계측을
 * 켰다는 이유로 코드젠의 숫자 id fast path나 배치 기능이 사라지지 않는다.
 *
 * @example
 * ```ts
 * import { createInstrumentedEngine } from '@rustra/devtools';
 * import { configure } from '@rustra/types';
 *
 * configure(createInstrumentedEngine(createNodeEngine({ invoke })));
 * await addNumbers({ a: 1, b: 2 });
 * console.table(engine.report().commandStats);
 * ```
 */

import type { BatchEntry, EngineClient, InvokeOptions } from '@rustra/types';

interface CommandStat {
  count: number;
  errors: number;
  totalMs: number;
}

export interface DevtoolsReport {
  totalCalls: number;
  commandStats: Record<string, CommandStat & { avgMs: number }>;
  batchStats: {
    count: number;
    entries: number;
    errors: number;
    totalMs: number;
    avgMs: number;
  };
  slowest: Array<{ command: string; ms: number }>;
}

export interface InstrumentedEngine extends EngineClient {
  report(): DevtoolsReport;
}

export function createInstrumentedEngine(inner: EngineClient): InstrumentedEngine {
  const stats = new Map<string, CommandStat>();
  const slowest: Array<{ command: string; ms: number }> = [];
  let totalCalls = 0;
  const batches = { count: 0, entries: 0, errors: 0, totalMs: 0 };

  const now = (): number => {
    const monotonic = globalThis.performance;
    return typeof monotonic?.now === 'function' ? monotonic.now() : Date.now();
  };

  // 전체 호출 이력을 쌓지 않고 top 10만 유지한다. report() 호출 빈도와 무관하게
  // 장기 실행 메모리는 O(10)으로 고정된다.
  const recordSlow = (command: string, ms: number): void => {
    slowest.push({ command, ms });
    slowest.sort((a, b) => b.ms - a.ms);
    if (slowest.length > 10) slowest.pop();
  };

  const statFor = (command: string): CommandStat => {
    let s = stats.get(command);
    if (!s) {
      s = { count: 0, errors: 0, totalMs: 0 };
      stats.set(command, s);
    }
    return s;
  };

  const engine: InstrumentedEngine = {
    async invoke<T>(command: string, args?: unknown, options?: InvokeOptions): Promise<T> {
      const start = now();
      try {
        // options(signal/timeoutMs)를 inner 엔진에 그대로 전달한다 — 관측 래핑이
        // 취소/타임아웃 기능을 조용히 제거하지 않는다.
        return await inner.invoke<T>(command, args, options);
      } catch (e) {
        statFor(command).errors += 1;
        throw e;
      } finally {
        const ms = now() - start;
        const s = statFor(command);
        s.count += 1;
        s.totalMs += ms;
        totalCalls += 1;
        recordSlow(command, ms);
      }
    },
    report(): DevtoolsReport {
      const commandStats: DevtoolsReport['commandStats'] = {};
      for (const [name, s] of stats) {
        commandStats[name] = { ...s, avgMs: s.count > 0 ? s.totalMs / s.count : 0 };
      }
      return {
        totalCalls,
        commandStats,
        batchStats: {
          ...batches,
          avgMs: batches.count > 0 ? batches.totalMs / batches.count : 0,
        },
        slowest: [...slowest],
      };
    },
  };

  // 생성 클라이언트가 알고 있는 numeric id를 보존한다. 이름은 통계 key와
  // 오류 메시지에 쓰고, id/name/options는 inner에 변경 없이 전달한다.
  if (inner.invokeById) {
    engine.invokeById = async <T>(
      commandId: number,
      command: string,
      args?: unknown,
      options?: InvokeOptions,
    ): Promise<T> => {
      const start = now();
      try {
        return await inner.invokeById!<T>(commandId, command, args, options);
      } catch (error) {
        statFor(command).errors += 1;
        throw error;
      } finally {
        const ms = now() - start;
        const stat = statFor(command);
        stat.count += 1;
        stat.totalMs += ms;
        totalCalls += 1;
        recordSlow(command, ms);
      }
    };
  }

  // inner 가 invokeBatch 를 지원하면 전달 — 래핑으로 배치 기능이 사라지지 않게.
  if (inner.invokeBatch) {
    engine.invokeBatch = async <T>(entries: BatchEntry[]): Promise<T[]> => {
      const start = now();
      try {
        return await inner.invokeBatch!<T>(entries);
      } catch (e) {
        // 단일 native batch 에러만으로는 어느 엔트리가 원인인지 알 수 없다.
        // 모든 command를 실패로 찍지 않고 batch-level 실패만 기록한다.
        batches.errors += 1;
        throw e;
      } finally {
        const ms = now() - start;
        batches.count += 1;
        batches.entries += entries.length;
        batches.totalMs += ms;
        totalCalls += entries.length;
        for (const { command } of entries) {
          const s = statFor(command);
          s.count += 1;
          s.totalMs += ms / entries.length;
        }
        recordSlow(`batch(${entries.length})`, ms);
      }
    };
  }

  return engine;
}
