/**
 * @rustra/devtools — 호출 관측성 엔진 래퍼.
 *
 * `createInstrumentedEngine` 은 어떤 `EngineClient` 든 감싸 호출 수/에러 수/누적
 * 지연을 기록한다. `report()` 로 명령별 통계(count/errors/avgMs)와 슬로우 콜
 * 타임라인(최대 10)을 조회한다. 타이밍은 `Date.now()` 기반 — `performance.now`
 * 글로벌이 없는 임베디드 JS 런타임을 고려한 퍼셉트 단위 관측이다.
 *
 * inner 엔진이 `invokeBatch` 를 지원하면 래퍼도 전달한다(배치 전체를 1관측으로
 * 기록 + 각 엔트리 실패 반영). 지원하지 않으면 일반 `invoke` 와 마찬가지로
 * 생략된다 — 래핑이 배치 기능을 조용히 제거하지 않는다.
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
  slowest: Array<{ command: string; ms: number }>;
}

export interface InstrumentedEngine extends EngineClient {
  report(): DevtoolsReport;
}

export function createInstrumentedEngine(inner: EngineClient): InstrumentedEngine {
  const stats = new Map<string, CommandStat>();
  const slowest: Array<{ command: string; ms: number }> = [];
  let totalCalls = 0;

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
      const start = Date.now();
      try {
        // options(signal/timeoutMs)를 inner 엔진에 그대로 전달한다 — 관측 래핑이
        // 취소/타임아웃 기능을 조용히 제거하지 않는다.
        return await inner.invoke<T>(command, args, options);
      } catch (e) {
        statFor(command).errors += 1;
        throw e;
      } finally {
        const ms = Date.now() - start;
        const s = statFor(command);
        s.count += 1;
        s.totalMs += ms;
        totalCalls += 1;
        slowest.push({ command, ms });
      }
    },
    report(): DevtoolsReport {
      const commandStats: DevtoolsReport['commandStats'] = {};
      for (const [name, s] of stats) {
        commandStats[name] = { ...s, avgMs: s.count > 0 ? s.totalMs / s.count : 0 };
      }
      slowest.sort((a, b) => b.ms - a.ms);
      return {
        totalCalls,
        commandStats,
        slowest: slowest.slice(0, 10),
      };
    },
  };

  // inner 가 invokeBatch 를 지원하면 전달 — 래핑으로 배치 기능이 사라지지 않게.
  if (inner.invokeBatch) {
    engine.invokeBatch = async <T>(entries: BatchEntry[]): Promise<T[]> => {
      const start = Date.now();
      try {
        return await inner.invokeBatch!<T>(entries);
      } catch (e) {
        for (const { command } of entries) statFor(command).errors += 1;
        throw e;
      } finally {
        const ms = Date.now() - start;
        totalCalls += entries.length;
        for (const { command } of entries) {
          const s = statFor(command);
          s.count += 1;
          s.totalMs += ms / entries.length;
        }
        slowest.push({ command: `batch(${entries.length})`, ms });
      }
    };
  }

  return engine;
}
