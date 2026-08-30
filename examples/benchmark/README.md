English | [한국어](./README.ko.md)

# Benchmark

rustra-bridge performance measurement: codegen speed, invoke overhead, payload scalability.

## Build

```sh
cargo build --release -p rustra-benchmark
```

## Run

```sh
cargo run --release -p rustra-benchmark
```

During optimization iterations, you can quickly re-measure only the hot path
without waiting for full payload scaling.

```sh
cargo run --release -p rustra-benchmark -- --hot-path-only
```

## What Is Measured

1. **Codegen speed** — time to generate `schema.json`, `types.ts`, `commands.ts`
2. **Invoke overhead** — command execution latency per payload size
3. **Throughput** — operations per second per payload size

## JS Benchmarks

```sh
bun scripts/adapter-bench.mjs
```

This script measures only the pure JS cost of JSON parsing and a mock EngineClient,
not native performance. For real bridge comparisons use `bun scripts/transport-bench.mjs`,
and for Rust Tier comparisons use the Criterion benchmarks.
