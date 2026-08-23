import React, { useEffect, useState } from 'react';
import { Platform, StyleSheet, Text, View, ScrollView } from 'react-native';
import { NitroModules } from 'react-native-nitro-modules';
import type { NitroBench } from 'nitro-bench';
import { configure } from '@rustra/types';
import {
  addNumbers,
  greet,
  sumList,
  toUpper,
  isEven,
  createItem,
  processItem,
  multiply,
  clamp,
  benchAdd,
  benchEchoString,
  benchEchoBytes,
  benchEchoPair,
  channelDemo,
  resourceOpen,
  resourceRead,
  resourceWrite,
  resourceClose,
} from '../calculator/generated/commands';
// ── Benchmark internals (not part of user-facing API) ───────
import { installRustraJSI, getRustraNative } from 'rustra-jsi';
import RustraCalculator, { invokeCommand as invokeFfiCommand } from 'rustra-calculator';
import { createBincodeEngine, bincodeRegistry } from './src/adapters/bincode-adapter';
import { createJsonEngine } from './src/adapters/json-adapter';
import { createMsgpackEngine } from './src/adapters/msgpack-adapter';
import { createPostcardEngine, postcardRegistry } from './src/adapters/postcard-adapter';
import { createRkyvEngine } from './src/adapters/rkyv-adapter';
import { createHybridEngine, hybridRegistry } from './src/adapters/hybrid-adapter';
import { createRkyvV2Engine, rkyvV2Registry } from './src/adapters/rkyv-v2-adapter';
import { decodeUtf8, encodeUtf8, exactArrayBuffer } from './src/utf8';
// ── End benchmark internals ─────────────────────────────────

// ── Helpers ──────────────────────────────────────────────

function bar(value: number, max: number, width = 25): string {
  const filled = Math.max(1, Math.round((value / max) * width));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function formatNs(ns: number): string {
  if (ns >= 1_000_000) return `${(ns / 1_000_000).toFixed(2)} ms`;
  if (ns >= 1_000) return `${(ns / 1_000).toFixed(1)} µs`;
  return `${ns.toFixed(0)} ns`;
}

type BenchResult = {
  label: string;
  avg: number;
  stddev: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  ops: number;
  batchMeans: number[];
};

function summarize(label: string, samples: number[]): BenchResult {
  const times = [...samples].sort((a, b) => a - b);
  const avg = times.reduce((sum, time) => sum + time, 0) / times.length;
  const variance = times.reduce((sum, time) => sum + (time - avg) ** 2, 0) / times.length;
  const at = (percentile: number) =>
    times[Math.min(Math.floor(times.length * percentile), times.length - 1)];
  const batchSize = Math.max(1, Math.ceil(samples.length / 100));
  const batchMeans: number[] = [];
  for (let start = 0; start < samples.length; start += batchSize) {
    const batch = samples.slice(start, start + batchSize);
    batchMeans.push(batch.reduce((sum, time) => sum + time, 0) / batch.length);
  }
  return {
    label,
    avg,
    stddev: Math.sqrt(variance),
    min: times[0],
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: times[times.length - 1],
    ops: 1_000_000_000 / avg,
    batchMeans,
  };
}

function measureSync(label: string, fn: () => void, iterations = 100_000): BenchResult {
  // warmup
  for (let i = 0; i < 1000; i++) fn();

  const times: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    fn();
    times.push((performance.now() - start) * 1_000_000);
  }
  return summarize(label, times);
}

async function measure(
  label: string,
  fn: () => Promise<unknown>,
  iterations = 10_000,
): Promise<BenchResult> {
  for (let i = 0; i < 500; i++) await fn();

  const times: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await fn();
    times.push((performance.now() - start) * 1_000_000);
  }
  return summarize(label, times);
}

type InterleavedCase = {
  key: string;
  label: string;
  run: () => Promise<unknown>;
};

/**
 * 비교 대상을 호출 단위로 순환한다: ABC → BCA → CAB. 항상 한 구현을 먼저
 * 재는 순서 편향과 장시간 연속 측정의 thermal/GC drift를 모든 대상에 나눈다.
 */
async function measureInterleaved(
  cases: InterleavedCase[],
  iterations = 10_000,
  warmupIterations = 500,
): Promise<Record<string, BenchResult>> {
  const samples = new Map(cases.map((entry) => [entry.key, [] as number[]]));
  const runRound = async (round: number, record: boolean) => {
    const startIndex = round % cases.length;
    for (let offset = 0; offset < cases.length; offset += 1) {
      const entry = cases[(startIndex + offset) % cases.length];
      const start = performance.now();
      await entry.run();
      if (record) samples.get(entry.key)!.push((performance.now() - start) * 1_000_000);
    }
  };

  for (let round = 0; round < warmupIterations; round += 1) await runRound(round, false);
  for (let round = 0; round < iterations; round += 1) await runRound(round, true);

  return Object.fromEntries(
    cases.map((entry) => [entry.key, summarize(entry.label, samples.get(entry.key)!)]),
  );
}

// ── Benchmark Runner ─────────────────────────────────────

async function runBenchmarks(): Promise<string[]> {
  const lines: string[] = [];
  const log = (s: string) => lines.push(s);

  if (__DEV__) {
    log('Benchmark disabled in Debug: performance receipts require a Release build.');
    log('Run: bunx --bun expo run:ios --configuration Release');
    return lines;
  }

  log('Installing JSI...');
  try {
    await installRustraJSI();
  } catch (e: any) {
    log(`JSI install failed: ${e.message}`);
    return lines;
  }
  log('JSI installed, getting native...');
  const native = getRustraNative();

  // ══════════════════════════════════════════════════════
  // DX example: how users would set up rustra in their app
  // ─────────────────────────────────────────────────────
  //   import { configure } from "@rustra/types";
  //   import { createRkyvV2Engine } from "./src/adapters/rkyv-v2-adapter";
  //   import { installRustraJSI, getRustraNative } from "./modules/rustra-jsi/src";
  //
  //   await installRustraJSI();
  //   configure(createRkyvV2Engine(getRustraNative()));
  //
  //   // Then use generated commands anywhere:
  //   const result = await addNumbers({ a: 42, b: 58 });
  // ══════════════════════════════════════════════════════

  const jsonEngine = createJsonEngine(native);
  const msgpackEngine = createMsgpackEngine(native);
  const postcardEngine = createPostcardEngine(native, postcardRegistry);
  const rkyvEngine = createRkyvEngine(native);
  const hybridEngine = createHybridEngine(native, hybridRegistry);
  const bincodeEngine = createBincodeEngine(native, bincodeRegistry);
  const rkyvV2Engine = createRkyvV2Engine(native);

  const nitroBench = NitroModules.createHybridObject<NitroBench>('NitroBench');

  const INPUT = { a: 42, b: 58 };

  // ══════════════════════════════════════════════════════
  log('╔════════════════════════════════════════════════╗');
  log('║  rustra rkyv V2 — Multi-Tier Benchmark        ║');
  log('╚════════════════════════════════════════════════╝');
  log('');

  // ── Correctness verification ──────────────────────────
  log('┌─ Tier 1: Fixed-width primitives ─────────────┐');
  const adapters = [
    { name: 'JSON', engine: jsonEngine },
    { name: 'Msgpack', engine: msgpackEngine },
    { name: 'Postcard', engine: postcardEngine },
    { name: 'rkyv', engine: rkyvEngine },
    { name: 'Hybrid', engine: hybridEngine },
    { name: 'Bincode', engine: bincodeEngine },
    { name: 'rkyvV2', engine: rkyvV2Engine },
  ];

  for (const { name, engine } of adapters) {
    configure(engine);
    try {
      const r = await addNumbers(INPUT);
      const v = r.value === 100 ? '✓' : `✗ got ${r.value}`;
      log(`│  ${name.padEnd(10)} addNumbers(42,58)=100 ${v}`);
    } catch (e: any) {
      log(`│  ${name.padEnd(10)} FAIL ${String(e).slice(0, 40)}`);
    }
  }

  configure(rkyvV2Engine);
  try {
    const even = await isEven({ n: 42 });
    log(`│  rkyvV2    isEven(42)=true    ${even.result === true ? '✓' : '✗'}`);
  } catch (e: any) {
    log(`│  isEven FAIL ${String(e).slice(0, 40)}`);
  }

  try {
    const mul = await multiply({ a: 3.14, b: 2.0 });
    log(`│  rkyvV2    multiply(3.14,2)=6.28 ${Math.abs(mul.value - 6.28) < 0.01 ? '✓' : '✗'}`);
  } catch (e: any) {
    log(`│  multiply FAIL ${String(e).slice(0, 40)}`);
  }
  log('└───────────────────────────────────────────────┘');
  log('');

  // ── Tier 2 verification ──────────────────────────────
  log('┌─ Tier 2: String / Vec<primitive> ─────────────┐');
  configure(rkyvV2Engine);
  try {
    const g = await greet({ name: 'Rustra' });
    log(`│  greet("Rustra")="${g.message}" ${g.message === 'Hello, Rustra!' ? '✓' : '✗'}`);
  } catch (e: any) {
    log(`│  greet FAIL ${String(e).slice(0, 40)}`);
  }

  try {
    const s = await sumList({ numbers: [1, 2, 3, 4, 5] });
    log(
      `│  sumList([1..5]) total=${s.total} count=${s.count} ${s.total === 15 && s.count === 5 ? '✓' : '✗'}`,
    );
  } catch (e: any) {
    log(`│  sumList FAIL ${String(e).slice(0, 40)}`);
  }

  try {
    const u = await toUpper({ s: 'hello' });
    log(`│  toUpper("hello")="${u.result}" ${u.result === 'HELLO' ? '✓' : '✗'}`);
  } catch (e: any) {
    log(`│  toUpper FAIL ${String(e).slice(0, 40)}`);
  }
  log('└───────────────────────────────────────────────┘');
  log('');

  // ── Tier 3 verification ──────────────────────────────
  log('┌─ Tier 3: Nested structs (JSON fallback) ──────┐');
  configure(rkyvV2Engine);
  try {
    const ci = await createItem({ name: 'Widget', value: 42 });
    const ok = ci.item.name === 'Widget' && ci.item.value === 42 && ci.item.active === true;
    log(`│  createItem("Widget",42) ${ok ? '✓' : '✗'}`);
  } catch (e: any) {
    log(`│  createItem FAIL ${String(e).slice(0, 40)}`);
  }

  try {
    const pi = await processItem({ item: { name: 'Gadget', value: 200, active: true } });
    const ok = pi.item.value === 400 && pi.doubled === true;
    log(`│  processItem(Gadget,200) val=${pi.item.value} dbl=${pi.doubled} ${ok ? '✓' : '✗'}`);
  } catch (e: any) {
    log(`│  processItem FAIL ${String(e).slice(0, 40)}`);
  }
  log('└───────────────────────────────────────────────┘');
  log('');

  // ══════════════════════════════════════════════════════
  // Performance: Micro-benchmarks (sync, 100K iterations)
  // ══════════════════════════════════════════════════════
  log('╔════════════════════════════════════════════════╗');
  log('║  Micro-bench: Sync steps (100K iter)          ║');
  log('╠════════════════════════════════════════════════╣');

  const codec = rkyvV2Registry.get('addNumbers')!;

  // 1. Pure encode
  const encodeBench = measureSync('rkyvV2 encode', () => codec.encode(INPUT));
  log(
    `│  encode   avg: ${formatNs(encodeBench.avg).padStart(10)}  p50: ${formatNs(encodeBench.p50)}`,
  );

  // 2. Pure JSI call (pre-encoded payload)
  const preEncoded = codec.encode(INPUT);
  const jsiBench = measureSync('rkyvV2 JSI', () => native.invokeRkyvV2(preEncoded));
  log(`│  JSI call avg: ${formatNs(jsiBench.avg).padStart(10)}  p50: ${formatNs(jsiBench.p50)}`);

  // 3. Pure decode (pre-encoded response)
  const preResponse = native.invokeRkyvV2(preEncoded);
  const decodeBench = measureSync('rkyvV2 decode', () => codec.decode(preResponse));
  log(
    `│  decode   avg: ${formatNs(decodeBench.avg).padStart(10)}  p50: ${formatNs(decodeBench.p50)}`,
  );

  // 4. Full encode+JSI+decode (sync, no Promise)
  const fullSyncBench = measureSync('rkyvV2 full sync', () => {
    const p = codec.encode(INPUT);
    const r = native.invokeRkyvV2(p);
    return codec.decode(r);
  });
  log(
    `│  full sync avg: ${formatNs(fullSyncBench.avg).padStart(10)}  p50: ${formatNs(fullSyncBench.p50)}`,
  );

  // (Tier 1/2) 최적화 경로 측정 — positional 진입(invokeTypedPos)은 인자 객체
  // 생성/JS 코덱 encode 를 통째로 건너뛴다. cmd_id 는 codec.commandId(=1).
  if (typeof native.invokeTypedPos === 'function') {
    const posBench = measureSync('rkyvV2 pos', () => {
      return (
        native as { invokeTypedPos(id: number, a: number, b: number): unknown }
      ).invokeTypedPos(codec.commandId, INPUT.a, INPUT.b);
    });
    log(`│  pos full avg: ${formatNs(posBench.avg).padStart(10)}  p50: ${formatNs(posBench.p50)}`);
    // 주성분 분해 — full sync 대비 절감 = (encode+객체생성) 비용.
    const saved = fullSyncBench.avg - posBench.avg;
    log(`│  pos saves avg: ${formatNs(Math.max(0, saved)).padStart(9)} (encode+obj-alloc 제거)`);
  }
  // byId 경로(객체 인자 유지, 코어 caller-buffer受益) — Tier 1 _into 효과 격리.
  if (typeof native.invokeTypedById === 'function') {
    const byIdBench = measureSync('rkyvV2 byId', () => {
      return (native as { invokeTypedById(id: number, args: unknown): unknown }).invokeTypedById(
        codec.commandId,
        INPUT,
      );
    });
    log(
      `│  byId full avg: ${formatNs(byIdBench.avg).padStart(9)}  p50: ${formatNs(byIdBench.p50)}`,
    );
  }

  // 5. JSON encode
  const jsonEncodeBench = measureSync('JSON encode', () => {
    JSON.stringify({ command: 'addNumbers', args: INPUT });
  });
  log(
    `│  JSON enc avg: ${formatNs(jsonEncodeBench.avg).padStart(10)}  p50: ${formatNs(jsonEncodeBench.p50)}`,
  );

  // 6. JSON JSI call
  const jsonPayload = encodeUtf8(JSON.stringify({ command: 'addNumbers', args: INPUT }));
  const jsonPayloadBuffer = exactArrayBuffer(jsonPayload);
  const jsonJsiBench = measureSync('JSON JSI', () => native.invoke(jsonPayloadBuffer));
  log(
    `│  JSON JSI avg: ${formatNs(jsonJsiBench.avg).padStart(10)}  p50: ${formatNs(jsonJsiBench.p50)}`,
  );

  // 7. JSON decode
  const jsonResponse = native.invoke(jsonPayloadBuffer);
  const jsonDecodeBench = measureSync('JSON decode', () => {
    const s = decodeUtf8(jsonResponse);
    JSON.parse(s);
  });
  log(
    `│  JSON dec avg: ${formatNs(jsonDecodeBench.avg).padStart(10)}  p50: ${formatNs(jsonDecodeBench.p50)}`,
  );

  const jsonFullSync = measureSync('JSON full sync', () => {
    const json = JSON.stringify({ command: 'addNumbers', args: INPUT });
    const p = exactArrayBuffer(encodeUtf8(json));
    const r = native.invoke(p);
    const s = decodeUtf8(r);
    JSON.parse(s);
  });
  log(
    `│  JSON full avg: ${formatNs(jsonFullSync.avg).padStart(10)}  p50: ${formatNs(jsonFullSync.p50)}`,
  );

  log('╚════════════════════════════════════════════════╝');
  log('');

  // ══════════════════════════════════════════════════════
  // Performance: Async full-path (10K iterations)
  // ══════════════════════════════════════════════════════
  log('╔════════════════════════════════════════════════╗');
  log('║  Async full-path: addNumbers (10K iter)       ║');
  log('╠════════════════════════════════════════════════╣');

  const nitroResult = await measure('Nitro raw lower bound', () =>
    Promise.resolve(nitroBench.add(42, 58)),
  );
  log(
    `│  NitroRaw avg: ${formatNs(nitroResult.avg).padStart(10)}  p50: ${formatNs(nitroResult.p50)}  (no ratio)`,
  );

  const noopPayload = exactArrayBuffer(
    encodeUtf8('{"command":"addNumbers","args":{"a":42,"b":58}}'),
  );
  const noopResult = await measure('JSI noop', () => Promise.resolve(native.noop(noopPayload)));
  log(
    `│  JSInoop  avg: ${formatNs(noopResult.avg).padStart(10)}  p50: ${formatNs(noopResult.p50)}  p99: ${formatNs(noopResult.p99)}`,
  );

  configure(jsonEngine);
  const jsonResult = await measure('JSON', () => addNumbers(INPUT));

  log(
    `│  JSON     avg: ${formatNs(jsonResult.avg).padStart(10)}  p50: ${formatNs(jsonResult.p50)}  p99: ${formatNs(jsonResult.p99)}`,
  );

  configure(rkyvV2Engine);
  const rkyvV2Result = await measure('rkyvV2', () => addNumbers(INPUT));
  log(
    `│  rkyvV2   avg: ${formatNs(rkyvV2Result.avg).padStart(10)}  p50: ${formatNs(rkyvV2Result.p50)}  p99: ${formatNs(rkyvV2Result.p99)}`,
  );

  let ffiSyncResult: BenchResult | undefined;
  let ffiAsyncValue: { value: number } | undefined;
  if (Platform.OS === 'ios') {
    try {
      const syncValue = RustraCalculator.addSync(42, 58);
      if (syncValue !== 100) {
        throw new Error(`Swift FFI addSync expected 100, got ${syncValue}`);
      }
      ffiSyncResult = measureSync(
        'Swift FFI sync',
        () => {
          RustraCalculator.addSync(42, 58);
        },
        10_000,
      );

      const asyncValue = await invokeFfiCommand('benchAdd', INPUT);
      if (
        typeof asyncValue !== 'object' ||
        asyncValue === null ||
        !('value' in asyncValue) ||
        asyncValue.value !== 100
      ) {
        throw new Error('Swift FFI invokeRaw returned an invalid benchAdd result');
      }
      ffiAsyncValue = asyncValue as { value: number };
      log(
        `│  FFI sync avg: ${formatNs(ffiSyncResult.avg).padStart(10)}  p50: ${formatNs(ffiSyncResult.p50)}  (scalar lower bound; no ratio)`,
      );
      log('│  FFI async: included in the interleaved equivalent-op suite below');
    } catch (error: unknown) {
      log(`│  Swift FFI unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    log('│  Swift FFI skipped: iOS-only comparison module');
  }

  log('╚════════════════════════════════════════════════╝');
  log('');

  // ── Tier 2 performance ─────────────────────────────
  log('╔════════════════════════════════════════════════╗');
  log('║  Tier 2 (String): greet (10K iter)            ║');
  log('╠════════════════════════════════════════════════╣');

  configure(rkyvV2Engine);
  const greetRkyvV2 = await measure('greet rkyvV2', () => greet({ name: 'World' }));
  log(
    `│  rkyvV2   avg: ${formatNs(greetRkyvV2.avg).padStart(10)}  p50: ${formatNs(greetRkyvV2.p50)}  p99: ${formatNs(greetRkyvV2.p99)}`,
  );

  configure(jsonEngine);
  const greetJson = await measure('greet JSON', () => greet({ name: 'World' }));
  log(
    `│  JSON     avg: ${formatNs(greetJson.avg).padStart(10)}  p50: ${formatNs(greetJson.p50)}  p99: ${formatNs(greetJson.p99)}`,
  );

  log('╚════════════════════════════════════════════════╝');
  log('');

  // ── 동등 조건 페이로드 비교 ──────────────────────────
  // 같은 JS 객체 모양, 같은 echo/add 연산, 같은 반환 모양을 호출 단위 순환
  // 측정한다. Nitro 원시 add(a,b)는 별도 lower bound일 뿐 ratio에 쓰지 않는다.
  log('╔════════════════════════════════════════════════╗');
  log('║  Equivalent ops: Nitro/rkyvV2/FFI (10K)      ║');
  log('╠════════════════════════════════════════════════╣');

  const nitroRaw = await measure('nitro raw add', () => Promise.resolve(nitroBench.add(42, 58)));
  log(`│  raw Nitro add(a,b) lower bound: ${formatNs(nitroRaw.avg).padStart(10)}`);

  const stringPayload = { value: 'benchmark-string-payload' };
  const bytesPayload = { data: Array.from({ length: 64 }, (_, i) => i & 0xff) };
  const byteBufferPayload = {
    data: Uint8Array.from(bytesPayload.data).buffer,
  };
  const makeByteBufferPayload = (size: number) => {
    const data = new Uint8Array(size);
    for (let index = 0; index < size; index += 1) data[index] = index & 0xff;
    return { data: data.buffer };
  };
  const asByteView = (data: ArrayBuffer | ArrayBufferView | ArrayLike<number>) =>
    data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : Uint8Array.from(data);
  const byteViewsEqual = (left: Uint8Array, right: Uint8Array) => {
    if (left.byteLength !== right.byteLength) return false;
    for (let index = 0; index < left.byteLength; index += 1) {
      if (left[index] !== right[index]) return false;
    }
    return true;
  };
  const normalizeBytes = (value: { data: ArrayBuffer | ArrayBufferView | ArrayLike<number> }) => ({
    data: Array.from(asByteView(value.data)),
  });
  const pairPayload = { name: 'widget', value: 42 };

  // 수치보다 먼저 정답과 공개 결과 shape를 확인한다. 하나라도 다르면 timing을
  // 시작하지 않아 서로 다른 작업의 ratio가 로그에 남지 않는다.
  const nitroAddValue = nitroBench.benchAdd(INPUT);
  configure(rkyvV2Engine);
  const rustraAddValue = await benchAdd(INPUT);
  const nitroStringValue = nitroBench.echoString(stringPayload);
  const rustraStringValue = await benchEchoString(stringPayload);
  const nitroBytesValue = normalizeBytes(nitroBench.echoBuffer(byteBufferPayload));
  const rustraBytesValue = normalizeBytes(await benchEchoBytes(byteBufferPayload));
  const nitroPairValue = nitroBench.echoPair(pairPayload);
  const rustraPairValue = await benchEchoPair(pairPayload);

  let ffiStringValue: { value: string } | undefined;
  let ffiBytesValue: { data: number[] } | undefined;
  let ffiPairValue: { name: string; value: number } | undefined;
  let ffiSuiteAvailable = Platform.OS === 'ios' && ffiAsyncValue !== undefined;
  if (ffiSuiteAvailable) {
    try {
      ffiStringValue = (await invokeFfiCommand('benchEchoString', stringPayload)) as {
        value: string;
      };
      ffiBytesValue = normalizeBytes(
        (await invokeFfiCommand('benchEchoBytes', bytesPayload)) as { data: ArrayLike<number> },
      );
      ffiPairValue = (await invokeFfiCommand('benchEchoPair', pairPayload)) as {
        name: string;
        value: number;
      };
    } catch (error: unknown) {
      ffiSuiteAvailable = false;
      log(
        `│  Swift FFI correctness failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const rustraNitroOutputsEquivalent =
    nitroAddValue.value === rustraAddValue.value &&
    nitroStringValue.value === rustraStringValue.value &&
    Array.isArray(nitroBytesValue.data) &&
    Array.isArray(rustraBytesValue.data) &&
    JSON.stringify(nitroBytesValue.data) === JSON.stringify(rustraBytesValue.data) &&
    nitroPairValue.name === rustraPairValue.name &&
    nitroPairValue.value === rustraPairValue.value;
  const ffiOutputsEquivalent =
    Platform.OS !== 'ios' ||
    (ffiSuiteAvailable &&
      ffiAsyncValue?.value === rustraAddValue.value &&
      ffiStringValue?.value === rustraStringValue.value &&
      JSON.stringify(ffiBytesValue?.data) === JSON.stringify(rustraBytesValue.data) &&
      ffiPairValue?.name === rustraPairValue.name &&
      ffiPairValue?.value === rustraPairValue.value);
  const equivalentOutputs = rustraNitroOutputsEquivalent && ffiOutputsEquivalent;
  if (!equivalentOutputs) {
    throw new Error('Nitro/rustra/FFI equivalent benchmark returned different outputs');
  }
  log('│  equivalent outputs checked before timing: ✓');

  const measureEquivalent = async (
    operation: string,
    nitro: () => Promise<unknown>,
    rustra: () => Promise<unknown>,
    iterations = 10_000,
    warmupIterations = 500,
  ) => {
    return measureInterleaved(
      [
        { key: 'nitro', label: `nitro ${operation}`, run: nitro },
        { key: 'rustra', label: `rustra ${operation}`, run: rustra },
      ],
      iterations,
      warmupIterations,
    );
  };

  configure(rkyvV2Engine);
  const addResults = await measureEquivalent(
    'add',
    () => Promise.resolve(nitroBench.benchAdd(INPUT)),
    () => benchAdd(INPUT),
  );
  const stringResults = await measureEquivalent(
    'string',
    () => Promise.resolve(nitroBench.echoString(stringPayload)),
    () => benchEchoString(stringPayload),
  );
  const bytesResults = await measureEquivalent(
    'buffer64',
    () => Promise.resolve(nitroBench.echoBuffer(byteBufferPayload)),
    () => benchEchoBytes(byteBufferPayload),
  );
  const pairResults = await measureEquivalent(
    'pair',
    () => Promise.resolve(nitroBench.echoPair(pairPayload)),
    () => benchEchoPair(pairPayload),
  );

  // FFI is an order of magnitude slower and schedules through Swift/Promise.
  // Mixing it into the sub-4us Nitro/rustra lane changes their GC/microtask
  // environment. Keep an independent, still-interleaved Nitro/FFI lane so
  // both comparisons remain equivalent without cross-contaminating the fast
  // bridge gate.
  const measureFfiEquivalent = (
    operation: string,
    nitro: () => Promise<unknown>,
    ffi: () => Promise<unknown>,
  ) =>
    measureInterleaved([
      { key: 'nitro', label: `nitro ${operation} (FFI lane)`, run: nitro },
      { key: 'ffi', label: `ffi ${operation}`, run: ffi },
    ]);

  const ffiAddResults = ffiSuiteAvailable
    ? await measureFfiEquivalent(
        'add',
        () => Promise.resolve(nitroBench.benchAdd(INPUT)),
        () => invokeFfiCommand('benchAdd', INPUT),
      )
    : undefined;
  const ffiStringResults = ffiSuiteAvailable
    ? await measureFfiEquivalent(
        'string',
        () => Promise.resolve(nitroBench.echoString(stringPayload)),
        () => invokeFfiCommand('benchEchoString', stringPayload),
      )
    : undefined;
  const ffiBytesResults = ffiSuiteAvailable
    ? await measureFfiEquivalent(
        'bytes64',
        () => Promise.resolve(normalizeBytes(nitroBench.echoBytes(bytesPayload))),
        () => invokeFfiCommand('benchEchoBytes', bytesPayload),
      )
    : undefined;
  const ffiPairResults = ffiSuiteAvailable
    ? await measureFfiEquivalent(
        'pair',
        () => Promise.resolve(nitroBench.echoPair(pairPayload)),
        () => invokeFfiCommand('benchEchoPair', pairPayload),
      )
    : undefined;

  const nitroAdd = addResults.nitro;
  const rustraAdd = addResults.rustra;
  const ffiAsyncResult = ffiAddResults?.ffi;
  const ffiNitroAdd = ffiAddResults?.nitro;
  const nitroStr = stringResults.nitro;
  const rustraStr = stringResults.rustra;
  const ffiStr = ffiStringResults?.ffi;
  const ffiNitroStr = ffiStringResults?.nitro;
  const nitroBuf = bytesResults.nitro;
  const rustraBuf = bytesResults.rustra;
  const ffiBuf = ffiBytesResults?.ffi;
  const ffiNitroBuf = ffiBytesResults?.nitro;
  const nitroPair = pairResults.nitro;
  const rustraPair = pairResults.rustra;
  const ffiPair = ffiPairResults?.ffi;
  const ffiNitroPair = ffiPairResults?.nitro;
  const byteSizeResults: Record<
    string,
    {
      sizeBytes: number;
      iterations: number;
      nitro: BenchResult;
      rustra: BenchResult;
      ratio: number;
    }
  > = {
    bytes64: {
      sizeBytes: 64,
      iterations: 10_000,
      nitro: nitroBuf,
      rustra: rustraBuf,
      ratio: rustraBuf.avg / nitroBuf.avg,
    },
  };

  // 공개 generated helper와 그 helper가 최종 선택한 native route를 같은
  // 호출 단위로 교차 측정한다. 이 값은 Nitro 비교 ratio가 아니라 남은 비용을
  // JS routing과 native codec/FFI로 나누기 위한 진단 lower bound다.
  let generatedRouteDiagnostics:
    | Record<string, { native: BenchResult; generated: BenchResult; generatedToNative: number }>
    | undefined;
  if (
    native.invokeTypedRaw &&
    native.invokeTypedPos &&
    native.invokeTypedById &&
    native.invokeTypedBuffer
  ) {
    const routeCases = async (
      operation: string,
      direct: () => Promise<unknown>,
      generated: () => Promise<unknown>,
    ) => {
      const measured = await measureInterleaved([
        { key: 'native', label: `${operation} native route`, run: direct },
        { key: 'generated', label: `${operation} generated helper`, run: generated },
      ]);
      return {
        native: measured.native,
        generated: measured.generated,
        generatedToNative: measured.generated.avg / measured.native.avg,
      };
    };
    generatedRouteDiagnostics = {
      add: await routeCases(
        'add',
        () => Promise.resolve(native.invokeTypedRaw!(23, 42, 58)),
        () => benchAdd(INPUT),
      ),
      string: await routeCases(
        'string',
        () => Promise.resolve(native.invokeTypedPos!(24, stringPayload.value)),
        () => benchEchoString(stringPayload),
      ),
      bytes64: await routeCases(
        'buffer64',
        () => Promise.resolve(native.invokeTypedBuffer!(25, byteBufferPayload.data)),
        () => benchEchoBytes(byteBufferPayload),
      ),
      pair: await routeCases(
        'pair',
        () => Promise.resolve(native.invokeTypedPos!(26, pairPayload.name, pairPayload.value)),
        () => benchEchoPair(pairPayload),
      ),
    };
    for (const [operation, result] of Object.entries(generatedRouteDiagnostics)) {
      console.log(
        `RUSTRA_ROUTE_OP_JSON=${JSON.stringify({
          operation,
          nativeAvgNs: result.native.avg,
          generatedAvgNs: result.generated.avg,
          generatedToNative: result.generatedToNative,
        })}`,
      );
    }
  }

  // Copy cost changes with payload size. Keep total moved bytes bounded while
  // proving the same fresh-output ownership contract at 64 KiB and 1 MiB.
  for (const byteCase of [
    { key: 'bytes64KiB', sizeBytes: 64 * 1024, iterations: 500, warmupIterations: 50 },
    // cmd_id(2 B) + postcard uvar length(3 B) + data = exactly the default
    // 1 MiB request limit. A full 1 MiB data buffer correctly fails closed.
    { key: 'bytes1MiBWire', sizeBytes: 1024 * 1024 - 5, iterations: 50, warmupIterations: 5 },
  ]) {
    const payload = makeByteBufferPayload(byteCase.sizeBytes);
    const nitroValue = nitroBench.echoBuffer(payload);
    const rustraValue = await benchEchoBytes(payload);
    if (!byteViewsEqual(asByteView(nitroValue.data), asByteView(rustraValue.data))) {
      throw new Error(`${byteCase.key} Nitro/rustra outputs differ before timing`);
    }
    const measured = await measureEquivalent(
      byteCase.key,
      () => Promise.resolve(nitroBench.echoBuffer(payload)),
      () => benchEchoBytes(payload),
      byteCase.iterations,
      byteCase.warmupIterations,
    );
    byteSizeResults[byteCase.key] = {
      sizeBytes: byteCase.sizeBytes,
      iterations: byteCase.iterations,
      nitro: measured.nitro,
      rustra: measured.rustra,
      ratio: measured.rustra.avg / measured.nitro.avg,
    };
  }
  for (const [operation, result] of Object.entries(byteSizeResults)) {
    console.log(
      `RUSTRA_BYTES_OP_JSON=${JSON.stringify({
        operation,
        sizeBytes: result.sizeBytes,
        iterations: result.iterations,
        nitroAvgNs: result.nitro.avg,
        rustraAvgNs: result.rustra.avg,
        rustraToNitro: result.ratio,
      })}`,
    );
  }

  const logResult = (prefix: string, result: BenchResult) =>
    log(
      `│  ${prefix.padEnd(11)} avg ${formatNs(result.avg).padStart(9)}  p50 ${formatNs(result.p50).padStart(9)}  p95 ${formatNs(result.p95).padStart(9)}  p99 ${formatNs(result.p99).padStart(9)}`,
    );
  logResult('add Nitro', nitroAdd);
  logResult('add rustra', rustraAdd);
  logResult('str Nitro', nitroStr);
  logResult('str rustra', rustraStr);
  logResult('buf Nitro', nitroBuf);
  logResult('buf rustra', rustraBuf);
  logResult('obj Nitro', nitroPair);
  logResult('obj rustra', rustraPair);
  if (ffiSuiteAvailable && ffiAsyncResult && ffiStr && ffiBuf && ffiPair) {
    logResult('add FFI', ffiAsyncResult);
    logResult('str FFI', ffiStr);
    logResult('buf FFI', ffiBuf);
    logResult('obj FFI', ffiPair);
  }

  log('│');
  log(`│  add  rustra/Nitro = ${(rustraAdd.avg / nitroAdd.avg).toFixed(2)}x`);
  log(`│  str  rustra/Nitro = ${(rustraStr.avg / nitroStr.avg).toFixed(2)}x`);
  log(`│  buf  rustra/Nitro = ${(rustraBuf.avg / nitroBuf.avg).toFixed(2)}x`);
  log(`│  obj  rustra/Nitro = ${(rustraPair.avg / nitroPair.avg).toFixed(2)}x`);
  if (
    ffiSuiteAvailable &&
    ffiAsyncResult &&
    ffiStr &&
    ffiBuf &&
    ffiPair &&
    ffiNitroAdd &&
    ffiNitroStr &&
    ffiNitroBuf &&
    ffiNitroPair
  ) {
    log('│');
    log(`│  add  FFI/Nitro    = ${(ffiAsyncResult.avg / ffiNitroAdd.avg).toFixed(2)}x`);
    log(`│  str  FFI/Nitro    = ${(ffiStr.avg / ffiNitroStr.avg).toFixed(2)}x`);
    log(`│  buf  FFI/Nitro    = ${(ffiBuf.avg / ffiNitroBuf.avg).toFixed(2)}x`);
    log(`│  obj  FFI/Nitro    = ${(ffiPair.avg / ffiNitroPair.avg).toFixed(2)}x`);
  }
  log('╚════════════════════════════════════════════════╝');
  log('');

  const equivalentBenchmarkReceipt = {
    schemaVersion: 4,
    generatedAt: new Date().toISOString(),
    platform: Platform.OS,
    platformVersion: String(Platform.Version),
    buildMode: 'release',
    jsEngine:
      typeof (globalThis as Record<string, unknown>).HermesInternal === 'object'
        ? 'hermes'
        : 'unknown',
    iterations: 10_000,
    warmupIterations: 500,
    order: 'rotating-interleaved',
    correctness: { equivalentOutputs, checkedBeforeTiming: true },
    rawLowerBound: { nitroAdd: nitroRaw, generatedRoutes: generatedRouteDiagnostics },
    equivalent: {
      add: { nitro: nitroAdd, rustra: rustraAdd, ratio: rustraAdd.avg / nitroAdd.avg },
      string: { nitro: nitroStr, rustra: rustraStr, ratio: rustraStr.avg / nitroStr.avg },
      bytes64: { nitro: nitroBuf, rustra: rustraBuf, ratio: rustraBuf.avg / nitroBuf.avg },
      pair: { nitro: nitroPair, rustra: rustraPair, ratio: rustraPair.avg / nitroPair.avg },
    },
    byteSizes: byteSizeResults,
    ffi:
      Platform.OS === 'ios'
        ? {
            available: ffiSuiteAvailable,
            syncScalarLowerBound: ffiSyncResult,
            nitroReference: ffiSuiteAvailable
              ? {
                  add: ffiNitroAdd,
                  string: ffiNitroStr,
                  bytes64: ffiNitroBuf,
                  pair: ffiNitroPair,
                }
              : undefined,
            equivalent: ffiSuiteAvailable
              ? {
                  add: ffiAsyncResult,
                  string: ffiStr,
                  bytes64: ffiBuf,
                  pair: ffiPair,
                }
              : undefined,
          }
        : { available: false, reason: 'iOS-only Swift Expo module' },
  };
  const bytes64KiBReceipt = equivalentBenchmarkReceipt.byteSizes.bytes64KiB;
  const bytes1MiBWireReceipt = equivalentBenchmarkReceipt.byteSizes.bytes1MiBWire;
  lines.unshift(
    `RESULT equivalent=${equivalentOutputs ? '✓' : '✗'} ffi=${Platform.OS === 'ios' ? (ffiSuiteAvailable ? '✓' : '✗') : 'skipped'} add=${equivalentBenchmarkReceipt.equivalent.add.ratio.toFixed(4)}x str=${equivalentBenchmarkReceipt.equivalent.string.ratio.toFixed(4)}x buf=${equivalentBenchmarkReceipt.equivalent.bytes64.ratio.toFixed(4)}x obj=${equivalentBenchmarkReceipt.equivalent.pair.ratio.toFixed(4)}x`,
    `BYTES 64KiB nitro=${bytes64KiBReceipt.nitro.avg.toFixed(3)}ns rustra=${bytes64KiBReceipt.rustra.avg.toFixed(3)}ns ratio=${bytes64KiBReceipt.ratio.toFixed(4)}x`,
    `BYTES 1MiB-wire nitro=${bytes1MiBWireReceipt.nitro.avg.toFixed(3)}ns rustra=${bytes1MiBWireReceipt.rustra.avg.toFixed(3)}ns ratio=${bytes1MiBWireReceipt.ratio.toFixed(4)}x`,
    '',
  );
  console.log(`RUSTRA_NITRO_JSON=${JSON.stringify(equivalentBenchmarkReceipt)}`);
  console.log(`RUSTRA_FFI_JSON=${JSON.stringify(equivalentBenchmarkReceipt.ffi)}`);
  console.log(
    `RUSTRA_NITRO_META_JSON=${JSON.stringify({
      schemaVersion: equivalentBenchmarkReceipt.schemaVersion,
      generatedAt: equivalentBenchmarkReceipt.generatedAt,
      platform: equivalentBenchmarkReceipt.platform,
      platformVersion: equivalentBenchmarkReceipt.platformVersion,
      buildMode: equivalentBenchmarkReceipt.buildMode,
      jsEngine: equivalentBenchmarkReceipt.jsEngine,
      order: equivalentBenchmarkReceipt.order,
      iterations: equivalentBenchmarkReceipt.iterations,
      warmupIterations: equivalentBenchmarkReceipt.warmupIterations,
      correctness: equivalentBenchmarkReceipt.correctness,
      rawLowerBound: equivalentBenchmarkReceipt.rawLowerBound,
    })}`,
  );
  for (const [operation, result] of Object.entries(equivalentBenchmarkReceipt.equivalent)) {
    const ffiResult =
      equivalentBenchmarkReceipt.ffi.available && equivalentBenchmarkReceipt.ffi.equivalent
        ? equivalentBenchmarkReceipt.ffi.equivalent[
            operation as keyof typeof equivalentBenchmarkReceipt.ffi.equivalent
          ]
        : undefined;
    const ffiNitroResult =
      equivalentBenchmarkReceipt.ffi.available && equivalentBenchmarkReceipt.ffi.nitroReference
        ? equivalentBenchmarkReceipt.ffi.nitroReference[
            operation as keyof typeof equivalentBenchmarkReceipt.ffi.nitroReference
          ]
        : undefined;
    console.log(
      `RUSTRA_BENCH_OP_JSON=${JSON.stringify({
        operation,
        nitroAvgNs: result.nitro.avg,
        rustraAvgNs: result.rustra.avg,
        ffiAvgNs: ffiResult?.avg,
        rustraToNitro: result.ratio,
        ffiToNitro: ffiResult && ffiNitroResult ? ffiResult.avg / ffiNitroResult.avg : undefined,
      })}`,
    );
  }
  for (const [operation, result] of Object.entries(equivalentBenchmarkReceipt.equivalent)) {
    console.log(`RUSTRA_NITRO_OP_JSON=${JSON.stringify({ operation, ...result })}`);
  }

  // ── 채널/리소스 E2E (타입 패리티 2단계 — Tauri v2 모델) ──────────
  // 채널: createChannel(cb) → 커맨드 인자 channel 로 핸들 전달 → Rust 가
  // 역방향 스트림 → JS 콜백 도달 순서 검증 → dropChannel.
  // 리소스: resource_open → read/write(정수 핸들만) → close → close 후
  // typed 에러(resource.not_found) 확인.
  try {
    log('╔════════════════════════════════════════════════╗');
    log('║  Channels & Resources (Tauri v2 model)        ║');
    log('╠════════════════════════════════════════════════╣');
    const native = getRustraNative();
    if (native?.createChannel) {
      const received: string[] = [];
      const handle = native.createChannel((payloadJson: string) => {
        received.push(payloadJson);
      });
      const chOut = await channelDemo({ channel: handle, ticks: 3 });
      // 채널은 동기 send 다 — 커맨드 반환 시점에 이미 drain 됐을 수 있고,
      // CallInvoker 배선이면 비동기 drain 이다. 최대 1초 기다린다.
      for (let i = 0; i < 100 && received.length < 3; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      log(`│  channel handle=${handle} sent=${chOut.sent} dropped=${chOut.droppedSends}`);
      log(`│  channel received ${received.length} payloads`);
      const first = JSON.parse(received[0] ?? '{}') as { step?: number };
      const last = JSON.parse(received[received.length - 1] ?? '{}') as { step?: number };
      log(`│  channel order: first.step=${first.step ?? '?'} last.step=${last.step ?? '?'}`);
      const dropped = native.dropChannel?.(handle) ?? false;
      log(`│  channel dropped=${dropped}`);
    } else {
      log('│  (createChannel 미지원 호스트 — 스킵)');
    }

    const opened = await resourceOpen({ initial: { seed: '1' } });
    const readSeed = await resourceRead({ handle: opened.handle, key: 'seed' });
    const wrote = await resourceWrite({ handle: opened.handle, key: 'extra', value: '42' });
    const readExtra = await resourceRead({ handle: opened.handle, key: 'extra' });
    const closed = await resourceClose({ handle: opened.handle });
    log(
      `│  resource handle=${opened.handle} read(seed)=${readSeed.value} entries=${wrote.entries}`,
    );
    log(`│  resource read(extra)=${readExtra.value} closed=${closed.closed}`);
    try {
      await resourceRead({ handle: opened.handle, key: 'seed' });
      log('│  resource post-close: ❌ 에러 없음(계약 위반)');
    } catch (e) {
      log(
        `│  resource post-close: ${(e as Error).message.includes('resource.not_found') ? '✓ resource.not_found' : '❌ ' + (e as Error).message}`,
      );
    }
    log('╚════════════════════════════════════════════════╝');
    log('');
  } catch (e) {
    log(`│  channel/resource block failed: ${(e as Error).message}`);
    log('╚════════════════════════════════════════════════╝');
    log('');
  }

  // ══════════════════════════════════════════════════════
  // Summary
  // ══════════════════════════════════════════════════════
  log('╔════════════════════════════════════════════════╗');
  log('║  Summary                                      ║');
  log('╠════════════════════════════════════════════════╣');
  log('│');
  log('│  Breakdown (rkyvV2 addNumbers sync 100K):');
  log(`│    encode  = ${formatNs(encodeBench.avg)}`);
  log(`│    JSI     = ${formatNs(jsiBench.avg)}`);
  log(`│    decode  = ${formatNs(decodeBench.avg)}`);
  log(`│    total   = ${formatNs(fullSyncBench.avg)}`);
  log('│');
  log('│  Breakdown (JSON addNumbers sync 100K):');
  log(`│    encode  = ${formatNs(jsonEncodeBench.avg)}`);
  log(`│    JSI     = ${formatNs(jsonJsiBench.avg)}`);
  log(`│    decode  = ${formatNs(jsonDecodeBench.avg)}`);
  log(`│    total   = ${formatNs(jsonFullSync.avg)}`);
  log('│');
  log('│  Async overhead (Promise.resolve):');
  log(`│    rkyvV2 async/sync = ${(rkyvV2Result.avg / fullSyncBench.avg).toFixed(1)}x`);
  log(`│    JSON async/sync   = ${(jsonResult.avg / jsonFullSync.avg).toFixed(1)}x`);
  if (ffiSyncResult && ffiAsyncResult) {
    log(`│    Swift FFI async/sync = ${(ffiAsyncResult.avg / ffiSyncResult.avg).toFixed(1)}x`);
  }
  log('│');
  log(`│  rkyvV2 vs JSON (sync) = ${(jsonFullSync.avg / fullSyncBench.avg).toFixed(1)}x faster`);
  log(`│  rkyvV2 vs JSON (async)= ${(jsonResult.avg / rkyvV2Result.avg).toFixed(1)}x faster`);
  log('│  Nitro ratios live in Equivalent ops (same JS shapes/operation/output)');
  log('│');
  log(`│  Tier 2 greet: rkyvV2 vs JSON = ${(greetJson.avg / greetRkyvV2.avg).toFixed(1)}x faster`);
  log('╚════════════════════════════════════════════════╝');

  for (const line of lines) console.log(line);
  return lines;
}

// ── UI ───────────────────────────────────────────────────

export default function App() {
  const [output, setOutput] = useState<string[]>(['Running benchmarks...']);
  const scrollRef = React.useRef<ScrollView>(null);

  useEffect(() => {
    runBenchmarks()
      .then((lines) => {
        setOutput(lines);
        // scroll to top to show correctness tests first
        setTimeout(() => scrollRef.current?.scrollTo({ y: 0, animated: true }), 100);
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        setOutput(['Benchmark failed:', msg]);
      });
  }, []);

  return (
    <View style={styles.container}>
      <ScrollView ref={scrollRef} style={styles.scroll}>
        <Text style={styles.text}>{output.join('\n')}</Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1a1a2e',
    padding: 16,
    paddingTop: 60,
  },
  scroll: {
    flex: 1,
  },
  text: {
    fontFamily: 'Courier',
    fontSize: 11,
    color: '#e0e0e0',
    lineHeight: 16,
  },
});
