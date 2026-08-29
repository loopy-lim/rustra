# Developer Hurdle Reduction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Rustra's environment diagnosis, Rust-to-TS/C++ code generation, development watch loop, and generated-file validation reproducible from one project configuration while documenting the native-build boundaries truthfully.

**Architecture:** Keep `rustra generate` as the schema-only renderer and add a config-driven `rustra codegen` orchestrator around the existing Rust generator plus renderer. Add a pure, injectable doctor module for host-conditional tool checks, make `rustra dev` invoke the same orchestrator, and make generation checks compare rendered bytes and a manifest without writing generated files. Update `init`, RN guidance, and user-facing limitation documentation to use these commands.

**Tech Stack:** TypeScript, Node `fs`/`child_process`/`crypto`, Bun test, Rust/Cargo metadata, Markdown documentation, existing React Native generated module and shell build scripts.

**Spec:** `docs/superpowers/specs/2026-08-29-developer-hurdle-reduction-design.md`

## Global Constraints

- Rustra application native artifacts remain app-specific; do not claim that a generic prebuilt package can replace the user's Rust command staticlib.
- Expo Go remains unsupported for custom JSI; RN instructions must use a development build or `expo run:*`.
- Workspace MSRV is Rust 1.88; Android NDK is pinned to `27.1.12297006`; CLI Node engine is `>=18`.
- `rustra generate` direct `--schema/--output` and `--config` usage remains backward compatible.
- `generate --check`, doctor JSON, and new config parsing must be fail-closed and must not install, delete, or rewrite user files; `codegen --check` may run the user's Rust generator, then its TS/C++/RN verification stage is read-only.
- Complex binary route, Tier 3 JSON fallback, owned FFI, retired `u16` command IDs, and release-frozen registry semantics remain unchanged.
- Do not add `file:../../vendor/rustra-react-native` or manual generated native registration; use the official generated module and autolinking.
- No push, pull request, npm publish, or crates.io publish is part of this plan.

## File Map

- Modify `packages/cli/src/index.ts`: config schema, `doctor`/`codegen` dispatch, Rust generator orchestration, generation `--check`, manifest creation, help text, and init templates.
- Create `packages/cli/src/doctor.ts`: pure tool/version check model, host-conditional checks, text/JSON formatters, and exit decision.
- Create `packages/cli/src/doctor.test.ts`: doctor fixtures and command-runner tests.
- Modify `packages/cli/src/dev.ts`: config mode, shared codegen invocation, source/manifest watching, single-flight retry, and child cleanup.
- Modify `packages/cli/src/dev.test.ts`: config-mode pipeline and retry tests.
- Modify `packages/cli/src/generate.test.ts`: config validation, init scripts, generated manifest, and `--check` behavior tests.
- Modify `packages/cli/package.json`: publish `doctor.d.ts/.js` and source maps if the new module is exported from the package.
- Modify `examples/calculator/rustra.json`, `examples/react-native-calculator/rustra.json`, and `examples/react-native-bare-calculator/rustra.json`: explicit codegen settings where inference would otherwise be ambiguous.
- Modify `examples/*/package.json` only where their codegen script currently duplicates the two-stage shell pipeline.
- Modify `README.md`, `packages/cli/README.md`, `docs/README.md`, `docs/getting-started.md`, `docs/extending/react-native-setup.md`, `docs/migrations/0.3-to-0.4.md`, and `docs/complex-codecs.md`: corrected commands, version lines, limits, and development-hurdle guidance.
- Create `docs/development-hurdles.md`: the reader-facing problem/current mitigation/remaining boundary table requested by the review.

### Task 1: Add the injectable environment doctor

**Files:**

- Create: `packages/cli/src/doctor.ts`
- Create: `packages/cli/src/doctor.test.ts`
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/package.json`

**Interfaces:**

- Produces `DoctorCheck`, `DoctorReport`, `DoctorOptions`, `collectDoctorReport`, `formatDoctorText`, and `doctorExitCode` for the CLI and tests.
- `collectDoctorReport(options, runner)` must not mutate the filesystem or invoke an installer.
- `runner(command, args)` returns `{ ok: boolean; stdout: string; stderr: string; error?: string }` so tests can provide deterministic fake tools.

- [ ] **Step 1: Write failing doctor tests for version parsing and strict status.**

Add tests with a fake runner that returns exact command output:

```ts
test('Rust 1.88 satisfies the MSRV and Rust 1.87 fails', () => {
  assert.deepEqual(parseRustVersion('rustc 1.88.0 (abc)'), [1, 88, 0]);
  assert.equal(isVersionAtLeast([1, 88, 0], [1, 88, 0]), true);
  assert.equal(isVersionAtLeast([1, 87, 9], [1, 88, 0]), false);
});

test('strict mode promotes warnings to a failing exit code', () => {
  const report = { checks: [{ id: 'optional', status: 'warn', required: false, summary: 'warn' }] };
  assert.equal(doctorExitCode(report, false), 0);
  assert.equal(doctorExitCode(report, true), 1);
});
```

Run: `bun test packages/cli/src/doctor.test.ts`

Expected: FAIL because the doctor model and functions do not exist.

- [ ] **Step 2: Add the doctor result model and pure version helpers.**

Implement the exact public types:

```ts
export type DoctorStatus = 'pass' | 'warn' | 'fail' | 'skip';
export interface DoctorCheck {
  id: string;
  status: DoctorStatus;
  required: boolean;
  summary: string;
  detail?: string;
  fix?: string[];
}
export interface DoctorReport {
  schemaVersion: 1;
  checks: DoctorCheck[];
}
export interface DoctorOptions {
  configPath: string;
  strict: boolean;
  platform?: NodeJS.Platform;
}
export interface DoctorCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}
export type DoctorRunner = (command: string, args: string[]) => DoctorCommandResult;
```

Export `parseRustVersion`, `isVersionAtLeast`, and `doctorExitCode`. Parse only semantic `rustc X.Y.Z` output and return `null` for unknown output; never treat an unknown version as a pass.

- [ ] **Step 3: Add common and host-conditional checks.**

Implement `collectDoctorReport` with these check IDs and behavior:

```text
config.file
rustc.present
rustc.msrv
cargo.present
js.runtime
codegen.rust_manifest
codegen.rust_binary
codegen.schema_output
rn.ios.platform
rn.ios.xcodebuild
rn.ios.cocoapods
rn.android.java
rn.android.sdk
rn.android.ndk
rn.android.rust_targets
tauri.platform_tools
```

Only emit RN iOS checks when `config.reactNative` is present and the host platform is macOS; emit RN Android checks when `config.reactNative` is present. For a Node/Bun-only config, RN checks must be `skip` or absent and must not fail the report. Check Java major version 17, NDK directory `ndk/27.1.12297006`, and the Android targets requested by the generated build script (`aarch64-linux-android` and `x86_64-linux-android` by default, with the other supported targets checked when configured). Use fix arrays such as `rustup toolchain install 1.88.0`, `xcode-select --install`, `gem install cocoapods`, and `sdkmanager "ndk;27.1.12297006"`; these are output only.

- [ ] **Step 4: Add text/JSON formatting and CLI dispatch.**

Format JSON with `JSON.stringify(report, null, 2)`. Format text with one line per check and indented `detail`/`fix` lines, for example:

```text
PASS rustc.msrv Rust 1.88.0 satisfies MSRV 1.88
FAIL rn.android.ndk Android NDK 27.1.12297006 is missing
  fix: sdkmanager "ndk;27.1.12297006"
```

Add `doctor [--config <path>] [--format text|json] [--strict]` to `main()` and `printHelp()`. Default config is `rustra.json` in the current working directory. Exit 1 on required failures, and on warnings only with `--strict`.

- [ ] **Step 5: Run the focused tests and package build.**

Run: `bun test packages/cli/src/doctor.test.ts && bun run --cwd packages/cli build`

Expected: PASS, with `packages/cli/dist/doctor.js`, declaration, and source-map files present.

- [ ] **Step 6: Commit the self-contained doctor change.**

```bash
git add packages/cli/src/doctor.ts packages/cli/src/doctor.test.ts packages/cli/src/index.ts packages/cli/package.json
git commit -m "feat(cli): 개발 환경 doctor 추가"
```

### Task 2: Make Rust-to-schema-to-client generation one command

**Files:**

- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/src/generate.test.ts`
- Modify: `packages/cli/src/dev.ts`
- Modify: `packages/cli/src/dev.test.ts`

**Interfaces:**

- Extend `RustraConfig` with `codegen?: { rustManifest?: string; rustPackage?: string; rustBinary?: string }`.
- Add `export function resolveCodegenTarget(configPath: string, config: RustraConfig): { manifestPath: string; packageName?: string; binaryName: string; cwd: string }`.
- Add `export async function runCodegen(args: string[]): Promise<void>`.
- `runCodegen` runs the resolved Cargo binary first and then invokes the existing schema renderer with the same config.

- [ ] **Step 1: Add failing config and pipeline tests.**

Add tests that assert the init config contains:

```ts
assert.match(files.rustraJson, /"codegen"/);
assert.match(files.packageJson, /"codegen": "rustra codegen --config rustra\.json"/);
```

Add target-selection tests for a `generate` binary, a single non-generate binary, and two ambiguous binaries. Add a pipeline test that records `cargo` then `generate` in order.

Run: `bun test packages/cli/src/generate.test.ts packages/cli/src/dev.test.ts`

Expected: FAIL because `codegen` config and runner are not implemented.

- [ ] **Step 2: Extend config validation and target resolution.**

Parse `codegen` as an object. Validate `rustManifest` as a non-empty safe path, `rustPackage` and `rustBinary` as Cargo identifiers, and reject arrays or control characters. Resolve the manifest from config directory, otherwise use the existing upward `findCargoManifest` behavior. Use existing `readCargoMetadata` and select the package by manifest/package name. Select `rustBinary` explicitly, then a binary named `generate`, then a sole binary; throw `codegen.rust_binary_ambiguous` with candidate names when selection is not unique.

- [ ] **Step 3: Implement the Cargo process runner and `runCodegen`.**

Use `spawn` with an argument array, never a shell string:

```ts
await spawnInherit(
  'cargo',
  [
    'run',
    '--quiet',
    '--manifest-path',
    target.manifestPath,
    ...(target.packageName ? ['--package', target.packageName] : []),
    '--bin',
    target.binaryName,
  ],
  target.cwd,
);
await runGenerate(['--config', configPath]);
```

Parse `--config` and `--check`; reject `--schema`/`--output` for `codegen` with an actionable usage message. Log the resolved manifest, package, and binary before execution. Propagate Cargo failure without starting the schema renderer.

- [ ] **Step 4: Wire the command and preserve existing commands.**

Dispatch `codegen` before `dev`, update help text, and retain `generate --watch`, direct schema generation, `init`, and `diff`. Add a package script in the generated template that calls only `rustra codegen --config rustra.json`.

- [ ] **Step 5: Verify the focused CLI tests.**

Run: `bun test packages/cli/src/generate.test.ts packages/cli/src/dev.test.ts && bun run --cwd packages/cli build`

Expected: PASS.

- [ ] **Step 6: Commit the unified codegen change.**

```bash
git add packages/cli/src/index.ts packages/cli/src/generate.test.ts packages/cli/src/dev.ts packages/cli/src/dev.test.ts
git commit -m "feat(cli): Rustra codegen 파이프라인 통합"
```

### Task 3: Add fail-closed generated drift checking

**Files:**

- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/src/generate.test.ts`
- Modify: `packages/cli/package.json` if a helper module is extracted

**Interfaces:**

- Extend `GenerateOptions` with `check?: boolean`.
- Add `export interface GeneratedManifest { schemaVersion: 1; schemaHash: string; generatorVersion: string; files: Array<{ path: string; sha256: string }>; }`.
- Add `export function buildGeneratedManifest(schemaContent: string, generatorVersion: string, files: Array<{ path: string; content: string }>): GeneratedManifest`.
- Add `export async function checkGeneratedFiles(files: Array<{ path: string; content: string }>, manifestPath: string): Promise<void>`.

- [ ] **Step 1: Write failing manifest and check tests.**

Use a temporary output directory and test all three drift classes:

```ts
test('check reports a missing generated file', async () => {
  await assert.rejects(
    () => checkGeneratedFiles([{ path: missing, content: 'x' }], manifest),
    /missing/,
  );
});

test('check rejects changed bytes and does not rewrite them', async () => {
  writeFileSync(target, 'old');
  await assert.rejects(
    () => checkGeneratedFiles([{ path: target, content: 'new' }], manifest),
    /changed/,
  );
  assert.equal(readFileSync(target, 'utf8'), 'old');
});

test('manifest records schema hash, generator version, and file hashes', () => {
  const result = buildGeneratedManifest('{}', '0.5.0', [{ path: 'types.ts', content: 'x' }]);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.files[0]?.path, 'types.ts');
  assert.match(result.schemaHash, /^[a-f0-9]{64}$/);
});
```

Run: `bun test packages/cli/src/generate.test.ts`

Expected: FAIL because manifest/check helpers do not exist.

- [ ] **Step 2: Refactor generated output into a list of absolute targets.**

Keep existing renderer functions unchanged. In `generateFromSchema`, build one list containing TypeScript output, optional C++ output, optional host entries, and rendered RN module files. Each item must contain an absolute `path`, a portable manifest `path` relative to the config app root, and `content`. Do not include `package.json` dependency edits in this list; dependency synchronization remains a normal generation side effect and is skipped in check mode.

- [ ] **Step 3: Implement hashing and manifest writing.**

Use `createHash('sha256')` over UTF-8 content. Write `.rustra-generated.json` in the configured output directory after successful normal generation. Include the CLI version and sorted file entries. Write the manifest only after all generated and RN module files have been written successfully.

- [ ] **Step 4: Implement read-only `generate --check`.**

When `--check` is present, render all expected contents in memory, read each target, compare bytes, and read the manifest. Report missing, changed, unexpected manifest entries, schema hash mismatch, and generator version mismatch. Do not call `writeFile`, `mkdir`, `writeReactNativeModule`, `ensureReactNativeDependency`, or `ensureHostDependencies` in check mode. Exit 1 through the existing top-level error handler.

Add `--check` to help and make `runCodegen --check` execute the Rust stage followed by this read-only renderer check; the CLI must state that a user-provided Rust generator may update `schema.json`, while the TS/C++/RN check stage is read-only. CI can detect schema changes with `git diff --exit-code`.

- [ ] **Step 5: Run drift tests and an example check.**

Run:

```bash
bun test packages/cli/src/generate.test.ts
bun run --cwd packages/cli build
bun run --cwd examples/calculator codegen
node packages/cli/dist/index.js generate --config examples/calculator/rustra.json --check
```

Expected: all tests pass, normal generation creates `.rustra-generated.json`, and the second command exits 0 without changing generated file mtimes or contents.

- [ ] **Step 6: Commit the drift gate.**

```bash
git add packages/cli/src/index.ts packages/cli/src/generate.test.ts packages/cli/package.json
git commit -m "feat(cli): generated drift 검사 추가"
```

### Task 4: Make `rustra dev` config-driven and retry-safe

**Files:**

- Modify: `packages/cli/src/dev.ts`
- Modify: `packages/cli/src/dev.test.ts`
- Modify: `packages/cli/src/index.ts`

**Interfaces:**

- Keep `parseDevArgs`, `planPipeline`, `detectDirty`, and `runOnce` backward compatible for existing tests and callers.
- Add `--config` to `DevOptions` as `configPath?: string`.
- Add `export function parseDevArgs(args: string[]): DevOptions` behavior where `--config` takes precedence over `--backend`/`--app`.
- Add an injectable `DevProcess` boundary for child process start/stop so tests do not spawn Cargo.

- [ ] **Step 1: Add failing config-mode and single-flight tests.**

Test that config mode uses the configured manifest/schema/output, that a Rust failure prevents the TS stage, and that a source change during an active run causes exactly one follow-up run:

```ts
test('config mode forwards one config to the integrated codegen command', async () => {
  const calls: string[][] = [];
  await runOnce({ rustBin: true, tsCli: true }, makeRunners(calls));
  assert.deepEqual(calls, [['rust'], ['ts']]);
});

test('a pending change schedules one retry after the active run', async () => {
  const calls: string[] = [];
  const run = makeDelayedPipeline(calls);
  await run.trigger();
  await run.trigger();
  await run.flush();
  assert.deepEqual(calls, ['start', 'follow-up']);
});
```

Run: `bun test packages/cli/src/dev.test.ts`

Expected: FAIL for the new config/retry cases.

- [ ] **Step 2: Resolve config source roots and generated paths.**

For `--config`, read `rustra.json`, resolve the codegen Cargo manifest, watch the manifest directory's `src` tree plus `Cargo.toml` and `Cargo.lock`, and use config `schema`/`output` plus RN `moduleDir`/`cppOutput` for stale checks. Keep `--backend`/`--app` as the legacy mode with current defaults.

- [ ] **Step 3: Invoke the shared `codegen` command and preserve pipeline order.**

Replace the hard-coded `cargo run --quiet --bin generate` in config mode with a child process invoking the current CLI entry and `codegen --config <path>`. Use the same executable path resolution used by the installed CLI. Keep the legacy mode's two injected runners for compatibility. The Rust stage must finish successfully before the renderer stage starts.

- [ ] **Step 4: Add single-flight, pending-dirty retry, and signal cleanup.**

Debounce source changes by 300 ms. While a run is active, set `pending = true` rather than starting a second run. After completion, call `detectDirty` again and run one follow-up if any relevant input is newer. On failure, retain the dirty state and keep watching. On `SIGINT`, clear timers, send `SIGINT` to the child, wait for its exit, close watchers, and resolve without an unhandled rejection.

- [ ] **Step 5: Add CLI help and inspect output for config mode.**

Document `rustra dev --config rustra.json [--inspect]`. Keep the existing `--backend`/`--app` help lines and state that config mode is preferred. `--inspect` remains informational and points users to `@rustra/devtools` without claiming in-process instrumentation.

- [ ] **Step 6: Run focused dev tests and commit.**

Run: `bun test packages/cli/src/dev.test.ts packages/cli/src/generate.test.ts && bun run --cwd packages/cli build`

Expected: PASS with no hanging watcher or child process.

```bash
git add packages/cli/src/dev.ts packages/cli/src/dev.test.ts packages/cli/src/index.ts
git commit -m "feat(cli): 설정 기반 dev 감시와 재시도"
```

### Task 5: Update init, examples, and RN setup path

**Files:**

- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/src/generate.test.ts`
- Modify: `examples/calculator/rustra.json`
- Modify: `examples/calculator/package.json`
- Modify: `examples/react-native-calculator/rustra.json`
- Modify: `examples/react-native-calculator/package.json`
- Modify: `examples/react-native-bare-calculator/rustra.json`
- Modify: `examples/react-native-bare-calculator/package.json`

**Interfaces:**

- `rustra init` emits `doctor`, `codegen`, `codegen:check`, and `dev` scripts.
- All example codegen scripts call the same `rustra codegen --config` entrypoint instead of duplicating Cargo and CLI commands.
- RN generated module ownership and standard autolinking remain unchanged.

- [ ] **Step 1: Add failing init/template assertions.**

Assert the generated package scripts equal:

```json
{
  "doctor": "rustra doctor --config rustra.json",
  "codegen": "rustra codegen --config rustra.json",
  "codegen:check": "rustra codegen --config rustra.json --check",
  "dev": "rustra dev --config rustra.json"
}
```

Assert the generated config contains `codegen.rustBinary = "generate"` and `codegen.rustManifest = "./Cargo.toml"`.

- [ ] **Step 2: Update the init generator and first-run messages.**

Make the generated Rust binary continue writing `generated/schema.json`, add the codegen config, and print:

```text
Next steps:
  cd <dir>
  bun install
  bun run doctor
  bun run codegen
  cargo run
```

For RN templates, print `bun run doctor`, `bun run codegen`, then the platform development build command. Do not generate Expo Go instructions.

- [ ] **Step 3: Convert repository examples to the unified command.**

Add explicit `codegen` objects to configs whose Rust package is outside the example directory. Replace duplicate scripts with `bunx --bun @rustra/cli codegen --config rustra.json` or the repository-local CLI equivalent. Keep path and workspace dependency behavior unchanged.

- [ ] **Step 4: Run init and example smoke checks.**

Run:

```bash
bun run --cwd packages/cli build
tmp_project="$(mktemp -d)"
node packages/cli/dist/index.js init "$tmp_project"
bun install --cwd "$tmp_project"
bun run --cwd "$tmp_project" doctor -- --format json
bun run --cwd "$tmp_project" codegen
```

Expected: the temporary scaffold reports structured doctor output, creates schema and generated TypeScript files, and does not require a manually remembered second CLI command.

- [ ] **Step 5: Commit template/example updates.**

```bash
git add packages/cli/src/index.ts packages/cli/src/generate.test.ts examples/calculator/rustra.json examples/calculator/package.json examples/react-native-calculator/rustra.json examples/react-native-calculator/package.json examples/react-native-bare-calculator/rustra.json examples/react-native-bare-calculator/package.json
git commit -m "feat(template): 첫 실행 codegen 경로 단순화"
```

### Task 6: Correct the user-facing limitation and setup documentation

**Files:**

- Create: `docs/development-hurdles.md`
- Modify: `README.md`
- Modify: `packages/cli/README.md`
- Modify: `docs/README.md`
- Modify: `docs/getting-started.md`
- Modify: `docs/extending/react-native-setup.md`
- Modify: `docs/migrations/0.3-to-0.4.md`
- Modify: `docs/complex-codecs.md`

**Interfaces:**

- Documentation must use the current independent release lines: Cargo `rustra` 0.4.x and npm CLI/types/RN packages at the repository's current compatible line.
- Documentation must link users to `docs/development-hurdles.md` and the commands `rustra doctor`, `rustra codegen`, `rustra dev`, `rustra generate --check`.

- [ ] **Step 1: Write the corrected development-hurdles document.**

Create a table with columns `주장`, `현재 구현`, `완화 방법`, and `남은 경계` covering:

```text
툴체인: doctor가 host별로 검사; 사용자 native artifact는 빌드 필요
Expo Go: custom JSI를 로드할 수 없음; development build 필요
코드젠: codegen/dev가 Rust -> schema -> TS/C++ 순서를 소유
타입: owned + serializable contract is intentional ABI boundary
성능: Tier 1/Tier 2/Tier 3 are distinct; complex types are not all JSON
registry: u16 max 65534 due to reserved sentinel; unregister retires IDs; release frozen
unsafe: safety contracts, ownership tests, fuzzing/sanitizer and runtime receipts remain required
성숙도: small ecosystem and pre-1.0 migration risk remain honest project risks
```

Include the exact first-run commands for Node/Bun and RN, and state that doctor pass is not physical-device runtime proof.

- [ ] **Step 2: Remove stale or misleading command/version text.**

Change stale `@rustra/cli@0.4.0` examples to the current CLI line, keep Cargo `rustra = "0.4"` separate, replace duplicated `cargo run && rustra generate` instructions with `rustra codegen`, and fix `rustra init --name` to `rustra init <dir>`. Do not edit historical documents whose date and past release context are intentionally preserved unless the command is presented as current guidance.

- [ ] **Step 3: Clarify native and prebuilt boundaries.**

Replace “prebuilt binary가 없어서 모든 사용자가 Rust를 설치해야 한다” with the precise distinction: the CLI is npm-installed, the shared RN adapter source is packaged, but the application-specific Rust staticlib contains the user's commands and must be built locally or in CI. Provide CI artifact as the recommended team workaround without pretending it is a generic prebuilt runtime.

- [ ] **Step 4: Align codec, registry, and unsafe explanations with code.**

Point complex-type readers to `docs/complex-codecs.md`, distinguish Tier 1 postcard/raw from Tier 2 schema-driven binary and Tier 3 JSON-in-binary, retain the measured benchmark caveat, and state that `command_id` capacity is 65,534 because `u16::MAX` is reserved. Keep `DeserializeOwned + Serialize + JsonSchema + 'static` and FFI Safety rules explicit.

- [ ] **Step 5: Run documentation scans and commit.**

Run:

```bash
git diff --check
rg -n "rustra init --name|@rustra/cli@0\.4\.0|cargo run --bin generate && rustra generate" README.md packages/cli/README.md docs examples --glob '*.md' --glob '*.json' --glob 'package.json'
```

Expected: no stale current-guidance matches; historical release notes may remain only when clearly labeled as historical. Then commit:

```bash
git add docs/development-hurdles.md README.md packages/cli/README.md docs/README.md docs/getting-started.md docs/extending/react-native-setup.md docs/migrations/0.3-to-0.4.md docs/complex-codecs.md
git commit -m "docs(dx): 개발 허들과 native 경계 정정"
```

### Task 7: Full verification and release-safe handoff

**Files:**

- Modify: `package.json` only if repository-level convenience scripts are needed.
- Modify: `docs/development-hurdles.md` only if verification discovers a documentation mismatch.

- [ ] **Step 1: Build and test the CLI package.**

Run:

```bash
bun run --cwd packages/cli build
bun run --cwd packages/cli test
bun run test:release-tools
```

Expected: PASS.

- [ ] **Step 2: Run TypeScript package and Rust gates.**

Run:

```bash
bun run test:types
bun run test:packages
cargo test --workspace
cargo clippy --all-targets -- -D warnings
```

Expected: PASS. A failure caused by an existing platform-specific runtime must be reported with its exact command and must not be masked as a doctor success.

- [ ] **Step 3: Exercise doctor and codegen against repository examples.**

Run:

```bash
node packages/cli/dist/index.js doctor --config examples/calculator/rustra.json --format json
node packages/cli/dist/index.js codegen --config examples/calculator/rustra.json
node packages/cli/dist/index.js generate --config examples/calculator/rustra.json --check
node packages/cli/dist/index.js doctor --config examples/react-native-calculator/rustra.json --format json
```

Expected: calculator common checks pass or report only environment-specific warnings, generated check exits 0, and RN doctor identifies missing platform tools instead of emitting unrelated failures.

- [ ] **Step 4: Run formatting and final diff inspection.**

Run:

```bash
bun run format:check
bun run lint
git diff --check
git status --short
```

Expected: format/lint pass, no generated build products are accidentally staged, and only the intended implementation/documentation commits are present.

- [ ] **Step 5: Record final evidence and boundaries.**

Report the exact passing commands, whether iOS simulator/Android device runtime was available, the generated artifact check result, and the fact that no push, PR, npm publish, or crates.io publish occurred. Mark the plan complete only after the current worktree and verification output support those claims.
