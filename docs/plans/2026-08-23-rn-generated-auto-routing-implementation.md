# RN generated API automatic routing implementation plan

## Phase 0: lock correctness evidence

- [x] Reproduce and fix the Runtime-invalid `PropNameID` cache crash.
- [x] Run same-process React Native reload stress after a Release rebuild.
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

- [ ] Define ownership for `ArrayBuffer`, `Uint8Array` views, and caller-owned
      response buffers.
- [ ] Add a generated direct-byte capability only for schema-proven byte fields.
- [ ] Preserve `maxPayloadBytes`, typed errors, offsets, and non-zero-length views.
- [ ] Measure 64 B, 64 KiB, and 1 MiB inputs before enabling the route by default.
- [x] Apply the representation-preserving interim path: positional `Vec<u8>`,
      one Writer reservation, one output bounds check, and explicit u8 validation.
- [x] Re-measure the 64 B `number[]` path. Median is 1.133x Nitro, so the 1.08x
      typed-buffer target remains open and is not claimed complete.

## Phase 3: make the fast path operationally boring

- [ ] Move native installation and generated-codec wiring into the Expo config
      plugin/codegen path.
- [ ] Add a Bun-based doctor command for Bun version, generated/native contract,
      Pod/autolinking, native symbols, and Release mode.
- [ ] Keep the repository and RN example free of pnpm/npm/yarn execution paths.
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
| RN runtime           | iOS Release simulator reload and correctness smoke |
| Performance          | Three-run normalized interleaved median            |
| Release claim        | Physical iOS and Android receipts                  |

Current evidence: Types 86/86, CLI generator 45/45, Rust public authoring 35/35,
C++ codec suites pass, iOS Release build/install/runtime pass, output equivalence
passes in all final performance runs, and React Doctor is 100/100. Full workspace
tests, fmt, and clippy are rerun before commit.

## Stop conditions

- Do not keep a faster route if public output/error/options behavior differs.
- Do not merge a simulator-only result as real-device proof.
- Do not start Phase 2 if Phase 1 fails reload stress or makes the public
  equivalent-operation median worse.
