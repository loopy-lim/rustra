#!/usr/bin/env node
// rustra-bridge transport benchmark
// Measures actual end-to-end performance across all transport types
//
// Usage:
//   node scripts/transport-bench.mjs       # Node subprocess + napi-rs
//   bun scripts/transport-bench.mjs        # Bun subprocess + Bun FFI

import { execSync, spawnSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const isBun = typeof Bun !== 'undefined';
const runtime = isBun ? 'Bun' : 'Node.js';
const version = isBun ? Bun.version : process.version;

// ── Helpers ──────────────────────────────────────────────

function bar(value, max, width = 35) {
  const filled = Math.max(1, Math.round((value / max) * width));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function fmtNs(ns) {
  if (ns >= 1_000_000) return `${(ns / 1_000_000).toFixed(2)} ms`;
  if (ns >= 1_000) return `${(ns / 1_000).toFixed(1)} µs`;
  return `${ns.toFixed(0)} ns`;
}

function fmtOps(n) {
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function percentile(sorted, pct) {
  const idx = Math.min(Math.floor((pct / 100) * sorted.length), sorted.length - 1);
  return sorted[idx];
}

// ── Transport implementations ────────────────────────────

function createSubprocessTransport(binPath) {
  const profile = binPath.includes('/release/') ? 'release' : 'debug';
  return {
    name: `${runtime} subprocess (${profile})`,
    invoke(command, args) {
      const output = spawnSync(binPath, ['invoke'], {
        input: JSON.stringify({ command, args }),
        encoding: 'utf8',
      });
      if (output.status !== 0) throw new Error(output.stderr || `exited ${output.status}`);
      const response = JSON.parse(output.stdout);
      if (!response.ok) throw new Error(response.error);
      return response.result;
    },
  };
}

function createBunFfiTransport() {
  const { dlopen, FFIType, suffix, CString } = require('bun:ffi');
  // release 우선 — debug 라이브러리는 최적화가 꺼져 브릿지 비용이 ~7x 부풀어
  // 오른다. release 가 없을 때만 debug 로 폴백하고 프로필을 이름에 노출한다.
  const candidates = [
    { dir: 'release', label: '' },
    { dir: 'debug', label: ' (debug)' },
  ];
  const found = candidates
    .map((c) => ({
      ...c,
      path: join(ROOT, `target/${c.dir}/librustra_calculator_example.${suffix}`),
    }))
    .find((c) => existsSync(c.path));
  if (!found) {
    throw new Error(
      'no librustra_calculator_example dylib in target/release|debug — run cargo build --release -p rustra-calculator-example',
    );
  }
  const lib = dlopen(found.path, {
    rustra_calculator_invoke: {
      args: [FFIType.cstring],
      returns: FFIType.ptr,
    },
    rustra_calculator_free_string: {
      args: [FFIType.ptr],
      returns: FFIType.void,
    },
  });
  return {
    name: `Bun FFI${found.label}`,
    profile: found.dir,
    invoke(command, args) {
      const payload = Buffer.from(JSON.stringify({ command, args }) + '\0');
      const rawPtr = lib.symbols.rustra_calculator_invoke(payload);
      if (!rawPtr) throw new Error('Bun FFI returned a null response pointer');
      // CString는 native pointer view라 free 뒤 lazy coercion하면 use-after-free가
      // 된다. 호스트 소유 문자열로 먼저 복사한 다음 Rust 버퍼를 해제한다.
      const rawResponse = new CString(rawPtr).toString();
      lib.symbols.rustra_calculator_free_string(rawPtr);
      const response = JSON.parse(rawResponse);
      if (!response.ok) throw new Error(response.error);
      return response.result;
    },
  };
}

function createNapiBufferTransport() {
  const napiPath = join(
    ROOT,
    `examples/calculator-napi/calculator-napi.${process.platform}-${process.arch}.node`,
  );
  const native = createRequire(__dirname)(napiPath);
  return {
    name: 'Node napi Buffer',
    invoke(command, args) {
      const argsJson = args !== undefined ? JSON.stringify(args) : undefined;
      const raw = native.rustraInvokeBuffer(command, argsJson);
      // Buffer→문자열 1회 — 실제 소비 형태. JS 엔진 디코드 비용은 동일하게 포함.
      const response = JSON.parse(raw.toString('utf8'));
      if (!response.ok) throw new Error(response.error);
      return response.result;
    },
  };
}

function createNapiTransport() {
  const napiPath = join(
    ROOT,
    `examples/calculator-napi/calculator-napi.${process.platform}-${process.arch}.node`,
  );
  const native = createRequire(__dirname)(napiPath);
  return {
    name: 'Node napi-rs',
    invoke(command, args) {
      const argsJson = args !== undefined ? JSON.stringify(args) : undefined;
      const rawResponse = native.rustraInvoke(command, argsJson);
      const response = JSON.parse(rawResponse);
      if (!response.ok) throw new Error(response.error);
      return response.result;
    },
  };
}

// ── rkyv V2 direct transports (postcard 왕복 — JSON/UTF-16 없음) ──
//
// 코어 FFI(rustra_ffi_invoke_rkyv_v2, wire-bench 61.5ns)를 버퍼 직결로 태운다.
// napi는 rustraInvokeRkyvV2 바인딩, Bun은 dlopen 심볼 직접 바인딩. JS 코덱
// 인코딩은 bench harness에서 고정 프레임을 재사용해 측정한다(코덱 자체 비용은
// adapter-bench/JS codec 벤치가 담당) — 여기선 transport 비용만 격리한다.

function zigzagVarint(n) {
  const v = n >= 0 ? n * 2 : -n * 2 - 1;
  const bytes = [];
  let x = v;
  do {
    bytes.push((x % 128) | 0x80);
    x = Math.floor(x / 128);
  } while (x > 0);
  bytes[bytes.length - 1] &= 0x7f;
  return bytes;
}

function decodeRkyvV2Result(frame) {
  // [ok:1][pad3][len u32 LE @4][postcard body @8]
  if (frame[0] !== 1) throw new Error('rkyv V2 bench: error frame');
  let v = 0;
  let shift = 0;
  let i = 8;
  for (;;) {
    const b = frame[i++];
    v |= (b & 0x7f) << shift;
    if (!(b & 0x80)) break;
    shift += 7;
  }
  return (v >>> 1) ^ -(v & 1);
}

function createNapiRkyvTransport() {
  const napiPath = join(
    ROOT,
    `examples/calculator-napi/calculator-napi.${process.platform}-${process.arch}.node`,
  );
  const native = createRequire(__dirname)(napiPath);
  if (typeof native.rustraInvokeRkyvV2 !== 'function') {
    throw new Error('napi addon predates rustraInvokeRkyvV2 — rebuild with napi build');
  }
  // addNumbers(cmd_id=1) 고정 프레임 — { a: 42, b: 58 }의 postcard 인코딩.
  const frame = Buffer.from([1, 0, ...zigzagVarint(42), ...zigzagVarint(58)]);
  return {
    name: 'Node napi rkyv V2',
    invoke(command, args) {
      void command;
      void args;
      const resp = native.rustraInvokeRkyvV2(frame);
      return decodeRkyvV2Result(resp);
    },
  };
}

function createBunRkyvTransport() {
  // createBunFfiTransport 와 동일한 release-우선 탐색을 공유한다. bun:ffi 는
  // 이 스크립트가 Bun 으로 실행될 때만 존재한다(호출부가 isBun 으로 게이트).
  // eslint-disable-next-line import/no-extraneous-dependencies
  const { dlopen, FFIType, suffix, toArrayBuffer } = Bun
    ? require('bun:ffi')
    : { dlopen: undefined, FFIType: undefined, suffix: undefined, toArrayBuffer: undefined };
  const candidates = [
    { dir: 'release', label: '' },
    { dir: 'debug', label: ' (debug)' },
  ];
  const found = candidates
    .map((c) => ({
      ...c,
      path: join(ROOT, `target/${c.dir}/librustra_calculator_example.${suffix}`),
    }))
    .find((c) => existsSync(c.path));
  if (!found) throw new Error('no librustra_calculator_example dylib');
  const lib = dlopen(found.path, {
    rustra_calculator_invoke_rkyv_v2: {
      args: [FFIType.ptr, FFIType.usize, FFIType.ptr],
      returns: FFIType.ptr,
    },
    rustra_calculator_free_rkyv_v2_buffer: {
      args: [FFIType.ptr, FFIType.usize],
      returns: FFIType.void,
    },
  });
  const frame = Buffer.from([1, 0, ...zigzagVarint(42), ...zigzagVarint(58)]);
  const outLen = new BigUint64Array(1);
  return {
    name: `Bun FFI rkyv V2${found.label}`,
    invoke(command, args) {
      void command;
      void args;
      const ptr = lib.symbols.rustra_calculator_invoke_rkyv_v2(
        frame,
        BigInt(frame.byteLength),
        outLen,
      );
      if (ptr === 0) throw new Error('Bun FFI rkyv V2 returned null');
      const len = Number(outLen[0]);
      // toArrayBuffer 는 Rust 메모리를 참조하는 뷰고 new Uint8Array(뷰) 도
      // 버퍼를 공유한다 — free 전에 값 복사로 materialize 해야 한다.
      const copied = Array.from(new Uint8Array(toArrayBuffer(ptr, 0, len)));
      lib.symbols.rustra_calculator_free_rkyv_v2_buffer(ptr, BigInt(len));
      return decodeRkyvV2Result(copied);
    },
  };
}

// ── Benchmark runner ─────────────────────────────────────

function bench(transport, command, args, iterations = 10000) {
  // Warm up
  for (let i = 0; i < 500; i++) transport.invoke(command, args);

  const times = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    transport.invoke(command, args);
    times.push((performance.now() - start) * 1_000_000);
  }
  times.sort((a, b) => a - b);

  // 트림드 평균(상하 5%) — 서브프로세스 스폰 지연 등 아웃라이어가 raw avg 를
  // 오염시키는 것을 방지한다. stddev 는 분산의 신뢰 근거로 함께 보고한다.
  const trim = Math.floor(times.length * 0.05);
  const trimmed = times.slice(trim, times.length - trim);
  const avg = trimmed.reduce((s, t) => s + t, 0) / trimmed.length;
  const variance = trimmed.reduce((s, t) => s + (t - avg) ** 2, 0) / trimmed.length;
  const stddev = Math.sqrt(variance);
  const p50 = percentile(times, 50);
  const p99 = percentile(times, 99);
  const ops = 1_000_000_000 / avg;

  return { name: transport.name, avg, stddev, p50, p99, ops, iterations };
}

function printBenchResult(r) {
  console.log(
    `  ${r.name.padEnd(24)} ${fmtNs(r.avg).padStart(12)} ±${fmtNs(r.stddev).padStart(10)} ${fmtNs(r.p50).padStart(12)} ${fmtNs(r.p99).padStart(12)} ${fmtOps(r.ops).padStart(14)}`,
  );
}

// ── Detect available transports ──────────────────────────

const transports = [];

// Subprocess always available (debug bin — 프로세스 스폰이 지배적이라 프로필 무의미)
const binCandidates = ['release', 'debug']
  .map((d) => join(ROOT, `target/${d}/rustra-calculator-example`))
  .filter((p) => existsSync(p));
const binPath = binCandidates[0];
if (existsSync(binPath)) {
  transports.push(createSubprocessTransport(binPath));
}

// Bun FFI
if (isBun) {
  try {
    transports.push(createBunFfiTransport());
  } catch (e) {
    console.log(`  (Bun FFI unavailable: ${e.message})`);
  }
  try {
    transports.push(createBunRkyvTransport());
  } catch (e) {
    console.log(`  (Bun FFI rkyv V2 unavailable: ${e.message})`);
  }
}

// Node napi-rs (String + Buffer 변형 비교)
if (!isBun) {
  try {
    transports.push(createNapiTransport());
    if (
      typeof createRequire(__dirname)(
        join(
          ROOT,
          `examples/calculator-napi/calculator-napi.${process.platform}-${process.arch}.node`,
        ),
      ).rustraInvokeBuffer === 'function'
    ) {
      transports.push(createNapiBufferTransport());
    }
  } catch (e) {
    console.log(`  (napi-rs unavailable: ${e.message})`);
  }
  try {
    transports.push(createNapiRkyvTransport());
  } catch (e) {
    console.log(`  (napi rkyv V2 unavailable: ${e.message})`);
  }
}

// ── Header ───────────────────────────────────────────────

console.log('');
console.log('┌─ Transport Benchmark ────────────────────────────────────────────────────────┐');
console.log(`│  Runtime: ${runtime} ${version}`);
console.log(`│  Date:    ${new Date().toISOString().split('T')[0]}`);
console.log(`│  Transports: ${transports.map((t) => t.name).join(', ')}`);
console.log(
  '└─────────────────────────────────────────────────────────────────────────────────────────────────────┘',
);
console.log('');

if (transports.length === 0) {
  console.log('No transports available. Build first:');
  console.log('  cargo build -p rustra-calculator-example');
  if (!isBun) console.log('  cd examples/calculator-napi && bun run build:debug');
  process.exit(1);
}

// ── 1) Transport comparison (simple call) ────────────────

console.log('┌─ 1) Transport Comparison (addNumbers, 10,000 iterations) ───────┐');
console.log(`│`);
console.log(
  `│  ${'Transport'.padEnd(24)} ${'Avg*'.padStart(12)} ${'±σ'.padStart(12)} ${'p50'.padStart(12)} ${'p99'.padStart(12)} ${'ops/s'.padStart(14)}`,
);
console.log(
  `│  ${'─'.repeat(24)} ${'─'.repeat(12)} ${'─'.repeat(12)} ${'─'.repeat(12)} ${'─'.repeat(14)}`,
);

const simpleResults = [];
for (const transport of transports) {
  const r = bench(transport, 'addNumbers', { a: 42, b: 58 });
  simpleResults.push(r);
  printBenchResult(r);
}

// Comparison chart
if (simpleResults.length > 1) {
  console.log(`│`);
  const maxAvg = Math.max(...simpleResults.map((r) => r.avg));
  for (const r of simpleResults) {
    console.log(`│  ${r.name.padEnd(24)} ${bar(r.avg, maxAvg)} ${fmtNs(r.avg)}`);
  }

  if (simpleResults.length === 2) {
    const ratio = simpleResults[0].avg / simpleResults[1].avg;
    const faster = ratio > 1 ? simpleResults[1].name : simpleResults[0].name;
    console.log(`│`);
    console.log(
      `│  ${faster} is ~${ratio > 1 ? ratio.toFixed(1) : (1 / ratio).toFixed(1)}x faster`,
    );
  }
}

console.log(`│`);
console.log(
  '└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘',
);
console.log('');

// ── 2) Measurement stability ─────────────────────────────

console.log('┌─ 2) Measurement Stability (fixed addNumbers payload) ─────────────┐');
console.log(`│`);

// Only test native transports (not subprocess — too slow for repeated samples).
// The calculator N-API fixture exposes addNumbers, not processPayload. Keep this
// section honest: it checks sample-count stability, while payload scaling is
// measured by the Rust Criterion type_scaling benchmark.
const nativeTransport = transports.find((t) => !t.name.includes('subprocess')) || transports[0];

const sampleCounts = [100, 500, 2000, 5000, 10000];
const stabilityResults = [];

for (const iterations of sampleCounts) {
  const args = { a: 42, b: 58 };
  const r = bench(nativeTransport, 'addNumbers', args, iterations);
  const jsonSize = JSON.stringify({ command: 'addNumbers', args }).length;
  stabilityResults.push({ iterations, avg: r.avg, jsonSize });
}

console.log(`│  ${nativeTransport.name} (fixed 47-byte addNumbers request)`);
console.log(`│`);
console.log(
  `│  ${'Iters'.padEnd(8)} ${'JSON'.padStart(8)} ${'Avg'.padStart(12)}  ${'Chart'.padEnd(35)}`,
);
console.log(`│  ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(12)}  ${'─'.repeat(35)}`);

const maxStabilityAvg = Math.max(...stabilityResults.map((r) => r.avg));
for (const r of stabilityResults) {
  const sizeStr = `${r.iterations}`.padEnd(8);
  const jsonStr = `${r.jsonSize}`.padStart(8);
  const avgStr = fmtNs(r.avg).padStart(12);
  console.log(`│  ${sizeStr} ${jsonStr} ${avgStr}  ${bar(r.avg, maxStabilityAvg, 25)}`);
}

console.log(`│`);
console.log(
  '└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘',
);
console.log('');

// ── 3) Layer-by-layer overhead breakdown ─────────────────

console.log('┌─ 3) Overhead Breakdown ─────────────────────────────────────────────────┐');
console.log(`│`);

const nativeResult = simpleResults.find((r) => !r.name.includes('subprocess'));
const subprocessResult = simpleResults.find((r) => r.name.includes('subprocess'));

if (nativeResult && subprocessResult) {
  // Measure JS-only overhead
  const jsOnly = (() => {
    const payload = JSON.stringify({ command: 'addNumbers', args: { a: 42, b: 58 } });
    const iterations = 10000;
    for (let i = 0; i < 500; i++) {
      JSON.parse(payload);
      JSON.stringify({ a: 42, b: 58 });
    }
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      JSON.parse(payload);
      JSON.stringify({ a: 42, b: 58 });
    }
    return ((performance.now() - start) * 1_000_000) / iterations;
  })();

  // Rust 코어 비용도 하드코딩 대신 이번 실행에서 실측한다 — wire-bench 와 동일
  // JSON invoke 경로를 그대로 잰다(서브마이크로초라 napi 변형으로는 분해 불가).
  const rustCoreNs = (() => {
    try {
      const { execFileSync } = require('child_process');
      // wire-bench 바이너리가 있으면 그 JSON 평균을 쓴다(코어 JSON invoke 실측).
      const out = execFileSync(join(ROOT, 'target/release/wire-bench'), {
        encoding: 'utf8',
        timeout: 60_000,
      });
      const m = out.match(/JSON \(invoke\).*?([\d.]+) (µs|ns)/);
      if (m) return m[2] === 'µs' ? parseFloat(m[1]) * 1000 : parseFloat(m[1]);
    } catch {
      /* wire-bench 미빌드 시 분해 생략 */
    }
    return null;
  })();

  const total = nativeResult.avg;
  const jsJsonNs = jsOnly;
  const bridgeNs = Math.max(0, total - jsJsonNs - (rustCoreNs ?? 0));

  const layers = [
    ...(rustCoreNs !== null ? [{ name: 'Rust core + serde', ns: rustCoreNs }] : []),
    { name: 'JS JSON ser/de', ns: jsJsonNs },
    { name: `${nativeResult.name} bridge`, ns: bridgeNs },
    { name: 'Total (measured)', ns: total },
  ];

  const maxLayerNs = Math.max(...layers.map((l) => l.ns));
  for (const l of layers) {
    const nsStr = fmtNs(l.ns).padStart(12);
    console.log(`│  ${l.name.padEnd(28)} ${bar(l.ns, maxLayerNs)} ${nsStr}`);
  }

  console.log(`│`);

  // Subprocess comparison
  const subprocessOverhead = subprocessResult.avg - total;
  console.log(`│  ${runtime} subprocess overhead: ~${fmtNs(subprocessOverhead)} per call`);
  console.log(
    `│  Native transport saves: ~${(subprocessOverhead / 1000).toFixed(0)} µs/call (${(subprocessResult.avg / total).toFixed(0)}x faster)`,
  );
}

// ── 4) Response-size scaling: String vs Buffer 변형 (Node napi) ──
// rustraInvokeBuffer 의 "대형 응답에서 유리" 주장을 실측으로만 유지한다.
// 작은 응답(addNumbers)에선 Buffer 할당+toString 비용으로 오히려 느릴 수 있다.
if (!isBun) {
  try {
    const napiPath = join(
      ROOT,
      `examples/calculator-napi/calculator-napi.${process.platform}-${process.arch}.node`,
    );
    const native = createRequire(__dirname)(napiPath);
    if (typeof native.rustraInvokeBuffer === 'function') {
      console.log('┌─ 4) Response Size Scaling — String vs Buffer (napi) ──┐');
      console.log(`│`);
      const largeString = 'rustra'.repeat(1366); // 약 8 KiB 실제 echo 응답
      const cases = [
        { label: 'addNumbers (34 B)', command: 'addNumbers', args: { a: 42, b: 58 } },
        {
          label: 'echoString (~8 KiB)',
          command: 'benchEchoString',
          args: { value: largeString },
        },
      ];
      console.log(
        `│  ${'Case'.padEnd(22)} ${'String'.padStart(12)} ${'Buffer'.padStart(12)} ${'우위'.padStart(8)}`,
      );
      console.log(`│  ${'─'.repeat(22)} ${'─'.repeat(12)} ${'─'.repeat(12)} ${'─'.repeat(8)}`);
      for (const c of cases) {
        const argsJson = c.args !== undefined ? JSON.stringify(c.args) : undefined;
        const str = bench(
          {
            name: 'str',
            invoke: (command, args) => {
              const raw = native.rustraInvoke(
                command,
                args !== undefined ? JSON.stringify(args) : undefined,
              );
              return JSON.parse(raw);
            },
          },
          c.command,
          c.args,
          5000,
        ).avg;
        const buf = bench(
          {
            name: 'buf',
            invoke: (command, args) => {
              const raw = native.rustraInvokeBuffer(
                command,
                args !== undefined ? JSON.stringify(args) : undefined,
              );
              return JSON.parse(raw.toString('utf8'));
            },
          },
          c.command,
          c.args,
          5000,
        ).avg;
        const winner = str < buf ? 'String' : 'Buffer';
        console.log(
          `│  ${c.label.padEnd(22)} ${fmtNs(str).padStart(12)} ${fmtNs(buf).padStart(12)} ${winner.padStart(8)}`,
        );
      }
      console.log(`│`);
      console.log(
        '└──────────────────────────────────────────────────────────────────────────────────┘',
      );
      console.log('');
    }
  } catch {
    /* napi 미로드 환경 스킵 */
  }
}

console.log(`│`);
console.log(
  '└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘',
);
console.log('');
