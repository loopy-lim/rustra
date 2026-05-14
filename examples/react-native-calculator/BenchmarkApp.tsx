import { useEffect, useState } from "react";
import { StyleSheet, Text, View, ScrollView } from "react-native";
import { NitroModules } from "react-native-nitro-modules";
import { addNumbers } from "../calculator/generated/commands";
import { createReactNativeEngine } from "../../packages/react-native/src";
import RustraCalculatorModule from "./modules/rustra-calculator";

type RustraNativeModule = {
  invoke(command: string, args?: unknown): Promise<unknown>;
  invokeSync(command: string, args?: unknown): unknown;
  addSync(a: number, b: number): number;
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

  // Load Nitro HybridObject
  const nitroBench = NitroModules.createHybridObject<{
    add(a: number, b: number): number;
  }>("NitroBench");

  log("╔════════════════════════════════════════════════╗");
  log("║       Rustra vs Nitro (iOS Simulator)         ║");
  log("╚════════════════════════════════════════════════╝");
  log("");

  // 1. Nitro (JSI C++ direct)
  log("┌─ Nitro Modules (JSI C++ HybridObject) ────────┐");
  const nitroResult = await measure("NitroBench.add", () =>
    Promise.resolve(nitroBench.add(42, 58)),
  );
  log(`│  10,000 iterations`);
  log(`│  avg: ${formatNs(nitroResult.avg).padStart(10)}  p50: ${formatNs(nitroResult.p50).padStart(10)}  p99: ${formatNs(nitroResult.p99).padStart(10)}`);
  log(`│  ${formatOps(nitroResult.ops)} ops/sec`);
  log("└───────────────────────────────────────────────┘");
  log("");

  // 2. Rustra sync
  log("┌─ Rustra SYNC (Expo + JSON + Rust FFI) ────────┐");
  const syncResult = await measure("addNumbers (sync)", () =>
    addNumbers(syncEngine, { a: 42, b: 58 }),
  );
  log(`│  10,000 iterations`);
  log(`│  avg: ${formatNs(syncResult.avg).padStart(10)}  p50: ${formatNs(syncResult.p50).padStart(10)}  p99: ${formatNs(syncResult.p99).padStart(10)}`);
  log(`│  ${formatOps(syncResult.ops)} ops/sec`);
  log("└───────────────────────────────────────────────┘");
  log("");

  // 3. Rustra async
  log("┌─ Rustra ASYNC (Expo AsyncFunction) ───────────┐");
  const asyncResult = await measure("addNumbers (async)", () =>
    addNumbers(asyncEngine, { a: 42, b: 58 }),
  );
  log(`│  10,000 iterations`);
  log(`│  avg: ${formatNs(asyncResult.avg).padStart(10)}  p50: ${formatNs(asyncResult.p50).padStart(10)}  p99: ${formatNs(asyncResult.p99).padStart(10)}`);
  log(`│  ${formatOps(asyncResult.ops)} ops/sec`);
  log("└───────────────────────────────────────────────┘");
  log("");

  // 4. Expo native baseline
  log("┌─ Expo Function (Swift only, no Rust) ─────────┐");
  const rawResult = await measure("addSync (Swift)", () =>
    Promise.resolve(nativeModule.addSync(42, 58)),
  );
  log(`│  avg: ${formatNs(rawResult.avg).padStart(10)}  p50: ${formatNs(rawResult.p50).padStart(10)}`);
  log("└───────────────────────────────────────────────┘");
  log("");

  // 5. Head-to-head
  log("╔════════════════════════════════════════════════╗");
  log("║         Head-to-Head Comparison               ║");
  log("╠════════════════════════════════════════════════╣");
  log("│");

  const allResults = [
    { name: "Nitro (JSI C++)", result: nitroResult },
    { name: "Expo Function (Swift)", result: rawResult },
    { name: "Rustra sync", result: syncResult },
    { name: "Rustra async", result: asyncResult },
  ];

  const maxAvg = Math.max(...allResults.map((r) => r.result.avg));
  for (const r of allResults) {
    const b = bar(r.result.avg, maxAvg);
    log(`│  ${r.name.padEnd(24)} ${b} ${formatNs(r.result.avg)}`);
  }

  log("│");
  const rustraVsNitro = syncResult.avg / nitroResult.avg;
  const overhead = syncResult.avg - nitroResult.avg;
  log(`│  Rustra sync / Nitro = ${rustraVsNitro.toFixed(1)}x`);
  log(`│  Rustra overhead: ${formatNs(overhead)}`);
  log("╚════════════════════════════════════════════════╝");

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
