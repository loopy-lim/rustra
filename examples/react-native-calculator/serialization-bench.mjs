// Serialization benchmark for Node.js / Bun
// Compares JSON, msgpackr, and binary encoding performance across runtimes

import { Packr } from "msgpackr";

const packr = new Packr({ useRecords: false });

function formatNs(ns) {
  if (ns >= 1_000_000) return `${(ns / 1_000_000).toFixed(2)} ms`;
  if (ns >= 1_000) return `${(ns / 1_000).toFixed(1)} µs`;
  return `${ns.toFixed(0)} ns`;
}

function formatOps(n) {
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function measureSync(label, fn, iterations = 100_000) {
  // Warmup
  for (let i = 0; i < 1000; i++) fn();

  const times = [];
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

const runtime = typeof Bun !== "undefined" ? "Bun" : "Node.js";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

console.log(`\n╔════════════════════════════════════════════════╗`);
console.log(`║  Serialization Benchmark (${runtime})${" ".repeat(16 - runtime.length)}║`);
console.log(`╚════════════════════════════════════════════════╝\n`);

// 1. JSON stringify + parse
const jsonResult = measureSync("JSON encode+decode", () => {
  const json = JSON.stringify({ command: "addNumbers", args: { a: 42, b: 58 } });
  const bytes = encoder.encode(json);
  const resp = decoder.decode(bytes);
  JSON.parse(resp);
});
console.log(`JSON:          ${formatNs(jsonResult.avg).padStart(10)}  ${formatOps(jsonResult.ops).padStart(12)} ops/sec`);

// 2. msgpackr pack + unpack
const msgpackResult = measureSync("msgpackr pack+unpack", () => {
  const packed = packr.pack({ command: "addNumbers", args: { a: 42, b: 58 } });
  packr.unpack(packed);
});
console.log(`msgpackr:      ${formatNs(msgpackResult.avg).padStart(10)}  ${formatOps(msgpackResult.ops).padStart(12)} ops/sec`);

// 3. Binary DataView (simulate raw protocol)
const binaryResult = measureSync("DataView encode+decode", () => {
  const buf = new ArrayBuffer(18);
  const view = new DataView(buf);
  view.setUint16(0, 1, true);
  view.setFloat64(2, 42, true);
  view.setFloat64(10, 58, true);
  const ok = view.getUint8(0);  // simulate reading response
  const val = view.getFloat64(1, true);
});
console.log(`Binary/DataView: ${formatNs(binaryResult.avg).padStart(8)}  ${formatOps(binaryResult.ops).padStart(12)} ops/sec`);

// 4. Bincode-like encoding (varint + i64 as two i32)
const bincodeResult = measureSync("Bincode encode+decode", () => {
  const cmd = "addNumbers";
  const cmdLen = cmd.length;
  const buf = new ArrayBuffer(1 + cmdLen + 16);
  const u8 = new Uint8Array(buf);
  u8[0] = cmdLen;
  for (let i = 0; i < cmdLen; i++) u8[1 + i] = cmd.charCodeAt(i);
  const dv = new DataView(buf);
  const off = 1 + cmdLen;
  dv.setInt32(off, 42, true);
  dv.setInt32(off + 4, 0, true);
  dv.setInt32(off + 8, 58, true);
  dv.setInt32(off + 12, 0, true);
  // decode response
  const respOk = dv.getUint8(0);
  const respVal = dv.getInt32(1, true);
});
console.log(`Bincode:       ${formatNs(bincodeResult.avg).padStart(10)}  ${formatOps(bincodeResult.ops).padStart(12)} ops/sec`);

// 5. Just ArrayBuffer allocation (baseline)
const allocResult = measureSync("ArrayBuffer alloc", () => {
  const buf = new ArrayBuffer(28);
});
console.log(`ArrayBuffer alloc: ${formatNs(allocResult.avg).padStart(7)}  ${formatOps(allocResult.ops).padStart(12)} ops/sec`);

console.log(`\n╔════════════════════════════════════════════════╗`);
console.log(`║  Comparison                                    ║`);
console.log(`╠════════════════════════════════════════════════╣`);
console.log(`│  msgpackr vs JSON  = ${(jsonResult.avg / msgpackResult.avg).toFixed(1)}x faster`);
console.log(`│  Binary vs JSON    = ${(jsonResult.avg / binaryResult.avg).toFixed(1)}x faster`);
console.log(`│  Bincode vs JSON   = ${(jsonResult.avg / bincodeResult.avg).toFixed(1)}x faster`);
console.log(`│  Binary vs msgpack = ${(msgpackResult.avg / binaryResult.avg).toFixed(1)}x`);
console.log(`╚════════════════════════════════════════════════╝\n`);
