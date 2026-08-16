/**
 * @rustra/devtools — 호출 관측성 엔진 래퍼.
 *
 * `createInstrumentedEngine` 은 어떤 `EngineClient` 든 감싸 호출 수/에러 수/누적
 * 지연을 기록한다. `report()` 로 명령별 통계(count/errors/avgMs)와 슬로우 콜
 * 타임라인(최대 10)을 조회한다. 타이밍은 `Date.now()` 기반 — QuickJS 런타임에
 * `performance.now` 가 없는 환경(Lynx)을 고려한 퍼셉트 단위 관측이다.
 *
 * @example
 * ```ts
 * import { createInstrumentedEngine } from '@rustra/devtools';
 *
 * const engine = createInstrumentedEngine(createNodeEngine({ invoke }));
 * await addNumbers(engine, { a: 1, b: 2 });
 * console.table(engine.report().commandStats);
 * ```
 */

import type { EngineClient } from '@rustra/types';

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

  return {
    async invoke<T>(command: string, args?: unknown): Promise<T> {
      const start = Date.now();
      try {
        return await inner.invoke<T>(command, args);
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
}
