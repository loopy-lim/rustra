import { useEffect, useState } from "react";
import { StyleSheet, Text, View, ScrollView } from "react-native";
import { NitroModules } from "react-native-nitro-modules";
import { configure } from "@rustra/types";
import {
  addNumbers, greet, sumList, toUpper, isEven,
  createItem, processItem, multiply, clamp,
} from "../calculator/generated/commands";
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
import {
  createRkyvV2Engine,
  rkyvV2Registry,
} from "./src/adapters/rkyv-v2-adapter";

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

function formatOps(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

type BenchResult = {
  label: string;
  avg: number;
  p50: number;
  p99: number;
  ops: number;
};

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

  await installRustraJSI();
  const native = getRustraNative();

  // Create engines
  const jsonEngine = createJsonEngine(native);
  const msgpackEngine = createMsgpackEngine(native);
  const postcardEngine = createPostcardEngine(native, postcardRegistry);
  const rkyvEngine = createRkyvEngine(native);
  const hybridEngine = createHybridEngine(native, hybridRegistry);
  const rkyvV2Engine = createRkyvV2Engine(native, rkyvV2Registry);

  const nitroBench = NitroModules.createHybridObject<{
    add(a: number, b: number): number;
  }>("NitroBench");

  const encoder = new TextEncoder();

  log("╔════════════════════════════════════════════════╗");
  log("║  rustra rkyv V2 — Multi-Tier Benchmark        ║");
  log("╚════════════════════════════════════════════════╝");
  log("");

  // ── Tier 1 verification (addNumbers) ──────────────────
  log("┌─ Tier 1: Fixed-width primitives ─────────────┐");
  const INPUT = { a: 42, b: 58 };

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

  // Tier 1: isEven
  configure(rkyvV2Engine);
  try {
    const even = await isEven({ n: 42 });
    log(`│  rkyvV2    isEven(42)=true    ${even.result === true ? "✓" : "✗"}`);
  } catch (e: any) {
    log(`│  isEven FAIL ${String(e).slice(0, 40)}`);
  }

  // Tier 1: multiply
  try {
    const mul = await multiply({ a: 3.14, b: 2.0 });
    const ok = Math.abs(mul.value - 6.28) < 0.01;
    log(`│  rkyvV2    multiply(3.14,2)=6.28 ${ok ? "✓" : "✗"}`);
  } catch (e: any) {
    log(`│  multiply FAIL ${String(e).slice(0, 40)}`);
  }
  log("└───────────────────────────────────────────────┘");
  log("");

  // ── Tier 2 verification (String/Vec) ────────────────
  log("┌─ Tier 2: String / Vec<primitive> ─────────────┐");
  configure(rkyvV2Engine);

  try {
    const g = await greet({ name: "Rustra" });
    log(`│  greet("Rustra")="${g.message}" ${g.message === "Hello, Rustra!" ? "✓" : "✗"}`);
  } catch (e: any) {
    log(`│  greet FAIL ${String(e).slice(0, 40)}`);
  }

  try {
    const s = await sumList({ numbers: [1, 2, 3, 4, 5] });
    log(`│  sumList([1..5]) total=${s.total} count=${s.count} ${s.total === 15 && s.count === 5 ? "✓" : "✗"}`);
  } catch (e: any) {
    log(`│  sumList FAIL ${String(e).slice(0, 40)}`);
  }

  try {
    const u = await toUpper({ s: "hello" });
    log(`│  toUpper("hello")="${u.result}" ${u.result === "HELLO" ? "✓" : "✗"}`);
  } catch (e: any) {
    log(`│  toUpper FAIL ${String(e).slice(0, 40)}`);
  }
  log("└───────────────────────────────────────────────┘");
  log("");

  // ── Tier 3 verification (nested structs) ────────────
  log("┌─ Tier 3: Nested structs (JSON fallback) ──────┐");
  configure(rkyvV2Engine);

  try {
    const ci = await createItem({ name: "Widget", value: 42 });
    const ok = ci.item.name === "Widget" && ci.item.value === 42 && ci.item.active === true;
    log(`│  createItem("Widget",42) ${ok ? "✓" : "✗"}`);
  } catch (e: any) {
    log(`│  createItem FAIL ${String(e).slice(0, 40)}`);
  }

  try {
    const pi = await processItem({ item: { name: "Gadget", value: 200, active: true } });
    const ok = pi.item.value === 400 && pi.doubled === true;
    log(`│  processItem(Gadget,200) val=${pi.item.value} dbl=${pi.doubled} ${ok ? "✓" : "✗"}`);
  } catch (e: any) {
    log(`│  processItem FAIL ${String(e).slice(0, 40)}`);
  }
  log("└───────────────────────────────────────────────┘");
  log("");

  // ── Performance benchmarks ──────────────────────────
  log("┌─ Performance: addNumbers (10K iterations) ────┐");

  // Nitro baseline
  const nitroResult = await measure("NitroBench.add", () =>
    Promise.resolve(nitroBench.add(42, 58)),
  );
  log(`│  Nitro    avg: ${formatNs(nitroResult.avg).padStart(10)}`);

  // JSI noop
  const noopPayload = encoder.encode('{"command":"addNumbers","args":{"a":42,"b":58}}');
  const noopResult = await measure("JSI noop", () =>
    Promise.resolve(native.noop(noopPayload.buffer)),
  );
  log(`│  JSInoop  avg: ${formatNs(noopResult.avg).padStart(10)}`);

  // JSON
  configure(jsonEngine);
  const jsonResult = await measure("JSON", () => addNumbers(INPUT));
  log(`│  JSON     avg: ${formatNs(jsonResult.avg).padStart(10)}`);

  // rkyv V2
  configure(rkyvV2Engine);
  const rkyvV2Result = await measure("rkyvV2", () => addNumbers(INPUT));
  log(`│  rkyvV2   avg: ${formatNs(rkyvV2Result.avg).padStart(10)}`);

  log("└───────────────────────────────────────────────┘");
  log("");

  // ── Tier 2 performance ─────────────────────────────
  log("┌─ Performance: greet (Tier 2, String) ─────────┐");
  const greetRkyvV2 = await measure("greet rkyvV2", () => greet({ name: "World" }));
  log(`│  rkyvV2   avg: ${formatNs(greetRkyvV2.avg).padStart(10)}`);

  configure(jsonEngine);
  const greetJson = await measure("greet JSON", () => greet({ name: "World" }));
  log(`│  JSON     avg: ${formatNs(greetJson.avg).padStart(10)}`);
  log("└───────────────────────────────────────────────┘");
  log("");

  // ── Head-to-head ────────────────────────────────────
  log("╔════════════════════════════════════════════════╗");
  log("║         Head-to-Head: addNumbers              ║");
  log("╠════════════════════════════════════════════════╣");
  log("│");

  const allResults = [
    { name: "Nitro (JSI C++)", result: nitroResult },
    { name: "JSI noop", result: noopResult },
    { name: "rkyv V2 ★", result: rkyvV2Result },
    { name: "JSON", result: jsonResult },
  ];

  const maxAvg = Math.max(...allResults.map((r) => r.result.avg));
  for (const r of allResults) {
    const b = bar(r.result.avg, maxAvg);
    log(`│  ${r.name.padEnd(20)} ${b} ${formatNs(r.result.avg)}`);
  }

  log("│");
  log(`│  rkyv V2 / Nitro = ${(rkyvV2Result.avg / nitroResult.avg).toFixed(1)}x`);
  log(`│  rkyv V2 vs JSON = ${(jsonResult.avg / rkyvV2Result.avg).toFixed(1)}x faster`);
  log("│");
  log(`│  Tier 2 (greet): rkyvV2 vs JSON = ${(greetJson.avg / greetRkyvV2.avg).toFixed(1)}x faster`);
  log("╚════════════════════════════════════════════════╝");

  for (const line of lines) console.log(line);
  return lines;
}

// ── UI ───────────────────────────────────────────────────

export default function App() {
  const [output, setOutput] = useState<string[]>(["Running benchmarks..."]);

  useEffect(() => {
    runBenchmarks().then(setOutput).catch((e) => setOutput([String(e)]));
  }, []);

  return (
    <View style={styles.container}>
      <ScrollView style={styles.scroll}>
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
