English | [한국어](./post-0.9-frame-and-audit.ko.md)

# After 0.9: Frame and audit migration

The coordinated release is prepared in [PR #69](https://github.com/loopy-lim/rustra/pull/69).
The 2026-09-10 release already used 0.9.0 for Rust and types/node/bun/cli, so this
release uses new versions. The [compatibility table](../compatibility-matrix.md)
is generated from release manifests; registry publication is verified separately.

The version step applies pre-1.0 minor bumps to all nine affected JS packages:
types/node/bun/cli 0.9.0 → 0.10.0, tauri/react-native 0.8.0 → 0.9.0,
react 0.7.1 → 0.8.0, testing/devtools 0.6.2 → 0.7.0. The Rust workspace is 0.10.0;
CLI `rustraTemplate.cargoRange` is ^0.10.0 and its RN adapter range is ^0.9.0.
Internal npm ranges, lockfiles, and generated manifests are updated in the same
release candidate. Independent adapters keep their own version numbers.

## Upgrade the native library, JS packages, and generated output together

Frame changes names on the public API and native symbol boundary. The rename itself
does not alter wire bytes, but old JS or generated native shells still look up old
symbols. A successful wire fixture is not proof that mixed package versions work.

| Old surface                                                                               | New surface                                                                          |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `createRkyvV2Engine`, `RkyvV2Engine`, `RkyvV2Codec`, `RkyvV2Native`, `RkyvV2SchemaNative` | `createFrameEngine`, `FrameEngine`, `FrameCodec`, `FrameNative`, `FrameSchemaNative` |
| `invokeRkyvV2`                                                                            | `invokeFrame`                                                                        |
| `rustra_ffi_invoke_rkyv_v2{,_into,_async,_async_into}`                                    | `rustra_ffi_invoke_frame{,_into,_async,_async_into}`                                 |
| `rkyv-codecs.ts`, `rkyv-registry.ts`                                                      | `frame-codecs.ts`, `frame-registry.ts`                                               |
| `BUN_RKYV_V2_ENGINE_SUPPORTS`, `REACT_NATIVE_RKYV_V2_ENGINE_SUPPORTS`                     | `BUN_FRAME_ENGINE_SUPPORTS`, `REACT_NATIVE_FRAME_ENGINE_SUPPORTS`                    |
| debug transport `'rkyv'`                                                                  | `'frame'`                                                                            |

The unused `RustraNative.invokeRkyv` type member is removed. Update manual imports,
custom FFI bindings, native mocks, and diagnostic filters. Run the new CLI's
`rustra codegen --config rustra.json` and rebuild native shells/libraries and apps.
Commit the new generated files and their manifest together. Keep the old release's
lockfiles and native artifacts if rollback is required.

## Tauri channels

JS-issued channels now use physical-WebView-owned IPC Channels and negotiate
`ipc-channel-chunks-v1`. Rebuild Rust together with `@rustra/tauri`; the adapter
rejects an old event-broadcast host. Global detection requires `core.Channel` and
callback cleanup, or provide `createIpcChannel(onMessage) => { value, dispose() }`.
`listen` alone is insufficient. See [channels](../events-and-channels.md#5-channels--js-side)
for raw fragments, the native min(runtime limit, 16 MiB) cap (1 MiB with the
default core configuration), the 16 MiB JS reassembly ceiling, the 30-second
reassembly deadline, and cleanup behavior. Ordinary events and trusted Rust broadcast helpers retain their
broadcast policy. Native GUI teardown acceptance remains a separate check.

## React and development tools

Use a separate Provider engine per SSR request or account. Suspense caches now
have 256 entries per engine, a 5-minute completed TTL, and a 30-second pending
deadline. The deadline does not cancel the engine operation. Configure with
`configureSuspenseCache`; use the engine argument to `invalidateCommands` when
only one scope should be invalidated. Unsupported structural inputs throw instead
of colliding. Mutation completion callbacks remain tied to the invocation even
when visible hook state has reset. See the [React guide](../../packages/react/README.md).

Put `uniffi.output` in a dedicated binding directory such as `uniffi/` or
`src/bindings/`. It must not overlap schema/TS output or cover the Rust source root
or Cargo manifest. Successful generation replaces that whole tree. Ordinary
`codegen --check` checks the Rust mirror; `codegen --check-bindings` builds and
compares actual Swift/Kotlin/header/modulemap output in a fresh directory.

Hot-core retains libraries for symbol safety. Inspect
`rustra::hot_core::retained_library_stats()`; `libraries` counts retained loads,
`artifact_bytes` measures file sizes, not RSS, and `restart_recommended()` becomes
true at 32 loads. Restart the development host to release them.

## Verify the candidate and roll back as a set

Run frozen installs, release coherence, build/lint/format/tests, API surface,
docs, codegen, binding freshness, and packed-consumer checks on the final candidate.
Repository subprocess tests require Node 22; the published CLI runtime minimum
remains Node 18. Pack all affected JS packages and use local Rust crate paths in
the clean consumer so a registry fallback cannot hide a broken candidate. Exercise
Node and Bun plus the target native host with its rebuilt shell. Record local,
CI-on-the-same-commit, registry publication, and physical-device results separately.

Do not publish or merge solely because this document or changeset exists. When
approved, release Rust and JS in the coordinated version workflow and verify the
actual registry artifacts. To roll back, restore the previous JS dependency set,
lockfiles, generated output, and native application build together; swapping only
the JS adapter cannot restore old native symbol/protocol compatibility.
