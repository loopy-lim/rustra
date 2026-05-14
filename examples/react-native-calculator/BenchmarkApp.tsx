import { useEffect, useState } from "react";
import { StyleSheet, Text, View, ScrollView } from "react-native";
import { NitroModules } from "react-native-nitro-modules";
import { addNumbers } from "../calculator/generated/commands";
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

  // Create 4 engines with identical API
  const jsonEngine = createJsonEngine(native);
  const msgpackEngine = createMsgpackEngine(native);
  const postcardEngine = createPostcardEngine(native, postcardRegistry);
  const rkyvEngine = createRkyvEngine(native);
  const hybridEngine = createHybridEngine(native, hybridRegistry);

  const nitroBench = NitroModules.createHybridObject<{
    add(a: number, b: number): number;
  }>("NitroBench");

  const encoder = new TextEncoder();

  log("╔════════════════════════════════════════════════╗");
  log("║  Fair DX Bench: JSON/Msgp/Post/rkyv/Hybrid   ║");
  log("╚════════════════════════════════════════════════╝");
  log("");

  // ── Verification ───────────────────────────────────────
  log("┌─ Verify all adapters return correct result ──┐");
  const INPUT = { a: 42, b: 58 };

  const adapters = [
    { name: "JSON", engine: jsonEngine },
    { name: "Msgpack", engine: msgpackEngine },
    { name: "Postcard", engine: postcardEngine },
    { name: "rkyv", engine: rkyvEngine },
    { name: "Hybrid", engine: hybridEngine },
  ];

  for (const { name, engine } of adapters) {
    try {
      const r = await addNumbers(engine, INPUT);
      log(`│  ${name.padEnd(10)} value=${r.value} ${r.value === 100 ? "✓" : "✗"}`);
    } catch (e: any) {
      log(`│  ${name.padEnd(10)} FAIL ${String(e).slice(0, 50)}`);
    }
  }

  log("└───────────────────────────────────────────────┘");
  log("");

  // ── 1. Nitro baseline ──────────────────────────────────
  log("┌─ 1. Nitro (raw JSI C++ add) ─────────────────┐");
  const nitroResult = await measure("NitroBench.add", () =>
    Promise.resolve(nitroBench.add(42, 58)),
  );
  log(`│  avg: ${formatNs(nitroResult.avg).padStart(10)}  p50: ${formatNs(nitroResult.p50).padStart(10)}`);
  log(`│  ${formatOps(nitroResult.ops)} ops/sec`);
  log("└───────────────────────────────────────────────┘");
  log("");

  // ── 2. JSI noop ────────────────────────────────────────
  log("┌─ 2. JSI noop (ArrayBuffer round-trip) ────────┐");
  const noopPayload = encoder.encode('{"command":"addNumbers","args":{"a":42,"b":58}}');
  const noopResult = await measure("JSI noop", () =>
    Promise.resolve(native.noop(noopPayload.buffer)),
  );
  log(`│  avg: ${formatNs(noopResult.avg).padStart(10)}  p50: ${formatNs(noopResult.p50).padStart(10)}`);
  log(`│  ${formatOps(noopResult.ops)} ops/sec`);
  log("└───────────────────────────────────────────────┘");
  log("");

  // ── 3. JSON ────────────────────────────────────────────
  log("┌─ 3. JSON (addNumbers via JSON adapter) ───────┐");
  const jsonResult = await measure("addNumbers (JSON)", () =>
    addNumbers(jsonEngine, INPUT),
  );
  log(`│  avg: ${formatNs(jsonResult.avg).padStart(10)}  p50: ${formatNs(jsonResult.p50).padStart(10)}`);
  log(`│  ${formatOps(jsonResult.ops)} ops/sec`);
  log("└───────────────────────────────────────────────┘");
  log("");

  // ── 4. Msgpack ────────────────────────────────────────
  log("┌─ 4. Msgpack (addNumbers via msgpack adapter) ─┐");
  const msgpackResult = await measure("addNumbers (msgpack)", () =>
    addNumbers(msgpackEngine, INPUT),
  );
  log(`│  avg: ${formatNs(msgpackResult.avg).padStart(10)}  p50: ${formatNs(msgpackResult.p50).padStart(10)}`);
  log(`│  ${formatOps(msgpackResult.ops)} ops/sec`);
  log("└───────────────────────────────────────────────┘");
  log("");

  // ── 5. Postcard ────────────────────────────────────────
  log("┌─ 5. Postcard (addNumbers via postcard adapter)┐");
  const postcardResult = await measure("addNumbers (postcard)", () =>
    addNumbers(postcardEngine, INPUT),
  );
  log(`│  avg: ${formatNs(postcardResult.avg).padStart(10)}  p50: ${formatNs(postcardResult.p50).padStart(10)}`);
  log(`│  ${formatOps(postcardResult.ops)} ops/sec`);
  log("└───────────────────────────────────────────────┘");
  log("");

  // ── 6. rkyv ────────────────────────────────────────────
  log("┌─ 6. rkyv (addNumbers via rkyv adapter) ───────┐");
  const rkyvResult = await measure("addNumbers (rkyv)", () =>
    addNumbers(rkyvEngine, INPUT),
  );
  log(`│  avg: ${formatNs(rkyvResult.avg).padStart(10)}  p50: ${formatNs(rkyvResult.p50).padStart(10)}`);
  log(`│  ${formatOps(rkyvResult.ops)} ops/sec`);
  log("└───────────────────────────────────────────────┘");
  log("");

  // ── 7. Hybrid (postcard req + rkyv resp) ──────────────
  log("┌─ 7. Hybrid (postcard→rkyv) ───────────────────┐");
  const hybridResult = await measure("addNumbers (hybrid)", () =>
    addNumbers(hybridEngine, INPUT),
  );
  log(`│  avg: ${formatNs(hybridResult.avg).padStart(10)}  p50: ${formatNs(hybridResult.p50).padStart(10)}`);
  log(`│  ${formatOps(hybridResult.ops)} ops/sec`);
  log("└───────────────────────────────────────────────┘");
  log("");

  // ── Head-to-head ──────────────────────────────────────
  log("╔════════════════════════════════════════════════╗");
  log("║         Head-to-Head (same DX)                ║");
  log("╠════════════════════════════════════════════════╣");
  log("│");

  const allResults = [
    { name: "Nitro (JSI C++)", result: nitroResult },
    { name: "JSI noop", result: noopResult },
    { name: "Hybrid", result: hybridResult },
    { name: "rkyv", result: rkyvResult },
    { name: "Postcard", result: postcardResult },
    { name: "Msgpack", result: msgpackResult },
    { name: "JSON", result: jsonResult },
  ];

  const maxAvg = Math.max(...allResults.map((r) => r.result.avg));
  for (const r of allResults) {
    const b = bar(r.result.avg, maxAvg);
    log(`│  ${r.name.padEnd(20)} ${b} ${formatNs(r.result.avg)}`);
  }

  log("│");
  log(`│  Same DX: addNumbers(engine, {a:42, b:58})`);
  log("│");
  log(`│  Hybrid  / Nitro = ${(hybridResult.avg / nitroResult.avg).toFixed(1)}x`);
  log(`│  rkyv    / Nitro = ${(rkyvResult.avg / nitroResult.avg).toFixed(1)}x`);
  log(`│  Postcard/ Nitro = ${(postcardResult.avg / nitroResult.avg).toFixed(1)}x`);
  log(`│  Msgpack / Nitro = ${(msgpackResult.avg / nitroResult.avg).toFixed(1)}x`);
  log(`│  JSON    / Nitro = ${(jsonResult.avg / nitroResult.avg).toFixed(1)}x`);
  log("│");
  log(`│  Hybrid  vs JSON = ${(jsonResult.avg / hybridResult.avg).toFixed(1)}x faster`);
  log(`│  rkyv    vs JSON = ${(jsonResult.avg / rkyvResult.avg).toFixed(1)}x faster`);
  log(`│  Postcard vs JSON = ${(jsonResult.avg / postcardResult.avg).toFixed(1)}x faster`);
  log(`│  Hybrid  vs Post = ${(postcardResult.avg / hybridResult.avg).toFixed(1)}x faster`);
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
