import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Source: examples/calculator/ts/ → project root
// Compiled: dist-ts/examples/calculator/ts/ → project root (one more level up)
const ROOT = resolve(__dirname, "..", "..", "..", "..");

const ITERATIONS = 1000;
const SUBPROCESS_MAX_AVG_US = 10000; // subprocess should be under 10ms
const NAPI_MAX_AVG_US = 500;        // napi-rs should be under 500µs
const NAPI_FASTER_THAN_SUBPROCESS = true;

function bench(label: string, fn: () => void, iterations = ITERATIONS) {
  for (let i = 0; i < 200; i++) fn();
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
  return { label, avg, p50, p99 };
}

// ── Subprocess transport ────────────────────────────────

function createSubprocessInvoke() {
  const binPath = join(ROOT, "target/debug/rustra-calculator-example");
  return (command: string, args: unknown): unknown => {
    const output = spawnSync(binPath, ["invoke"], {
      input: JSON.stringify({ command, args }),
      encoding: "utf8",
    });
    if (output.status !== 0) throw new Error(output.stderr || `exited ${output.status}`);
    const response = JSON.parse(output.stdout) as { ok: boolean; result?: unknown; error?: string };
    if (!response.ok) throw new Error(response.error ?? "invoke failed");
    return response.result;
  };
}

// ── napi-rs transport ───────────────────────────────────

function createNapiInvoke() {
  const napiPath = join(ROOT, `examples/calculator-napi/calculator-napi.${process.platform}-${process.arch}.node`);
  const native = createRequire(__dirname)(napiPath) as { rustraInvoke: (cmd: string, args: string | undefined) => string };
  return (command: string, args: unknown): unknown => {
    const argsJson = args !== undefined ? JSON.stringify(args) : undefined;
    const rawResponse = native.rustraInvoke(command, argsJson);
    const response = JSON.parse(rawResponse) as { ok: boolean; result?: unknown; error?: string };
    if (!response.ok) throw new Error(response.error ?? "invoke failed");
    return response.result;
  };
}

// ── Tests ───────────────────────────────────────────────

describe("transport performance", { concurrency: 1 }, () => {
  const binPath = join(ROOT, "target/debug/rustra-calculator-example");
  const napiPath = join(ROOT, `examples/calculator-napi/calculator-napi.${process.platform}-${process.arch}.node`);

  it("subprocess: addNumbers returns correct result", () => {
    const invoke = createSubprocessInvoke();
    const result = invoke("addNumbers", { a: 20, b: 22 }) as { value: number };
    assert.equal(result.value, 42);
  });

  it("subprocess: latency within threshold", () => {
    const invoke = createSubprocessInvoke();
    const r = bench("subprocess", () => invoke("addNumbers", { a: 42, b: 58 }));
    console.log(`    subprocess: avg=${r.avg.toFixed(0)}ns p50=${r.p50.toFixed(0)}ns p99=${r.p99.toFixed(0)}ns`);
    assert(r.avg < SUBPROCESS_MAX_AVG_US * 1000, `subprocess avg ${r.avg.toFixed(0)}ns exceeds ${SUBPROCESS_MAX_AVG_US}µs threshold`);
  });

  if (existsSync(napiPath)) {
    it("napi-rs: addNumbers returns correct result", () => {
      const invoke = createNapiInvoke();
      const result = invoke("addNumbers", { a: 20, b: 22 }) as { value: number };
      assert.equal(result.value, 42);
    });

    it("napi-rs: latency within threshold", () => {
      const invoke = createNapiInvoke();
      const r = bench("napi-rs", () => invoke("addNumbers", { a: 42, b: 58 }));
      console.log(`    napi-rs:    avg=${r.avg.toFixed(0)}ns p50=${r.p50.toFixed(0)}ns p99=${r.p99.toFixed(0)}ns`);
      assert(r.avg < NAPI_MAX_AVG_US * 1000, `napi-rs avg ${r.avg.toFixed(0)}ns exceeds ${NAPI_MAX_AVG_US}µs threshold`);
    });

    it("napi-rs is faster than subprocess", () => {
      const subprocessInvoke = createSubprocessInvoke();
      const napiInvoke = createNapiInvoke();

      const subR = bench("subprocess", () => subprocessInvoke("addNumbers", { a: 42, b: 58 }));
      const napiR = bench("napi-rs", () => napiInvoke("addNumbers", { a: 42, b: 58 }));

      console.log(`    subprocess: ${subR.avg.toFixed(0)}ns  napi-rs: ${napiR.avg.toFixed(0)}ns  ratio: ${(subR.avg / napiR.avg).toFixed(1)}x`);

      if (NAPI_FASTER_THAN_SUBPROCESS) {
        assert(napiR.avg < subR.avg, `napi-rs (${napiR.avg.toFixed(0)}ns) should be faster than subprocess (${subR.avg.toFixed(0)}ns)`);
      }
    });
  } else {
    it.skip("napi-rs: .node file not found, skipping", () => {});
  }
});
