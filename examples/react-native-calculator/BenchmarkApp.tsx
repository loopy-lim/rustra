import { useEffect, useState } from "react";
import { StyleSheet, Text, View, ScrollView } from "react-native";
import { addNumbers } from "../calculator/generated/commands";
import { createReactNativeEngine } from "../../packages/react-native/src";
import RustraCalculatorModule from "./modules/rustra-calculator";

type RustraNativeModule = {
  invoke(command: string, args?: unknown): Promise<unknown>;
  invokeSync(command: string, args?: unknown): unknown;
};

const nativeModule = RustraCalculatorModule as RustraNativeModule;

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

  const syncEngine = createReactNativeEngine(nativeModule);
  const asyncEngine = createReactNativeEngine(nativeModule, { mode: "async" });

  log("╔════════════════════════════════════════════════╗");
  log("║   rustra-bridge RN Benchmark (iOS Simulator)  ║");
  log("╚════════════════════════════════════════════════╝");
  log("");

  // 1. Sync mode (new)
  log("┌─ SYNC MODE (Function) ────────────────────────┐");
  const syncResult = await measure("addNumbers (sync)", () =>
    addNumbers(syncEngine, { a: 42, b: 58 }),
  );
  log(`│  10,000 iterations`);
  log(`│  avg: ${formatNs(syncResult.avg).padStart(10)}  p50: ${formatNs(syncResult.p50).padStart(10)}  p99: ${formatNs(syncResult.p99).padStart(10)}`);
  log(`│  ${formatOps(syncResult.ops)} ops/sec`);
  log("└───────────────────────────────────────────────┘");
  log("");

  // 2. Async mode (original)
  log("┌─ ASYNC MODE (AsyncFunction) ──────────────────┐");
  const asyncResult = await measure("addNumbers (async)", () =>
    addNumbers(asyncEngine, { a: 42, b: 58 }),
  );
  log(`│  10,000 iterations`);
  log(`│  avg: ${formatNs(asyncResult.avg).padStart(10)}  p50: ${formatNs(asyncResult.p50).padStart(10)}  p99: ${formatNs(asyncResult.p99).padStart(10)}`);
  log(`│  ${formatOps(asyncResult.ops)} ops/sec`);
  log("└───────────────────────────────────────────────┘");
  log("");

  // 3. JSON-only baseline
  log("┌─ JS JSON roundtrip (no bridge) ───────────────┐");
  const jsonInput = { command: "addNumbers", args: { a: 42, b: 58 } };
  const jsonBench = await measure("JSON roundtrip", () =>
    Promise.resolve(JSON.parse(JSON.stringify(jsonInput))),
  );
  log(`│  avg: ${formatNs(jsonBench.avg).padStart(10)}  p50: ${formatNs(jsonBench.p50).padStart(10)}`);
  log("└───────────────────────────────────────────────┘");
  log("");

  // 4. Sync vs Async comparison
  const speedup = asyncResult.avg / syncResult.avg;
  const saved = asyncResult.avg - syncResult.avg;

  log("┌─ Sync vs Async Improvement ───────────────────┐");
  log("│");
  log(`│  Async:  ${bar(asyncResult.avg, asyncResult.avg)} ${formatNs(asyncResult.avg)}`);
  log(`│  Sync:   ${bar(syncResult.avg, asyncResult.avg)} ${formatNs(syncResult.avg)}`);
  log("│");
  log(`│  ${speedup.toFixed(1)}x faster  (${formatNs(saved)} saved per call)`);
  log("└───────────────────────────────────────────────┘");
  log("");

  // 5. Overhead breakdown (sync)
  log("┌─ Sync Overhead Breakdown ─────────────────────┐");
  const syncOverhead = syncResult.avg - jsonBench.avg;
  const layers = [
    { name: "JSON ser/de (JS)", ns: jsonBench.avg, ch: "▓" },
    { name: "Sync bridge + FFI", ns: syncOverhead, ch: "▒" },
  ];
  const maxNs = Math.max(...layers.map((l) => l.ns));
  for (const l of layers) {
    const b = bar(l.ns, maxNs);
    log(`│  ${l.name.padEnd(20)} ${b} ${formatNs(l.ns)}`);
  }
  log(`│  Total: ${formatNs(syncResult.avg)}`);
  log("└───────────────────────────────────────────────┘");
  log("");

  // 6. All adapters comparison
  log("┌─ Comparison: All Adapters ────────────────────┐");
  log("│");
  log("│  Adapter        Avg latency    Throughput");
  log("│  ───────────    ───────────    ──────────");
  const adapters = [
    { name: "Rust (typed)", avgNs: 209, ops: 5093309 },
    { name: "Swift FFI", avgNs: 3500, ops: 296710 },
    { name: "RN sync", avgNs: syncResult.avg, ops: syncResult.ops },
    { name: "RN async", avgNs: asyncResult.avg, ops: asyncResult.ops },
    { name: "Bun (est.)", avgNs: 5000, ops: 200000 },
    { name: "Node (est.)", avgNs: 50000, ops: 20000 },
  ];
  const maxOps = Math.max(...adapters.map((a) => a.ops));
  for (const a of adapters) {
    const b = bar(a.ops, maxOps);
    log(`│  ${a.name.padEnd(16)} ${formatNs(a.avgNs).padStart(10)}  ${b} ${formatOps(a.ops)}`);
  }
  log("│");
  log("└───────────────────────────────────────────────┘");

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
