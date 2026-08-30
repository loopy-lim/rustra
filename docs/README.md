English | [한국어](./README.ko.md)

# rustra Documentation

rustra is a bridge framework that automatically generates a host-neutral TypeScript client once you define a Rust package.

## Reading Paths

### Library Users

1. [Architecture Overview](architecture.md) — grasp the overall structure and core concepts
2. [Getting Started](getting-started.md) — installation and building your first package
3. [Development Hurdles Guide](development-hurdles.md) — doctor, integrated codegen, drift, native boundary
4. [Rust API Guide](rust-api-guide.md) — full macro/Builder reference
5. [React Native Setup](extending/react-native-setup.md) — wiring the JSI native module (iOS/Android)
6. [Transport Replacement Guide](extending/transport-guide.md) — replacing transports such as Bun FFI, Node napi-rs
7. [Adding a New Host Guide](extending/adding-host.md) — adding new host adapters such as Electron, Deno

### Project Contributors

1. [Architecture Overview](architecture.md) — grasp the overall structure and core concepts
2. [Crate and Package Structure](internal/crate-structure.md) — responsibilities and dependencies of each crate/package
3. [TypeScript Code Generation](internal/codegen.md) — schema → TS type mapping, command name conversion
4. [Testing Structure](internal/testing.md) — test layers, per-file roles, run commands

## Full Document List

| Document                                                                 | Audience    | Content                                                                               |
| ------------------------------------------------------------------------ | ----------- | ------------------------------------------------------------------------------------- |
| [Architecture Overview](architecture.md)                                 | All         | Data flow, EngineClient contract, transport separation principles                     |
| [Getting Started](getting-started.md)                                    | Users       | Installation, minimal example, TS integration, error handling, adapter choice, running |
| [Development Hurdles Guide](development-hurdles.md)                      | Users       | doctor, integrated codegen/dev, drift gates, native/prebuilt boundary                 |
| [Transport Replacement Guide](extending/transport-guide.md)              | Users       | Bun FFI and Node napi-rs replacement, selection criteria                              |
| [React Native Setup](extending/react-native-setup.md)                    | Users       | JSI native module, iOS/Android builds, BenchmarkApp                                   |
| [Adding a New Host Guide](extending/adding-host.md)                      | Users       | Writing an adapter, choosing a Rust entry point, adding tests                         |
| [Crate and Package Structure](internal/crate-structure.md)               | Contributors | Responsibilities of each crate/package, build dependencies                            |
| [TypeScript Code Generation](internal/codegen.md)                        | Contributors | Codegen pipeline, type mapping, limitations                                           |
| [Testing Structure](internal/testing.md)                                 | Contributors | Test layers, script chain, per-host status                                            |
| [Compatibility Contract](compatibility-contract.md)                      | Contributors | EngineClient stability contract, runtime acceptance gates                             |
| [Compatibility Matrix](compatibility-matrix.md)                          | Users       | Feature (signal/cancellation/batch/events) × adapter support table                    |
| [Contract Migration Guide](migration-guide.md)                           | All         | Schema breaking-change detection (rustra diff) · resolution recipes · rollout order   |
| [Rust API Guide](rust-api-guide.md)                                      | Users       | `#[command]`/`#[bridge_type]`/`build!` macros, Package/Builder API                    |
| [Benchmarks](benchmarks.md)                                              | All         | Per-adapter performance comparison, overhead analysis, payload scaling                |
| [Complex Data Codecs](complex-codecs.md)                                 | Users       | Recursive map/enum/Option wire, limits, RN boundary                                   |
| [Security Audit](security-audit.md)                                      | Contributors | Lockfile vulnerabilities/warnings status, resolution history                          |
| [Release Procedure](release-procedure.md)                                | Contributors | Changeset publishing procedure, version management                                    |
| [Security Policy](../.github/SECURITY.md)                                | All         | Vulnerability reporting channels, supported versions, scope                           |
| [Contributing Guide](../CONTRIBUTING.md)                                 | Contributors | Development environment, commit rules, debugging, releases                            |

## Research Background

[docs/research/](research/) contains bridge/benchmark/transport research documents from the early iOS PoC. Crate names may differ from the current implementation, but they are preserved as the rationale behind design decisions.

## Plans / Contracts / Report Records

- [docs/specs/](specs/) — per-feature design specs
- [docs/plans/](plans/) — implementation plans and spike records (including historical documents)
- [docs/prs/](prs/) — PR reports for merged tracks
