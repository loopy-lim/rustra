# RN generated API automatic routing implementation plan

## Phase 0: lock correctness evidence

- [x] Reproduce and fix the Runtime-invalid `PropNameID` cache crash.
- [x] Run same-process React Native reload stress with the Debug allocator guard,
      then rebuild Release for performance.
- [x] Record a normalized three-run Nitro/Rustra/Swift FFI baseline.
- [x] Keep React Doctor at 100/100.

## Phase 1: unify scalar and positional routing

- [x] Add field-aware internal generated invoke helpers without changing command
      function signatures.
- [x] Emit those helpers from both TypeScript generation paths so
      `Package::generate_typescript()` and `rustra generate` cannot drift.
- [x] Add a native command capability mask and cache it once per engine.
- [x] Route verified raw commands to `invokeTypedRaw`, then positional commands
      to `invokeTypedPos`, then fall back to the existing by-id/name/codec paths.
- [x] Reconstruct the declared output object in generated C++ for raw results.
- [x] Cover old-native fallback, id/name mismatch, options, raw, positional, and
      unsupported command behavior with Bun and C++ tests.
- [x] Resolve immutable per-command routes once and cache direct closures so the
      public generated helper avoids repeated capability/name Map lookups.

## Phase 2: optimize bytes and collections

- [x] Define ownership for `ArrayBuffer`, `Uint8Array` views, and Rust-owned
      response buffers transferred to a JSI `MutableBuffer` finalizer.
- [x] Add a generated direct-byte capability only for exact single-required-field
      input/output schemas plus an explicitly registered Rust buffer handler.
- [x] Preserve the dynamic wire-size limit, typed errors, empty buffers, view
      offsets, detached-storage rejection, and one-byte-view restriction.
- [x] Measure 64 B, 64 KiB, and exact 1 MiB-wire inputs before enabling the route.
- [x] Apply the representation-preserving interim path: positional `Vec<u8>`,
      one Writer reservation, one output bounds check, and explicit u8 validation.
- [x] Re-measure the dedicated typed-buffer path. Final three-run ratios from
      median times are 0.947x Nitro at 64 KiB and 1.000x at exact 1 MiB wire.

## Phase 3: make the fast path operationally boring

- [ ] Move native installation and generated-codec wiring into the Expo config
      plugin/codegen path.
- [ ] Add a Bun-based doctor command for Bun version, generated/native contract,
      Pod/autolinking, native symbols, and Release mode.
- [x] Keep active repository and RN example execution paths on Bun 1.4. Registry
      names, Dependabot's `npm` ecosystem key, changelogs, and historical plans
      remain factual references rather than executable package-manager paths.
- [ ] Add reload stress and normalized performance receipts to the release gate.
- [x] Make `bun run ios`/`bun run android` rebuild their Rust static library before
      invoking Expo so stale FFI symbols cannot survive an app rebuild.

## Verification matrix

| Gate                 | Required evidence                                  |
| -------------------- | -------------------------------------------------- |
| TypeScript contracts | Bun tests and typecheck                            |
| Generator parity     | Bun CLI tests plus Rust generation tests           |
| Native codecs        | C++ codec compile/round-trip suite                 |
| Rust core            | Cargo tests and clippy/fmt checks                  |
| React quality        | React Doctor 100/100                               |
| RN runtime           | iOS Debug reload stress plus Release runtime smoke |
| Performance          | Three-run normalized interleaved median            |
| Release claim        | Physical iOS and Android receipts                  |

Current evidence: focused Types, CLI generator, Rust buffer/FFI, and C++ codec
suites pass. A direct-buffer/pending-async reload probe passed 30/30 after moving
native installation from the TurboModule queue to the JS Runtime thread. iOS
Release build/install/runtime and three-run byte output equivalence also pass.
Full workspace tests, fmt, clippy, and React Doctor are rerun before commit.

## Stop conditions

- Do not keep a faster route if public output/error/options behavior differs.
- Do not merge a simulator-only result as real-device proof.
- Do not start Phase 2 if Phase 1 fails reload stress or makes the public
  equivalent-operation median worse.
