---
'@rustra/cli': minor
'@rustra/types': minor
'@rustra/node': minor
'@rustra/bun': minor
'@rustra/tauri': minor
'@rustra/react-native': minor
'rustra': minor
---

#### Codegen correctness (fix)

- The rkyv postcard codec no longer silently drops unsupported fields (`Option<T>`, `Vec<String>`, `Vec<Struct>`, string enums) from generated codecs — the crud example's `updateItem`/`getItem`/`listItems` wire frames were silently truncated. All four shapes now encode/decode correctly, verified by byte-exact round-trip tests against an independent postcard implementation.
- Commands with genuinely unsupported field types (maps, data-carrying enums) are excluded from the rkyv registry and the C++ `has_static_codec` dispatch with a `WARN` at generation time; the engine routes them through the Tier 3 JSON-in-binary fallback. Rust mirrors the same support set (`js_postcard_codec_supported`) so both sides agree on the wire — no more partial-codec preemption.
- `allOf` maps to `A & B` intersections and integer enums map to `1 | 2 | 3` literal unions in both the Rust codegen and the TS CLI (dual-path parity).
- Field-order drift warning: when schema properties appear alphabetically sorted, `rustra generate` warns that postcard requires declaration order (preserve_order).
- `rustra init` templates reference `^0.1.3` (was pinned to `^0.1.1`).

#### Cancellation & semantics

- AbortSignal propagation now reaches the Rust checkpoint on typed (tier 1) and Tier 3 dynamic commands when the native module exposes `invokeAsync`/`invokeCancel` — previously only JS-codec (tier 2) commands propagated. Commands without a commandId source keep shallow cancel.
- `getLiveSchema` throws `schema.unavailable` when the native module does not expose `getSchema` (was: silent empty Map). Engine dispatch absorbs this and preserves the `command.not_found` contract.
- JSON transports (Node/Bun/Tauri engines) no longer silently ignore `options.signal`: pre-abort rejects with `cancelled`, in-flight rejects with `cancel.unsupported`.
- `invokeBatch` single-traversal cancel semantics documented as an explicit contract (signal-bearing entries route per-item).

#### Onboarding / DX

- `createNodeProcessTransport` in `@rustra/node`: subprocess transport speaking the standard `<bin> invoke` stdio JSON protocol — the getting-started Node quickstart is now copy-paste complete. The crud example ships the same `invoke` entrypoint as the calculator.
- New `docs/compatibility-matrix.md`: signal/cancel/batch/events × adapter support table.
- New `examples/reference-app`: a React app using `@rustra/react` hooks (`useCommand`/`useMutation`/`useEvent`/`RustraProvider`) over the crud package, with a runnable smoke (`npm run test:app:reference`).

#### Performance follow-ups

- `rustra_ffi_invoke_json_into`: caller-buffer FFI variant eliminating the Rust malloc → copy → caller-memcpy triple copy (size-probe → write two-phase protocol).
- `rustra generate --positional`: emits `positional-facade.ts` wrapping static commands as positional signatures (`addNumbers(a, b)`) calling JSI `invokeTyped` directly.

#### Misc

- RN JSI bridge exposes `getContractHash` — the `contractHash` engine option works on React Native now.
- `docs/rust-api-guide.md` rewritten to match the real macro contracts (single Input struct required, `Result<O>` required; removed fictional scalar-multi-param/bare-return/`rename_all` override APIs; documented event bus, capability, FFI, freeze, tauri APIs).
- RSS measurement in the benchmark harness works on Linux (`/proc/self/statm`).
