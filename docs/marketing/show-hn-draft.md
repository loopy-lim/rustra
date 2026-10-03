# Show HN Draft — rustra

This file is a submission draft for Show HN. The article below quotes only
numbers that already appear verbatim in
[`benchmark-highlights.md`](./benchmark-highlights.md) (which itself links to
raw receipts), and the honest-limitations section follows
[`docs/compatibility-matrix.md`](../compatibility-matrix.md). No new
measurements were made for this draft.

---

## Title candidates

1. **Show HN: Rustra – Define once in Rust, call from Node, Bun, Tauri, and React Native**
2. **Show HN: One Rust core, four type-safe JS hosts, one binary wire with a CI contract gate**
3. **Show HN: Rustra – a bridge framework that owns definition, codegen, wire, and verification**

## First-comment context (posted as the author's first comment)

> Author here. rustra started as a scratch-my-own-itch project: I wanted one
> Rust core callable from every JS runtime I ship to — Node, Bun, a Tauri
> WebView, and React Native — without maintaining four hand-written binding
> layers. Everything in the post links back to the repo; the performance
> numbers come from committed benchmark receipts with the commands to
> reproduce them. The honest-limitations section is worth reading before the
> benchmarks: in-flight cancellation is shallow on most adapters, and Linux is
> explicitly Alpha. Feedback on the contract-gate design (`rustra diff` +
> contract hash) especially welcome.

---

## Article

### The problem I kept re-solving

Every Rust-core project I've shipped has ended the same way. The core —
parsing, crypto, whatever the reason was for using Rust — works fine. Then
comes the bridge tax: hand-write napi bindings for the Node service, a
different binding for the Bun CLI, JSON commands over the Tauri IPC bridge for
the desktop app, and a JSI module for the React Native client. Four host
integrations, four places where types drift out of sync, and no automated way
to notice that last week's Rust change silently broke the mobile client.

The type drift is the part that hurts. Not because any single drift is hard to
fix, but because nothing in CI catches it. The Rust side compiles, the TS side
compiles, and the mismatch only surfaces at runtime on a device you don't have
attached to your CI runner.

### Why the existing tools didn't cover it

This is not a complaint about those tools — several are excellent at what
they target. The gap is what they choose _not_ to own:

- **napi-rs** is a great way to build native Node addons from Rust, with
  TypeScript definitions generated from Rust structs via attribute macros. But
  it targets Node (and Electron). It doesn't give me the same generated client
  in a Tauri WebView or a React Native app, and there's no contract check that
  flags a breaking signature change.
- **Tauri commands** are the natural way to call Rust from a Tauri app, but
  they're Tauri-only, typing is manual on the JS side, and the payload travels
  as JSON IPC. tauri-specta adds codegen, still within the Tauri boundary.
- **Nitro Modules** solve this well for React Native specifically, with JSI
  objects instead of a serialized wire — but RN-centric is the point: it's not
  a path to the same core from Node or Bun.

Each tool is reasonable within its host. The problem is multiplying a single
Rust core across all four hosts, and getting type safety and wire format from
_one_ source of truth rather than four adapters that each invent their own.

### What rustra does instead

rustra's bet: own the whole RPC surface — definition → codegen → wire →
verification — as a single contract.

You define commands once in Rust:

```rust
#[bridge_type]
struct AddNumbersInput { a: i64, b: i64 }
#[bridge_type]
struct AddNumbersOutput { sum: i64 }

#[command]
fn add_numbers(input: AddNumbersInput) -> Result<AddNumbersOutput> {
    Ok(AddNumbersOutput { sum: input.a + input.b })
}
```

Then `rustra codegen` emits a type-safe TypeScript client per host from the
published contract — the same contract, the same binary wire, for Node, Bun,
Tauri, and React Native:

```ts
import { addNumbers } from './generated/node.js';

const { sum } = await addNumbers({ a: 42, b: 58 });
```

Three pieces make this more than macros plus a serializer:

1. **A compact binary wire ("Frame").** Instead of JSON over every transport,
   commands travel as a framed postcard-encoded payload with command ids. On
   one representative command payload (`addNumbers`), the request measures
   **4 B on the Frame wire versus 47 B as JSON** — about 11.8× smaller. To be
   precise about scope: that is a payload-bytes ratio only. It excludes
   framing, transport overhead, and the response, and it is not an
   end-to-end-RTT claim. (The wire-format doc has a whole section on why this
   number must not be quoted beyond its layer.)

2. **A verification gate.** `generate_typescript()` publishes the contract;
   each generated host entry embeds the contract hash and verifies it against
   the live native library at bootstrap. An old native binary against new
   generated code rejects with `contract.mismatch` instead of silently
   misbehaving. `rustra diff` reports breaking schema changes, so the gate
   runs in CI rather than in a QA session.

3. **Documented per-host semantics instead of silent divergence.** Cancellation,
   batching, events, and channels differ across hosts for unavoidable reasons
   (a WebView transport can't preempt a Rust call mid-flight the way a JSI
   path can). Rather than pretend otherwise, every adapter exposes an
   `engine.supports` object transcribed from the compatibility matrix, so you
   can branch on `engine.supports?.cancellation === 'cooperative'` before
   relying on it.

### What it measures like

All figures below come from committed receipts on one Apple Silicon machine
(M1 Max class, macOS, release builds); they are medians or trimmed means, not
p95 guarantees, and each is reproducible with commands in the benchmarks doc.

- **Core dispatch:** the Frame round trip through the Rust core
  (`Package::invoke_frame`) runs at a **134 ns mean — about 8.9× faster than
  the JSON path (1.19 µs)**, with postcard in between at 433 ns. Core dispatch
  only — no JS host, transport, or WebView cost included.
- **Real host API.** Calling real generated entry points in real runtimes —
  `addNumbers({ a: 42, b: 58 })`, trimmed mean of 3 repeats:

  | Path                        |       Mean | Throughput |
  | --------------------------- | ---------: | ---------: |
  | Node generated one-shot     |   2.758 ms |      363/s |
  | Node persistent loop        |  16.863 µs |   59,301/s |
  | Node N-API Frame            |   1.261 µs |  793,185/s |
  | Bun generated FFI Frame     |   2.273 µs |  439,961/s |
  | Tauri generated WebView IPC | 279.044 µs |    3,584/s |

  That's a ~164× mean-latency cut from Node one-shot to the persistent loop,
  and ~2,188× to the N-API Frame path — the same contract, different
  transports, which is the actual design point: you pick the transport per
  deployment, the client code doesn't change.

- **React Native:** against a real Nitro HybridObject on an iPhone 17
  Simulator Release app (Hermes, RN 0.81.5 + Expo 54), equivalent-operation
  medians landed within **±5%** on all four operations measured — i.e., the
  JSI Frame path is Nitro-grade on the same public object API. Simulator only;
  see limitations.
- **Codec work:** a 0.10.2 codec patch (A/B against published 0.10.1, five
  independent processes per variant) cut recursive round trips by **78.66%**
  (4,455.16 ns → 950.55 ns on the depth-8 case) and requested allocations from
  81 to 11 per call — with the two regressions it caused (oneOf enums 9.60%
  slower, 64-key maps 6.24% slower) reported as controls, both inside a
  declared 10% regression budget.

### Honest limitations

Reading the compatibility matrix before adopting matters more than reading the
benchmarks:

- **In-flight cancellation is shallow on most adapters.** On Node, Bun, Tauri,
  and the RN JSON engine, cancelling mid-run rejects the JS promise and
  discards the result — the Rust command itself keeps running. Only the RN
  Frame engine can propagate cancellation to a Rust checkpoint, and only
  conditionally. Timeout semantics are similarly documented: a timeout is a
  JS-observed race, not a preemption (except where `timeoutPreemption` says
  otherwise), so `retryable` never means "re-running is safe" for non-idempotent
  commands.
- **Linux is Alpha.** Runtime evidence covers macOS (Tauri, Node, Bun), the iOS
  simulator and specific Android devices for RN. Tauri on Windows, Tauri Linux
  WebView flows, and RN on Windows/macOS hosts have no runtime claims here.
- **The performance numbers are one machine, one OS.** M1 Max class, macOS,
  release builds. No physical-device, Windows, Linux, p95, or energy claims,
  and receipts are evidence for the runs they record, not guarantees for every
  checkout.
- **The 11.8× figure is payload bytes**, not end-to-end latency; the Tauri
  WebView IPC row above (279 µs) is the honest end-to-end picture for that
  host.

### Status and try it

Current release line: Rust crates 0.12.0, `@rustra/types` 0.12.1,
`@rustra/cli` 0.12.0, adapters on their own version lines. MIT licensed. With
Rust and Bun installed:

```bash
bunx --bun @rustra/cli@0.12.0 init my-project --setup
```

scaffolds the project, generates the client, builds the Rust, and runs a demo
call. `rustra doctor` checks the toolchain prerequisites per target.

The repo (with the benchmark receipts, verification scripts, and the full
compatibility matrix) is linked from the submission. If you've hit the
four-adapters-one-core problem, I'd specifically like feedback on whether the
contract-hash gate catches the drift cases you've actually seen.
