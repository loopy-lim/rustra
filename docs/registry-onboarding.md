English | [한국어](registry-onboarding.ko.md)

# Verify public-registry onboarding

Rustra has two distinct checks:

- `bun run test:onboarding` exercises the current checkout before publication. It injects local Cargo patches and package symlinks.
- `bun run verify:consumer:registry --output /tmp/rustra-registry/receipt.json` creates a new consumer using exact public npm and crates.io versions. It executes the published CLI, native builds, generated calls, a contract change, an upgrade and rollback. The receipt names the actual adapters and untested segments.

Three sibling journeys extend the same contract beyond the Node/Bun command line:

- `bun run verify:consumer:tauri --output <abs>/registry-tauri.json` scaffolds a registry-only Tauri consumer (`@rustra/tauri` + crates.io `rustra` with the `tauri` feature), bundles the frontend, embeds it via `generate_context!`, boots the real macOS WebView and reports observations from inside the WebView through a `reportEvidence` command on the Rustra contract itself. It covers first call, domain-error propagation, event subscribe/unsubscribe over the push sink and a contract field change with regeneration and a real-WebView re-run.
- `bun run verify:consumer:rn-android --output <abs>/registry-rn-android.json --serial <adb-serial>` scaffolds a public React Native community template (no Expo), pins the published CLI/types/adapter, lets codegen render the `rustra-bridge` native module, builds the Rust staticlib with cargo-ndk and the debug APK with Gradle, then runs it on a physical Android device and recovers JS observations from the logcat marker. The same A1/A2/A3 surface as the Tauri leg, at device-evidence level.
- `bun run verify:consumer:diagnostics --output <abs>/registry-diagnostics.json` injects five real failure inputs — stale generated files, a stale client against a rebuilt binary, a missing native binary, an emptied `PATH` for `doctor`, and an out-of-contract payload — and requires each to fail loudly with cause, target and next action (A4).

These journeys need the same tools as the base gate plus, for the Tauri leg, nothing beyond macOS; for the RN leg, the Android SDK/NDK, cargo-ndk and a connected device; each writes its own receipt and logs under the output directory.

The second check requires Node 22, Bun 1.4, Rust 1.88 or newer, a native linker, and registry access. It writes only the new temporary consumer, its own caches and the requested output directory. Run it from this checkout; the consumer itself must have no local Rustra dependency. The npm installer and Cargo may download dependencies, so allow time for an empty cache.

```bash
bun run test:registry-consumer
bun run verify:consumer:registry --output /tmp/rustra-registry/receipt.json
```

Use a new output directory per execution to preserve the previous receipt. The command fails at the first failing step and retains diagnostics. It checks installed package versions and sources; substituting a local checkout, Cargo patch, Git source, package override or symlink must fail. Successful process exit alone is insufficient: returned values and the changed field must match.

The default version cycle verifies the Rust upgrade `0.10.2 → 0.11.0 → 0.10.2` with `@rustra/cli` `0.11.3`, `types` `0.12.0`, `node`/`bun` `0.10.2` — the current published line, including `@rustra/tauri` `0.9.3` and `@rustra/react-native` `0.9.2` for the sibling journeys (see `scripts/registry-consumer/versions.json`). This verifies one Rust upgrade and rollback, not two successive product upgrades. Pins are deliberate: a floating `latest` could silently change the thing being verified. Review the version selection when preparing another release.

The published CLI advertises caret ranges in its own manifest (`types ^0.12.0`, `node/bun ^0.10.0`, `tauri ^0.9.0`). When the newest patch (e.g. `0.10.2`) differs from the range base (`^0.10.0`), a manifest caret written from the patch trips the CLI's own release-line guard, so the gate writes **exact** pins in consumer manifests, prepares the npm lock with `--save-exact`, installs with `npm ci`, and checks the lock and installed versions at every phase. Exact pins inside the CLI's advertised range satisfy both the CLI guard and the contamination scan. A newer resolution still fails. Cargo dependencies remain exact `=0.10.x`/`=0.11.0` pins. This does not substitute local packages for the published CLI.

The manual **Registry consumer** workflow runs this check on macOS and uploads the receipt and logs even on failure. Its success is separate from the normal source CI and publishing workflows. It does not publish packages. Local results do not prove that this workflow has run.

## Known published-CLI findings (2026-09-21)

Two onboarding defects were found by the sibling journeys against published CLI `0.11.3`; both are fixed in this repository and await the next CLI release:

1. The generated `@rustra/generated-react-native` module manifest declared `"type": "module"` while its `react-native.config.js` is CommonJS. Node-based autolinking (Gradle settings generation) silently skipped the module, so `RustraBridge` was never linked — invisible to `bunx --bun react-native config` verification because Bun's `require` loads ESM. The renderer now omits `type`; until the fixed CLI ships, the RN journey applies the same edit after codegen and records it as `workaround-published-cli-esm-module-manifest`.
2. RN CLI autolinking registers the generated module through the `node_modules` workspace symlink, so Gradle's `file()` base made the rendered relative adapter path resolve to `node_modules/node_modules/...`. Apps avoid this by pinning the dependency root in an app-owned `react-native.config.js` (the journey renders one); a renderer-side hardening is a follow-up candidate.

## Read the evidence correctly

Record the runner revision, package versions, actual adapter, OS/tool versions, step duration, generated/native hashes, lockfile/source checks and original log locations. A Bun process invoking the Node adapter proves the Node transport under Bun; only a real FFI library call proves the Bun FFI adapter.

The extended fixture checks error propagation across each adapter; it does not declare typed domain errors. Event subscribe/unsubscription is covered by the Tauri and RN journeys above on their push paths. The original Node scaffold is executed before adding that fixture.

The Node/Bun probe does not replace Tauri WebView execution, existing-app integration, RN iOS execution, external evaluator observations or real-device lifetime tests — the Tauri and RN/Android journeys now cover the first and the RN/Android execution leg at their stated evidence levels. Neither proves two hours of load or four weeks of actual use. See the [current roadmap status](verification/2026-09-16-roadmap-status.md) and [roadmap acceptance criteria](specs/2026-09-14-rustra-roadmap.md).
