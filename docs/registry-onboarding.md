English | [한국어](registry-onboarding.ko.md)

# Verify public-registry onboarding

Rustra has two distinct checks:

- `bun run test:onboarding` exercises the current checkout before publication. It injects local Cargo patches and package symlinks.
- `bun run verify:consumer:registry --output /tmp/rustra-registry/receipt.json` creates a new consumer using exact public npm and crates.io versions. It executes the published CLI, native builds, generated calls, a contract change, an upgrade and rollback. The receipt names the actual adapters and untested segments.

The second check requires Node 22, Bun 1.4, Rust 1.88 or newer, a native linker, and registry access. It writes only the new temporary consumer, its own caches and the requested output directory. Run it from this checkout; the consumer itself must have no local Rustra dependency. The npm installer and Cargo may download dependencies, so allow time for an empty cache.

```bash
bun run test:registry-consumer
bun run verify:consumer:registry --output /tmp/rustra-registry/receipt.json
```

Use a new output directory per execution to preserve the previous receipt. The command fails at the first failing step and retains diagnostics. It checks installed package versions and sources; substituting a local checkout, Cargo patch, Git source, package override or symlink must fail. Successful process exit alone is insufficient: returned values and the changed field must match.

The default version cycle verifies the Rust patch `0.10.0 → 0.10.1 → 0.10.0` with `@rustra/cli`, `types`, `node` and `bun` pinned to `0.10.0`. This verifies a Rust patch upgrade and rollback, not two successive product upgrades. Pins are deliberate: a floating `latest` could silently change the thing being verified. Review the version selection when preparing another release.

Published CLI `0.10.0` requires canonical caret strings such as `^0.10.0` in consumer manifests. The gate therefore selects exact `package@0.10.0` versions when preparing the npm lock, installs with `npm ci`, and checks the lock and installed versions at every phase. A newer patch resolution fails even when the manifest caret allows it. Cargo dependencies remain exact `=0.10.x` pins. This does not substitute local packages for the published CLI.

The manual **Registry consumer** workflow runs this check on macOS and uploads the receipt and logs even on failure. Its success is separate from the normal source CI and publishing workflows. It does not publish packages. Local results do not prove that this workflow has run.

## Read the evidence correctly

Record the runner revision, package versions, actual adapter, OS/tool versions, step duration, generated/native hashes, lockfile/source checks and original log locations. A Bun process invoking the Node adapter proves the Node transport under Bun; only a real FFI library call proves the Bun FFI adapter.

The extended fixture checks error propagation across each adapter; it does not declare typed domain errors or exercise event subscription/unsubscription. The original Node scaffold is executed before adding that fixture.

This probe does not replace Tauri WebView execution, existing-app integration, RN Android/iOS execution, external evaluator observations or real-device lifetime tests. It also does not prove two hours of load or four weeks of actual use. See the [current roadmap status](verification/2026-09-16-roadmap-status.md) and [roadmap acceptance criteria](specs/2026-09-14-rustra-roadmap.md).
