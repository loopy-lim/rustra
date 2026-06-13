import React, { useEffect, useState } from "react";
import { StyleSheet, Text, View, ScrollView } from "react-native";
import { NitroModules } from "react-native-nitro-modules";
import { configure } from "@rustra/types";
import {
  addNumbers, greet, sumList, toUpper, isEven,
  createItem, processItem, multiply, clamp,
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
  log(`│  rkyvV2   avg: ${formatNs(greetRkyvV2.avg).padStart(10)}  p50: ${formatNs(greetRkyvV2.p50)}`);

  configure(jsonEngine);
  const greetJson = await measure("greet JSON", () => greet({ name: "World" }));
  log(`│  JSON     avg: ${formatNs(greetJson.avg).padStart(10)}  p50: ${formatNs(greetJson.p50)}`);

  log("╚════════════════════════════════════════════════╝");
  log("");

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
