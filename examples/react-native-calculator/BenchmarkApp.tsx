import React, { useEffect, useState } from "react";
import { StyleSheet, Text, View, ScrollView } from "react-native";
import { NitroModules } from "react-native-nitro-modules";
import { configure } from "@rustra/types";
import {
  addNumbers, greet, sumList, toUpper, isEven,
  createItem, processItem, multiply, clamp, sizeOf,
  channelDemo, resourceOpen, resourceRead, resourceWrite, resourceClose,
} from "../calculator/generated/commands";
// ── Benchmark internals (not part of user-facing API) ───────
import { installRustraJSI, getRustraNative } from "./modules/rustra-jsi/src";
import { createJsonEngine } from "./src/adapters/json-adapter";
import { createMsgpackEngine } from "./src/adapters/msgpack-adapter";
import {
  createPostcardEngine,
  postcardRegistry,
} from "./src/adapters/postcard-adapter";
import { createRkyvEngine } from "./src/adapters/rkyv-adapter";
import {
  createHybridEngine,
  hybridRegistry,
} from "./src/adapters/hybrid-adapter";
import { createRkyvV2Engine, rkyvV2Registry } from "./src/adapters/rkyv-v2-adapter";
// ── End benchmark internals ─────────────────────────────────

// ── Helpers ──────────────────────────────────────────────

function bar(value: number, max: number, width = 25): string {
  const filled = Math.max(1, Math.round((value / max) * width));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function formatNs(ns: number): string {
  if (ns >= 1_000_000) return `${(ns / 1_000_000).toFixed(2)} ms`;
  if (ns >= 1_000) return `${(ns / 1_000).toFixed(1)} µs`;
  return `${ns.toFixed(0)} ns`;
}

type BenchResult = {
  label: string;
  avg: number;
  p50: number;
  p99: number;
  ops: number;
};

function measureSync(label: string, fn: () => void, iterations = 100_000): BenchResult {
  // warmup
  for (let i = 0; i < 1000; i++) fn();

  const times: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    fn();
    times.push((performance.now() - start) * 1_000_000);
  }
  times.sort((a, b) => a - b);

  const avg = times.reduce((s, t) => s + t, 0) / times.length;
  const p50 = times[Math.floor(times.length * 0.5)];
  const p99 = times[Math.floor(times.length * 0.99)];
  const ops = 1_000_000_000 / avg;

  return { label, avg, p50, p99, ops };
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
  times.sort((a, b) => a - b);

  const avg = times.reduce((s, t) => s + t, 0) / times.length;
  const p50 = times[Math.floor(times.length * 0.5)];
  const p99 = times[Math.floor(times.length * 0.99)];
  const ops = 1_000_000_000 / avg;

  return { label, avg, p50, p99, ops };
}

// ── Benchmark Runner ─────────────────────────────────────

async function runBenchmarks(): Promise<string[]> {
  const lines: string[] = [];
  const log = (s: string) => lines.push(s);

  log("Installing JSI...");
  try {
    await installRustraJSI();
  } catch (e: any) {
    log(`JSI install failed: ${e.message}`);
    return lines;
  }
  log("JSI installed, getting native...");
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
  const rkyvV2Engine = createRkyvV2Engine(native);

  const nitroBench = NitroModules.createHybridObject<{
    add(a: number, b: number): number;
    name: string;
    equals(other: object): boolean;
    dispose(): void;
    // ── 페이로드 형태 비교(2026-08-22): string/ArrayBuffer/구조체 ──
    echoString(value: string): string;
    echoBuffer(value: ArrayBuffer): ArrayBuffer;
    echoPair(value: { name: string; value: number }): { name: string; value: number };
  }>("NitroBench");

  const encoder = new TextEncoder();
  const INPUT = { a: 42, b: 58 };

  // ══════════════════════════════════════════════════════
  log("╔════════════════════════════════════════════════╗");
  log("║  rustra rkyv V2 — Multi-Tier Benchmark        ║");
  log("╚════════════════════════════════════════════════╝");
  log("");

  // ── Correctness verification ──────────────────────────
  log("┌─ Tier 1: Fixed-width primitives ─────────────┐");
  const adapters = [
    { name: "JSON", engine: jsonEngine },
    { name: "Msgpack", engine: msgpackEngine },
    { name: "Postcard", engine: postcardEngine },
    { name: "rkyv", engine: rkyvEngine },
    { name: "Hybrid", engine: hybridEngine },
    { name: "rkyvV2", engine: rkyvV2Engine },
  ];

  for (const { name, engine } of adapters) {
    configure(engine);
    try {
      const r = await addNumbers(INPUT);
      const v = r.value === 100 ? "✓" : `✗ got ${r.value}`;
      log(`│  ${name.padEnd(10)} addNumbers(42,58)=100 ${v}`);
    } catch (e: any) {
      log(`│  ${name.padEnd(10)} FAIL ${String(e).slice(0, 40)}`);
    }
  }

  configure(rkyvV2Engine);
  try {
    const even = await isEven({ n: 42 });
    log(`│  rkyvV2    isEven(42)=true    ${even.result === true ? "✓" : "✗"}`);
  } catch (e: any) { log(`│  isEven FAIL ${String(e).slice(0, 40)}`); }

  try {
    const mul = await multiply({ a: 3.14, b: 2.0 });
    log(`│  rkyvV2    multiply(3.14,2)=6.28 ${Math.abs(mul.value - 6.28) < 0.01 ? "✓" : "✗"}`);
  } catch (e: any) { log(`│  multiply FAIL ${String(e).slice(0, 40)}`); }
  log("└───────────────────────────────────────────────┘");
  log("");

  // ── Tier 2 verification ──────────────────────────────
  log("┌─ Tier 2: String / Vec<primitive> ─────────────┐");
  configure(rkyvV2Engine);
  try {
    const g = await greet({ name: "Rustra" });
    log(`│  greet("Rustra")="${g.message}" ${g.message === "Hello, Rustra!" ? "✓" : "✗"}`);
  } catch (e: any) { log(`│  greet FAIL ${String(e).slice(0, 40)}`); }

  try {
    const s = await sumList({ numbers: [1, 2, 3, 4, 5] });
    log(`│  sumList([1..5]) total=${s.total} count=${s.count} ${s.total === 15 && s.count === 5 ? "✓" : "✗"}`);
  } catch (e: any) { log(`│  sumList FAIL ${String(e).slice(0, 40)}`); }

  try {
    const u = await toUpper({ s: "hello" });
    log(`│  toUpper("hello")="${u.result}" ${u.result === "HELLO" ? "✓" : "✗"}`);
  } catch (e: any) { log(`│  toUpper FAIL ${String(e).slice(0, 40)}`); }
  log("└───────────────────────────────────────────────┘");
  log("");

  // ── Tier 3 verification ──────────────────────────────
  log("┌─ Tier 3: Nested structs (JSON fallback) ──────┐");
  configure(rkyvV2Engine);
  try {
    const ci = await createItem({ name: "Widget", value: 42 });
    const ok = ci.item.name === "Widget" && ci.item.value === 42 && ci.item.active === true;
    log(`│  createItem("Widget",42) ${ok ? "✓" : "✗"}`);
  } catch (e: any) { log(`│  createItem FAIL ${String(e).slice(0, 40)}`); }

  try {
    const pi = await processItem({ item: { name: "Gadget", value: 200, active: true } });
    const ok = pi.item.value === 400 && pi.doubled === true;
    log(`│  processItem(Gadget,200) val=${pi.item.value} dbl=${pi.doubled} ${ok ? "✓" : "✗"}`);
  } catch (e: any) { log(`│  processItem FAIL ${String(e).slice(0, 40)}`); }
  log("└───────────────────────────────────────────────┘");
  log("");

  // ══════════════════════════════════════════════════════
  // Performance: Micro-benchmarks (sync, 100K iterations)
  // ══════════════════════════════════════════════════════
  log("╔════════════════════════════════════════════════╗");
  log("║  Micro-bench: Sync steps (100K iter)          ║");
  log("╠════════════════════════════════════════════════╣");

  const codec = rkyvV2Registry.get("addNumbers")!;

  // 1. Pure encode
  const encodeBench = measureSync("rkyvV2 encode", () => codec.encode(INPUT));
  log(`│  encode   avg: ${formatNs(encodeBench.avg).padStart(10)}  p50: ${formatNs(encodeBench.p50)}`);

  // 2. Pure JSI call (pre-encoded payload)
  const preEncoded = codec.encode(INPUT);
  const jsiBench = measureSync("rkyvV2 JSI", () => native.invokeRkyvV2(preEncoded));
  log(`│  JSI call avg: ${formatNs(jsiBench.avg).padStart(10)}  p50: ${formatNs(jsiBench.p50)}`);

  // 3. Pure decode (pre-encoded response)
  const preResponse = native.invokeRkyvV2(preEncoded);
  const decodeBench = measureSync("rkyvV2 decode", () => codec.decode(preResponse));
  log(`│  decode   avg: ${formatNs(decodeBench.avg).padStart(10)}  p50: ${formatNs(decodeBench.p50)}`);

  // 4. Full encode+JSI+decode (sync, no Promise)
  const fullSyncBench = measureSync("rkyvV2 full sync", () => {
    const p = codec.encode(INPUT);
    const r = native.invokeRkyvV2(p);
    return codec.decode(r);
  });
  log(`│  full sync avg: ${formatNs(fullSyncBench.avg).padStart(10)}  p50: ${formatNs(fullSyncBench.p50)}`);

  // (Tier 1/2) 최적화 경로 측정 — positional 진입(invokeTypedPos)은 인자 객체
  // 생성/JS 코덱 encode 를 통째로 건너뛴다. cmd_id 는 codec.commandId(=1).
  if (typeof native.invokeTypedPos === "function") {
    const posBench = measureSync("rkyvV2 pos", () => {
      return (native as { invokeTypedPos(id: number, a: number, b: number): unknown })
        .invokeTypedPos(codec.commandId, INPUT.a, INPUT.b);
    });
    log(`│  pos full avg: ${formatNs(posBench.avg).padStart(10)}  p50: ${formatNs(posBench.p50)}`);
    // 주성분 분해 — full sync 대비 절감 = (encode+객체생성) 비용.
    const saved = fullSyncBench.avg - posBench.avg;
    log(`│  pos saves avg: ${formatNs(Math.max(0, saved)).padStart(9)} (encode+obj-alloc 제거)`);
  }
  // byId 경로(객체 인자 유지, 코어 caller-buffer受益) — Tier 1 _into 효과 격리.
  if (typeof native.invokeTypedById === "function") {
    const byIdBench = measureSync("rkyvV2 byId", () => {
      return (native as { invokeTypedById(id: number, args: unknown): unknown })
        .invokeTypedById(codec.commandId, INPUT);
    });
    log(`│  byId full avg: ${formatNs(byIdBench.avg).padStart(9)}  p50: ${formatNs(byIdBench.p50)}`);
  }

  // 5. JSON encode
  const jsonEncodeBench = measureSync("JSON encode", () => {
    JSON.stringify({ command: "addNumbers", args: INPUT });
  });
  log(`│  JSON enc avg: ${formatNs(jsonEncodeBench.avg).padStart(10)}  p50: ${formatNs(jsonEncodeBench.p50)}`);

  // 6. JSON JSI call
  const jsonPayload = encoder.encode(JSON.stringify({ command: "addNumbers", args: INPUT }));
  const jsonJsiBench = measureSync("JSON JSI", () => native.invoke(jsonPayload.buffer));
  log(`│  JSON JSI avg: ${formatNs(jsonJsiBench.avg).padStart(10)}  p50: ${formatNs(jsonJsiBench.p50)}`);

  // 7. JSON decode
  const jsonResponse = native.invoke(jsonPayload.buffer);
  const jsonDecodeBench = measureSync("JSON decode", () => {
    const s = new TextDecoder().decode(jsonResponse);
    JSON.parse(s);
  });
  log(`│  JSON dec avg: ${formatNs(jsonDecodeBench.avg).padStart(10)}  p50: ${formatNs(jsonDecodeBench.p50)}`);

  const jsonFullSync = measureSync("JSON full sync", () => {
    const json = JSON.stringify({ command: "addNumbers", args: INPUT });
    const p = encoder.encode(json);
    const r = native.invoke(p.buffer);
    const s = new TextDecoder().decode(r);
    JSON.parse(s);
  });
  log(`│  JSON full avg: ${formatNs(jsonFullSync.avg).padStart(10)}  p50: ${formatNs(jsonFullSync.p50)}`);

  log("╚════════════════════════════════════════════════╝");
  log("");

  // ══════════════════════════════════════════════════════
  // Performance: Async full-path (10K iterations)
  // ══════════════════════════════════════════════════════
  log("╔════════════════════════════════════════════════╗");
  log("║  Async full-path: addNumbers (10K iter)       ║");
  log("╠════════════════════════════════════════════════╣");

  const nitroResult = await measure("Nitro", () =>
    Promise.resolve(nitroBench.add(42, 58)),
  );
  log(`│  Nitro    avg: ${formatNs(nitroResult.avg).padStart(10)}  p50: ${formatNs(nitroResult.p50)}  p99: ${formatNs(nitroResult.p99)}`);

  const noopPayload = encoder.encode('{"command":"addNumbers","args":{"a":42,"b":58}}');
  const noopResult = await measure("JSI noop", () =>
    Promise.resolve(native.noop(noopPayload.buffer)),
  );
  log(`│  JSInoop  avg: ${formatNs(noopResult.avg).padStart(10)}  p50: ${formatNs(noopResult.p50)}  p99: ${formatNs(noopResult.p99)}`);

  configure(jsonEngine);
  const jsonResult = await measure("JSON", () => addNumbers(INPUT));

  log(`│  JSON     avg: ${formatNs(jsonResult.avg).padStart(10)}  p50: ${formatNs(jsonResult.p50)}  p99: ${formatNs(jsonResult.p99)}`);

  configure(rkyvV2Engine);
  const rkyvV2Result = await measure("rkyvV2", () => addNumbers(INPUT));
  log(`│  rkyvV2   avg: ${formatNs(rkyvV2Result.avg).padStart(10)}  p50: ${formatNs(rkyvV2Result.p50)}  p99: ${formatNs(rkyvV2Result.p99)}`);

  log("╚════════════════════════════════════════════════╝");
  log("");

  // ── Tier 2 performance ─────────────────────────────
  log("╔════════════════════════════════════════════════╗");
  log("║  Tier 2 (String): greet (10K iter)            ║");
  log("╠════════════════════════════════════════════════╣");

  configure(rkyvV2Engine);
  const greetRkyvV2 = await measure("greet rkyvV2", () => greet({ name: "World" }));
  log(`│  rkyvV2   avg: ${formatNs(greetRkyvV2.avg).padStart(10)}  p50: ${formatNs(greetRkyvV2.p50)}  p99: ${formatNs(greetRkyvV2.p99)}`);

  configure(jsonEngine);
  const greetJson = await measure("greet JSON", () => greet({ name: "World" }));
  log(`│  JSON     avg: ${formatNs(greetJson.avg).padStart(10)}  p50: ${formatNs(greetJson.p50)}  p99: ${formatNs(greetJson.p99)}`);

  log("╚════════════════════════════════════════════════╝");
  log("");

  // ── 페이로드 형태 비교(2026-08-22) ──────────────────
  // Nitro(프로퍼티 분해 마셜링) vs rustra rkyvV2(postcard 직렬화)를
  // string/bytes/struct 세 형태로 같은 조건에서 왕복 측정한다.
  log("╔════════════════════════════════════════════════╗");
  log("║  Payload shapes: Nitro vs rkyvV2 (10K iter)   ║");
  log("╠════════════════════════════════════════════════╣");

  // string — Nitro echoString vs rustra greet(유사 왕복)
  const nitroStr = await measure("nitro str", () =>
    Promise.resolve(nitroBench.echoString("benchmark-string-payload")),
  );
  log(`│  str Nitro  avg: ${formatNs(nitroStr.avg).padStart(10)}  p50: ${formatNs(nitroStr.p50)}`);

  configure(rkyvV2Engine);
  const rustraStr = await measure("rustra str", () => greet({ name: "benchmark-string-payload" }));
  log(`│  str rustra avg: ${formatNs(rustraStr.avg).padStart(10)}  p50: ${formatNs(rustraStr.p50)}`);

  // bytes(64B) — Nitro echoBuffer vs rustra sizeOf(Vec<u8> 왕복)
  const buf = new Uint8Array(64);
  for (let i = 0; i < 64; i++) buf[i] = i & 0xff;
  const ab = buf.buffer as ArrayBuffer;
  const nitroBuf = await measure("nitro buf", () =>
    Promise.resolve(nitroBench.echoBuffer(ab)),
  );
  log(`│  buf Nitro  avg: ${formatNs(nitroBuf.avg).padStart(10)}  p50: ${formatNs(nitroBuf.p50)}`);

  const rustraBuf = await measure("rustra buf", () => sizeOf({ data: Array.from(buf) }));
  log(`│  buf rustra avg: ${formatNs(rustraBuf.avg).padStart(10)}  p50: ${formatNs(rustraBuf.p50)}`);

  // struct — Nitro echoPair(프로퍼티 분해) vs rustra createItem(postcard)
  const nitroPair = await measure("nitro pair", () =>
    Promise.resolve(nitroBench.echoPair({ name: "widget", value: 42 })),
  );
  log(`│  obj Nitro  avg: ${formatNs(nitroPair.avg).padStart(10)}  p50: ${formatNs(nitroPair.p50)}`);

  const rustraPair = await measure("rustra pair", () => createItem({ name: "widget", value: 42 }));
  log(`│  obj rustra avg: ${formatNs(rustraPair.avg).padStart(10)}  p50: ${formatNs(rustraPair.p50)}`);

  log("│");
  log(`│  str  rustra/Nitro = ${(rustraStr.avg / nitroStr.avg).toFixed(2)}x`);
  log(`│  buf  rustra/Nitro = ${(rustraBuf.avg / nitroBuf.avg).toFixed(2)}x`);
  log(`│  obj  rustra/Nitro = ${(rustraPair.avg / nitroPair.avg).toFixed(2)}x`);
  log("╚════════════════════════════════════════════════╝");
  log("");

  // ── 채널/리소스 E2E (타입 패리티 2단계 — Tauri v2 모델) ──────────
  // 채널: createChannel(cb) → 커맨드 인자 channel 로 핸들 전달 → Rust 가
  // 역방향 스트림 → JS 콜백 도달 순서 검증 → dropChannel.
  // 리소스: resource_open → read/write(정수 핸들만) → close → close 후
  // typed 에러(resource.not_found) 확인.
  try {
    log("╔════════════════════════════════════════════════╗");
    log("║  Channels & Resources (Tauri v2 model)        ║");
    log("╠════════════════════════════════════════════════╣");
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
      const first = JSON.parse(received[0] ?? "{}") as { step?: number };
      const last = JSON.parse(received[received.length - 1] ?? "{}") as { step?: number };
      log(`│  channel order: first.step=${first.step ?? "?"} last.step=${last.step ?? "?"}`);
      const dropped = native.dropChannel?.(handle) ?? false;
      log(`│  channel dropped=${dropped}`);
    } else {
      log("│  (createChannel 미지원 호스트 — 스킵)");
    }

    const opened = await resourceOpen({ initial: { seed: "1" } });
    const readSeed = await resourceRead({ handle: opened.handle, key: "seed" });
    const wrote = await resourceWrite({ handle: opened.handle, key: "extra", value: "42" });
    const readExtra = await resourceRead({ handle: opened.handle, key: "extra" });
    const closed = await resourceClose({ handle: opened.handle });
    log(`│  resource handle=${opened.handle} read(seed)=${readSeed.value} entries=${wrote.entries}`);
    log(`│  resource read(extra)=${readExtra.value} closed=${closed.closed}`);
    try {
      await resourceRead({ handle: opened.handle, key: "seed" });
      log("│  resource post-close: ❌ 에러 없음(계약 위반)");
    } catch (e) {
      log(`│  resource post-close: ${(e as Error).message.includes("resource.not_found") ? "✓ resource.not_found" : "❌ " + (e as Error).message}`);
    }
    log("╚════════════════════════════════════════════════╝");
    log("");
  } catch (e) {
    log(`│  channel/resource block failed: ${(e as Error).message}`);
    log("╚════════════════════════════════════════════════╝");
    log("");
  }

  // ══════════════════════════════════════════════════════
  // Summary
  // ══════════════════════════════════════════════════════
  log("╔════════════════════════════════════════════════╗");
  log("║  Summary                                      ║");
  log("╠════════════════════════════════════════════════╣");
  log("│");
  log("│  Breakdown (rkyvV2 addNumbers sync 100K):");
  log(`│    encode  = ${formatNs(encodeBench.avg)}`);
  log(`│    JSI     = ${formatNs(jsiBench.avg)}`);
  log(`│    decode  = ${formatNs(decodeBench.avg)}`);
  log(`│    total   = ${formatNs(fullSyncBench.avg)}`);
  log("│");
  log("│  Breakdown (JSON addNumbers sync 100K):");
  log(`│    encode  = ${formatNs(jsonEncodeBench.avg)}`);
  log(`│    JSI     = ${formatNs(jsonJsiBench.avg)}`);
  log(`│    decode  = ${formatNs(jsonDecodeBench.avg)}`);
  log(`│    total   = ${formatNs(jsonFullSync.avg)}`);
  log("│");
  log("│  Async overhead (Promise.resolve):");
  log(`│    rkyvV2 async/sync = ${(rkyvV2Result.avg / fullSyncBench.avg).toFixed(1)}x`);
  log(`│    JSON async/sync   = ${(jsonResult.avg / jsonFullSync.avg).toFixed(1)}x`);
  log("│");
  log(`│  rkyvV2 vs JSON (sync) = ${(jsonFullSync.avg / fullSyncBench.avg).toFixed(1)}x faster`);
  log(`│  rkyvV2 vs JSON (async)= ${(jsonResult.avg / rkyvV2Result.avg).toFixed(1)}x faster`);
  log(`│  rkyvV2 / Nitro       = ${(rkyvV2Result.avg / nitroResult.avg).toFixed(1)}x`);
  log("│");
  log(`│  Tier 2 greet: rkyvV2 vs JSON = ${(greetJson.avg / greetRkyvV2.avg).toFixed(1)}x faster`);
  log("╚════════════════════════════════════════════════╝");

  for (const line of lines) console.log(line);
  return lines;
}

// ── UI ───────────────────────────────────────────────────

export default function App() {
  const [output, setOutput] = useState<string[]>(["Running benchmarks..."]);
  const scrollRef = React.useRef<ScrollView>(null);

  useEffect(() => {
    runBenchmarks().then((lines) => {
      setOutput(lines);
      // scroll to top to show correctness tests first
      setTimeout(() => scrollRef.current?.scrollTo({ y: 0, animated: true }), 100);
    }).catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      setOutput(["Benchmark failed:", msg]);
    });
  }, []);

  return (
    <View style={styles.container}>
      <ScrollView ref={scrollRef} style={styles.scroll}>
        {output.map((line, i) => (
          <Text key={i} style={styles.text}>
            {line}
          </Text>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#1a1a2e",
    padding: 16,
    paddingTop: 60,
  },
  scroll: {
    flex: 1,
  },
  text: {
    fontFamily: "Courier",
    fontSize: 11,
    color: "#e0e0e0",
    lineHeight: 16,
  },
});
