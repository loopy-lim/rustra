/**
 * @rustra/devtools — 호출 관측성 엔진 래퍼.
 *
 * 계측 래퍼는 invoke, invokeById, invokeBatch의 선택 기능을 보존하며
 * bounded payload log와 명령별 지연/error 통계를 제공한다.
 */
export { createInstrumentedEngine } from './instrumented-engine.js';
export type {
  CommandStat,
  DevtoolsReport,
  DevtoolsLog,
  InstrumentedEngine,
  InstrumentedEngineOptions,
} from './devtools-types.js';
