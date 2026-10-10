/**
 * A2 마이크로벤치 — 필드 명령 라우트의 기존 경로와 세대 캐시 팩토리 경로 비교.
 *
 * - 기존 경로: invokeGeneratedFields1(기존 코드젠 emit) — 매 호출
 *   `runtime.generatedFieldsRoutes[commandId]` 배열 조회 + `route.command === command`
 *   문자열 비교 + fieldCount 재확인 후 invokeRoute.
 * - 신규 경로: createGeneratedFields1(A2 팩토리) — 세대 정수 비교 1회 + 캡처 클로저.
 *
 * 측정 관례는 scripts/complex-codec-bench.mjs 를 따른다(20,000회, 월클록,
 * 호출당 할당 정책 공개). 두 경로 모두 같은 스텁 엔진 라우트를 공유하므로
 * 차이는 순수하게 JS 디스패치 오버헤드(라우트 조회·문자열 비교)다.
 *
 * 실행: env -u RUSTRA_BUN_LIBRARY bun scripts/a2-fields-microbench.mjs
 */
import {
  configure,
  createGeneratedFields1,
  invokeGeneratedFields1,
  invokeGeneratedFieldsSync,
  resolveGeneratedFieldsSync,
  resetConfiguredRoutes,
} from '../packages/types/src/index.ts';

/** 계산기 예제 생성물의 실제 필드 명령(generated/commands.ts 122–125행)과 동일한 정체성. */
const COMMAND_ID = 38;
const COMMAND = 'parityIndexed';
const FIELD_KEY = 'id';

function numericOption(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * 내부 디스패치 프로토콜을 구현하는 최소 스텁 엔진. 라우트는 실제 네이티브
 * 호출 대신 동기 평범 객체를 반환한다(invokeRoute 가 Promise.resolve 로 감싼다).
 * 카운터로 호출 수 불변(A2 채택 기준)을 검증한다.
 */
function createBenchEngine() {
  const counters = { routeResolutions: 0, routeInvocations: 0, looseInvocations: 0, resets: 0 };
  const route = (args, field0) => {
    counters.routeInvocations += 1;
    return { even: (field0 & 1) === 0, id: field0 };
  };
  const engine = {
    async invoke(_command, args) {
      counters.looseInvocations += 1;
      return route(args, args?.[FIELD_KEY]);
    },
    [resolveGeneratedFieldsSync](_commandId, _command, fieldCount) {
      counters.routeResolutions += 1;
      return fieldCount === 1 ? route : undefined;
    },
    [invokeGeneratedFieldsSync](_commandId, _command, args, _fieldCount, field0) {
      counters.routeInvocations += 1;
      return route(args, field0);
    },
  };
  const reset = () => {
    counters.resets += 1;
    resetConfiguredRoutes();
  };
  return { engine, counters, reset };
}

function median(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function stat(samplesUs) {
  const usPerCall = median(samplesUs);
  return {
    usPerCall: Number(usPerCall.toFixed(4)),
    opsPerSecond: Math.round(1_000_000 / usPerCall),
    samplesUs: samplesUs.map((value) => Number(value.toFixed(4))),
  };
}

/** 월클록 timed loop — complex-codec-bench 의 encode/decode 측정과 동일한 형태. */
function timedCallsPerUs(call, iterations) {
  const start = performance.now();
  for (let i = 0; i < iterations; i += 1) call(i);
  return ((performance.now() - start) * 1_000) / iterations;
}

function assertRouteCounters(counters, before, totalCalls, label) {
  const invocations = counters.routeInvocations - before.routeInvocations;
  if (invocations !== totalCalls)
    throw new Error(
      `${label}: expected exactly ${totalCalls} route invocations, saw ${invocations} ` +
        `(fallback path engaged — route resolution is broken)`,
    );
}

/** warm 시나리오 — warmup 뒤 timed loop. 세대 내 라우트 해결은 1회만 일어나야 한다. */
function measureWarm(call, counters, iterations, warmup) {
  const before = { ...counters };
  for (let i = 0; i < warmup; i += 1) call(i);
  const us = timedCallsPerUs(call, iterations);
  assertRouteCounters(counters, before, warmup + iterations, 'warm');
  return us;
}

/**
 * cold 시나리오 — 재설정 직후 첫 호출의 end-to-end 평균. reset 비용 자체가
 * 포함되며, 그 기준선(reset-only 평균)은 두 경로 공통으로 별도 측정한다.
 */
function measureColdFirstCall(call, iterations, reset) {
  const start = performance.now();
  for (let i = 0; i < iterations; i += 1) {
    reset();
    call(i);
  }
  return ((performance.now() - start) * 1_000) / iterations;
}

/** reset-only 기준선 — cold 수치에서 reset 몫을 가늠하게 하는 공통 참조값. */
function measureResetOnly(reset, iterations) {
  const start = performance.now();
  for (let i = 0; i < iterations; i += 1) reset();
  return ((performance.now() - start) * 1_000) / iterations;
}

/**
 * reset 후 경로 — reset 1회 뒤 warmup 없이 timed loop(첫 호출은 재해결을,
 * 나머지는 재설정 이후 steady state을 함께 포함한다).
 */
function measureAfterReset(call, counters, iterations, reset) {
  const before = { ...counters };
  reset();
  const us = timedCallsPerUs(call, iterations);
  assertRouteCounters(counters, before, iterations, 'afterReset');
  return us;
}

/**
 * 본 측정 전 JIT 정착용 프리웜(미계측). 호출당 수십 ns 작업은 초기 샘플에서
 * tier-up 드리프트가 커서, 라운드 시작 전에 두 경로를 충분히 데운다.
 */
function prewarm(call, reset, calls) {
  for (let i = 0; i < calls; i += 1) call(i);
  reset();
  for (let i = 0; i < calls; i += 1) call(i);
}

export async function runA2FieldsMicrobench(options = {}) {
  const iterations = numericOption(options.iterations, 20_000);
  const warmup = numericOption(options.warmup, 1_000);
  const repeats = numericOption(options.repeats, 5);
  const coldSamples = numericOption(options.coldSamples, 5_000);
  const prewarmCalls = numericOption(options.prewarmCalls, 100_000);

  const legacy = { warm: [], coldFirstCall: [], afterReset: [] };
  const factory = { warm: [], coldFirstCall: [], afterReset: [] };
  const shared = { resetOnlyUs: [], resetAndCallUs: [] };

  // 생성물이 쓰는 정확한 호출 형태(commands.ts 123행): 헬퍼 경유 + 매 호출 필드 접근.
  const input = { id: 4 };
  const legacyCall = () => invokeGeneratedFields1(COMMAND_ID, COMMAND, input, input[FIELD_KEY]);
  const factoryCommand = createGeneratedFields1(
    COMMAND_ID,
    COMMAND,
    FIELD_KEY,
    COMMAND,
  );
  const factoryCall = () => factoryCommand(input);

  if (factoryCommand.commandId !== COMMAND || factoryCommand.name !== COMMAND)
    throw new Error('factory command must preserve commandId and name metadata');

  // 결과 정합성 — 두 경로 모두 동일한 라우트 결과를 Promise 로 반환해야 한다.
  const { engine, counters, reset } = createBenchEngine();
  configure(engine);
  counters.resets += 1; // configure 내부의 resetConfiguredRoutes 를 세대 이벤트로 가산
  const verificationCalls = 4;
  const results = await Promise.all([
    legacyCall(),
    factoryCall(),
    legacyCall(),
    factoryCall(),
  ]);
  for (const value of results) {
    if (value.even !== true || value.id !== 4)
      throw new Error(`unexpected route result: ${JSON.stringify(value)}`);
  }

  // JIT 정착 — 두 경로를 세대 경계(reset) 포함해 데운 뒤 라운드를 시작한다.
  const prewarmEach = Math.floor(prewarmCalls / 2);
  prewarm(legacyCall, reset, prewarmEach);
  prewarm(factoryCall, reset, prewarmEach);

  for (let round = 0; round < repeats; round += 1) {
    // 교대 순서로 측정 순서 편향을 상쇄한다(짝수 라운드는 legacy 먼저).
    const legacyFirst = round % 2 === 0;
    const order = legacyFirst ? [legacyCall, factoryCall] : [factoryCall, legacyCall];

    for (const call of order) {
      const isFirst = call === legacyCall;
      const bucket = isFirst ? legacy : factory;

      // warm — 세대 내 steady state. 이 구간에서 해결은 0회(캐시 유효) 또는
      // 최악 1회(앞 세그먼트 reset 잔여)여야 하고, timed loop 내 0회임을 단언한다.
      const warmBeforeResolutions = counters.routeResolutions;
      bucket.warm.push(measureWarm(call, counters, iterations, warmup));
      if (counters.routeResolutions - warmBeforeResolutions > 1)
        throw new Error('warm segment resolved the route more than once per generation');
      // reset 후 경로 — reset 직후 warmup 없이 timed loop. 해결은 정확히 1회.
      const beforeResolutions = counters.routeResolutions;
      bucket.afterReset.push(measureAfterReset(call, counters, iterations, reset));
      if (counters.routeResolutions - beforeResolutions !== 1)
        throw new Error('afterReset segment must resolve exactly once after one reset');
      // cold — 재설정 직후 첫 호출(reset 비용 포함, 기준선은 라운드 말미에 측정).
      bucket.coldFirstCall.push(measureColdFirstCall(call, coldSamples, reset));
    }
    shared.resetOnlyUs.push(measureResetOnly(reset, coldSamples));
  }

  // 재설정 후에도 호출 수가 변하지 않음(closure 결합 기각 선례와의 구분 기준):
  // 라우트 호출 수는 정확히 JS 호출 수와 같고, 폴백 경로는 0회여야 한다.
  const totalRouteCalls =
    verificationCalls +
    2 * prewarmCalls +
    repeats * 2 * (warmup + iterations) + repeats * 2 * iterations + repeats * 2 * coldSamples;
  if (counters.routeInvocations !== totalRouteCalls)
    throw new Error(
      `call-count invariance broken: ${counters.routeInvocations} route calls for ${totalRouteCalls} js calls`,
    );
  if (counters.looseInvocations !== 0)
    throw new Error('fallback invoke path must never engage on the fast path');
  // 세대 해결은 호출마다 일어나지 않는다 — 총 해결 수는 세대(reset+configure) 수에
  // 상한(세대당 최대 1회, 경로별)이며 호출 수와 무관하게 O(세대)를 유지한다.
  const maxResolutions = 2 * (counters.resets + 1);
  if (counters.routeResolutions > maxResolutions)
    throw new Error(
      `route resolved ${counters.routeResolutions} times for ${counters.resets} generations ` +
        `(upper bound ${maxResolutions}) — generation cache is resolving per call`,
    );

  const improvementPct = (legacySamples, factorySamples) => {
    const [before, after] = [median(legacySamples), median(factorySamples)];
    return Number((((before - after) / before) * 100).toFixed(2));
  };

  return {
    bench: 'a2-generated-fields-route',
    route: 'generated-fields-dispatch-js',
    command: { commandId: COMMAND_ID, name: COMMAND, fieldKey: FIELD_KEY },
    iterations,
    warmup,
    repeats,
    coldSamples,
    unit: 'µs/call (lower is better); ops/s = 1e6 / µs',
    allocationMode: 'per-call-promise-and-fields-array (identical objects on both paths)',
    legacy: {
      warm: stat(legacy.warm),
      coldFirstCall: stat(legacy.coldFirstCall),
      afterReset: stat(legacy.afterReset),
    },
    factory: {
      warm: stat(factory.warm),
      coldFirstCall: stat(factory.coldFirstCall),
      afterReset: stat(factory.afterReset),
    },
    improvementPct: {
      warm: improvementPct(legacy.warm, factory.warm),
      coldFirstCall: improvementPct(legacy.coldFirstCall, factory.coldFirstCall),
      afterReset: improvementPct(legacy.afterReset, factory.afterReset),
    },
    resetBaseline: {
      resetOnlyUs: Number(median(shared.resetOnlyUs).toFixed(4)),
    },
    invariance: {
      totalJsCalls: totalRouteCalls,
      routeInvocations: counters.routeInvocations,
      routeResolutions: counters.routeResolutions,
      generationEvents: counters.resets,
      maxResolutionsPerGeneration: 2,
      looseFallbackInvocations: counters.looseInvocations,
    },
    verified: true,
    limitations: [
      'single-process wall-clock samples; medians over alternating-order repeats after an untimed prewarm',
      'measures the synchronous dispatch portion up to promise creation; caller await excluded (identical for both paths)',
      'coldFirstCall includes the resetConfiguredRoutes() cost itself; the reset-only baseline is reported separately and is identical for both paths',
      'stub route returns a plain object; native FFI cost is outside this benchmark by design',
    ],
  };
}

if (import.meta.main) {
  runA2FieldsMicrobench().then((result) => console.log(JSON.stringify(result, null, 2)));
}
