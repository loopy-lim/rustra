English | [한국어](./README.ko.md)

# rustra Documentation

rustra is a bridge framework that automatically generates a host-neutral TypeScript client once you define a Rust package.

## Reading Paths

### Library Users

1. [Getting Started](getting-started.md) — installation and building your first package
2. [Architecture Overview](architecture.md) — grasp the overall structure and core concepts
3. [Events and Channels](events-and-channels.md) — Rust → JS push: `subscribeEvent`, `createChannel`
4. [Development Hurdles Guide](development-hurdles.md) — doctor, integrated codegen, drift, native boundary, mock engine
5. [Rust API Guide](rust-api-guide.md) — full macro/Builder reference
6. [React Native Setup](extending/react-native-setup.md) — wiring the JSI native module (iOS/Android)
7. [Tauri Setup](extending/tauri-setup.md) — adding rustra to an existing Tauri app
8. [Transport Replacement Guide](extending/transport-guide.md) — replacing transports such as Bun FFI, Node napi-rs
9. [Adding a New Host Guide](extending/adding-host.md) — adding new host adapters such as Electron, Deno
10. [Dynamic Development Tier](dev-tier.md) — loose invoke prototyping, device token experiments, `test:fast`

### Project Contributors

1. [Architecture Overview](architecture.md) — grasp the overall structure and core concepts
2. [Crate and Package Structure](internal/crate-structure.md) — responsibilities and dependencies of each crate/package
3. [TypeScript Code Generation](internal/codegen.md) — schema → TS type mapping, command name conversion
4. [Testing Structure](internal/testing.md) — test layers, per-file roles, run commands

## Full Document List

| Document                                                                                     | Audience     | Content                                                                                            |
| -------------------------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------- |
| [Architecture Overview](architecture.md)                                                     | All          | Data flow, EngineClient contract, transport separation principles                                  |
| [Getting Started](getting-started.md)                                                        | Users        | Installation, minimal example, TS integration, error handling, adapter choice, running             |
| [Events and Channels](events-and-channels.md)                                                | Users        | `.event::<T>` declaration, generated `events.ts`, per-host `subscribeEvent`/`createChannel`        |
| [Development Hurdles Guide](development-hurdles.md)                                          | Users        | doctor, integrated codegen/dev, drift gates, native/prebuilt boundary, mock engine, CLI forms      |
| [Transport Replacement Guide](extending/transport-guide.md)                                  | Users        | Bun FFI and Node napi-rs replacement, selection criteria                                           |
| [React Native Setup](extending/react-native-setup.md)                                        | Users        | JSI native module, iOS/Android builds, BenchmarkApp                                                |
| [Tauri Setup](extending/tauri-setup.md)                                                      | Users        | Adding rustra to an existing Tauri app — the five files, in order                                  |
| [Adding a New Host Guide](extending/adding-host.md)                                          | Users        | Writing an adapter, choosing a Rust entry point, adding tests                                      |
| [Dynamic Development Tier](dev-tier.md) ([한국어](dev-tier.ko.md))                           | Users        | `invokeLoose` prototyping, catalog-outside token experiments, gate profiles                         |
| [Crate and Package Structure](internal/crate-structure.md)                                   | Contributors | Responsibilities of each crate/package, build dependencies                                         |
| [TypeScript Code Generation](internal/codegen.md)                                            | Contributors | Codegen pipeline, type mapping, limitations                                                        |
| [Testing Structure](internal/testing.md)                                                     | Contributors | Test layers, script chain, per-host status                                                         |
| [Compatibility Contract](compatibility-contract.md) ([한국어](compatibility-contract.ko.md)) | Contributors | EngineClient stability contract, runtime acceptance gates                                          |
| [Compatibility Matrix](compatibility-matrix.md)                                              | Users        | Feature (signal/cancellation/batch/events) × adapter support table                                 |
| [Wire Format](wire-format.md)                                                                | All          | What "rkyv V2/postcard" actually are, per-tier bytes, quoting rules for measurements               |
| [Verification Checklist](verification-checklist.md)                                          | Contributors | Manual per-host verification blocks backing the evidence-level tables                              |
| [Contract Migration Guide](migration-guide.md)                                               | All          | Schema breaking-change detection (rustra diff) · resolution recipes · rollout order                |
| [Migration Notes](migrations/0.3-to-0.4.md), [0.5→0.6](migrations/0.5-to-0.6.md)             | Users        | Step-by-step notes when jumping rustra minor versions                                              |
| [Rust API Guide](rust-api-guide.md)                                                          | Users        | `#[command]`/`#[bridge_type]`/`build!` macros, Package/Builder API                                 |
| [Benchmarks](benchmarks.md)                                                                  | All          | Per-adapter performance comparison, overhead analysis, payload scaling                             |
| [Complex Data Codecs](complex-codecs.md)                                                     | Users        | Recursive map/enum/Option wire, limits, RN boundary                                                |
| [Platform Permissions](platform-permissions.md)                                              | Users        | OS permission ownership per platform (iOS/Android/Windows/macOS), Tauri ACL vs rustra capabilities |
| [Threat Model](threat-model.md)                                                              | Contributors | STRIDE analysis, trust boundaries, code-backed mitigations, open gaps                              |
| [Security Audit](security-audit.md)                                                          | Contributors | Lockfile vulnerabilities/warnings status, resolution history                                       |
| [Release Procedure](release-procedure.md)                                                    | Contributors | Changeset publishing procedure, version management                                                 |
| [Versioning Policy](versioning-policy.md)                                                    | All          | Compatibility guarantees per surface, deprecation cycle, MSRV, experimental surface                |
| [Security Policy](../.github/SECURITY.md)                                                    | All          | Vulnerability reporting channels, supported versions, scope                                        |
| [Contributing Guide](../CONTRIBUTING.md)                                                     | Contributors | Development environment, commit rules, debugging, releases                                         |

## Example Gallery

Ten runnable examples live in [`examples/`](../examples/) — each has its own README
(en/ko) with prerequisites and run commands.

| Example                                                                     | What you learn                                                                    |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [`calculator`](../examples/calculator/)                                     | the baseline: commands, contract probe, stdio/FFI binaries, all generated entries |
| [`crud`](../examples/crud/)                                                 | a resource pattern: create/get/list/update/delete over one schema                 |
| [`streaming`](../examples/streaming/)                                       | Rust → JS events: `.event::<T>()` + `Package::emit` + `subscribeEvent` per host   |
| [`auth`](../examples/auth/)                                                 | deny-by-default capability gates (`require_capability` + runtime grants)          |
| [`tauri-calculator`](../examples/tauri-calculator/)                         | a real Tauri WebView build with IPC, push events, and a performance receipt       |
| [`react-native-calculator`](../examples/react-native-calculator/)           | Expo development build on the autolinked JSI package (iOS/Android)                |
| [`react-native-bare-calculator`](../examples/react-native-bare-calculator/) | bare React Native without Expo — identical app code to the Expo example           |
| [`calculator-napi`](../examples/calculator-napi/)                           | replacing the transport with napi-rs (source of the release transport benchmark)  |
| [`benchmark`](../examples/benchmark/)                                       | payload scaling and throughput measurement harness                                |
| [`reference-app`](../examples/reference-app/)                               | `@rustra/react` hooks in a real app: useCommand/useMutation/useEvent              |

`examples/rn-wasm-spike/` is an experimental wasm32-in-wasm3 spike — evidence and
scope caveats are in the [compatibility matrix](compatibility-matrix.md), not a
supported path.

## Research Background

[docs/research/](research/) contains bridge/benchmark/transport research documents from the early iOS PoC. Crate names may differ from the current implementation, but they are preserved as the rationale behind design decisions.

## Plans / Contracts / Report Records

- [docs/specs/](specs/) — per-feature design specs
- [docs/plans/](plans/) — implementation plans and spike records (including historical documents)
- [docs/prs/](prs/) — PR reports for merged tracks
